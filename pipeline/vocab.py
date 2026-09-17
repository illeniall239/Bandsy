"""'Check Your English Vocabulary for IELTS' -> content/vocab.json: one themed word list per unit.

  python pipeline/vocab.py --text claude:sonnet        # ~50 small text calls, once

The book is a workbook (exercises + answer key), text-layer PDF. Unit boundaries come from its contents page;
each unit's text (exercises + its answer-key entry) goes to the model, which returns the words worth learning.
"""
import argparse, json, re, sys
from pathlib import Path
import pymupdf
sys.path.insert(0, str(Path(__file__).parent))
from extract import model_json, ROOT, BOOKS, W, J

SCHEMA = {"type": "object", "properties": {"words": {"type": "array", "items": {"type": "object", "properties": {
    "word": {"type": "string"}, "definition": {"type": "string", "description": "plain English, one line"},
    "example": {"type": "string", "description": "one IELTS-style sentence using it"}}, "required": ["word", "definition", "example"]}}}, "required": ["words"]}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--text", required=True, help="provider:model"); a = ap.parse_args()
    pdf = pymupdf.open(next(BOOKS.glob("Check Your English Vocabulary*.pdf")))
    pages = [p.get_text() for p in pdf]
    contents = "\n".join(pages[4:8])
    norm = lambda t: re.sub(r"\s+", " ", t.replace("&", "and")).strip().lower()
    titles = {norm(l): l.strip() for l in contents.splitlines() if l.strip() and not re.match(r"^(Contents|General vocabulary|Topic-specific vocabulary|Answers?|\d+)$", l.strip())}
    # a unit starts on the page whose first line is its title; the "Answers" section ends the units
    key_start = next(n for n, t in enumerate(pages) if t.strip().startswith("Answers") and n > 100)
    starts, seen = [], set()
    for n, t in enumerate(pages[:key_start]):
        first = norm(t.strip().split("\n")[0])
        if first in titles and first not in seen and n > 7 and not first.startswith("practice tasks"):
            starts.append((titles[first], n)); seen.add(first)
    cache = ROOT / "work" / "vocab"; cache.mkdir(parents=True, exist_ok=True)
    out = []
    print(f"{len(starts)} units, answer key from page {key_start + 1}")
    for i, (title, n) in enumerate(starts):
        end = starts[i + 1][1] if i + 1 < len(starts) else key_start
        f = cache / f"{i:02d}.json"
        if not f.exists():
            text = "\n".join(pages[n:end])
            key = next((t for t in pages[key_start:] if title in t), "")
            data = model_json(a.text, f"Unit '{title}' of an IELTS vocabulary workbook, followed by its answer-key entry. List every word or phrase "
                              f"this unit teaches (the items in its word banks and answers, not the instructions), with a one-line definition and an example sentence. "
                              f"Skip trivial words.\n\nUNIT:\n{text[:12000]}\n\nANSWER KEY:\n{key[:4000]}", SCHEMA)
            W(f, {"topic": title, **data})
            print(f"  {title}: {len(data['words'])} words")
        out.append(J(f))
    W(ROOT / "content" / "vocab.json", out)
    print(f"content/vocab.json: {sum(len(u['words']) for u in out)} words in {len(out)} lists")

if __name__ == "__main__":
    main()
