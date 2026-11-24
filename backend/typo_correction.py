import torch
import cleanspeak_cli as cs
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

cs.load_model()
SP = "oliverguhr/spelling-correction-english-base"
sp_tok = AutoTokenizer.from_pretrained(SP)
sp_model = AutoModelForSeq2SeqLM.from_pretrained(SP).eval()

def spell_fix(t):
    enc = sp_tok(t, return_tensors="pt", truncation=True, max_length=128)
    with torch.no_grad():
        out = sp_model.generate(**enc, max_length=128, num_beams=4)
    return sp_tok.decode(out[0], skip_special_tokens=True)

TESTS = [
    "the student o f university off enginrering annd mangeenyt",   # your example
    "I recieved ur mesage yesterday and it was realy helpfull",
    "tomorow we are going to the univercity for the departmant meeting",
    "can u send me teh notes pls",
    "The meeting starts at 10 AM tomorrow.",                       # clean: must stay unchanged
    "tbh bruh that movie was lit",                                 # slang: must not be mangled
    "i live in bengaluru and work at infosys",                     # names: must not be mangled
    "this is bullshit, the teacher dont no nothing",               # mixed
]
for t in TESTS:
    s = cs.fix_slang(t)
    print(f"IN              : {t}")
    print(f"spell only      : {spell_fix(s)}")
    print(f"coedit grammar  : {cs.polish(s)}")
    print(f"spell -> coedit : {cs.polish(spell_fix(s))}")
    print(f"current pipeline: {cs.cleanspeak(t)[0]}\n")