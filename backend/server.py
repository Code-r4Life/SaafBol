"""Local API for the CleanSpeak browser extension.

    pip install fastapi uvicorn      (plus everything cleanspeak_cli.py needs)
    uvicorn server:app --host 127.0.0.1 --port 8000

Keep it on 127.0.0.1: there is no authentication, and the text you check is sent here.
The model loads once at startup, so the first start takes a while.
"""
import json
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

import cleanspeak_cli as cs            # same file as the terminal tool: one pipeline, two front-ends

LOCK = threading.Lock()                # one model, so run one request at a time
FEEDBACK_FILE = Path("feedback.jsonl")
MAX_CHARS = 2000                       # keeps a huge paste from freezing the model


@asynccontextmanager
async def lifespan(app):
    cs.load_model()                    # adapter + base model, loaded once
    yield


app = FastAPI(title="CleanSpeak", lifespan=lifespan)


class CheckReq(BaseModel):
    text: str


class FeedbackReq(BaseModel):
    original: str
    clean: str
    rating: int                        # 1 = good, -1 = bad
    host: str = ""                     # site name only, never the full URL


@app.get("/health")
def health():
    return {"ok": True, "pipeline": cs.PIPELINE}


@app.get("/lexicon")
def lexicon():
    """Word lists for the extension's live underlines. The Python lists stay the single source of truth."""
    plain = re.compile(r"[A-Za-z']+")
    ignore = {w.lower() for w in cs.IGNORE}
    words = set()
    for w in cs.profanity.CENSOR_WORDSET:          # better-profanity stores VaryingString objects
        orig = str(getattr(w, "_original", w))
        if plain.fullmatch(orig) and orig.lower() not in ignore:
            words.add(orig.lower())                # single plain words only; leetspeak variants are skipped
    return {"slang": cs.SLANG, "bad": sorted(words), "ignore": sorted(ignore)}


@app.post("/check")
def check(req: CheckReq):
    text = req.text[:MAX_CHARS]
    out_lines, items = [], []
    with LOCK:
        for line in text.split("\n"):  # keep paragraph breaks; the pipeline works on single sentences
            if not line.strip():
                out_lines.append(line)
                continue
            clean, stages = cs.cleanspeak(line)
            out_lines.append(clean)
            items.extend(stages)       # one stage dict per sentence, for the stage-wise view
    clean_text = "\n".join(out_lines)
    return {
        "original": text,
        "clean": clean_text,
        "flagged": cs.real_dirty(text),
        "changes": cs.changes(text, clean_text),
        "items": items,
    }


@app.post("/feedback")
def feedback(req: FeedbackReq):
    """Thumbs up/down from the extension, saved locally as a small real-world evaluation set."""
    with FEEDBACK_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps({**req.model_dump(), "ts": int(time.time())}, ensure_ascii=False) + "\n")
    return {"ok": True}