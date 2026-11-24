#!/usr/bin/env python
"""SaafBol engine (CleanSpeak pipeline v1) + typo-correction stage on top.

Pipeline: caps -> slang dictionary -> TYPO MODEL -> fine-tuned CoEdIT (LoRA) -> backstop -> CoEdIT grammar polish -> mask.

Setup (once):
    pip install torch transformers peft sentencepiece better-profanity sentence-transformers
    hf auth login            # the adapter repo is private, so log in (or set the HF_TOKEN env var)

Run:
    python cleanspeak_cli.py                              # interactive: type a sentence, get the cleaned one
    python cleanspeak_cli.py --verbose                    # also print every pipeline stage
    python cleanspeak_cli.py --no-spell                   # same pipeline WITHOUT the typo model (for comparing)
    python cleanspeak_cli.py --eval                       # run the built-in 39-sentence test set + metrics
    python cleanspeak_cli.py --eval --file my_tests.txt   # add your own sentences (one per line)

Pipeline stages:
    1 slang     rule-based dictionary (tbh -> honestly, gonna -> going to, ...)
    1b spell    typo model (oliverguhr/spelling-correction-english-base): recieved -> received, o f -> of, ...
    2 model     the LoRA adapter removes / rewrites toxic words (it sees every sentence)
    3 backstop  only if the model left a bad word: swap it for a milder word from SOFTEN
    4 polish    the ORIGINAL CoEdIT (adapter switched off) fixes grammar
    5 mask      last resort: if a bad word is still there, star it out (r******)
"""
import argparse
import csv
import difflib
import os
import re

BASE = "grammarly/coedit-large"
ADAPTER = "Shinjan123/coedit-paradetox-lora"
PREFIX = "Clean this sentence: "   # same instruction the adapter was trained with
PIPELINE = "v1"                    # kept as a constant so server.py can report it

# Typo model: a pretrained BART spelling corrector (about 139M params, MIT). ON by default.
# To switch it off without editing code: set the environment variable CLEANSPEAK_SPELL=0 (or use --no-spell here).
SPELL_MODEL = "oliverguhr/spelling-correction-english-base"
USE_SPELL = os.environ.get("CLEANSPEAK_SPELL", "1") != "0"

# ---------------------------------------------------------------- word lists (edit these freely)
# Slang: deterministic and explainable. Longest keys are matched first, so "lit af" wins over "af".
SLANG = {"lit af": "really exciting", "tbh": "honestly", "idk": "I do not know", "gonna": "going to",
         "wanna": "want to", "gotta": "have to", "kinda": "kind of", "u": "you", "ur": "your",
         "pls": "please", "thx": "thanks", "cuz": "because", "af": "very", "bro": "", "dude": "",
         "lol": "", "irl": "in real life", "bruh": "", "bruv": ""}

# Words that sit on the profanity list but are not toxic by themselves (a judgment call: say so in the report).
IGNORE = {"pot", "gay", "omg", "kill", "dang", "wtf"}

# Mild insults the default list misses, so detection catches them.
EXTRA_BAD = ["rascal", "bastard", "idiot", "moron", "clown", "stupid", "jerk"]

# Backstop: used ONLY when the model leaves a bad word behind. Each replacement is milder but keeps the
# criticism (an insult stays a mild criticism, never praise). Crude on purpose: it is a safety net.
SOFTEN = {"idiot": "fool", "idiots": "fools", "moron": "fool", "morons": "fools", "stupid": "unwise",
          "dumb": "unwise", "jerk": "unpleasant person", "bastard": "unpleasant person",
          "rascal": "troublemaker", "clown": "fool", "sucked": "performed poorly", "sucks": "is bad",
          "sucking": "performing poorly", "screwed": "messed", "crap": "nonsense", "damn": "darn",
          "hell": "heck", "shit": "nonsense", "bullshit": "nonsense"}

from better_profanity import profanity  # noqa: E402

profanity.load_censor_words()            # built-in list first...
profanity.add_censor_words(EXTRA_BAD)    # ...then ADD ours (load_censor_words(x) would REPLACE the defaults)

SLANG_RE = re.compile(r"\b(" + "|".join(sorted(map(re.escape, SLANG), key=len, reverse=True)) + r")\b", re.I)


# ---------------------------------------------------------------- rule-based helpers
def fix_slang(text):
    s = SLANG_RE.sub(lambda m: SLANG[m.group(0).lower()], text)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s+([,.!?])", r"\1", s)            # no space before punctuation
    return re.sub(r"^[\s,]+|[\s,]+$", "", s)        # trim commas left where bro/dude was removed


def real_dirty(text):
    """Bad words that remain, ignoring the IGNORE list. Checked word by word so 'assess' is NOT flagged."""
    return [w for w in re.findall(r"[\w']+", text)
            if w.lower() not in IGNORE and profanity.contains_profanity(w)]


def soften_words(text):
    def sub(m):
        w = m.group(0)
        rep = SOFTEN.get(w.lower())
        if not rep:
            return w
        return rep.capitalize() if w[:1].isupper() else rep   # keep the capital letter
    return re.sub(r"[A-Za-z']+", sub, text)


def mask_dirty(text):
    """Last resort: keep the first letter, star the rest (r******)."""
    dirty = {w.lower() for w in real_dirty(text)}
    return re.sub(r"[\w']+", lambda m: m.group(0)[0] + "*" * (len(m.group(0)) - 1)
                  if m.group(0).lower() in dirty else m.group(0), text)


def split_sentences(text):
    return [p for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p]


# ---------------------------------------------------------------- model
TOK = MODEL = None
SP_TOK = SP_MODEL = None
DEVICE = "cpu"


def load_model(adapter=ADAPTER):
    global TOK, MODEL, DEVICE, USE_SPELL, SP_TOK, SP_MODEL
    import torch
    from peft import PeftModel
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading model on {DEVICE} (first run downloads ~3GB)...")
    TOK = AutoTokenizer.from_pretrained(BASE)       # adapter repo has no tokenizer files; it is unchanged from the base
    base = AutoModelForSeq2SeqLM.from_pretrained(BASE)
    MODEL = PeftModel.from_pretrained(base, adapter).to(DEVICE).eval()

    if USE_SPELL:                                   # the typo model (about 0.6 GB more RAM)
        try:
            SP_TOK = AutoTokenizer.from_pretrained(SPELL_MODEL)
            SP_MODEL = AutoModelForSeq2SeqLM.from_pretrained(SPELL_MODEL).to(DEVICE).eval()
            print("Typo model loaded: spelling stage is ON.")
        except Exception as e:                      # offline / download problem: carry on without it
            print(f"Typo model could not be loaded ({e}). Continuing without the spelling stage.")
            USE_SPELL = False


def generate(texts, prefix=PREFIX, beams=4):
    import torch
    enc = TOK([prefix + t for t in texts], return_tensors="pt", padding=True,
              truncation=True, max_length=96).to(DEVICE)
    with torch.no_grad():
        out = MODEL.generate(**enc, max_length=96, num_beams=beams)
    return TOK.batch_decode(out, skip_special_tokens=True)


def polish(text):
    with MODEL.disable_adapter():                   # adapter off = original CoEdIT, so grammar skills are untouched
        return generate([text], prefix="Fix the grammar: ")[0]


def spell_fix(text):
    """The typo model: fixes misspellings, repeated letters, and split / merged words."""
    import torch
    enc = SP_TOK(text, return_tensors="pt", truncation=True, max_length=128).to(DEVICE)
    with torch.no_grad():
        out = SP_MODEL.generate(**enc, max_length=128, num_beams=4)
    return SP_TOK.decode(out[0], skip_special_tokens=True)


def normalize_caps(text):
    """ALL-CAPS input (DANG IT) is unusual for T5, so the model leaves it alone. Lowercase it first."""
    letters = [c for c in text if c.isalpha()]
    # mostly-uppercase and at least 2 words, so "NASA launched a rocket", "OK", and "PDF" are left alone
    if len(letters) >= 4 and len(text.split()) >= 2 and sum(c.isupper() for c in letters) / len(letters) > 0.8:
        return text.lower()
    return text


# ---------------------------------------------------------------- the pipeline (v1 + typo model on top)
def cleanspeak_sentence(text):
    """One sentence in -> (final sentence, dict of every stage for debugging)."""
    stages = {"input": text}
    s = fix_slang(normalize_caps(text))
    stages["1 slang"] = s
    if not s:
        return "", stages

    if USE_SPELL:                                   # typo model, right after the slang dictionary so slang is not "corrected"
        s = spell_fix(s)
        stages["1b spell"] = s

    out = generate([s])[0]                          # the model sees every sentence
    stages["2 model"] = out

    if real_dirty(out):                             # the model missed a bad word -> deterministic backstop
        out = soften_words(out)
        stages["3 backstop"] = out

    out = polish(out)
    stages["4 polish"] = out

    if real_dirty(out):                             # still dirty -> mask rather than let it through
        out = mask_dirty(out)
        stages["5 mask"] = out
    return out, stages


def cleanspeak(text):
    """Any text in (one or many sentences) -> (final text, list of stage dicts)."""
    outs, all_stages = [], []
    for sent in split_sentences(text):              # the model was trained on single sentences
        o, st = cleanspeak_sentence(sent)
        outs.append(o)
        all_stages.append(st)
    return " ".join(o for o in outs if o), all_stages


def changes(a, b):
    d = [x for x in difflib.ndiff(a.split(), b.split()) if x[0] in "+-"]
    return "  ".join(d) if d else "(no change)"


# ---------------------------------------------------------------- interactive mode
def repl(verbose):
    print("\nSaafBol ready. Type a sentence (empty line or 'q' to quit).")
    while True:
        try:
            text = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if text.lower() in {"", "q", "quit", "exit"}:
            break
        out, stages = cleanspeak(text)
        flagged = real_dirty(text)
        print(f"  flagged : {flagged if flagged else '-'}")
        if verbose:
            for st in stages:
                for k, v in st.items():
                    print(f"  {k:11}: {v}")
                print()
        print(f"  CLEAN   : {out}")
        print(f"  changes : {changes(text, out)}")


# ---------------------------------------------------------------- evaluation
TEST_SET = {
    # clean sentences must come back unchanged (apart from case/punctuation): checks for over-editing
    "clean": ["The meeting starts at 10 AM tomorrow.", "I need to assess the class schedule.",
              "Please send me the report by Friday.", "She is going to the library after lunch.",
              "The bus was late, so we missed the first lecture.", "Can you help me with this assignment?",
              "We are meeting at the cafeteria at noon.", "He bought a new laptop yesterday."],
    "grammar": ["She dont like apples", "He go to school every day", "Their going to the park tomorrow.",
                "I seen the movie yesterday and it was realy good",
                "The teacher dont know nothing about this topic", "Me and him was late to class"],
    "slang": ["bro i is gonna go there, its lit af", "idk why u keep ignoring my texts lol",
              "tbh the exam was kinda hard", "pls send me the notes cuz i missed class",
              "dude that presentation was legit amazing", "that happens irl all the time",
              "wanna grab lunch, im starving af"],
    "insult": ["you are a bastard and you never listen", "that rascal stole my bike yesterday",
               "tbh he's a clown, idk why u trust him", "only an idiot would believe that",
               "stop being so stupid and read the instructions", "my manager is a jerk who never says thanks",
               "those morons ruined the whole project", "you dumb kid, give me back my pen"],
    "profanity": ["this is bullshit, the teacher dont know nothing", "what the hell is wrong with you",
                  "shut the fuck up and listen to me", "this damn printer is useless",
                  "get your ass over here right now", "that movie was crap and a waste of money"],
    "mixed": ["bro u r such an idiot, idk why i even talk to u", "this app sucks and ur team is dumb af",
              "omg stop being stupid, its not that hard", "he dont know shit about cars, the dumb jerk"],
}


def norm(s):
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).split()


def retention(src, out, skip):
    """Share of the input's ordinary words that survive. Slang/flagged words are expected to change, so skipped."""
    keep = [w for w in norm(src) if w not in skip]
    o = set(norm(out))
    return sum(w in o for w in keep) / len(keep) if keep else 1.0


def run_eval(extra_file=None):
    from sentence_transformers import SentenceTransformer, util
    embedder = SentenceTransformer("all-MiniLM-L6-v2", device=DEVICE)

    test_set = {k: list(v) for k, v in TEST_SET.items()}
    if extra_file:
        with open(extra_file, encoding="utf-8") as f:
            test_set["custom"] = [ln.strip() for ln in f if ln.strip()]

    slang_words = {w for k in SLANG for w in k.split()}
    rows = []
    for cat, sents in test_set.items():
        for s in sents:
            out, _ = cleanspeak(s)
            skip = slang_words | {w.lower() for w in real_dirty(s)}
            meaning = util.cos_sim(embedder.encode(s), embedder.encode(out)).item() if out else 0.0
            rows.append({"category": cat, "input": s, "output": out,
                         "bad_left": int(bool(real_dirty(out))),
                         "meaning": round(meaning, 3),
                         "retention": round(retention(s, out, skip), 3),
                         "unchanged": int(norm(s) == norm(out))})
            print(f"[{cat}] {s}\n   -> {out}")

    print("\n" + "=" * 78)
    print(f"{'category':10} {'n':>3} {'bad left':>9} {'meaning':>8} {'retention':>10} {'unchanged':>10}")
    for cat in test_set:
        r = [x for x in rows if x["category"] == cat]
        n = len(r)
        print(f"{cat:10} {n:>3} {sum(x['bad_left'] for x in r):>9} "
              f"{sum(x['meaning'] for x in r) / n:>8.2f} {sum(x['retention'] for x in r) / n:>10.2f} "
              f"{(str(sum(x['unchanged'] for x in r)) + '/' + str(n)) if cat == 'clean' else '-':>10}")
    print("Read the insult/mixed outputs by eye too: no metric here can tell 'rude' from a flipped compliment.")

    with open("eval_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print("Saved eval_results.csv")


# ---------------------------------------------------------------- entry point
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", action="store_true", help="run the built-in test set and print metrics")
    ap.add_argument("--file", help="extra test sentences, one per line (used with --eval)")
    ap.add_argument("--verbose", action="store_true", help="show every pipeline stage in interactive mode")
    ap.add_argument("--no-spell", action="store_true", help="turn the typo model OFF (for A/B comparison)")
    ap.add_argument("--adapter", default=ADAPTER, help="HF repo or local folder of the LoRA adapter")
    args = ap.parse_args()

    if args.no_spell:
        USE_SPELL = False
    load_model(args.adapter)
    if args.eval:
        run_eval(args.file)
    else:
        repl(args.verbose)