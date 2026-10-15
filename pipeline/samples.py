"""Cambridge IELTS book -> content/camNN/samples.json: the book's own answers to each Writing task.

  python pipeline/samples.py --book 15 --vision claude:sonnet [--pages 129-139]

Near the end of each book, every Writing task has an answer with the examiner's comment: a real candidate's script at a stated band
(Cambridge 10-12 print them as photos of handwriting, 13-15 typeset them), and in some books a model answer written by an examiner.
The app shows them beside your graded answer, and the grader is shown a candidate script with its real band to calibrate its scale.

Handwriting defeats OCR, so each page goes to a model that reads images: one call per page, cached under work/camNN/samples/.
Claude sometimes declines to copy a page of book text (its verbatim filter, and not every time): the page is asked again, then for the
bands and examiner's comments alone, so a task keeps at least what the examiner said. A declined answer that is typeset (Cambridge 13-15
scripts, every examiner's model answer) is then read by Tesseract, and the model, looking at the page, lists only the OCR's misreads
to fix ('|' for 'I', '25' for 'as'): it never has to copy the text, and the writer's own mistakes stay as printed.
An answer or comment running onto the next page is joined to it. The output is its own file, so `extract.py assemble` never overwrites it.
"""
import argparse, json, re, subprocess, sys
from pathlib import Path
import pymupdf
sys.path.insert(0, str(Path(__file__).parent))
from extract import model_json, book_pdf, ROOT, W, J

# the Academic "Sample answers for Writing tasks" pages (1-based) in the PDFs in Cambridge-lists-main; --pages for another copy
PAGES = {10: (162, 169), 11: (133, 140), 12: (124, 131), 13: (124, 133), 14: (119, 128), 15: (129, 139)}

SCHEMA = {"type": "object", "properties": {"entries": {"type": "array", "items": {"type": "object", "properties": {
    "test": {"type": "integer", "description": "n in the heading 'TEST n, WRITING TASK m'; 0 if this part continues an answer or comment from the previous page"},
    "task": {"type": "integer", "description": "m in that heading; 0 when continuing"},
    "kind": {"type": "string", "enum": ["model", "candidate"], "description": "model: a MODEL ANSWER prepared by an examiner; candidate: a SAMPLE ANSWER by a candidate"},
    "band": {"type": "number", "description": "the band the candidate achieved, e.g. 6.5; 0 for a model answer or a continuation"},
    "answer": {"type": "string", "description": "the answer's text on this page, exactly as written; paragraphs separated by a blank line; empty if none here"},
    "comment": {"type": "string", "description": "the examiner's comment on this page, exactly; empty if none here"}},
    "required": ["test", "task", "kind", "band", "answer", "comment"]}}}, "required": ["entries"]}

PROMPT = """This page is from the "Sample answers for Writing tasks" section of a Cambridge IELTS Academic book.
List every answer on the page, in page order, filling the schema.
- Transcribe each answer exactly as the candidate wrote it, keeping every mistake in spelling, grammar and punctuation. Do not correct
  or improve anything: the mistakes are what the examiner's band reflects. Keep the paragraph breaks.
- Copy the examiner's comment exactly, including any [bracketed examples].
- Leave out the page header, page number, any website watermark, and the lead-in lines ("This is an answer written by a candidate who
  achieved a Band ... score", "This model has been prepared by an examiner ...", "Here is the examiner's comment").
- If the page begins by continuing an answer or comment from the previous page, give that part as an entry with test 0 and task 0.
- Skip anything marked GENERAL TRAINING."""

COMMENTS_ONLY = PROMPT + """
- This time leave every "answer" empty: give only the headings, kinds, bands and the examiner's comments."""

def read_page(spec, png):
    for prompt in (PROMPT, PROMPT, COMMENTS_ONLY):
        if (r := model_json(spec, prompt, SCHEMA, images=[png])) is not None: return r
    return None

# books whose candidate scripts are typeset in a handwriting-style font, which OCR reads; 10-12 print photos of handwriting, which it can't
TYPESET = {13, 14, 15}

def ocr_page(pdf, n, outdir):
    txt = outdir / f"p{n:03d}.ocr.txt"
    if not txt.exists():
        png = outdir / f"p{n:03d}.300.png"
        pdf[n - 1].get_pixmap(dpi=300).save(png)
        txt.write_text(subprocess.run(["tesseract", str(png), "-", "--psm", "4"], capture_output=True, text=True, check=True).stdout, encoding="utf-8")
    return txt.read_text(encoding="utf-8")

def answer_from_ocr(text, test, task):
    """The answer in OCR'd text: from this task's heading and the lead-in line after it, to the examiner's comment or the next task.
    Line breaks inside a paragraph are joined; running headers and page numbers dropped."""
    if m := re.search(rf"TEST {test}\s*,\s*WRITING TASK {task}", text): text = text[m.end():]
    text = re.split(r"(?i)here is the examiner", text)[0]
    lead = re.search(r"(?is)many possible\s+approaches\.?", text) or re.search(r"(?is)achieved a\s+band\s+[\d.]+\s+score[.:]?", text)
    if not lead: return ""
    body = re.split(r"TEST \d+\s*,\s*WRITING TASK \d", text[lead.end():])[0]
    lines = [l for l in body.splitlines() if not re.fullmatch(r"\s*(\d{1,3}|Sample (Writing answers|answers for Writing tasks)|(SAMPLE|MODEL) ANSWER)\s*", l, re.I)]
    return "\n\n".join(" ".join(p.split()) for p in re.split(r"\n\s*\n", "\n".join(lines)) if p.strip())

PROOF = {"type": "object", "properties": {"fixes": {"type": "array", "items": {"type": "object", "properties": {
    "ocr": {"type": "string", "description": "a few consecutive words copied exactly from the OCR text, containing one misread"},
    "page": {"type": "string", "description": "the same words as printed on the page"}}, "required": ["ocr", "page"]}}}, "required": ["fixes"]}
PROOF_PROMPT = """Below is OCR text of one answer printed on these pages of a Cambridge IELTS book. The writer's text is printed exactly as
they wrote it, mistakes included. List only the places where the OCR misread what is printed: '|' for 'I', 'fo' or '1o' for 'to', '25' or
'a5' for 'as', '2' for 'a', a dropped or swapped letter, a wrong capital. Do NOT correct the writer's own spelling, grammar or punctuation:
if the page shows the mistake, it stays. Each fix is a few words from the OCR text around the misread, and those words as printed.
Return an empty list if the OCR matches the page.

OCR TEXT:
"""

def proofread(spec, text, pngs, cache):
    if not cache.exists():
        r = model_json(spec, PROOF_PROMPT + text, PROOF, images=pngs)
        W(cache, r if r is not None else {"fixes": []})
    for f in J(cache)["fixes"]:
        if f["ocr"] and f["ocr"] in text: text = text.replace(f["ocr"], f["page"], 1)
    return text

def page_png(pdf, n, outdir):
    png = outdir / f"p{n:03d}.png"
    if not png.exists(): pdf[n - 1].get_pixmap(dpi=130).save(png)   # upright: rendering applies the page's /Rotate
    return png

def join(a, b):
    """A part continued from the previous page: same paragraph if the page broke mid-sentence."""
    if not a or not b: return a or b
    return a + (" " if not re.search(r"[.!?\"'”’)\]]\s*$", a) else "\n\n") + b

def samples(book, spec, pages=None):
    pdf, out = pymupdf.open(book_pdf(book)), ROOT / "work" / f"cam{book:02d}" / "samples"
    out.mkdir(parents=True, exist_ok=True)
    a, b = pages or PAGES[book]
    entries, missing = [], []
    for n in range(a, b + 1):
        cache = out / f"p{n:03d}.json"
        if not cache.exists():
            r = read_page(spec, page_png(pdf, n, out))
            if r is None: missing.append(n); print(f"  p{n}: the model declined to transcribe it (content filter)"); continue
            W(cache, r)
        for e in J(cache)["entries"]:
            if e["test"] == 0 and entries:
                entries[-1]["pages"] = sorted({*entries[-1]["pages"], n})
                entries[-1]["answer"] = join(entries[-1]["answer"], e["answer"].strip())
                entries[-1]["comment"] = join(entries[-1]["comment"], e["comment"].strip())
            elif e["test"] >= 1 and e["task"] in (1, 2):
                entries.append({**{k: e[k].strip() if isinstance(e[k], str) else e[k] for k in ("test", "task", "kind", "band", "answer", "comment")}, "pages": [n]})
        print(f"  p{n}: " + ", ".join(f"T{e['test']} task {e['task']} {e['kind']}" for e in J(cache)["entries"]) if cache.exists() else f"  p{n}: -")
    for e in entries:   # a declined script the OCR can read: Tesseract, then the model's list of OCR misreads
        if e["answer"] or not (book in TYPESET or e["kind"] == "model"): continue
        pages = [*e["pages"], e["pages"][-1] + 1] if e["pages"][-1] < b else e["pages"]   # an answer can run onto the next page
        if text := answer_from_ocr("\n".join(ocr_page(pdf, n, out) for n in pages), e["test"], e["task"]):
            fixes = out / f"p{e['pages'][0]:03d}.t{e['test']}k{e['task']}.proof.json"
            e["answer"], e["source"] = proofread(spec, text, [page_png(pdf, n, out) for n in pages], fixes), "ocr"
            print(f"  T{e['test']} task {e['task']} {e['kind']}: {len(e['answer'].split())} words by OCR, {len(J(fixes)['fixes'])} misreads fixed")
    shift = min((e["test"] for e in entries), default=1) - 1   # Cambridge 12 numbers its tests 5-8: they're this book's 1-4
    entries = [{**e, "test": e["test"] - shift} for e in entries if e["answer"] or e["comment"]]   # a declined model answer has neither
    res = {}
    for e in entries:
        item = {"kind": e["kind"], "band": e["band"] if e["kind"] == "candidate" and e["band"] else None, "answer": e["answer"], "comment": e["comment"],
                **({"source": "ocr"} if e.get("source") else {})}
        res.setdefault(str(e["test"]), {}).setdefault(str(e["task"]), []).append(item)
    W(ROOT / "content" / f"cam{book:02d}" / "samples.json", res)
    got = [(t, k) for t in res for k in res[t]]
    print(f"content/cam{book:02d}/samples.json: {len(got)}/8 tasks, {len(entries)} answers"
          + (f"; pages the model declined: {missing}" if missing else "")
          + "".join(f"\n  T{t} task {k}: " + ", ".join(f"{i['kind']} {i['band'] or ''} ({len(i['answer'].split())} words, comment {len(i['comment'].split())})" for i in res[t][k]) for t, k in got))

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", type=int, required=True)
    ap.add_argument("--vision", required=True, help="provider:model that reads images, e.g. claude:sonnet")
    ap.add_argument("--pages", help="first-last PDF pages of the section, for a copy whose pages differ from PAGES")
    a = ap.parse_args()
    samples(a.book, a.vision, tuple(map(int, a.pages.split("-"))) if a.pages else None)
