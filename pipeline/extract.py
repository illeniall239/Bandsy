"""Cambridge IELTS book -> content/camNN/testN.json.

  python pipeline/extract.py ocr      --book 15                       # Tesseract every page (local, ~1 s/page)
  python pipeline/extract.py map      --book 15                       # section boundaries from OCR headers, no model
  python pipeline/extract.py units    --book 15 --text claude:sonnet --vision claude:sonnet   [--verify]
  python pipeline/extract.py assemble --book 15

Text is OCR (passages, transcripts, writing prompts: no model at all). A model only structures question
groups, speaking frames and answer keys; free validators flag numbering gaps (--verify adds an A/B model diff). Provider strings:
ollama:<model> or claude:<model> (Claude Code subprocess on the subscription, text-only except keys).
Idempotent: everything under work/camNN/ is a cache. Any model error stops the run; rerun to resume.
"""
import argparse, base64, json, re, subprocess, sys, urllib.request
from pathlib import Path
import pymupdf
sys.path.insert(0, str(Path(__file__).parent))
import ocr

ROOT = Path(__file__).resolve().parent.parent
BOOKS = ROOT / "Cambridge-lists-main"
HEADER = ocr.HEADER

def book_pdf(book):
    """Books 1-15 keep the PDF in a per-book folder; 16+ sit at the top level as Cambridge-IELTS-NN-Academic.pdf."""
    folder = BOOKS / f"Cambridge IELTS {book:02d}"
    return next(folder.glob("*.pdf"), None) or next(BOOKS.glob(f"Cambridge-IELTS-{book}-*.pdf"))
def work(book):
    w = ROOT / "work" / f"cam{book:02d}"
    for d in ("ocr", "pages", "units"): (w / d).mkdir(parents=True, exist_ok=True)
    return w
def J(p): return json.loads(Path(p).read_text(encoding="utf-8"))
def W(p, d): Path(p).write_text(json.dumps(d, indent=1, ensure_ascii=False), encoding="utf-8")

# ---------- ocr ----------
def ocr_all(book):
    w, pdf = work(book), pymupdf.open(book_pdf(book))
    for n in range(1, len(pdf) + 1):
        ocr.ocr_page(pdf, n, w / "ocr")
        png = w / "pages" / f"p{n:03d}.png"
        if not png.exists(): pdf[n - 1].get_pixmap(dpi=130).save(png)
    print(f"ocr: {len(pdf)} pages")

# site watermark (Cambridge 12: "RAMS : www.iyuce.com"), its bare "AMT SA >:" variants, stray 1–3 symbol lines, and the
# "TES" / "DING" fragments of a banner. A speaker label on its own line ("ED:", "RUTH:") is kept: the colon has letters before it.
NOISE = re.compile(r"www\.\S+\.(com|net|org)|^[A-Z ]{0,10}[>]+\s*:?\s*$|^[A-Z ]{0,10}:\s*>+\s*$|^\W{1,3}$|^[A-Z]{1,4}$")

def text(w, n, strip=True):
    t = (w / "ocr" / f"p{n:03d}.txt").read_text(encoding="utf-8")
    lines = [l for l in t.splitlines() if not NOISE.search(l)]
    return "\n".join(l for l in lines if not HEADER.match(l)) if strip else "\n".join(lines)

# ---------- map ----------
def map_book(book):
    w, out = work(book), work(book) / "map.json"
    if out.exists(): return J(out)
    npages = len(list((w / "ocr").glob("p*.txt")))
    head = lambda n: "\n".join(text(w, n, False).splitlines()[:3])
    first = lambda rx, lo=1: next(n for n in range(lo, npages + 1) if re.search(rx, head(n), re.M))
    top = lambda n: (text(w, n, False).splitlines() or [""])[0]
    audio = next(n for n in range(1, npages + 1) if top(n).startswith("Audioscripts"))       # first line only: the contents page lists it too
    two = lambda n: " ".join(text(w, n, False).splitlines()[:2])   # Cambridge 16 wraps it: "Listening and / Reading answer keys"
    keys = next(n for n in range(audio, npages + 1) if re.search(r"(?i)answer keys", two(n)))   # "Answer Keys" in Cambridge 13
    sample = next((n for n in range(keys, npages + 1) if re.search(r"(?i)^(Model and )?Sample .*Writing", head(n), re.M)), npages + 1)
    # General Training pages (Cambridge 10 prints two GT reading/writing tests after the four Academic ones, and their keys
    # after the Academic keys): the Academic tests end where they begin
    gt = next((n for n in range(1, audio) if re.search(r"(?i)^General Training", head(n), re.M)), audio)
    gt_keys = next((n for n in range(keys, sample) if re.search(r"(?i)GENERAL TRAINING", head(n))), sample)
    # a test starts at its Listening Part/Section 1 ("SECTION" before the 2020 format change, e.g. Cambridge 14)
    # ("SECTION 1" on its own line under "LISTENING" when the badge is clipped, e.g. Cambridge 11 Test 3 "LISTENIN")
    starts = sorted({n for n in range(1, gt) if re.search(r"^\W?(LISTENING\W?|(PART|SECTION) 1 Questions 1[-–—]10|(PART|SECTION) 1)$", head(n), re.M) and not re.search(r"(?i)speaking|examiner", head(n))}) + [gt]
    assert len(starts) == 5, f"expected 4 test starts, got {starts[:-1]}"
    tests = {}
    for t in range(4):
        cur, secs = "listening", {}
        for n in range(starts[t], starts[t + 1]):
            h = "\n".join(text(w, n, False).splitlines()[:6])
            if m := re.search(r"^READING PASSAGE (\d)", h, re.M): cur = f"reading_passage_{m.group(1)}"
            elif m := re.search(r"^WRITING TASK (\d)", h, re.M): cur = f"writing_task_{m.group(1)}"
            elif re.search(r"^SPEAKING|The examiner asks", h, re.M): cur = "speaking"
            secs.setdefault(cur, [n, n])[1] = n
        tests[str(t + 1)] = secs
    m = {"book": book, "pages": npages, "tests": tests, "audioscripts": [audio, keys - 1], "answer_keys": [keys, gt_keys - 1]}
    W(out, m); print(json.dumps(m["tests"]["1"]), m["audioscripts"], m["answer_keys"])
    return m

# ---------- models ----------
def model_json(spec, prompt, schema, images=(), _retry=0):
    provider, model = spec.split(":", 1)
    if provider == "ollama":
        msg = {"role": "user", "content": prompt}
        if images: msg["images"] = [base64.b64encode(Path(p).read_bytes()).decode() for p in images]
        body = {"model": model, "stream": False, "think": False, "format": schema, "messages": [msg],
                "options": {"temperature": 0, "num_ctx": 16384}}
        req = urllib.request.Request("http://localhost:11434/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
        res = json.loads(urllib.request.urlopen(req, timeout=3600).read())
        return json.loads(res["message"]["content"])
    if provider == "claude":
        # token diet: own one-line system prompt, no settings/CLAUDE.md/memory, no tools (Read only for key-page images),
        # prompt over stdin. Measured: ~6k tokens per text call vs ~300k for the image-reading agent it replaced.
        cmd = ["claude", "-p", "--model", model, "--output-format", "json", "--json-schema", json.dumps(schema),
               "--system-prompt", "You convert IELTS exam pages into JSON exactly as instructed.", "--setting-sources=",
               "--no-session-persistence", "--tools", "Read" if images else "", "--max-turns", str(2 + len(images) + 2 * _retry)]
        if images: prompt = "Read " + ", ".join(Path(p).name for p in images) + ".\n" + prompt
        r = subprocess.run(cmd, input=prompt, cwd=Path(images[0]).parent if images else None, capture_output=True, text=True, encoding="utf-8", shell=sys.platform == "win32")
        out = json.loads(r.stdout) if r.stdout.strip() else sys.exit(f"claude gave no output: {r.stderr[-500:]}")
        if "content filtering" in str(out.get("result", "")): return None   # verbatim-text filter: caller keeps what it has
        if (out.get("subtype") == "error_max_turns" or not out.get("is_error")) and "structured_output" not in out and _retry < 2:
            print(f"  (no structured output: stop={out.get('stop_reason')} turns={out.get('num_turns')}; retry {_retry + 1})")
            return model_json(spec, prompt, schema, images, _retry=_retry + 1)  # truncated turn, not a limit
        if out.get("is_error") or "structured_output" not in out:
            # rate limit lands here: stop, never downgrade
            sys.exit(f"claude failed: subtype={out.get('subtype')} stop={out.get('stop_reason')} result={out.get('result', '')[:500]!r}")
        u = out.get("usage", {}); TOKENS[0] += u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("input_tokens", 0) + u.get("output_tokens", 0)
        return out["structured_output"]
    sys.exit(f"unknown provider {provider}")

# ---------- schemas ----------
QTYPES = ["matching_headings", "true_false_not_given", "yes_no_not_given", "matching_information", "matching_features",
          "matching_sentence_endings", "sentence_completion", "summary_completion", "note_completion", "table_completion",
          "form_completion", "flow_chart_completion", "diagram_labelling", "map_labelling", "multiple_choice",
          "multiple_choice_multi", "short_answer"]
OPT = {"type": "array", "items": {"type": "object", "properties": {"key": {"type": "string"}, "text": {"type": "string"}}, "required": ["key", "text"]}}
QGROUP = {"type": "object", "properties": {
    "type": {"type": "string", "enum": QTYPES},
    "instructions": {"type": "string", "description": "verbatim instruction lines incl. word limits"},
    "first": {"type": "integer"}, "last": {"type": "integer"},
    "body": {"type": "string", "description": "shared text (summary/notes/table/form) with each numbered gap written as [[n]]; empty if none"},
    "options": {**OPT, "description": "shared option list (headings i-x, features A-H, endings); empty if none"},
    "questions": {"type": "array", "items": {"type": "object", "properties": {"n": {"type": "integer"}, "text": {"type": "string"}, "options": OPT}, "required": ["n", "text", "options"]}},
    "figure_pdf_page": {"type": "integer", "description": "PDF page of the map/diagram/chart this group refers to, else 0"}},
    "required": ["type", "instructions", "first", "last", "body", "options", "questions", "figure_pdf_page"]}
SCHEMAS = {
    "reading": {"type": "object", "properties": {"title": {"type": "string"}, "groups": {"type": "array", "items": QGROUP}}, "required": ["title", "groups"]},
    "listening": {"type": "object", "properties": {"parts": {"type": "array", "items": {"type": "object", "properties": {
        "part": {"type": "integer"}, "groups": {"type": "array", "items": QGROUP}}, "required": ["part", "groups"]}}}, "required": ["parts"]},
    "speaking": {"type": "object", "properties": {
        "part1": {"type": "array", "items": {"type": "object", "properties": {"topic": {"type": "string"}, "questions": {"type": "array", "items": {"type": "string"}}}, "required": ["topic", "questions"]}},
        "part2": {"type": "object", "properties": {"cue": {"type": "string"}, "points": {"type": "array", "items": {"type": "string"}}, "rounding_off": {"type": "array", "items": {"type": "string"}}}, "required": ["cue", "points", "rounding_off"]},
        "part3": {"type": "array", "items": {"type": "object", "properties": {"topic": {"type": "string"}, "questions": {"type": "array", "items": {"type": "string"}}}, "required": ["topic", "questions"]}}},
        "required": ["part1", "part2", "part3"]},
    "keys": {"type": "object", "properties": {"blocks": {"type": "array", "items": {"type": "object", "properties": {
        "test": {"type": "integer"}, "module": {"type": "string", "enum": ["listening", "reading"]},
        "answers": {"type": "array", "items": {"type": "object", "properties": {"n": {"type": "integer"}, "answer": {"type": "string"}}, "required": ["n", "answer"]}}},
        "required": ["test", "module", "answers"]}}}, "required": ["blocks"]},
}
PROMPTS = {"A": "Fill the JSON schema from the exam material below. Copy text exactly; do not paraphrase.",
           "B": "You are digitising an exam paper for a candidate who will never see the original. Produce the JSON schema. "
                "Check that question numbers are complete and consecutive and that every option list is present."}
GUIDE = ("Question groups: 'instructions' verbatim, 'body' = shared notes/summary/table text with each numbered gap as [[n]] "
         "(OCR shows gaps as dots or ...), 'options' = shared option list if any, each question with its number, text and own options. "
         "Lines like '[A] text' are option or paragraph letters from the page margin. "
         "Tables and forms: keep the grid — one row per line, cells separated by ' | ', the first line being the column headers "
         "(a form is a two-column table of label | value); a table title goes on its own line above.")

# ---------- units ----------
def unit_text(w, pages): return "\n".join(f"=== PDF page {n} ===\n{text(w, n)}" for n in pages)

TOKENS = [0]
VERIFY = [False]  # --verify: second (B) model run diffed against A, on top of the free validators

def run_ab(w, uid, spec, prompt_body, schema, images=()):
    res = {}
    for v in "AB" if VERIFY[0] else "A":
        f = w / "units" / f"{uid}.{v}.json"
        if not f.exists():
            ask = lambda: model_json(spec, f"{PROMPTS[v]}\n{GUIDE}\n\n{prompt_body}", schema, images)
            out = ask() or ask()   # the verbatim-text filter fires now and then on a page that reads fine on a second try
            if out is None: sys.exit(f"{uid} {v}: the model refused this page twice (content filter)")
            W(f, out); print(f"  {uid} {v}")
        res[v] = J(f)
    for g in res["A"].get("groups") or [g for p in res["A"].get("parts", []) for g in p["groups"]]:
        if not g["questions"]:  # completion groups: the [[n]] gaps in body are the questions
            g["questions"] = [{"n": int(n), "text": "", "options": []} for n in re.findall(r"\[\[(\d+)\]\]", g["body"])]
        # "Choose TWO letters": one question on the page, but both numbers are answered
        if g["type"] == "multiple_choice_multi" and [q["n"] for q in g["questions"]] != list(range(g["first"], g["last"] + 1)):
            first = g["questions"][0] if g["questions"] else {"n": g["first"], "text": "", "options": []}
            first["n"] = g["first"]
            g["questions"] = [first] + [{"n": n, "text": "", "options": []} for n in range(g["first"] + 1, g["last"] + 1)]
    W(w / "units" / f"{uid}.A.json", res["A"])
    flags = validate(res["A"]) + (compare(res["A"], res["B"]) if "B" in res else [])
    W(w / "units" / f"{uid}.diff.json", flags)
    print(f"  {uid}: {len(flags)} flag(s)")
    return res["A"]

def validate(d):
    flags = _validate(d)
    for g in (d.get("groups") or [g for p in d.get("parts", []) for g in p["groups"]]):
        keys = option_keys(g)
        have = [o["key"].lower().strip(".)") for o in g["options"]] if g.get("options") else []
        # a book can promise one letter more than it prints (Cambridge 15 T4 P3 "A-J", nine words): a consecutive run one short passes
        longer = ROMAN[:len(keys) + 1] if keys and keys[0] == "i" else [chr(ord("a") + i) for i in range(len(keys) + 1)]
        if keys and have and have != [k.lower() for k in keys] and have != [k.lower() for k in keys[:-1]] and have != longer:
            flags.append({"path": f"groups Q{g['first']}", "check": "options missing", "A": [o["key"] for o in g["options"]], "expected": keys})
    return flags

def _validate(d):
    """Free checks that catch most structuring failures: numbering gaps, gaps vs questions, missing options."""
    groups = d.get("groups") or [g for p in d.get("parts", []) for g in p["groups"]]
    flags, nums = [], []
    if "paragraphs" in d and (want := lettered(groups)) and [p["label"] for p in d["paragraphs"] if p["label"]] != want:
        flags.append({"path": "passage", "check": "paragraph letters incomplete", "A": [p["label"] for p in d["paragraphs"] if p["label"]]})
    if "paragraphs" in d and len(d["paragraphs"]) < 3:
        flags.append({"path": "passage", "check": "passage text missing", "A": len(d["paragraphs"])})
    for g in groups:
        qn = [q["n"] for q in g["questions"]]; nums += qn
        if qn != list(range(g["first"], g["last"] + 1)):
            flags.append({"path": f"group {g['first']}-{g['last']}", "check": "questions vs first/last", "A": qn})
        gaps = sorted({int(x) for x in re.findall(r"\[\[(\d+)\]\]", g["body"])})
        rows = [l for l in g["body"].split("\n") if "|" in l]
        if g["type"] in ("table_completion", "form_completion") and not rows:
            flags.append({"path": f"group {g['first']}-{g['last']}", "check": "table stored without cells", "A": g["body"][:80]})
        if len({l.count("|") for l in rows}) > 1:
            flags.append({"path": f"group {g['first']}-{g['last']}", "check": "table rows have different cell counts", "A": [l.count("|") + 1 for l in rows]})
        if g["type"].endswith("_completion") and not g["body"].strip() and not any(q["text"] for q in g["questions"]):
            flags.append({"path": f"group {g['first']}-{g['last']}", "check": "completion text missing", "A": qn})
        if gaps and gaps != qn:
            flags.append({"path": f"group {g['first']}-{g['last']}", "check": "[[n]] gaps vs questions", "A": gaps})
        if g["type"] in ("multiple_choice", "multiple_choice_multi", "matching_headings", "matching_features", "matching_sentence_endings") \
                and not g["options"] and not (all(q["options"] for q in g["questions"])
                     or (g["type"] == "multiple_choice_multi" and g["questions"] and g["questions"][0]["options"])):   # a "choose TWO" pair prints one option list
            flags.append({"path": f"group {g['first']}-{g['last']}", "check": "letter question without options", "A": g["instructions"]})
    if nums and nums != list(range(nums[0], nums[0] + len(nums))):
        flags.append({"path": "unit", "check": "question numbers not consecutive", "A": nums})
    for b in d.get("blocks", []):  # answer keys
        qn = [a["n"] for a in b["answers"]]
        if qn != list(range(qn[0], qn[0] + len(qn))) if qn else True:
            flags.append({"path": f"keys test {b['test']} {b['module']}", "check": "answer numbering", "A": qn})
    return flags

def passage_pages(w, pages):
    """[(page, passage text on it)]: everything above a page's first 'Questions N' heading. The passage can come before
    its questions (usual) or after them (Cambridge 14, Test 2 Passage 3: 'based on Reading Passage 3 on pages 47 and 48')."""
    out = []
    for n in pages:
        t = text(w, n)
        q = re.search(r"^Questions? \d", t, re.M)
        t = t[:q.start()] if q else t
        t = re.sub(r"^READING( PASSAGE \d)?\s*$", "", t, flags=re.M)
        # READING badge fragments OCR leaves on their own line ("READIN", "DING")
        t = "\n".join(l for l in t.split("\n") if not (len(l.strip()) >= 3 and l.strip() in "READING"))
        # the intro sentence, however OCR garbled its ending: from "You should spend" to the first of the next 3 lines
        # that mentions below / pages / the passage number
        lines = [re.sub(r"^\[[A-J]\]\s*(?=You should spend)", "", l) for l in t.split("\n")]
        while (i := next((k for k, l in enumerate(lines) if l.strip().startswith("You should spend")), None)) is not None:
            j = next((k for k in range(i, min(i + 4, len(lines))) if re.search(r"(?i)below|pages? \d|passage \d", lines[k])), i)
            del lines[i:j + 1]
        lines = [l for l in lines if not re.match(r"(?i)^(READING PASSAGE \d|Passage \d (below|on the following)|Test \d)\b", l.strip())]
        t = "\n".join(lines)
        if len(t.split()) > 25: out.append((n, t.strip()))
    return out

def passage_paragraphs(w, pages):
    """(title, paragraphs) from OCR. A short first line is the title; a bare letter line (a margin label OCR put on its own
    line) labels the next paragraph. Labels are only provisional here — fix_labels() checks them against the questions."""
    region = "\n".join(t for _, t in passage_pages(w, pages)).strip()
    lines = region.split("\n")
    pending = ""
    while lines and re.fullmatch(r"\[?[A-J]\]?", lines[0].strip()):
        pending = lines.pop(0).strip("[] ")
    known = known_words()
    scrap = lambda l: not re.search(r"[a-z]{3}", l) or (not any(x in known for x in re.findall(r"[a-z]{3,}", l.lower())) and not re.search(r"\b[A-Z][a-z]{4,}", l)) or len(re.findall(r"[=<>~#|]", l)) >= 2   # "- aaa cag = oo = ."
    while lines and scrap(lines[0]) and not re.fullmatch(r"[A-Z][A-Z ,'\-]{2,}", lines[0].strip()): lines.pop(0)   # watermark scrap ("FLFR : v", "obslat ube e220"), not an all-caps title
    title = "" if not lines or lines[0].startswith("[") or len(lines[0].split()) > 10 else lines[0].strip()
    while title and len(lines) > 1 and (re.fullmatch(r"\d{4}\s*[-–—]\s*\d{4}", lines[1].strip()) or (lines[1][:1].islower() and len(lines[1].split()) <= 6 and not re.search(r"[.!?]$", lines[1].strip()))):
        title += " " + lines.pop(1).strip()                                # "The Context, Meaning / and Scope of Tourism"
    if title.count("”") > title.count("“"): title = title.rstrip("”*")   # a footnote asterisk OCR'd as a closing quote
    if title and len(lines) > 2 and lines[1].strip():   # a subtitle sentence straight under the title ("What have been the trends ... systems?")
        sub = []
        for l in lines[1:4]:
            if not l.strip() or len(l.split()) > 12: break
            sub.append(l.strip())
            if re.search(r"[?]$", l.strip()): break
        if sub and re.search(r"[?]$", sub[-1]) and len(" ".join(sub).split()) <= 25:
            title += "\n" + " ".join(sub); del lines[1:1 + len(sub)]
    body = "\n".join(lines[1:] if title else lines).strip()
    paras, notes = [], []
    # question text that leaked in because OCR garbled its "Questions N" heading (Cambridge 13 Test 1 Passage 2)
    instructions = re.compile(r"(?i)answer sheet|in boxes \d+|write the correct (letter|number)|choose (the correct|no more than|one word|two words|two letters|three letters)")
    chunks = [" ".join(l.strip() for l in c.splitlines()).strip() for c in re.split(r"\n\s*\n", body)]
    # a margin label mid-chunk ("...worldwide. [B] B Farmers") is a paragraph break OCR missed on a garbled page (Cambridge 12 T2 P1)
    chunks = [part for c in chunks for part in re.split(r"\s+(?=\[([A-J])\] \1\.? [A-Z])", c)[::2]]
    # a footnote runs straight into the next page's first paragraph ("* pathogens: ... [E] 'We discovered") (Cambridge 14 T2 P2)
    chunks = [part for c in chunks for part in (re.split(r"\s+(?=\[[A-J]\]\s)", c) if c.startswith("*") else [c])]
    for chunk in chunks:
        if instructions.search(chunk): break
        if not re.search(r"[A-Za-z]{2}", chunk): continue            # lone OCR symbols ("�")
        if re.fullmatch(r"\[?[A-J]\]?", chunk):
            pending = chunk.strip("[] "); continue
        label = ""
        if m := re.match(r"^\[([A-J])\] ", chunk):
            label, chunk = m.group(1), chunk[4:]
            chunk = re.sub(rf"^{label}\.? (?=[A-Z])", "", chunk)   # "[F] F It is" — margin strip and body both caught the letter
        elif m := re.match(r"^([A-J]) (?=[A-Z‘'\"])", chunk):   # "A The automotive..." when OCR kept the letter inline
            label, chunk = m.group(1), chunk[2:]
        if pending and not label: label = pending
        pending = ""
        if not chunk: continue
        # watermark fragments inside the text (Cambridge 12): the site name in any OCR spelling, plus the short caps scrap before it
        chunk = re.sub(r"(?i)[\"'“”]?\s*(?:[A-Z]{2,8}(?: [A-Z]{1,4})?\s*:\s*)?(?:bbs|www|[a-z]{0,2})?\.?[jy]{0,2}yuce\.com\S*\s*", " ", chunk)
        chunk = re.sub(r"\s+[A-Z]{4,8}(?: [A-Z]{1,4})? : v\b\s*", " ", chunk)
        chunk = re.sub(r"(?:^|\s)[A-Za-z]{3,10}\s*:\s*(?:bbs|www)\b\.?\S*", " ", chunk)   # "FAAMCis : bbs." — the watermark with its site name cut off
        chunk = pipes_to_i(re.sub(r"\s{2,}", " ", chunk).strip())
        chunk = re.sub(r"^[A-J]_\s+", "", chunk)
        chunk = re.sub(r"^[I|l] (?=[A-Z][a-z]+ [a-z])", "", chunk)                      # a margin scrap "I By the year 2050"
        chunk = re.sub(r"(?<=[.!?\u201d\u2019\"'])\s+\d{1,3}$", "", chunk)          # the page number printed under the last line ("outlook. 43")                         # "B_ Peter Groffman": the margin letter with a stray underline
        if (m := re.search(r"[.!?\u201d\"]\s+(\S.{0,24})$", chunk)) and not re.search(r"[A-Za-z]{3}|[0-9]", m.group(1)): chunk = chunk[:m.start(1)].strip()
        if re.search(r"(?i)h[it]tps?://|www\.", chunk): continue        # a source citation under the passage (Cambridge 14)
        if not re.search(r"[a-z]{3}", chunk): continue                 # a line of OCR noise with no real word ("SEE EEE NIMES OP...")
        if not any(x in known for x in re.findall(r"[a-z]{3,}", chunk.lower())): continue   # "26 obslyel obj aoe"
        chunk = re.sub(r"(?<!\S)[{}]+(?!\S)\s*", "", chunk)                          # "80% of } the Earth's"
        if paras and not label and chunk[0].islower():   # "he suggests." — a page break split one paragraph in two
            paras[-1]["text"] += " " + chunk; continue
        if chunk.startswith("*"): notes.append({"label": "", "text": chunk}); continue   # footnote printed mid-passage; keep it after the text
        paras.append({"label": label, "text": chunk})
    return title, paras + notes

TITLE_SCHEMA = {"type": "object", "properties": {"title": {"type": "string"}, "subtitle": {"type": "string"}}, "required": ["title", "subtitle"]}
def fix_title(w, uid, data, pages, vision_spec, ocr_title):
    from difflib import SequenceMatcher
    """The title (and a subtitle line, if the scan clipped it into the first paragraph) re-read from the page image when
    a title word isn't a word ("THE FALKI", "Great Mi"). Cached per passage; one small call."""
    known = known_words()
    def clipped(line):
        words = re.findall(r"[A-Za-z]+", line)
        return bool(words) and len(words) <= 8 and len(words[-1]) >= 2 and words[-1].lower() not in known
    paras = data["paragraphs"]
    first = paras[0]["text"].split("\n")[0] if paras else ""
    sub_clipped = paras and len(first.split()) <= 5 and clipped(first) and len(paras[0]["text"].split()) > 8
    # a one- or two-word title is usually the clipped start of a longer one ("Raising the", "THE STORY"); an empty one means
    # the scan lost it altogether (Cambridge 11 T4 P2)
    # ...and a title ending in ":" or "," or with an unclosed quote continues on a line the scan cut ("Preface to 'How the other half thinks:")
    unfinished = bool(re.search(r"[:,]$", ocr_title.strip())) or ocr_title.count("\u2018") + ocr_title.count("'") + ocr_title.count("\u201c") > ocr_title.count("\u2019") + ocr_title.count("\u201d")
    short_first = bool(paras) and len(paras[0]["text"].split()) <= 25 and not re.search(r"[.!?]", paras[0]["text"][:-1])   # a subtitle read as paragraph 1
    # a subtitle glued to the front of paragraph 1 with its last word lost: "... the future of a The description of any animal"
    broken = re.search(r"^(.{20,300}?\b(?:a|an|the|of|to|and|in|for|with))\s+(?=[A-Z][a-z]+\s+[a-z])", paras[0]["text"]) if paras else None
    if ocr_title and not (clipped(ocr_title) or sub_clipped or len(ocr_title.split()) <= 2 or unfinished or short_first or broken): return
    if not ocr_title and (w / "units" / f"{uid}.title.json").exists(): pass
    cache = w / "units" / f"{uid}.title.json"
    if not cache.exists():
        n = next((n for n, _ in passage_pages(w, pages)), pages[0])
        r = model_json(vision_spec, "Return the title of the reading passage on this page exactly as printed, and its subtitle "
                       "(the line under the title, if any; else empty). Nothing else.", TITLE_SCHEMA, images=[w / "pages" / f"p{n:03d}.png"])
        W(cache, r or {"title": "", "subtitle": ""}); print(f"  {uid} title re-read from page image")
    r = J(cache)
    if not r.get("title"): return
    data["title"] = r["title"].strip()
    sub = r.get("subtitle", "").strip()
    if sub and paras:
        # the subtitle (or all but its last word, which the scan lost) printed at the head of paragraph 1: cut exactly that
        text0 = paras[0]["text"]
        pos = [k for k, ch in enumerate(text0) if ch.isalnum()]
        stream = "".join(text0[k].lower() for k in pos)
        full = letters(sub)
        short = letters(" ".join(sub.split()[:-1]))
        for key in (full, short):
            if len(key) >= 20 and len(stream) > len(key) + 20 and sum(a != b for a, b in zip(stream[:len(key)], key)) <= max(2, len(key) // 25):
                paras[0]["text"] = text0[pos[len(key) - 1] + 1:].lstrip(" .,;:!?\u2019'\"").strip()
                if not data["title"].endswith(sub): data["title"] = r["title"].strip() + "\n" + sub
                return
        # clipped subtitle words at the head of paragraph 1, cut off at the column edge and in any order ("Step A millennium
        # ago, stepwells wer parts of India. Richard Cox tra document these spectacular During the sixth ..."): drop the
        # longest head of the paragraph whose words are subtitle/title words or their clipped starts
        skeys = [letters(x) for x in (r["title"] + " " + sub).split() if letters(x)]
        toks = text0.split()
        frag = lambda x: (k := letters(x)) and (k in skeys or (len(k) >= 2 and any(sk.startswith(k) for sk in skeys)))
        cut = 0
        for i_ in range(min(len(toks), 60)):
            if frag(toks[i_]): cut = i_ + 1
            elif i_ + 1 - sum(bool(frag(x)) for x in toks[:i_ + 1]) > 1: break         # two body words: the paragraph proper
        if cut >= 6 and sum(len(letters(x)) for x in toks[:cut]) >= len(full) * 0.35:
            rest = " ".join(toks[cut:]).lstrip(": ").strip()
            if rest[:1].isupper():
                paras[0]["text"] = rest
                if not data["title"].endswith(sub): data["title"] = r["title"].strip() + "\n" + sub
                return
        if len(full) >= 40:
            head = stream[:int(len(full) * 1.2) + 10]
            sm = SequenceMatcher(None, full, head, autojunk=False)
            blocks = [b_ for b_ in sm.get_matching_blocks() if b_.size >= 4]
            covered = sum(b_.size for b_ in blocks)
            if blocks and covered >= len(full) * 0.45 and len(blocks) >= 3 and blocks[0].b <= 12:
                end = blocks[-1].b + blocks[-1].size                                  # letters of the paragraph the subtitle covers
                cut = pos[end - 1] + 1
                nxt = re.search(r"\s+(?=[A-Z])", text0[cut:])                        # the body starts at the next capitalised word
                if nxt and nxt.start() <= 20:
                    paras[0]["text"] = text0[cut + nxt.end():].strip()
                    if not data["title"].endswith(sub): data["title"] = r["title"].strip() + "\n" + sub
                    return
    if sub and paras and len(paras[0]["text"].split()) <= 25 and letters(sub)[:10] in letters(paras[0]["text"]) or (sub and short_first and SequenceMatcher(None, letters(sub), letters(paras[0]["text"])).ratio() > 0.6):
        data["title"] += "\n" + sub; paras.pop(0); return                      # the subtitle was read as a paragraph of its own
    if sub_clipped:   # the clipped subtitle sits at the head of paragraph 1: replace it, or drop it if the image has none
        rest = paras[0]["text"][len(first):].strip()
        paras[0]["text"] = (r["subtitle"].strip() + "\n" + rest).strip() if r.get("subtitle") else rest
    elif r.get("subtitle") and letters(r["subtitle"])[:12] not in letters(paras[0]["text"] if paras else ""):
        data["title"] += "\n" + r["subtitle"].strip()

def lettered(groups):
    """Letters the questions say the passage has ('seven paragraphs, A-G' / 'eight sections, A-H'), else []."""
    inst = " ".join(g["instructions"] + " " + g["body"] for g in groups)
    m = re.search(r"(?:paragraphs|sections)[,\s]*A\s*[-–—]\s*([B-L])\b", inst)
    return [chr(c) for c in range(ord("A"), ord(m.group(1)) + 1)] if m else []

LABELS_SCHEMA = {"type": "object", "properties": {"labels": {"type": "array", "items": {"type": "object", "properties": {
    "label": {"type": "string"}, "opening": {"type": "string"}}, "required": ["label", "opening"]}}}, "required": ["labels"]}

def fix_labels(w, uid, data, pages, vision_spec):
    """Paragraph letters from OCR's margin strip are unreliable (missed, or noise from nearby text). The questions say
    which letters must exist: unlettered passage -> clear all; exact A..X sequence found -> keep; otherwise read each
    letter's opening words from the page images and attach it to the paragraph that starts that way (splitting a
    paragraph OCR merged). Cached per passage."""
    want, paras = lettered(data["groups"]), data["paragraphs"]
    if not want:
        for p in paras: p["label"] = ""
        return
    if [p["label"] for p in paras if p["label"]] == want: return
    cache = w / "units" / f"{uid}.labels.json"
    if not cache.exists():
        imgs = [w / "pages" / f"p{n:03d}.png" for n, _ in passage_pages(w, pages)]
        prompt = (f"The image(s) show a reading passage whose paragraphs or sections are lettered {want[0]}–{want[-1]} in the margin. "
                  "For each letter, return the letter and the first eight words of that lettered paragraph/section exactly as printed.")
        W(cache, model_json(vision_spec, prompt, LABELS_SCHEMA, images=imgs))
        print(f"  {uid} paragraph letters read from page images")
    for p in paras: p["label"] = ""
    # OCR reads a capital I as T, | or l ("T have suggested", "colleagues and | at"): treat those as one letter when matching
    ocr_word = lambda w: "[ITl|1]" if w in ("I", "T", "l", "|", "1") else re.escape(w)
    for L in J(cache)["labels"]:
        all_words = re.findall(r"[A-Za-z0-9]+", L["opening"])
        if not all_words or L["label"] not in want: continue
        found = False
        # eight words before five: a subtitle can open with the same five words as paragraph A (Cambridge 13 T4 P2)
        hit = None
        for count in (8, 5):
            pat = re.compile(r"\W+".join(map(ocr_word, all_words[:count])), re.I)
            hit = next(((i, m) for i, p in enumerate(paras) if (m := pat.search(p["text"]))), None)
            if hit: break
        for i, m in [hit] if hit else []:
            p = paras[i]
            if m.start() > 0:   # the lettered paragraph was merged into this chunk: split it off
                paras.insert(i + 1, {"label": "", "text": p["text"][m.start():]}); p["text"] = p["text"][:m.start()].strip(); i += 1
            paras[i]["label"] = L["label"]; found = True
            break
        if not found:   # OCR typos ("Ve all know", "Aresearch team", "T have"): letters-only search allowing 2 wrong letters
            key = re.sub(r"[^a-z0-9]", "", L["opening"].lower())[:24]
            best = None
            for i, p in enumerate(paras):
                pos = [k for k, ch in enumerate(p["text"]) if ch.isalnum()]
                stream = "".join(p["text"][k].lower() for k in pos)
                for s in range(len(stream) - len(key) + 1) if len(key) >= 12 else ():
                    miss = sum(a != b for a, b in zip(stream[s:s + len(key)], key))
                    if miss <= 2 and (best is None or miss < best[0]) and not (s == 0 and p["label"]): best = (miss, i, pos[s])
                    if best and best[0] == 0: break
            if best:
                _, i, at = best
                p = paras[i]
                at = p["text"].rfind(" ", 0, at) + 1          # start of the word the match begins in
                if at > 0:
                    paras.insert(i + 1, {"label": "", "text": p["text"][at:]}); p["text"] = p["text"][:at].strip(); i += 1
                paras[i]["label"] = L["label"]
    # an unlabelled paragraph between A and C is B: its opening was too garbled to match (Cambridge 12 T2 P1, T3 P2)
    for i in range(1, len(paras) - 1):
        x, y = paras[i - 1]["label"], paras[i + 1]["label"]
        if not paras[i]["label"] and x and y and ord(y) - ord(x) == 2: paras[i]["label"] = chr(ord(x) + 1)
    strip_letters(paras)

def final_clean(paras):
    """After the image re-reads: a watermark the model copied from the page ("lela! obj apse www.irLanguage.com") with the
    scrap words before it, and any paragraph left without a real word ("26 obslyel obj aoe")."""
    known = known_words()
    for p in paras:
        toks = p["text"].split()
        while True:
            k = next((i for i, x in enumerate(toks) if re.search(r"(?i)www\.?\w+\.(com|net|org)|yuce\.com|\w*(guage|lang\w*)\.com", x)), None)
            if k is None: break
            j = k
            while j > 0 and not any(y in known for y in re.findall(r"[a-z]{3,}", toks[j - 1].lower())) and not re.search(r"[.!?]$", toks[j - 1]): j -= 1
            del toks[j:k + 1]
        # scraps after the last sentence ("...contraption? lela! obj apse"): up to 4 lower-case tokens, one of them no word
        if (m := re.search(r"[.!?”\"']\s+((?:[a-z][a-z!]*\s*){1,4})$", " ".join(toks))) and any(re.sub(r"\W", "", x) not in known for x in m.group(1).split()):
            toks = " ".join(toks)[:m.start(1)].split()
        p["text"] = " ".join(toks)
        # a lone lower-case letter between words is the edge of the other column or a margin mark ("Mona t Lisa", "spectacular m During")
        p["text"] = re.sub(r"(?<=\S) [b-hj-z](?= \S)", "", p["text"])
        p["text"] = re.sub(r" _{2,}(?= )", "", p["text"])
    def real(p):   # a short paragraph made mostly of non-words is a scrap ("26 obslyel obj aoe")
        words = re.findall(r"[A-Za-z]+", p["text"])
        unknown = [x for x in words if x.lower() not in known and not x[0].isupper()]
        return words and not (len(words) <= 6 and len(unknown) * 2 >= len(words))
    paras[:] = [p for p in paras if real(p)]

def strip_letters(paras):
    """Splitting leaves the printed letter behind: "... top layer B_" / a lone "C" chunk / "A More than..." duplicates.
    Footnotes ("* photosynthesis: ...") go last: a letter split can leave a paragraph after one (Cambridge 10 T2 P1 "E")."""
    paras.sort(key=lambda p: p["text"].lstrip().startswith("*"))
    # lettered paragraphs out of order (E found inside a footnote and split off after G): put each lettered paragraph, with
    # the unlettered ones that follow it, back in letter order
    body = [p for p in paras if not p["text"].lstrip().startswith("*")]
    labels = [p["label"] for p in body if p["label"]]
    if labels != sorted(labels):
        head, blocks = [], []
        for p in body:
            if p["label"]: blocks.append([p])
            elif blocks: blocks[-1].append(p)
            else: head.append(p)
        blocks.sort(key=lambda b: b[0]["label"])
        paras[:] = head + [p for b in blocks for p in b] + [p for p in paras if p["text"].lstrip().startswith("*")]
    for p in paras:
        p["text"] = re.sub(r"\s+\[?[A-L]\]?_?$", "", p["text"]).strip()
        if p["label"] and re.match(rf"\[?{p['label']}\]?[_ ]+\S", p["text"]): p["text"] = re.sub(r"^\[?[A-L]\]?[_ ]+", "", p["text"])
    paras[:] = [p for p in paras if re.search(r"[A-Za-z]{2}", p["text"])]

def writing_task(w, pages, task):
    t = text(w, pages[0])
    t = t[h.end():] if (h := re.search(rf"WRITING TASK {task}", t)) else t        # drop the badge/header lines above the task
    t = re.sub(r"^\[[A-J]\] ", "", t, flags=re.M)                                # margin-letter noise from ocr.py
    t = re.sub(r"(?m)^.{0,6}should spend about", "You should spend about", t)     # "‘feu should spend", "Se should spend"
    t = re.sub(r"(?m)^\s*\S{1,2}\s*$\n?", "", t)                                  # stray 1–2 character OCR lines ("j")
    t = re.sub(r"(?im)^(Write\s*at\s*least\s+\d+)\b(?!\s+words)[^\n]*$", r"\1 words.", t)   # "Write at least 250 FY Pil vl AK" (watermark over the last word)
    m = re.search(r"(?is)^(.*?at\s+least\s+\d+\s+words\.?)", t)                   # prompt ends at "Write at least N words."
    if not m: m = re.search(r"(?is)^(.*?(?:where relevant|your own knowledge or experience)\.)", t)   # ...or its last fixed sentence
    prompt = (m.group(1) if m else t).strip()
    prompt = re.sub(r"(?m)^(?=.*(?:yuce\.com|:\s*bbs\b)).*$\n?", "", prompt)   # watermark line (Cambridge 12)
    # figure-edge debris lines ("Lo _ _ __ _"): no word of 3+ letters on the line
    known = known_words()
    prompt = "\n".join(l for l in prompt.split("\n") if not l.strip() or (re.search(r"[A-Za-z]{3}", l) and any(x in known for x in re.findall(r"[a-z]{3,}", l.lower())))).strip()
    prompt = "\n".join(re.sub(r"(\s+[a-z]{1,12}){1,4}$", lambda m: "" if all(x not in known and x not in SHORT for x in m.group(0).split()) else m.group(0), l) for l in prompt.split("\n"))
    prompt = re.sub(r"(?i)\bat\s*least\b", "at least", prompt)                   # "atleast"
    prompt = re.sub(r"\bW(?:irte|rtie|ite)\b", "Write", prompt)                  # "Wirte at least 150 words" (Cambridge 13 T1)
    return {"task": task, "prompt": prompt, "figure_pdf_page": pages[0] if task == 1 else 0}

SCRIPT_ALL_PAGES = [False]
def script_page(w, n):
    """One audioscript page. Some scans print the speaker names as a column of their own (Cambridge 13-15): Tesseract then
    reads all the names first ("OFFICIAL:\nWOMAN:\n...") and the dialogue after, and a stain can split a printed line into
    pieces. Such a page is rebuilt from positions: Tesseract's line pieces that sit at the same height (following each
    piece's own tilt, the scans curve) are joined left to right, the name column is read again on its own, enlarged,
    and each name joins the line it sits beside."""
    t = text(w, n)
    if len(re.findall(r"(?m)^[A-Z]{2,14}:?\s*$", t)) < 4 and not SCRIPT_ALL_PAGES[0]: return t
    cache = w / "ocr" / f"p{n:03d}.speakers.txt"
    if cache.exists(): return cache.read_text(encoding="utf-8")
    from PIL import Image
    png = w / "pages" / f"p{n:03d}.png"
    pieces = {}
    for r in ocr.tsv(png, 3):
        pieces.setdefault((r[2], r[3], r[4]), []).append(dict(left=int(r[6]), right=int(r[6]) + int(r[8]), y=int(r[7]) + int(r[9]) / 2, h=int(r[9]), word=r[11]))
    pieces = list(pieces.values())
    height = sorted(x["h"] for p in pieces for x in p)[len([x for p in pieces for x in p]) // 2]
    # a piece with a wide hole in it has another piece's words belonging in the hole ("Feedback fro ... helmingly" around
    # "im staff has been overwi"): split it there so the two can interleave
    split = []
    for pc in pieces:
        cur = [pc[0]]
        for x in pc[1:]:
            if x["left"] - cur[-1]["right"] > height * 2.5: split.append(cur); cur = []
            cur.append(x)
        split.append(cur)
    pieces = split
    name = re.compile(r"(?!SECT|PART|AUDI)[A-Z]{2,14}[^\w\s]?")
    def fit(ws, tilt=0.0):   # the piece's mid-line height at any x
        mx = sum((x["left"] + x["right"]) / 2 for x in ws) / len(ws); my = sum(x["y"] for x in ws) / len(ws)
        spread = ws[-1]["right"] - ws[0]["left"]
        if spread > 150:
            var = sum(((x["left"] + x["right"]) / 2 - mx) ** 2 for x in ws)
            tilt = sum(((x["left"] + x["right"]) / 2 - mx) * (x["y"] - my) for x in ws) / var if var else tilt
        return lambda x: my + tilt * (x - mx)
    from collections import Counter
    body_left = Counter(p[0]["left"] // 10 * 10 for p in pieces if len(p) >= 4).most_common(1)[0][0]
    in_column = lambda p: len(p) == 1 and name.fullmatch(p[0]["word"]) and p[0]["right"] < body_left   # "OK." in the text is not a name
    labels = [(p[0]["left"], p[0]["y"], p[0]["word"]) for p in pieces if in_column(p)]
    body = [p for p in pieces if not in_column(p)]
    # the name column again, on its own at twice the size: Tesseract misses small names beside a busy text column
    strip = w / "ocr" / f"p{n:03d}.names.png"
    im = Image.open(png); im.crop((0, 0, max(body_left - 6, 10), im.height)).resize((max(body_left - 6, 10) * 2, im.height * 2)).save(strip)
    for r in ocr.tsv(strip, 6) + ocr.tsv(strip, 11):
        y = (int(r[7]) + int(r[9]) / 2) / 2
        if name.fullmatch(r[11]) and not any(abs(y - l[1]) < height * 0.6 for l in labels): labels.append((int(r[6]) // 2, y, r[11]))
    strip.unlink(missing_ok=True)
    if len(labels) < 3: labels = []                      # a page without a name column: the strip only caught heading scraps ("SEC")
    # join pieces into printed lines: widest first, a piece joins a line at its height that it doesn't overlap
    lines = []
    for p in sorted(body, key=lambda p: -(p[-1]["right"] - p[0]["left"])):
        f = fit(p)
        for line in lines:
            if abs(line["fit"](p[0]["left"]) - f(p[0]["left"])) < height * 0.5 and all(p[0]["left"] >= q[-1]["right"] - 4 or p[-1]["right"] <= q[0]["left"] + 4 for q in line["pieces"]):
                line["pieces"].append(p); break
        else:
            lines.append({"fit": f, "pieces": [p], "label": None})
    lines.sort(key=lambda l: l["fit"](body_left))
    # a name sits beside the first line of its turn, its middle level with that line or slightly above it
    for x, y, word in sorted(labels, key=lambda l: l[1]):
        heading = lambda l: re.match(r"(SECTION|PART|Audioscripts)\b", min(l["pieces"], key=lambda p: p[0]["left"])[0]["word"])
        near = [(abs(l["fit"](body_left) - y - height * 0.2), l) for l in lines if l["fit"](body_left) > y - height * 0.8 and l["label"] is None and not heading(l)]
        if near and (best := min(near, key=lambda z: z[0]))[0] < height * 1.2: best[1]["label"] = re.sub(r"\W", "", word) + ":"
    out = []
    for l in lines:
        s_ = " ".join(x["word"] for p in sorted(l["pieces"], key=lambda p: p[0]["left"]) for x in p)
        if NOISE.search(s_) or HEADER.match(s_): continue
        if l["label"] and re.match(r"[A-Za-z]{2,14}[:;]\s", s_): s_ = s_.split(None, 1)[1] if len(s_.split(None, 1)) > 1 else ""   # the name was read in the text too
        out.append((l["label"] + " " if l["label"] else "") + re.sub(r"^[_=|\-]+\s*", "", s_))
    page = "\n".join(out)
    cache.write_text(page, encoding="utf-8")
    return page

def transcripts(w, m):
    """Audioscripts: split at PART/SECTION headings; a new test starts at each Part/Section 1. (Not 'every 4 parts':
    a heading OCR loses — or a page missing from the scan, Cambridge 13 Test 3 Section 2 — would shift every later test.)"""
    a, b = m["audioscripts"]
    t = "\n".join(script_page(w, n) for n in range(a, b + 1))
    t = re.sub(r"^Audioscripts\n", "", t, flags=re.M)
    t = re.sub(r"(?m)^(Example|[Qa][0-9sgiIloO]{1,2})\s*$\n?", "", t)       # margin markers: "Example", "Q1", OCR'd "Qi", "a4", "Qg"
    t = re.sub(r"(?m)^\[[A-J]\] ", "", t)                                     # margin-letter noise from ocr.py
    t = re.sub(r"(?m)^(PART|SECTION) (\d)\b[^\n]*$", r"\1 \2", t)              # heading with OCR debris after it: "SECTION 2 ' : | Je»"
    # a heading OCR lost entirely: the script restarts at "Example" with a new Q1 (a Part/Section 1 with a stained banner,
    # Cambridge 12 Test 4) — insert the heading where the first line of a fresh dialogue appears after Q40
    def restart(mm):   # only when no heading already sits between Q40 and the new dialogue
        return mm.group(0) if re.search(r"(?m)^(PART|SECTION) \d$", mm.group(1)) else mm.group(1) + "SECTION 1\n"
    t = re.sub(r"(?m)((?:Q40|Q4O)\b[^\n]*\n(?:[^\n]*\n){0,6}?)(?=[A-Z][A-Z ]{1,14}: )", restart, t)
    pieces = re.split(r"^(?:PART|SECTION) (\d)\s*$", t, flags=re.M)[1:]
    tests = []
    for i in range(0, len(pieces), 2):
        part = {"part": int(pieces[i]), "text": clean_script(pieces[i + 1].strip())}
        if part["part"] == 1 or not tests: tests.append([])
        tests[-1].append(part)
    return {str(i + 1): parts for i, parts in enumerate(tests)}

# real one- and two-letter words; any other short scrap ("aa", "ee", "oe") is debris even though OCR repeats it
SHORT = set("a i am an as at be by do go he hi if in is it me my no of oh ok on or so to up us we er um mm uh ah eh ha tv uk pm ex ms mr dr st id ll re ve ad bc cv mc".split())
FILLERS = {"um", "er", "erm", "mm", "uh", "oh", "ah", "hmm", "uhuh", "dunno"}
ABBREV = {"etc", "approx", "al", "vs", "mr", "mrs", "ms", "dr", "st", "no", "eg", "ie"}
KNOWN = [None]

def pipes_to_i(t):
    """Tesseract reads a capital I as | (or ! before an apostrophe): "How can | help", "|'m", "!'d", "|was", "but| must"."""
    t = re.sub(r"(?<!\S)[|!\\](?=\s|['’]\w)", "I", t)
    t = re.sub(r"(?<![\S])([\"'‘“(]?)\|(?=[\s,.]|$)", r"\1I", t)
    t = re.sub(r"(?<!\S)\|(?=[tfn]\b)", "I", t)                                   # "|t seems", "|f", "|n"
    t = re.sub(r"(?<=[a-z.])\|(?=\s)", " I", t)                                   # "but| must", "Street.| was"
    return re.sub(r"(?<!\S)\|(?=[a-z]{2,})", "I ", t)

def clean_script(t):
    """OCR debris every scanned audioscript has, fixed by rule (free)."""
    t = re.sub(r"(?<=\w)[?\u2019']\s+['\u2019](s|ll|re|ve|d|m)\b", r"'\1", t)          # "There? 's just" -> "There's just"
    t = re.sub(r"(?m)^~\s*", "", t)
    t = re.sub(r"\s*~\s*", " \u2013 ", t)                                              # "competitive ~ there's" (a dash)
    t = re.sub(r"(?<![\w'’])['’](m|ll|l|d|ve)\b", lambda m: "I'" + ("ll" if m.group(1) == "l" else m.group(1)), t)   # "'m not sure" -> "I'm"
    t = re.sub(r"(?m)\s+[;:,]\s+[a-z]{1,2}\s*$", "", t)                              # "...I'd like to ; om" (a stain at the line end)
    t = re.sub(r"(?m)^.*(?:yuce\.com|:\s*bbs\b).*$\n?", "", t)                      # the watermark line (Cambridge 12)
    t = pipes_to_i(t)
    t = re.sub(r"(?<!\S)[lI]am\b", "I am", t)                                     # "lam, yes"
    t = re.sub(r"(?m)[ \t]+@?(?:Q\s?[0-9OSilg]{1,2}\??|Example)[ \t]*$", "", t)    # margin markers at a line end: "... pleased Q77"
    t = re.sub(r"(?<=\w)_(?=\w)", " ", t)                                          # "wasn't_known"
    t = re.sub(r"(?<=\S)_+(?=\s|$)|(?<!\S)[_>]+(?=\w)", "", t)                     # "an_", "construct _a bridge", ">this"
    t = re.sub(r"(?m)^[-–—_= \t]+(?=[A-Za-z])", "", t)                   # "- NATALIE:", "_ It's"
    t = re.sub(r"(?m)^([A-Za-z]{2,14}:[ \t]+)[_=|\-]+[ \t]*", r"\1", t)            # "TRUDIE: _No idea"
    return t

def edit_distance(a, b):
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1]

ROLES = set("WOMAN MAN TUTOR OFFICIAL EMPLOYEE STUDENT LECTURER PRESENTER INTERVIEWER CUSTOMER RECEPTIONIST ASSISTANT CLERK "
             "GIRL BOY TEACHER MANAGER GUIDE AGENT OFFICER SECRETARY DOCTOR CALLER VISITOR".split())

def speakers(t):
    """Speaker names made consistent within a part, each at the start of its turn:
    - junk before a name goes ("?CAROL:", "?oFFiciaL:"), a name alone on its line joins its dialogue ("GREG:" / "ALICE");
    - two- and three-word names stay one label ("TRAVEL AGENT:", "TC EMPLOYEE:"), joined with "_" inside the pipeline
      (unjoin_names() restores the space);
    - a misread ("ROCER", "COUN", "METANE", "AUICE", "USA", "?ack;") becomes the closest name the part really uses: a name
      that is a word/name in the dictionary or the dialogue ("Roger", "Colin") and is used more often wins."""
    from collections import Counter
    common = common_words()
    W1 = r"[A-Za-z]{2,14}"
    # a name alone on its line: "GREG:" / "RUSS:" / "ALICE" followed by the dialogue on the next line
    t = re.sub(r"(?m)^[^A-Za-z\n]{0,3}([A-Z]{2,14}(?: [A-Z]{2,14}){0,2})[ \t]*[:;]?[ \t]*\n+(?=[A-Za-z\"'\u2018\u201c(])", lambda m: m.group(1) + ": ", t)
    t = re.sub(r"(?m)^([A-Z]{2,14}(?: [A-Z]{2,14}){0,2}):[ \t]*[^A-Za-z\n]{0,3}([A-Z]{2,14}(?: [A-Z]{2,14}){0,2}):",
               lambda m: m.group(2) + ":" if m.group(2).startswith(m.group(1)) or m.group(1).startswith(m.group(2)) else m.group(0), t)
    head = re.compile(r"(?m)^[^A-Za-z\n]{0,3}(" + W1 + r"(?: " + W1 + r"){0,2})[ \t]?([:;])[ \t]*(?=\S)")
    said = {x.upper() for x in re.findall(r"\b[A-Z][a-z]{1,13}\b", t)} | ROLES
    strong = Counter()
    for m in head.finditer(t):
        name = m.group(1)
        if name.isupper() or (sum(c.isupper() for c in name) >= 2 and not re.search(r"[a-z]{3}", name.replace(" ", ""))) \
                or (m.group(2) == ":" and name.upper() in said and " " not in name):     # "woman:" is WOMAN
            strong[name.upper()] += 1
    real = lambda n: all(w in said or w.lower() in common for w in n.split())
    score = lambda n: strong[n] + (100 if real(n) else 0)
    names = sorted(strong, key=lambda n: -score(n))
    squash = lambda n: n.replace(" ", "")
    shapes = lambda n: {squash(n), squash(n).replace("LI", "U"), squash(n).replace("RN", "M"), squash(n).replace("CL", "D"), squash(n).replace("M", "RN")}
    def closest(up):
        best = None
        for n in names:
            if n == up: continue
            d = edit_distance(squash(up), squash(n))
            limit = 0 if squash(up) == squash(n) else (1 if len(squash(n)) <= 4 and strong[up] * 3 > strong[n] else 2)
            if all(w_ in said for w_ in up.split()) and all(w_ in said for w_ in n.split()): continue   # WOMAN and MAN, TIM and TOM are two people
            if d <= limit and score(n) > score(up) and not (real(up) and strong[up] * 2 > strong[n]):
                if best is None or (d, -score(n)) < best[0]: best = ((d, -score(n)), n)
        return best[1] if best else None
    def fix(m):
        name, sep = m.group(1), m.group(2)
        up = name.upper()
        looks_label = name.isupper() or sum(c.isupper() for c in name) >= 2 or (m.group(0)[:1] not in "" and not m.group(0)[0].isalpha()) \
                      or (sep == ":" and up in said and " " not in name)
        shaped = next((n for n in names if up in shapes(n) and up != n), None) or \
                 (next((n for n in names if len(up) == 2 and len(n) == 3 and up[-1] == n[-1] and strong[n] >= 3 and sep == ":"), None))
        if shaped: return shaped.replace(" ", "_") + ": "                        # "usa:" -> LISA
        if not looks_label and up not in strong:
            from difflib import SequenceMatcher
            near = max(names, key=lambda n: SequenceMatcher(None, squash(up), squash(n)).ratio(), default=None)
            if near and " " not in name and SequenceMatcher(None, squash(up), squash(near)).ratio() >= 0.7 and len(up) >= 3 \
                    and not (up.lower() in common and SequenceMatcher(None, up, near).ratio() < 0.75):
                return near.replace(" ", "_") + ": "                               # "caroune:" -> CAROLINE
            return m.group(0)                                                        # "equipment; we're ..." is text
        target = closest(up) or (up if up in strong or looks_label else None)
        if target and target not in names and names:                               # a one-off label ("CAROUE") close to a real name
            from difflib import SequenceMatcher
            near = max(names, key=lambda n: SequenceMatcher(None, squash(target), squash(n)).ratio())
            if SequenceMatcher(None, squash(target), squash(near)).ratio() >= 0.7 and strong[target] <= 2 and not all(w_ in said for w_ in target.split()):
                target = near
        if target is None: return m.group(0)
        return target.replace(" ", "_") + ": "
    t = head.sub(fix, t)
    # a name the part uses, at a line's start, with its colon misread or lost ("SAM) Good morning", "SAM! Which", "SAM Right.")
    if names:
        alts = "|".join(sorted((re.escape(n) for n in names), key=len, reverse=True))
        from difflib import SequenceMatcher
        out, prev = [], ""
        for line in t.split("\n"):
            # only where a turn can start: after a blank line or a line that ends a sentence, or anywhere for a name in capitals
            # ("CARL! Yeah", "CARL. That's", "R08: Well") since dialogue text doesn't open a line with a speaker's name in capitals
            caps = re.match(r"^[^A-Za-z\n]{0,3}([A-Z0-9][A-Z0-9.]{1,13})(?:[)!|.,?;:]\s*|\s+)(?=[^A-Za-z\n]{0,3}[A-Z\"'\u2018\u201c(])", line)
            if caps:
                cand = caps.group(1).translate(str.maketrans("0158", "OISS")).replace(".", "")
                hit = next((n for n in names if squash(n) == cand), None)
                if hit: line = hit.replace(" ", "_") + ": " + re.sub(r"^[^A-Za-z\"'\u2018\u201c(]{0,3}", "", line[caps.end():]); out.append(line); prev = line; continue
            m3 = re.match(r"^[^A-Za-z\n]{0,3}([a-z][a-z.]{2,13}):\s*(?=\S)", line)      # "me.anie: Oh, hello"
            if m3 and "." in m3.group(1):
                cand = m3.group(1).replace(".", "l").upper()
                near = max(names, key=lambda n: SequenceMatcher(None, cand, squash(n)).ratio())
                if SequenceMatcher(None, cand, squash(near)).ratio() >= 0.75: line = near.replace(" ", "_") + ": " + line[m3.end():]; out.append(line); prev = line; continue
            if not prev.strip() or re.search(r"[.?!\u2019\"')]\s*$", prev):
                m = re.match(r"^[^A-Za-z\n]{0,3}(" + alts + r")(?:[)!|.,?;:]\s*|\s+)(?=[A-Z\"'\u2018\u201c(])", line, re.I)
                if m and (m.group(1).isupper() or sum(c.isupper() for c in m.group(1)) >= 2 or m.group(1)[:1].isupper() and m.group(1)[1:].islower() and re.match(r"[^A-Za-z]*" + re.escape(m.group(1)) + r"\s+[A-Z]", line)
                          or re.match(r"[^A-Za-z]*" + re.escape(m.group(1)) + r"[?.,;:)!]", line)):
                    line = m.group(1).upper().replace(" ", "_") + ": " + line[m.end():]
                else:
                    # a misread name ("AMBEE Do", "usa? Yeah", "sue. And") close to one of the part's names
                    m2 = re.match(r"^[^A-Za-z\n]{0,3}([A-Za-z]{2,14})(?:[?.,;:)!\u2019]\s*|\s+)(?=[A-Z\"'\u2018\u201c(])", line)
                    shaped = next((n for n in names if m2 and m2.group(1).upper() in shapes(n)), None) if m2 else None
                    if shaped and re.match(r"[^A-Za-z]*[A-Za-z]+[?.,;:)!\u2019]", line):
                        line = shaped.replace(" ", "_") + ": " + line[m2.end():]
                    elif m2 and (m2.group(1).isupper() or re.match(r"[^A-Za-z]*[A-Za-z]+[?.,;:)!]", line)):
                        near = max(names, key=lambda n: SequenceMatcher(None, m2.group(1).upper(), squash(n)).ratio())
                        if SequenceMatcher(None, m2.group(1).upper(), squash(near)).ratio() >= 0.75 and m2.group(1).upper() not in ("OK", "YES", "NO", "WELL", "RIGHT", "SO", "OH"):
                            line = near.replace(" ", "_") + ": " + line[m2.end():]
            out.append(line); prev = line
        t = "\n".join(out)
        # two labels in a row (a label column read twice): the one next to the words is the turn's
        t = re.sub(r"(?m)^[A-Z][A-Z_]{1,30}:[ \t]*[^A-Za-z0-9\n]{0,3}(?=[A-Za-z0-9]{2,14}:)", "", t)
        t = head.sub(fix, t)
    return t

def unjoin_names(t):
    """ "TRAVEL_AGENT:" -> "TRAVEL AGENT:" once the pipeline's word-level passes are done."""
    return re.sub(r"(?m)^([A-Z]+(?:_[A-Z]+)+):", lambda m: m.group(1).replace("_", " ") + ":", t)

def stray_stops(t, heard=""):
    """A full stop before a lower-case word is OCR debris ("the evening. and only", "our case. study"). The recording says
    whether a comma belongs there; with no recording, a comma is the likelier reading."""
    def fix(m):
        a, b = m.group(1), m.group(2)
        if a in ABBREV: return m.group(0)
        h = re.search(rf"(?i)\b{re.escape(a)}([,.;]?) {re.escape(b)}\b", heard)
        stop = h.group(1) if h else ","
        return a + stop + " " + (b.capitalize() if stop == "." else b)
    return re.sub(r"\b([a-z]{2,})\. ([a-z]+)", fix, t)

def known_words():
    """The English words the corpus has: words that occur 12+ times across every book's OCR (real words repeat, debris
    doesn't), every word Tesseract read with high confidence anywhere (it checks its own dictionary), and every word
    Whisper transcribed. Cached in work/known_words.json; a new book's pages are added to it when they are OCR'd."""
    if KNOWN[0] is None:
        f = ROOT / "work" / "known_words.json"
        pages = sorted(str(x.relative_to(ROOT)) for x in (ROOT / "work").glob("cam*/ocr/p*.txt"))
        cache = J(f) if f.exists() else {"pages": [], "words": []}
        words = set(cache["words"])
        if cache["pages"] != pages or cache.get("en_50k") != 3:
            if cache.get("en_50k") != 3: words, cache["pages"] = set(), []      # the recipe changed: rebuild from nothing
            from collections import Counter
            c = Counter()
            for x in (ROOT / "work").glob("cam*/ocr/p*.txt"): c.update(re.findall(r"[a-z]+", x.read_text(encoding="utf-8").lower()))
            words |= {x for x, n in c.items() if n >= 12}      # a misread that recurs a few times ("wouid") must not count as a word
            done = set(cache["pages"])
            for pg in pages:
                if pg in done: continue
                png = ROOT / pg.replace("ocr", "pages").replace(".txt", ".png")
                if png.exists(): words |= {r[11].lower() for r in ocr.tsv(png, 3) if float(r[10]) >= 88 and re.fullmatch(r"[A-Za-z]{2,}", r[11])}
            for x in (ROOT / "work").glob("cam*/units/*.whisper.json"): words |= set(re.findall(r"[a-z]+", J(x)["text"].lower()))
            # ...plus the 50,000 commonest English words (hermitdave/FrequencyWords, OpenSubtitles 2018), so a rare but real
            # word in a passage ("hectares", "droughts") is never taken for a scrap
            words |= common_words()
            W(f, {"pages": pages, "en_50k": 3, "words": sorted(words)})
        KNOWN[0] = words
    return KNOWN[0]

# the recording's own announcements, never part of the printed script
announcer = lambda words: bool(re.search(r"(?i)questions? \S+ (to|and) \S+|you now have|now,? listen|that is the end of|you will hear|now we shall begin|published by", " ".join(words)))

def repair_scripts(book, w, tr):
    """Garbled audioscript lines (watermark or stain under the text: "led gh er Pllc Ale Rbnek") are rewritten from the
    book's own recording, transcribed by local Whisper (free, cached per part). The scan and the transcription are aligned
    word by word, speaker names left out (the recording has none); only scan words that are debris get replaced, so
    names, spellings and speaker labels the scan got right stay as printed."""
    from difflib import SequenceMatcher
    known = known_words()
    key = lambda x: letters(re.split(r"['’]", x)[0])
    doubtful = doubtful_words(w, J(w / "map.json"))
    for t, parts in tr.items():
        files = audio_files(book, int(t))
        for p in parts:
            if p.get("auto") or len(files) < p["part"]:
                p["text"] = unjoin_names(debris_lines(speakers(stray_stops(p["text"])), set(), known)); continue
            cache = w / "units" / f"t{t}_part{p['part']}.whisper.json"
            if not cache.exists():
                W(cache, {"text": transcribe(ROOT / files[p["part"] - 1])}); print(f"  test {t} part {p['part']} transcribed from audio")
            heard = J(cache)["text"].split()
            heard_set = {key(x) for x in heard}
            fixed = 0
            p["text"] = speakers(p["text"])
            for mode in ("stretch", "line", "line", "line", "stretch"):
                text = p["text"]
                toks = list(re.finditer(r"\S+", text))
                is_label = [bool(re.fullmatch(r"[A-Z][A-Z_]{1,30}:", m.group(0))) and (m.start() == 0 or text[m.start() - 1] == "\n") for m in toks]
                label = lambda i: is_label[i]
                def junk(i):
                    x = toks[i].group(0); k = key(x)
                    if is_label[i] or re.fullmatch(r"[\d.,:%$/()-]+(?:st|nd|rd|th|s|am|pm)?[.,?!)]?", x) or k in FILLERS: return False
                    if not k: return x == ":" or bool(re.search(r"[|_=<>@\\]", x))   # a dash or ellipsis is punctuation, not debris
                    return (bool(re.search(r"[|_=<>@\\{}]", x)) or (k not in known and k not in heard_set)
                            or (len(k) <= 2 and k not in SHORT) or (len(k) == 1 and x.strip(".,?!") not in ("a", "A", "I")))
                lines, start = [], 0
                for i, m in enumerate(toks):
                    if i + 1 == len(toks) or "\n" in text[m.end():toks[i + 1].start()]: lines.append((start, i + 1)); start = i + 1
                line_of = {i: (a, b) for a, b in lines for i in range(a, b)}
                def junk_line(i):   # the token sits on a line that is itself mostly debris
                    a, b = line_of[i]
                    return sum(junk(k) for k in range(a, b)) * 5 >= (b - a) * 2
                idx = [i for i in range(len(toks)) if not is_label[i]]                  # the aligned words: everything but names
                sm = SequenceMatcher(None, [key(toks[i].group(0)) for i in idx], [key(x) for x in heard], autojunk=False)
                edits = []   # (first token, end token, replacement text)
                if mode == "stretch":
                    for op, s1, s2, j1, j2 in sm.get_opcodes():
                        if op not in ("replace", "delete"): continue
                        i1, i2 = idx[s1], idx[s2 - 1] + 1
                        span = [i for i in range(i1, i2)]
                        if any(is_label[i] for i in span): continue                     # a turn change inside: leave it to the line pass
                        # a cleanly printed name the recording can't spell ("Emilie Snell-Rood" -> "Emily Snellrude") stays as printed
                        # (a name is a capitalised scan word that sounds like a word heard at that spot; "Couey" for "country" is not)
                        if any(re.fullmatch(r"[A-Z][a-z]+(?:-[A-Z][a-z]+)?[.,?!]?", toks[k].group(0)) and not junk_line(k)
                               and not any(junk(x) for x in (k - 1, k + 1) if 0 <= x < len(toks))      # "Aes aa eapectaly" is debris, not a name
                               and any(SequenceMatcher(None, key(toks[k].group(0)), key(x)).ratio() >= 0.7 for x in heard[j1:j2]) for k in span): continue
                        bad = sum(junk(i) for i in span)
                        digits = sum(bool(re.fullmatch(r"\d{1,2}\)?", toks[i].group(0))) for i in span)
                        # a delete of words the recording has just nearby is a leftover duplicate of a restored stretch
                        nearby = {key(x) for x in heard[max(0, j1 - 40):j1 + 40]}
                        dup = sum(key(toks[i].group(0)) in nearby for i in span)
                        if op == "delete" and bad + digits < len(span) and not (len(span) >= 4 and bad + dup >= len(span) - 1): continue
                        # a replace where every scan word is a scrap or a lower-case word never heard in the part ("ith thai s round")
                        unheard = sum(key(toks[i].group(0)) not in heard_set and toks[i].group(0).islower() for i in span)
                        if op == "replace" and bad < len(span) / 2 and not (bad >= 1 and bad + unheard >= len(span) - 1 and len(span) <= 6): continue
                        if j2 - j1 > max(3 * len(span) + 6, 40) or announcer(heard[j1:j2]): continue
                        edits.append((i1, i2, " ".join(heard[j1:j2])))
                else:
                    # lines that are still mostly debris: stray short words in them ("in", "at") matched the recording by chance
                    # and split them into small stretches. A run of such lines is replaced whole, between anchors (a matched run of
                    # 2+ words, or a matched word of 4+ letters); good scan words between an anchor and the run count one-to-one.
                    anchors = [(idx[b.a + k], b.b + k) for b in sm.get_matching_blocks()
                               if b.size >= 2 or (b.size == 1 and len(key(toks[idx[b.a]].group(0))) >= 4) for k in range(b.size)]
                    def garbled(a, b, share, least=2):
                        body = [i for i in range(a, b) if not is_label[i]]
                        bad = sum(junk(i) for i in body)
                        return len(body) >= 1 and bad >= min(least, len(body)) and bad >= len(body) * share
                    runs = []
                    for a, b in lines:
                        if not garbled(a, b, 0.4): continue
                        if runs and runs[-1][1] == a: runs[-1][1] = b
                        else: runs.append([a, b])
                    # a neighbouring line with some debris is part of the same damage ("centuries, for in @, or ii i ies O ige")
                    for r in runs:
                        while (prev := next((x for x in lines if x[1] == r[0]), None)) and garbled(*prev, 0.2, 1): r[0] = prev[0]
                        while (nxt := next((x for x in lines if x[0] == r[1]), None)) and garbled(*nxt, 0.2, 1): r[1] = nxt[1]
                    runs = [r for k, r in enumerate(runs) if not any(q[0] <= r[0] and r[1] <= q[1] and q is not r for q in runs[:k])]
                    for a, b in runs:
                        before = [x for x in anchors if x[0] < a]; after = [x for x in anchors if x[0] >= b]
                        if not before or not after: continue
                        (i0, j0), (i1, j1) = before[-1], after[0]
                        gap = [i for i in list(range(i0 + 1, a)) + list(range(b, i1)) if not is_label[i]]
                        if len(gap) > 3 or any(junk(i) for i in gap): continue
                        if any(is_label[i] for i in range(b, i1)): continue
                        lead_gap = len([i for i in range(i0 + 1, a) if not is_label[i]])
                        tail_gap = len([i for i in range(b, i1) if not is_label[i]])
                        words = heard[j0 + 1 + lead_gap:j1 - tail_gap]
                        body_n = len([i for i in range(a, b) if not is_label[i]])
                        if len(words) > max(3 * body_n + 8, 120) or announcer(words): continue
                        # speaker labels inside the run: split the recording's words by printed line length, each cut moved to the
                        # nearest sentence end (a speaker change follows one)
                        run_lines = [(x, y) for x, y in lines if a <= x < b]
                        chars = [toks[y - 1].end() - toks[x].start() for x, y in run_lines]
                        pieces, cut = [], 0
                        for n, (x, y) in enumerate(run_lines):
                            if n and is_label[x]:
                                target = round(len(words) * sum(chars[:n]) / sum(chars))
                                ends = [k for k in range(max(cut, target - 6), min(len(words), target + 7)) if re.search(r"[.?!]$", words[k - 1] if k else "")]
                                k = min(ends, key=lambda k: abs(k - target)) if ends else target
                                pieces.append(" ".join(words[cut:k])); cut = k
                                pieces.append("\n" + toks[x].group(0) + " ")
                        pieces.append(" ".join(words[cut:]))
                        lead = toks[a].group(0) + " " if is_label[a] else ""
                        edits.append((a, b, lead + "".join(pieces).strip(" ")))
                for i1, i2, new in sorted(edits, reverse=True):
                    if i2 <= i1: continue
                    text = text[:toks[i1].start()] + new + text[toks[i2 - 1].end():]
                    fixed += 1
                p["text"] = re.sub(r"[ \t]{2,}", " ", text)
            # scraps at a line's end are cut only after fill_lines had its chance to restore the line from the recording
            p["text"] = debris_lines(join_split(stray_stops(p["text"], " ".join(heard)), heard, known), heard_set, known, tails=False)
            p["text"] = debris_lines(fill_lines(p["text"], heard, heard_set, known), heard_set, known)
            p["text"] = unjoin_names(apply_turns(w, t, p["part"], alternate_turns(speakers(extend_cut_lines(p["text"], heard)), heard)))
            p["text"] = near_misses(p["text"], heard, heard_set, known, doubtful)
            if fixed: print(f"  test {t} part {p['part']}: {fixed} garbled stretch(es) replaced from the recording")
    return tr

def debris_words(line, heard_set, known):
    """The OCR scraps in one transcript line: symbol debris, or a lower-case token that is neither a real word nor heard."""
    bad = []
    for x in line.split():
        if re.fullmatch(r"[A-Z][A-Z_]{1,30}:", x): continue
        k = letters(x) if re.search(r"['’]\w{3,}", x) else letters(re.split(r"['’]", x)[0])
        if re.search(r"[|_=<>@\\{}]", x): bad.append(x); continue
        if not k or re.search(r"\d|[^\x00-\x7f]", x) or re.fullmatch(r"[A-Z][A-Za-z'’.-]*[:,.?!;]?", x) or k in FILLERS: continue
        if (len(k) <= 2 and k not in SHORT) or (len(k) > 2 and k not in known and k not in heard_set): bad.append(x)
    return bad

def unannounced(words):
    """The recording's announcement cut out of a run of heard words ("Before you hear the rest ... Now listen and answer
    questions 26 to 30.")."""
    t = " ".join(words)
    t = re.sub(r"(?i)\b(?:Before you hear|You now have|Now,? listen|That is the end of|Now turn to)\b.*?(?:questions? \S+(?: (?:to|and) \S+)+|answers|section \w+)[.?!]?\s*", "", t)
    return t.split()

def fill_lines(t, heard, heard_set, known):
    """Last pass for lines that still hold scraps: the clean line before and the clean line after are found in the
    recording by their edge words, and what was said between them replaces the damaged lines (names kept; a name inside
    goes at the nearest sentence end, as in repair_scripts). A neighbour too scrappy to find ("thin in", "By a See") joins
    the damaged lines and the next line out is tried, up to two each way."""
    hk = [letters(re.split(r"['’]", x)[0]) for x in heard]
    name_re = r"^[A-Z][A-Z_]{1,30}: "
    keys_of = lambda line: [k for k in (letters(re.split(r"['’]", x)[0]) for x in re.sub(name_re, "", line).split()) if k]
    def find(keys, expect, first, lo=0):
        """Where a clean line's edge words are in the recording: the occurrence nearest where the line should be (a
        common phrase recurs), skipping up to three scraps at the edge."""
        for n in (3, 2):
            hits = []
            for off in range(4):
                run = keys[off:off + n] if first else keys[max(len(keys) - n - off, 0):len(keys) - off]
                if len(run) < n or sum(len(k) for k in run) < 7: continue
                hits += [max(q - off, 0) if first else q + n + off for q in range(lo, len(hk) - n + 1) if hk[q:q + n] == run]
            if hits: return min(hits, key=lambda q: abs(q - expect))
        return None
    lines = t.split("\n")
    total = max(sum(len(l.split()) for l in lines), 1)
    at_word = [0]
    for l in lines: at_word.append(at_word[-1] + len(l.split()))
    expect = lambda n: len(hk) * at_word[n] / total          # the recording position a line should have
    dirty = [bool(l.strip()) and bool(debris_words(l, heard_set, known)) for l in lines]
    out_lines = list(lines)
    i = 0
    while i < len(lines):
        if not dirty[i]: i += 1; continue
        j = i
        while j < len(lines) and dirty[j]: j += 1
        done = False
        for grow_back in range(3):
            for grow_fwd in range(3):
                a0, b0 = i - grow_back, j + grow_fwd
                prev = next((k for k in range(a0 - 1, -1, -1) if lines[k].strip()), None)
                nxt = next((k for k in range(b0, len(lines)) if lines[k].strip()), None)
                if prev is None or nxt is None or a0 < 0 or any(dirty[k] for k in (prev, nxt)): continue
                a = find(keys_of(lines[prev]), expect(prev + 1), False)
                b = find(keys_of(lines[nxt]), expect(nxt), True, a or 0) if a is not None else None
                if a is not None and b is None and len(keys_of(lines[nxt])) <= 2 and b0 - a0 <= 4:
                    k1 = keys_of(lines[nxt])[:1]
                    if k1 and len(k1[0]) >= 5 and a < len(hk) and hk[a] == k1[0]:          # the single word is said right after
                        damaged = lines[a0:b0]
                        alpha = [x for l in damaged for x in l.split() if re.search(r"[A-Za-z]", x)]
                        if not any(re.match(name_re, l) for l in damaged) and sum(len(debris_words(l, heard_set, known)) for l in damaged) * 4 >= len(alpha):
                            out_lines[a0:b0] = [None] * (b0 - a0)
                            for k in range(a0, b0): dirty[k] = False
                            i, done = b0, True
                            break
                if a is None or b is None or b <= a: continue
                words, damaged = unannounced(heard[a:b]), lines[a0:b0]
                alpha = [x for l in damaged for x in l.split() if re.search(r"[A-Za-z]", x)]
                if not words and b - a <= 1 and not any(re.match(name_re, l) for l in damaged) and \
                        sum(len(debris_words(l, heard_set, known)) for l in damaged) * 5 >= len(alpha) * 2:
                    out_lines[a0:b0] = [None] * (b0 - a0)                        # "? ? ? / for th -60s. / mother, mi tere li J J"
                    for k in range(a0, b0): dirty[k] = False
                    i, done = b0, True
                    break
                if not words or len(words) > max(25 * len(damaged) + 10, 150) or announcer(words): continue
                # the damaged lines' readable words must be in what the recording says there, or the anchors are wrong
                good = {letters(x) for l in damaged for x in l.split() if len(letters(x)) >= 4 and letters(x) in known}
                said = {letters(re.split(r"['’]", x)[0]) for x in words}
                if len(good) >= 2 and len(good & said) < len(good) / 2: continue
                chars = [len(l) for l in damaged]
                pieces, cut = [], 0
                for n, l in enumerate(damaged):
                    if n and re.match(name_re, l):
                        target = round(len(words) * sum(chars[:n]) / sum(chars))
                        ends = [k for k in range(max(cut, target - 6), min(len(words), target + 7)) if k and re.search(r"[.?!]$", words[k - 1])]
                        k = min(ends, key=lambda k: abs(k - target)) if ends else target
                        pieces.append(" ".join(words[cut:k])); cut = k
                        pieces.append("\n" + l.split()[0] + " ")
                pieces.append(" ".join(words[cut:]))
                lead = damaged[0].split()[0] + " " if re.match(name_re, damaged[0]) else ""
                out_lines[a0:b0] = [lead + "".join(pieces).strip(" ")] + [None] * (b0 - a0 - 1)
                for k in range(a0, b0): dirty[k] = False
                i, done = b0, True
                break
            if done: break
        if not done: i = j
    return "\n".join(l for l in out_lines if l is not None)

def doubtful_words(w, m):
    """Words Tesseract itself was unsure of on the audioscript pages (confidence < 75), as letter keys. A misread that
    happens to spell a word ("sight" for "eight", "pat" for "part") is nearly always one of these."""
    f = w / "ocr" / "scripts.lowconf.json"
    if f.exists(): return set(J(f))
    a, b = m["audioscripts"]
    keys = {letters(r[11]) for n in range(a, b + 1) for r in ocr.tsv(w / "pages" / f"p{n:03d}.png", 3) if float(r[10]) < 75}
    W(f, sorted(k for k in keys if k))
    return keys

def near_misses(t, heard, heard_set, known, stained):
    """A scan word that differs from the word heard at the same spot by a letter or two, never heard anywhere in the part,
    and one Tesseract doubted ("pay for sight hours", "taking pat too", "2 along time"): a misread that spells a word, so
    the recording wins. Otherwise the scan wins (Whisper writes "program", "cafe", "seeing" for "programme", "café",
    "saying"), and spelling/ending variants are never touched."""
    from difflib import SequenceMatcher
    key = lambda x: letters(re.split(r"['’]", x)[0])
    lines = t.split("\n")
    toks = [x for x in t.split() if not re.fullmatch(r"[A-Z][A-Z_]{1,30}:", x)]
    scrappy = {i for i, x in enumerate(toks) if key(x) in stained}
    swap = {}
    for op, i1, i2, j1, j2 in SequenceMatcher(None, [key(x) for x in toks], [key(x) for x in heard], autojunk=False).get_opcodes():
        if op != "replace" or i2 - i1 != j2 - j1 or i2 - i1 > 3: continue
        for i, h in zip(range(i1, i2), heard[j1:j2]):
            a, ka, kh = toks[i], key(toks[i]), key(h)
            # one substituted letter ("father" heard as "rather", "sere" as "were") is an OCR slip even on a word
            # Tesseract was sure of, if the scan's word is not said anywhere near that spot
            near = {key(x) for x in heard[max(0, j1 - 40):j2 + 40]}
            one_letter = len(ka) == len(kh) >= 3 and sum(x != y for x, y in zip(ka, kh)) == 1 and ka not in near
            if one_letter:
                sa, sh = next((x, y) for x, y in zip(ka, kh) if x != y)
                # only a letter pair Tesseract confuses; a pair Whisper confuses, or a British/American spelling (s/z, grey/gray,
                # licence/license, enquire/inquire), stays as printed. a/e and a/o only for a non-word or a small function word
                # ("end" -> "and", "wamen" -> "women"), since "beech"/"beach" and "massages"/"messages" are both real words
                strong = {frozenset(x) for x in ("fr", "lt", "il", "ij", "lj", "nr", "rn", "vy", "gq", "cg", "ec", "hb", "mn", "ft", "ti", "cl", "ce")}
                weak = {frozenset(x) for x in ("ea", "ao", "eo", "uo")}
                FUNC = {"and", "an", "the", "that", "than", "then", "they", "what", "was", "were", "with", "you", "your", "just", "right", "women", "have"}
                pair = frozenset((sa, sh))
                one_letter = pair in strong or (pair in weak and (ka not in known or kh in FUNC))
            if not a[0].islower() or not ka or kh not in known or len(kh) < 3: continue
            if not one_letter and (i not in scrappy or ka in heard_set): continue
            if ka.startswith(kh) or kh.startswith(ka): continue          # a spelling or ending variant (programme/program, weekend/weekends)
            d = edit_distance(ka, kh)
            if d <= 2 and d < len(ka) / 2: swap[i] = re.sub(r"[A-Za-z]+", re.sub(r"[^A-Za-z']", "", h), a, count=1) if re.search(r"[A-Za-z]", a) else h   # the printed punctuation stays
    if not swap: return t
    out, i = [], 0
    for l in lines:
        words = []
        for x in l.split():
            if re.fullmatch(r"[A-Z][A-Z_]{1,30}:", x): words.append(x); continue
            words.append(swap.get(i, x)); i += 1
        out.append(" ".join(words))
    return "\n".join(out)

def alternate_turns(t, heard):
    """In a two-person dialogue the same name never starts two turns in a row. Where it does, the other person's turn
    between them lost its name or was lost altogether (a stain took the line):
    - an unlabelled paragraph between the two turns (after a blank line, starting with a capital) is the other person's;
    - with nothing between them, what the recording says between the first turn's end and the second turn's start
      (three words or more, never an announcement) is inserted as the other person's turn."""
    from collections import Counter
    lab = re.compile(r"^([A-Z][A-Z_]{1,30}): ")
    lines = t.split("\n")
    c = Counter(m.group(1) for l in lines if (m := lab.match(l)))
    people = [n for n, k in c.items() if k >= 3]
    if len(people) != 2: return t
    other = lambda n: people[1] if n == people[0] else people[0]
    hk = [letters(re.split(r"['\u2019]", x)[0]) for x in heard]
    keys_of = lambda line: [k for k in (letters(re.split(r"['\u2019?]", x)[0]) for x in lab.sub("", line).split()) if k]
    starts = [i for i, l in enumerate(lines) if lab.match(l)]
    inserts = []
    for i, j in zip(starts, starts[1:]):
        a_name, b_name = lab.match(lines[i]).group(1), lab.match(lines[j]).group(1)
        if a_name != b_name or a_name not in people: continue
        # an unlabelled paragraph in between: blank line, then a capitalised line
        para = next((k for k in range(i + 1, j) if not lines[k].strip() and k + 1 < j and re.match(r"\s*[A-Z\"'‘“]", lines[k + 1])
                     and not any(lines[k + 1].upper().startswith(n.replace("_", " ")) for n in people)), None)   # "LOUISE? December" is labelled already
        if para is None:
            cands = [k for k in range(i + 1, j) if lines[k].strip() and re.search(r"[.?!]\s*$", lines[k - 1].strip() or "x")
                     and re.match(r"\s*(?:Oh|Hmm+|Mm+|Er+m?|Um|OK|Okay|Yes|Yeah|No|Right|Well|Sure|Great|Thanks|Thank you|Really|Sorry|Fine|Good|Ah|Uh-huh)\b", lines[k]) and lines[k - 1].strip()]   # a reply opener
            if len(cands) == 1: para = cands[0] - 1                                   # "CAROL: ... if possible. / Hmm. I'll check."
        if para is not None:
            lines[para + 1] = other(a_name) + ": " + lines[para + 1].lstrip()
            continue
        if not heard: continue
        # nothing in between: the recording between the end of turn i and the start of turn j
        end_keys = keys_of(" ".join(l for l in lines[i:j] if l.strip()))[-3:]
        start_keys = keys_of(lines[j])[:3]
        if len(start_keys) < 3 or sum(map(len, start_keys)) < 7: continue
        if len(end_keys) < 3: end_keys = end_keys[-2:]
        if len(end_keys) < 2 or sum(map(len, end_keys)) < 8: continue
        a_hits = [q + len(end_keys) for q in range(len(hk) - len(end_keys) + 1) if hk[q:q + len(end_keys)] == end_keys]
        for a in a_hits:
            b = next((q for q in range(a, min(len(hk), a + 50)) if hk[q:q + 3] == start_keys), None)
            if b is None: continue
            words = unannounced(heard[a:b])
            if 3 <= len(words) <= 45 and not announcer(words):
                inserts.append((j, other(a_name) + ": " + " ".join(words)))
            break
    for j, line in sorted(inserts, reverse=True):
        lines.insert(j, line)
    return "\n".join(lines)

TURNS_SCHEMA = {"type": "object", "properties": {"turns": {"type": "array", "items": {"type": "object", "properties": {
    "line": {"type": "integer"}, "speaker": {"type": "string"}}, "required": ["line", "speaker"]}}}, "required": ["turns"]}

def repeated_turns(t):
    """Places in a transcript where the same name starts two turns in a row: [(first line, next line, name)]."""
    lab = re.compile(r"^([A-Z][A-Z_ ]{1,30}): ")
    lines = t.split("\n")
    starts = [(i, m.group(1)) for i, l in enumerate(lines) if (m := lab.match(l))]
    return [(i, j, a) for (i, a), (j, b) in zip(starts, starts[1:]) if a == b]

def speaker_turns(book, text_spec):
    """One text call per dialogue part that still has the same name on two turns in a row (paid, cached in
    units/t{N}_part{P}.turns.json): the model reads the numbered lines and says on which line each speaker's turn starts.
    It never writes words; apply_turns() only uses it to name an unnamed line between two same-name turns."""
    from collections import Counter
    w = work(book)
    tr = J(w / "units" / "transcripts.json")
    for t, parts in tr.items():
        for p in parts:
            if p.get("auto") or not repeated_turns(p["text"]): continue
            cache = w / "units" / f"t{t}_part{p['part']}.turns.json"
            if cache.exists(): continue
            names = [n for n, k in Counter(re.findall(r"(?m)^([A-Z][A-Z ]{1,30}): ", p["text"])).items() if k >= 3]
            if len(names) < 2: continue
            numbered = "\n".join(f"{k}: {l}" for k, l in enumerate(p["text"].split("\n")))
            prompt = (f"This is an IELTS listening audioscript, read by OCR from a scanned book, of a conversation between {', '.join(names)}. "
                      "Some speaker names were lost, so a turn can appear without its name and run on after the previous speaker's words. "
                      "The lines are numbered. Return every line on which a speaker's turn begins and who is speaking, using only these names. "
                      "A turn usually runs over several lines; do not list continuation lines.\n\n" + numbered)
            W(cache, model_json(text_spec, prompt, TURNS_SCHEMA) or {"turns": []})
            print(f"  test {t} part {p['part']}: {len(J(cache)['turns'])} turns read")
    print(f"model tokens this run: {TOKENS[0]:,}")

def apply_turns(w, t, part, text):
    """Name the unnamed turn the model found between two turns of the same speaker. Only a line that starts a sentence
    (after one that ended) and has no name gets one, and only a name different from the speaker on both sides."""
    f = w / "units" / f"t{t}_part{part}.turns.json"
    if not f.exists(): return text
    lines = text.split("\n")
    said = {x["line"]: x["speaker"].strip().upper() for x in J(f)["turns"] if isinstance(x.get("line"), int)}
    names = set(said.values())
    for i, j, name in reversed(repeated_turns(text)):
        # the scan glued the other speaker's turn onto this line ("... free 4 evan: You said ..."): a lower-case name-like
        # token before a capital, where the model puts the other speaker's turn on this or the next line, splits it
        for k in range(i, j):
            if not lines[k].strip(): continue
            g = re.search(r"\s([a-z][a-z]{1,13})[.:;,]\s+(?=[A-Z\"'\u2018\u201c])", lines[k])
            nxt = next((q for q in range(k + 1, j + 1) if lines[q].strip()), None)
            if g and nxt is not None and said.get(nxt) not in (None, name.replace("_", " ")) and said.get(k) in (None, name.replace("_", " ")) \
                    and not re.match(r"^[A-Z][A-Z_ ]{1,30}: ", lines[nxt]) and edit_distance(g.group(1).upper(), said[nxt].replace(" ", "")) <= max(2, len(said[nxt]) // 2) \
                    and not re.match(r"^\W{0,3}[A-Za-z]{2,14}[.:;,]?\s+[A-Z]", lines[nxt]):   # the next line is itself the turn ("evan: You said")
                who = said[nxt]
                lines[k:k + 1] = [lines[k][:g.start()].rstrip(), who.replace(" ", "_") + ": " + lines[k][g.end():]]
                break
        for k in range(i + 1, j):
            who = said.get(k)
            if not who or who == name.replace("_", " ") or who not in names or not lines[k].strip(): continue
            if re.match(r"^[A-Z][A-Z_ ]{1,30}: ", lines[k]): continue
            body = lines[k].strip()
            mis = re.match(r"^([A-Za-z]{2,14})([.:;,]?)\s+(?=[A-Z\"'\u2018\u201c])", body)   # "aint And", "coun Yeah", "evan: You": the name, mangled
            STARTERS = {"and", "but", "so", "or", "if", "as", "at", "in", "on", "to", "of", "for", "it", "is", "we", "he", "she", "they", "you", "this", "that", "these",
                        "there", "then", "now", "oh", "ok", "yes", "no", "well", "um", "er", "the", "a", "an", "my", "our", "your", "his", "her", "its", "not", "what", "when", "how", "why", "who", "where", "with", "from", "by", "about", "like", "just", "only", "also", "even", "still", "very", "really", "quite", "mr", "mrs", "ms", "dr"}
            if mis and (mis.group(2) == ":" or edit_distance(mis.group(1).upper(), who.replace(" ", "")) <= max(1, len(who) // 3)
                        or (len(mis.group(1)) <= 6 and mis.group(1).lower() not in STARTERS and not mis.group(1)[0].isupper())): body = body[mis.end():]
            if body[:1].islower():
                # the line opens with the end of the previous speaker's sentence ("time that's available. So maybe ..."):
                # those words go back to the previous line, the name goes where the new sentence starts
                m = re.search(r"[.?!]\s+(?=[A-Z\"'\u2018\u201c])", body)
                if not m or m.start() > 60: continue
                prev = next((q for q in range(k - 1, i - 1, -1) if lines[q].strip()), None)
                if prev is None: continue
                carried = body[:m.start() + 1]
                carried = re.sub(r"\s*\b[A-Za-z]{2,14}[.:;,]\s*$", "", carried) if re.search(r"\b([A-Za-z]{2,14})[.:;,]$", carried) and edit_distance(re.search(r"\b([A-Za-z]{2,14})[.:;,]$", carried).group(1).upper(), who.replace(" ", "")) <= 2 else carried
                lines[prev] = lines[prev].rstrip() + " " + carried
                body = body[m.end():]
            lines[k] = who.replace(" ", "_") + ": " + body
            break
    return "\n".join(lines)

def extend_cut_lines(t, heard):
    """A speaker's turn the scan cut short ("SUSIE: Yes, but that?" where the recording goes on "... that's only for the
    over 60s so you wouldn't qualify."): the turn's last words are found in the recording, and so are the next turn's first
    words; when three or more words are said in between, the turn is completed from the recording. Only turns that look
    cut (no closing punctuation, or a "?" standing in for an apostrophe on a word the recording says differently)."""
    hk = [letters(re.split(r"['\u2019]", x)[0]) for x in heard]
    name_re = r"^[A-Z][A-Z_]{1,30}: "
    lines = t.split("\n")
    keys_of = lambda line: [k for k in (letters(re.split(r"['\u2019?]", x)[0]) for x in re.sub(name_re, "", line).split()) if k]
    total = max(sum(len(l.split()) for l in lines), 1)
    at_word = [0]
    for l in lines: at_word.append(at_word[-1] + len(l.split()))
    for n, line in enumerate(lines[:-1]):
        nxt = next((k for k in range(n + 1, len(lines)) if lines[k].strip()), None)
        if nxt is None or not re.match(name_re, lines[nxt]) or not line.strip(): continue
        last = line.split()[-1]
        heard_last = None
        clipped_apos = bool(re.search(r"[a-z][?\u2019']$", last))                  # "that?" / "that’" for "that's"
        if not clipped_apos and re.search(r"[.!?\u2019\"')]$", last): continue
        k1, k2 = keys_of(line)[-3:], keys_of(lines[nxt])[:3]
        if len(k1) < 2 or len(k2) < 2 or sum(map(len, k1)) < 7 or sum(map(len, k2)) < 7: continue
        expect = len(hk) * at_word[n + 1] / total
        a_hits = [q + len(k1) for q in range(len(hk) - len(k1) + 1) if hk[q:q + len(k1)] == k1]
        if not a_hits: continue
        a = min(a_hits, key=lambda q: abs(q - expect))
        if clipped_apos and not re.search(r"['\u2019]\w", heard[a - 1]): continue     # "one?" is a real question mark
        b_hits = []
        for off in range(3):
            run = keys_of(lines[nxt])[off:off + 3]
            if len(run) == 3: b_hits += [q - off for q in range(a, min(len(hk), a + 60)) if hk[q:q + 3] == run]
        if not b_hits: continue
        b = min(b_hits)
        words = unannounced(heard[a:b])
        if not (3 <= len(words) <= 40) or announcer(words) or not re.search(r"[.?!]$", words[-1]): continue
        # the line's last word as the recording says it ("that?" -> "that's"), then the rest of the turn
        toks = line.split()
        if clipped_apos: toks[-1] = heard[a - 1]
        lines[n] = " ".join(toks) + " " + " ".join(words)
    return "\n".join(lines)

def join_split(t, heard, known):
    """Two words OCR ran together ("Iwas", "Ofcourse", "yourown", "takea"): split where the recording has the pair."""
    pairs = {(letters(a), letters(b)) for a, b in zip(heard, heard[1:])}
    def fix(m):
        x = m.group(0); k = letters(x)
        if k in known or len(k) < 3: return x
        for c in range(1, len(x)):
            if (letters(x[:c]), letters(x[c:])) in pairs: return x[:c] + " " + x[c:]
        return x
    return re.sub(r"(?<![\w'’-])[A-Za-z]{3,}(?![\w'’-])", fix, t)

def debris_lines(t, heard_set, known, tails=True):
    """Lines that are only OCR scraps ("eS", "Te PK iy 5", "HK Fil WU PR ia A", a lone "Qn") are dropped, and so are
    scraps a stain left beside text that is already whole nearby ("im staff has been overwi" a few lines under
    "Feedback from staff has been overwhelmingly positive")."""
    lines = t.split("\n")
    name = lambda l: re.match(r"[A-Z][A-Z_]{1,30}: ", l)
    unknown = lambda x: (k := letters(re.split(r"['’]", x)[0])) and len(k) >= 2 and k not in known and k not in heard_set and not x[0].isupper() and not re.search(r"\d", x)
    symbol = lambda x: not re.search(r"[A-Za-z0-9]", x) or bool(re.fullmatch(r"0\d+", x))
    keep = []
    for n, line in enumerate(lines):
        toks0 = line.split()
        # a scrap at the head of a sentence ("wan. First of all") or a run of scraps after a comma at the line end
        # ("...for the future, suite sugcess Ihe worksnap-on 015 & 16": margin markers a stain smeared)
        if len(toks0) >= 2 and unknown(toks0[0]) and re.match(r"[a-z]+[.!?]?$", toks0[0]) and toks0[1][:1].isupper(): line = " ".join(toks0[1:]); toks0 = toks0[1:]
        body_at = len(name(line).group(0)) if name(line) else 0
        if tails and (m := re.search(r"[,.;:]\s+(\S+(?:\s+\S+){2,})$", line[body_at:])):
            run = m.group(1).split(); bad = sum(bool(unknown(x)) or symbol(x) for x in run)
            if bad * 2 >= len(run) and sum(bool(unknown(x)) for x in run) >= 1 or all(symbol(x) for x in run):
                line = line[:body_at + m.start(1)].rstrip(); toks0 = line.split()
        if name(line) and all(symbol(x) for x in toks0[1:]): line = toks0[0]; toks0 = [toks0[0]]   # "JAMES: ~ ? ? . : ."
        # a short line that is mostly non-words ("obsbel ob gave", "fas")
        if toks0 and not name(line) and len(toks0) <= 4 and sum(bool(unknown(x)) for x in toks0) * 2 >= len(toks0) and sum(bool(unknown(x)) for x in toks0) >= 1: continue
        words = [letters(x) for x in line.split()]
        real = [k for k in words if len(k) >= 3 and (k in known or k in heard_set)]
        if line.strip() and not name(line) and not real and not re.search(r"\d{2,}", line) and not all(k in SHORT for k in words if k):
            continue
        toks = [x for x in line.split() if letters(x)]
        if line.strip() and not name(line) and len(toks) <= 10:
            middle = "".join(letters(x) for x in (toks[1:-1] if len(toks) > 2 else toks))
            window = "".join(letters(x) for l in lines[max(0, n - 8):n] + lines[n + 1:n + 4] for x in l.split())
            if len(middle) >= 8 and (len(toks) >= 4 or (len(toks) == 3 and debris_words(line, heard_set, known))) and middle in window:
                continue
            clean = [letters(x) for x in toks if not debris_words(x, heard_set, known) and len(letters(x)) >= 3]
            if debris_words(line, heard_set, known) and len(clean) >= 2 and "".join(clean) in window and len("".join(clean)) >= 8:
                continue
            scraps = debris_words(line, heard_set, known)
            if scraps and len(toks) <= 6 and len(scraps) <= 2:
                rest = "".join(letters(x) for x in toks if x not in scraps)
                tail = "".join(letters(x) for x in scraps)[-3:]
                if len(rest) >= 7 and (tail + rest) in window: continue
        keep.append(line)
    return "\n".join(keep)

def letters(s): return re.sub(r"[^a-z0-9]", "", s.lower())

def fuzzy_at(stream, key, max_miss):
    """First index where key matches stream with at most max_miss wrong characters, else -1."""
    for s in range(len(stream) - len(key) + 1):
        if sum(a != b for a, b in zip(stream[s:s + len(key)], key)) <= max_miss: return s
    return -1

def bad_lines(w, n):
    """The page's garbled lines: a quarter or more of the words got low Tesseract confidence (< 60). Each is kept as the
    set of its confidently-read words, so the paragraph it belongs to can be found. Cached next to the page's OCR text."""
    f = w / "ocr" / f"p{n:03d}.badlines.json"
    if f.exists(): return J(f)
    lines = {}
    for r in ocr.tsv(w / "pages" / f"p{n:03d}.png", 3):
        lines.setdefault((r[2], r[3], r[4]), []).append((float(r[10]), r[11]))
    bad = [sorted({wd.lower() for c, wd in l if c >= 80 and re.fullmatch(r"[A-Za-z]{4,}", wd)})
           for l in lines.values() if len(l) >= 4 and sum(c < 60 for c, _ in l) / len(l) >= 0.24]
    W(f, bad)
    return bad

def page_damage(w, n): return len(bad_lines(w, n))   # 0-1 clean; 3+ stained or watermarked (Cambridge 13 p85, Cambridge 12 every page)

PARA_SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}

NEAR = {}
def misread(k):
    """A non-word one or two letters from a common word, and not just a spelling or ending variant of it: "femily",
    "wsits", "aclults", "pericular" are misreads; "sarcophagi", "axolotl" are rare words (nothing common is that close)."""
    if k in NEAR: return NEAR[k]
    top = common_top()
    hit = False
    if len(k) >= 4:
        for c in top:
            if abs(len(c) - len(k)) <= 2 and c[0] in (k[0], k[1] if len(k) > 1 else "") or (abs(len(c) - len(k)) <= 2 and c[-2:] == k[-2:]):
                if c.startswith(k) or k.startswith(c) or c.rstrip("s") == k.rstrip("s"): continue
                if edit_distance(k, c) <= (1 if len(k) <= 5 else 2): hit = True; break
    NEAR[k] = hit
    return hit

def page_lowconf(w, n, below=60):
    """The words Tesseract read with confidence below 60 (or `below`) on a page (lower-case letters only). Cached next to the OCR."""
    f = w / "ocr" / (f"p{n:03d}.lowconf.json" if below == 60 else f"p{n:03d}.conf{below}.json")
    if f.exists(): return set(J(f))
    words = {re.sub(r"[^a-z]", "", r[11].lower()) for r in ocr.tsv(w / "pages" / f"p{n:03d}.png", 3) if float(r[10]) < below}
    W(f, sorted(x for x in words if x))
    return words - {""}

def word_like(k, known):
    """A real word the dictionary lacks: a known stem with a common ending, a known prefix, or two known words joined."""
    for suf in ("s", "es", "ed", "ing", "ly", "er", "ers", "ness", "less", "ist", "ists", "ism", "ation", "ion", "al", "ful", "fold", "ity", "ise", "ize"):
        if k.endswith(suf) and len(k) - len(suf) >= 3 and (k[:-len(suf)] in known or k[:-len(suf)] + "e" in known): return True
    for pre in ("un", "dis", "re", "over", "under", "micro", "sub", "non", "pre", "mis"):
        if k.startswith(pre) and k[len(pre):] in known: return True
    return any(k[:c] in known and k[c:] in known for c in range(3, len(k) - 2))

def repair_damaged_paragraphs(w, uid, data, pages, vision_spec):
    """Paragraphs on a damaged scan page are re-read from the image one at a time (paragraph-sized requests pass the
    output filter that blocks whole passages). A re-read replaces the OCR text only if it contains most of the OCR's
    readable long words, so a wrong paragraph can't slip in. Cached per paragraph."""
    ppages = passage_pages(w, pages)
    page_nums = [n for n, _ in ppages]
    # a paragraph with OCR debris tokens ("Farmers ever e fa | nclu AN", "increa g profe sionalization f") is garbled even on a page
    # that doesn't score as damaged, and its garbled line may have no confident word to locate it by
    known = known_words()
    unsure = set().union(*(page_lowconf(w, n) for n in page_nums))
    doubted = set().union(*(page_lowconf(w, n, 85) for n in page_nums))
    def junk(p):   # a scrap symbol, or two words that are no words AND that Tesseract itself doubted ("moressive ... wsits")
        toks = p["text"].split()
        if sum(bool(re.search(r"[|\\_]|^[b-hj-z]$|[a-z][!|][a-z]", t)) for t in toks) >= 1: return True
        bad = [t for t in (re.sub(r"^[^A-Za-z]+|[^A-Za-z]+$", "", x) for x in toks)
               if t and t.islower() and "-" not in t and t not in known and t not in SHORT and not word_like(t, known) and (t in unsure or (t in doubted and misread(t)))]
        # one misread Tesseract doubted is enough when it is also a near miss of a common word ("aclults", "emingly", "tcam")
        return len(bad) >= 2 or any(t in doubted and misread(t) for t in bad)
    # a paragraph is on the page if its start, middle or end is (it may only run onto the page)
    windows = lambda s: [s[:24], s[len(s) // 2:len(s) // 2 + 24], s[-24:]] if len(s) > 60 else [s]
    located = lambda n: [i for i, p in enumerate(data["paragraphs"]) if any(fuzzy_at(letters(text(w, n)), k, 3) >= 0 for k in windows(letters(p["text"])))]
    for n in page_nums:
        if page_damage(w, n) < 3 and not any(junk(data["paragraphs"][i]) for i in located(n)): continue
        on_page = located(n)
        if on_page and on_page[0] > 0: on_page.insert(0, on_page[0] - 1)     # the paragraph running onto this page
        paras = data["paragraphs"]
        # only paragraphs that hold a garbled line cost a call; the rest keep OCR (or an earlier cached re-read, for free).
        # A watermarked book (Cambridge 12) has damage on every page but only 2-3 garbled lines on each.
        def dirty(p):
            words = set(re.findall(r"[a-z]{4,}", p["text"].lower()))
            return any(len(set(line) & words) >= min(2, len(line)) for line in bad_lines(w, n) if line)
        queue = [paras[i] for i in on_page]
        must = {id(p) for p in queue if junk(p) or (page_damage(w, n) >= 3 and dirty(p))}
        while queue:
            p = queue.pop(0)
            opening = " ".join(p["text"].split()[:6])
            cache = w / "units" / f"{uid}.para-{letters(opening)[:30]}.json"
            if not cache.exists() and id(p) not in must: continue
            if not cache.exists():
                imgs = [w / "pages" / f"p{k:03d}.png" for k in (n - 1, n, n + 1) if k in page_nums]
                r = model_json(vision_spec, f"Return ONLY the paragraph of the reading passage that begins '{opening}', exactly as printed and "
                               "complete to its end (it may run across the page images). Nothing else.", PARA_SCHEMA, images=imgs)
                W(cache, r or {"text": ""})
                print(f"  {uid} paragraph '{opening[:30]}…' re-read from page image")
            new = J(cache)["text"].strip()
            new_words = set(re.findall(r"[a-z]{5,}", new.lower()))
            ocr_words = set(re.findall(r"[a-z]{5,}", p["text"].lower()))
            same_start = fuzzy_at(letters(p["text"])[:40], letters(new)[:16], 3) == 0
            if not new or not new_words or len(new_words & ocr_words) / len(new_words) < (0.5 if same_start and junk(p) else 0.7):
                continue                                    # the re-read isn't this paragraph's text: keep OCR
            if len(new_words & ocr_words) / max(len(ocr_words), 1) >= 0.6:
                p["text"] = new; continue                   # the re-read covers the paragraph
            # the re-read is only the first part: OCR merged two paragraphs (Cambridge 13 T4 P2 "D"). Split after the re-read's
            # last words and queue the remainder as its own paragraph.
            pos = [k for k, ch in enumerate(p["text"]) if ch.isalnum()]
            stream = "".join(p["text"][k].lower() for k in pos)
            tail = letters(new)[-24:]
            at = fuzzy_at(stream, tail, 3)
            if at >= 0:
                rest = p["text"][pos[at + len(tail) - 1] + 1:].lstrip(" .,;:!?").strip()
            else:
                # the scan's copy of the re-read's end is garbled too ("than it would otherwise have been" -> "Hl nave been"):
                # cut after the re-read's last word where it first appears past the re-read's length, then drop scraps up
                # to the next capitalised sentence start
                toks = p["text"].split()
                last = re.sub(r"[^a-z]", "", new.split()[-1].lower())
                n_new = len(new.split())
                k = next((i for i in range(max(0, n_new - 8), min(len(toks), n_new + 12)) if re.sub(r"[^a-z]", "", toks[i].lower()) == last), None)
                if k is None: continue
                rest_toks = toks[k + 1:]
                while rest_toks and not (re.fullmatch(r"[A-Z][a-z]{2,}", rest_toks[0]) and len(rest_toks) > 1 and re.fullmatch(r"[a-z]{3,}", rest_toks[1])):
                    rest_toks.pop(0)
                rest = " ".join(rest_toks)
            p["text"] = new
            if len(rest.split()) >= 8:
                q = {"label": "", "text": rest}
                paras.insert(paras.index(p) + 1, q); queue.insert(0, q); must.add(id(q))

WHISPER = [None]
def transcribe(path):
    if WHISPER[0] is None:
        from faster_whisper import WhisperModel
        WHISPER[0] = WhisperModel("base.en", device="cpu", compute_type="int8")
    segs, _ = WHISPER[0].transcribe(str(path), language="en", vad_filter=True)
    return " ".join(s.text.strip() for s in segs)

def fill_missing_parts(book, w, tr):
    """A part with no audioscript (page missing from the scan, Cambridge 13 Test 3 Section 2) is transcribed from the
    book's own recording with local Whisper (free). The part before it ran onto the missing page, so the recording's
    continuation is appended after the last words the scan has. Both are marked as automatic."""
    for t, parts in tr.items():
        have = {p["part"] for p in parts}
        missing = [n for n in (1, 2, 3, 4) if n not in have]
        files = audio_files(book, int(t))
        for n in missing:
            if len(files) < n: continue
            cache = w / "units" / f"t{t}_part{n}.whisper.json"
            if not cache.exists():
                W(cache, {"text": transcribe(ROOT / files[n - 1])}); print(f"  test {t} part {n} transcribed from audio")
            parts.append({"part": n, "auto": True, "text": "[Transcribed automatically from the recording: this audioscript page is missing "
                          "from the book scan, so speaker names are not shown.]\n\n" + " ".join(unannounced(J(cache)["text"].split()))})
            prev = next((p for p in parts if p["part"] == n - 1 and not p.get("auto")), None)
            if prev and len(files) >= n - 1:
                pc = w / "units" / f"t{t}_part{n - 1}.whisper.json"
                if not pc.exists():
                    W(pc, {"text": transcribe(ROOT / files[n - 2])}); print(f"  test {t} part {n - 1} transcribed from audio (continuation)")
                full = J(pc)["text"]
                pos = [k for k, ch in enumerate(full) if ch.isalnum()]
                stream = "".join(full[k].lower() for k in pos)
                # book wording and speech differ slightly ("Thursday's preferable" / "Thursday is preferable"), so fall back
                # from the scan's last 40 letters to its last 16 ("gethomebefore6pm") until one lines up
                for size in (40, 24, 16):
                    tail_key = letters(prev["text"])[-size:]
                    if (at := fuzzy_at(stream, tail_key, size // 10)) >= 0: break
                if at >= 0 and at + len(tail_key) < len(pos):
                    rest = full[pos[at + len(tail_key) - 1] + 1:].lstrip(" .,;:!?")
                    if rest:
                        prev["text"] += "\n\n[The rest of this part is transcribed automatically from the recording: the book scan is missing a page.]\n\n" + " ".join(unannounced(rest.split()))
        parts.sort(key=lambda p: p["part"])
    return tr

GRID_TYPES = ("table_completion", "form_completion", "flow_chart_completion")
TABLE_SCHEMA = {"type": "object", "properties": {"body": {"type": "string"}}, "required": ["body"]}

def tables_from_pages(w, uid, data, pages, vision_spec):
    """Re-reads two kinds of group from the page image, because OCR text is unreliable for them:
    (a) every table/form/flow chart — OCR reads multi-column tables straight across, interleaving neighbouring cells,
        so the text model mis-assigns words to cells (Cambridge 15, Test 1 Listening Q19);
    (b) any group whose [[n]] gaps don't match its question numbers — the text model dropped or duplicated a gap
        (Cambridge 15, Test 3 Listening Q25).
    The re-read is kept only if its gaps match the group's numbers exactly; otherwise the OCR version stays and
    validate() flags it. Cached per group."""
    expected = lambda g: list(range(g["first"], g["last"] + 1))
    gaps_of = lambda body: sorted(int(x) for x in re.findall(r"\[\[(\d+)\]\]", body))
    groups = data.get("groups") or [g for p in data.get("parts", []) for g in p["groups"]]
    for g in groups:
        grid = g["type"] in GRID_TYPES
        broken = bool(gaps_of(g["body"])) and gaps_of(g["body"]) != expected(g)
        # (c) notes OCR never saw (Cambridge 10 Test 1 Q26-30: the notes sit in a shaded box that Tesseract skipped entirely)
        lost = g["type"].endswith("_completion") and not g["body"].strip() and not any(q["text"] for q in g["questions"])
        broken = broken or lost
        if not (grid or broken): continue
        cache = w / "units" / f"{uid}.grid{g['first']}.json"
        if not cache.exists():
            # the page that prints "Questions {first}" heads the group; a long table can run onto the next page
            head = next((n for n in pages if re.search(rf"Questions {g['first']}\b", text(w, n, False))), pages[0])
            imgs = [w / "pages" / f"p{n:03d}.png" for n in (head, head + 1) if n in pages]
            what = f"Questions {g['first']}–{g['last']} ({g['type'].replace('_', ' ')})"
            if grid:
                prompt = (f"The image(s) show {what}. Transcribe ONLY that {'form' if g['type'] == 'form_completion' else 'table'}, exactly as printed, "
                          "cell by cell: one row per line, cells separated by ' | ', a header row first if the table prints one (empty cells stay empty), "
                          "and a title line above ONLY if a title is printed — never invent one. Inside a cell, write a line break as the two characters \\n. "
                          "Write each numbered answer gap as [[n]]. A form is two columns: label | value. A flow chart is one box per line. "
                          "Do not include the instructions.")
            else:
                prompt = (f"The image(s) show {what}. Transcribe ONLY that group's shared notes/summary text, exactly as printed, one line per printed "
                          "line, a heading line only if one is printed. Write each numbered answer gap as [[n]] — every gap from "
                          f"{g['first']} to {g['last']} appears exactly once. Do not include the instructions.")
            W(cache, model_json(vision_spec, prompt, TABLE_SCHEMA, images=imgs))
            print(f"  {uid} Q{g['first']} {'grid' if grid else 'gaps'} re-read from page image")
        body = J(cache)["body"].replace("\r", "")
        if gaps_of(body) == expected(g):
            g["body"] = body
            # "Complete the table below" over a one-column box of notes (Cambridge 16 Test 1 Q8-13): it is notes, not a table
            if grid and "|" not in body: g["type"] = "note_completion"
            if not any(q["text"] for q in g["questions"]):   # questions were derived from the gaps: rebuild them from the repaired body
                g["questions"] = [{"n": n, "text": "", "options": []} for n in expected(g)]

ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv"]
OPTIONS_SCHEMA = {"type": "object", "properties": {"options": {"type": "array", "items": {"type": "object", "properties": {
    "key": {"type": "string"}, "text": {"type": "string"}}, "required": ["key", "text"]}}}, "required": ["options"]}

def option_keys(g):
    """The option letters/numerals a group's instructions promise ("i-viii", "A-H"), else []."""
    inst = g["instructions"]
    if g["type"] == "matching_headings":   # headings are numbered i, ii, ...; "sections A-F" in the instructions are the passage, not options
        present = [o["key"].lower().strip(".)") for o in g.get("options", []) if o["key"].lower().strip(".)") in ROMAN]
        if m := re.search(r"\b(i|ii|iii|iv|v|vi)\s*[-–—~]\s*(v?i{1,3}|iv|ix|x|xi{0,3}|xiv|xv)\b", inst.lower()):
            if m.group(2) in ROMAN and ROMAN.index(m.group(2)) > ROMAN.index(m.group(1)): return ROMAN[ROMAN.index(m.group(1)):ROMAN.index(m.group(2)) + 1]
        return ROMAN[:max(ROMAN.index(k) for k in present) + 1] if present else []
    if m := re.search(r"\b(i|ii|iii|iv|v|vi)\s*[-–—~]\s*(v?i{1,3}|iv|ix|x|xi{0,3}|xiv|xv)\b", inst.lower()):
        a, b = ROMAN.index(m.group(1)), ROMAN.index(m.group(2)) if m.group(2) in ROMAN else -1
        if b > a: return ROMAN[a:b + 1]
    if m := re.search(r"\b([A-H])\s*[-–—~]\s*([B-L])\b", inst):
        return [chr(c) for c in range(ord(m.group(1)), ord(m.group(2)) + 1)]
    return []

def options_from_pages(w, uid, data, pages, vision_spec):
    """A list of headings/options OCR lost part of (a stain took two headings and garbled a third: Cambridge 12 Test 1
    Passage 3 "ii A oh title with two intot i") is re-read from the page image. Triggered when the instructions promise
    more options than the group has, or an option holds words that are no words. Cached per group; kept only if the
    re-read has every promised key."""
    known = known_words()
    unsure = set().union(*(page_lowconf(w, n) for n in pages))
    doubted = set().union(*(page_lowconf(w, n, 85) for n in pages))
    scrappy = lambda o: not o["text"].strip() or len([x for x in re.findall(r"[a-z]{2,}", o["text"].lower()) if x not in known and x not in SHORT and not word_like(x, known) and (x in unsure or (x in doubted and misread(x)))]) >= 1
    groups = data.get("groups") or [g for p in data.get("parts", []) for g in p["groups"]]
    INST = {"type": "object", "properties": {"instructions": {"type": "string"}}, "required": ["instructions"]}
    for g in groups:
        # options that are only letters with no text (a "which paragraph" question) are no options at all
        if g.get("options") and not any(o["text"].strip() for o in g["options"]) and g["type"] in ("matching_information", "map_labelling", "diagram_labelling"):
            g["options"] = []
        # instructions a stain garbled ("Do th?tf?llowing sails abet yiltom ...") are re-read from the page
        bad = [x for x in re.findall(r"[a-z]{3,}", g["instructions"].lower()) if x not in known and not word_like(x, known)]
        lines = g["instructions"].split("\n")
        garbled = lambda l: len([x for x in re.findall(r"[a-z]{3,}", l.lower()) if x not in known and not word_like(x, known)]) >= 2
        if bad and g["type"] in ("true_false_not_given", "yes_no_not_given") and garbled(lines[0]):
            # the first line of these is always the same sentence; the lines below say "information" or "views/claims"
            what = "the information given in" if g["type"] == "true_false_not_given" else ("the claims of the writer in" if "claims" in g["instructions"] else "the views of the writer in")
            n = re.search(r"Reading Passage (\d)", " ".join(lines[1:])) or re.search(r"reading_passage_(\d)", uid)
            lines[0] = f"Do the following statements agree with {what} Reading Passage {n.group(1)}?"
            g["instructions"] = "\n".join(lines); continue_check = False
            bad = []
        if len(bad) >= 2:
            cache = w / "units" / f"{uid}.inst{g['first']}.json"
            if not cache.exists():
                head = next((n for n in pages if re.search(rf"Questions {g['first']}\b", text(w, n, False))), pages[0])
                W(cache, model_json(vision_spec, f"Return ONLY the instructions printed under the heading 'Questions {g['first']}–{g['last']}' "
                                   "(the sentences telling the candidate what to do), exactly as printed. Nothing else.", INST,
                                   images=[w / "pages" / f"p{head:03d}.png"]) or {"instructions": ""})
                print(f"  {uid} Q{g['first']} instructions re-read from page image")
            new = J(cache)["instructions"].strip()
            old_words = {x for x in re.findall(r"[a-z]{4,}", g["instructions"].lower()) if x in known}
            new_words = set(re.findall(r"[a-z]{4,}", new.lower()))
            # kept only if it is the instructions (most of the readable old words are in it), not a remark about them
            if new and old_words and len(old_words & new_words) >= len(old_words) * 0.6: g["instructions"] = new
        QS = {"type": "object", "properties": {"questions": {"type": "array", "items": {"type": "object", "properties": {
            "n": {"type": "integer"}, "text": {"type": "string"}}, "required": ["n", "text"]}}}, "required": ["questions"]}
        def tail_scrap(tx):
            toks = tx.split()[-6:]
            return sum(bool(re.search(r"[A-Za-z]", x)) and letters(x) not in known and not word_like(letters(x), known) and not x[:1].isupper() for x in toks) + \
                   sum(bool(re.fullmatch(r"[^\w\s]+|[a-zA-Z]{1,2}", x)) and letters(x) not in SHORT for x in toks) >= 3
        if any(q.get("text") and tail_scrap(q["text"]) for q in g["questions"]):
            cache = w / "units" / f"{uid}.qtext{g['first']}.json"
            if not cache.exists():
                head = next((n for n in pages if re.search(rf"Questions {g['first']}\b", text(w, n, False))), pages[0])
                W(cache, model_json(vision_spec, f"Return ONLY questions {g['first']}–{g['last']} on this page: each question's number and its text exactly as printed.",
                                   QS, images=[w / "pages" / f"p{n:03d}.png" for n in (head, head + 1) if n in pages]) or {"questions": []})
                print(f"  {uid} Q{g['first']} question text re-read from page image")
            got = {x["n"]: x["text"].strip() for x in J(cache)["questions"]}
            for q in g["questions"]:
                new = got.get(q["n"], "")
                old_w = {x for x in re.findall(r"[a-z]{4,}", q.get("text", "").lower()) if x in known}
                if new and old_w and len(old_w & set(re.findall(r"[a-z]{4,}", new.lower()))) >= len(old_w) * 0.6: q["text"] = new
        keys = option_keys(g)
        # a box of options the group needs: "Choose ... from the box" / "list of ..." (matching_information answers are paragraph
        # letters and labelling answers are on the picture; neither has a box)
        letter_answers = g["type"] not in ("matching_information", "map_labelling", "diagram_labelling") and re.search(r"(?i)from the (box|list)|list of", g["instructions"])
        if not keys or (not g.get("options") and not letter_answers) or (not g.get("options") and any(q.get("options") for q in g["questions"])): continue
        have = [o["key"].lower().strip(".)") for o in g.get("options", [])]
        if have == [k.lower() for k in keys] and not any(scrappy(o) for o in g["options"]): continue
        cache = w / "units" / f"{uid}.options{g['first']}.json"
        if not cache.exists():
            head = next((n for n in pages if re.search(rf"Questions {g['first']}\b", text(w, n, False))), pages[0])
            imgs = [w / "pages" / f"p{n:03d}.png" for n in (head, head + 1) if n in pages]
            prompt = (f"The image(s) show Questions {g['first']}–{g['last']}. Return ONLY the list of options for them (the lettered or "
                      f"numbered choices {keys[0]}–{keys[-1]}, e.g. a 'List of Headings'), each with its key and its text exactly as printed. Nothing else.")
            W(cache, model_json(vision_spec, prompt, OPTIONS_SCHEMA, images=imgs) or {"options": []})
            print(f"  {uid} Q{g['first']} options re-read from page image")
        opts = J(cache)["options"]
        if [o["key"].lower().strip(".)") for o in opts] == [k.lower() for k in keys]: g["options"] = [{"key": o["key"].strip(".)"), "text": o["text"].strip()} for o in opts]

def units(book, text_spec, vision_spec):
    w, m = work(book), map_book(book)
    for t, secs in m["tests"].items():
        for s, (a, b) in secs.items():
            pages, uid = list(range(a, b + 1)), f"t{t}_{s}"
            kind = s.split("_")[0]
            if kind == "writing":
                W(w / "units" / f"{uid}.A.json", writing_task(w, pages, int(s[-1]))); continue
            note = f"Cambridge IELTS {book}, Test {t}, {s.replace('_', ' ')}.\n\n{unit_text(w, pages)}"
            if kind == "reading":
                data = run_ab(w, uid, text_spec, "Return the passage title and every question group. Do not include passage text.\n" + note, SCHEMAS["reading"])
                title, data["paragraphs"] = passage_paragraphs(w, pages)
                data["title"] = title or data["title"]
                fix_labels(w, uid, data, pages, vision_spec)
                fix_title(w, uid, data, pages, vision_spec, title)
                repair_damaged_paragraphs(w, uid, data, pages, vision_spec); strip_letters(data["paragraphs"]); final_clean(data["paragraphs"])
                tables_from_pages(w, uid, data, pages, vision_spec); options_from_pages(w, uid, data, pages, vision_spec)
                W(w / "units" / f"{uid}.A.json", data); W(w / "units" / f"{uid}.diff.json", validate(data))
            elif kind == "listening":
                data = run_ab(w, uid, text_spec, "Return all four Parts with every question group, questions 1-40.\n" + note, SCHEMAS["listening"])
                tables_from_pages(w, uid, data, pages, vision_spec); options_from_pages(w, uid, data, pages, vision_spec)
                W(w / "units" / f"{uid}.A.json", data); W(w / "units" / f"{uid}.diff.json", validate(data))
            elif kind == "speaking":
                run_ab(w, uid, text_spec, "Return the speaking test frame: Part 1 topics and questions, Part 2 cue card, Part 3 topics and questions.\n" + note, SCHEMAS["speaking"])
    a, b = m["answer_keys"]
    for n in range(a, b + 1):
        run_ab(w, f"keys_p{n}", vision_spec,
               f"This image is an answer-key page of Cambridge IELTS {book}. Return every answer block on it: the test number, "
               "the module (listening or reading), and each question number with its answer exactly as printed "
               "(alternatives separated by '/', optional words in brackets). Ignore explanation boxes and band-score tables.",
               SCHEMAS["keys"], images=[w / "pages" / f"p{n:03d}.png"])
    scripts(book)

def scripts(book):
    w, m = work(book), J(work(book) / "map.json")
    W(w / "units" / "transcripts.json", repair_scripts(book, w, fill_missing_parts(book, w, transcripts(w, m))))

# ---------- diff ----------
def norm(s): return re.sub(r"[^a-z0-9\[\]]+", " ", str(s).lower()).strip()
def flatten(d, prefix=""):
    if isinstance(d, dict):
        return {k2: v2 for k, v in d.items() for k2, v2 in flatten(v, f"{prefix}.{k}").items()}
    if isinstance(d, list):
        out = {}
        for i, v in enumerate(d):
            key = v.get("n", v.get("first", v.get("part", v.get("test", i)))) if isinstance(v, dict) else i
            out.update(flatten(v, f"{prefix}[{key}]"))
        return out
    return {prefix: d}
def compare(A, B):
    fa, fb = flatten(A), flatten(B)
    return [{"path": k, "A": fa.get(k), "B": fb.get(k)} for k in sorted(set(fa) | set(fb)) if norm(fa.get(k)) != norm(fb.get(k))]

# ---------- assemble ----------
def audio_files(book, test):
    d = next((x for x in (BOOKS / f"Cambridge IELTS {book:02d}", BOOKS / f"Cambridge IELTS {book} Audio") if x.is_dir()), None)
    files = sorted(p for p in d.rglob("*") if p.suffix.lower() in (".mp3", ".m4a", ".wma")) if d else []
    # every naming the books use: "Test 1 Part 1", "Test-1-Part-1", "0101.mp3", "C14T1S1.mp3", "ELT_IELTS17_t1_audio1"
    pat = [re.compile(rf"test[\s_-]*{test}(?!\d)", re.I), re.compile(rf"^0{test}0[1-4]\."), re.compile(rf"T{test}S[1-4]\.", re.I), re.compile(rf"_t{test}_", re.I)]
    hit = [p for p in files if any(r.search(p.name) for r in pat)]
    if not hit:   # Cambridge 12 numbers its tests 5-8 ("Test 5 Section 1.mp3"): take the book's n-th test
        nums = sorted({int(m[1]) for p in files if (m := re.search(r"(?i)test\s*_?(\d+)", p.name))})
        if len(nums) >= test: hit = [p for p in files if re.search(rf"(?i)test\s*_?{nums[test - 1]}(?!\d)", p.name)]
    return [p.relative_to(ROOT).as_posix() for p in hit]


# Tesseract's usual letter confusions; a one-letter substitution outside these is a different word, not a misread
CONFUSE = [set(x) for x in ("iltfrj1", "ecoau", "nurmh", "vwyr", "szg", "bhd", "gq", "kx")]
COMMON = [None]
def common_top():
    """The 25,000 commonest words: the only spellings a one-letter correction may produce."""
    if len(COMMON) < 2:
        rank = {}
        for l in (ROOT / "pipeline" / "en_50k.txt").read_text(encoding="utf-8").splitlines():
            if l.strip() and re.fullmatch(r"[a-z]{2,}", l.split()[0]): rank.setdefault(l.split()[0], len(rank) + 1)
        COMMON.append({w for w in common_words() if rank.get(w, 10 ** 9) <= 25000})
    return COMMON[1]

def common_words():
    """The 50,000 commonest English words (hermitdave/FrequencyWords, OpenSubtitles 2018) — the only spellings a misread
    may be corrected to. The list itself carries OCR junk from subtitles ("wouid" at rank 22,055): a low-ranked word one
    letter-confusion away from a word 20x more frequent is dropped."""
    if COMMON[0] is None:
        rank = {}
        for l in (ROOT / "pipeline" / "en_50k.txt").read_text(encoding="utf-8").splitlines():
            if l.strip() and re.fullmatch(r"[a-z]{2,}", l.split()[0]): rank.setdefault(l.split()[0], len(rank) + 1)
        def junk(w):
            if rank[w] < 10000: return False
            for i, ch in enumerate(w):
                for cs in CONFUSE:
                    if ch in cs and any(rank.get(w[:i] + r + w[i + 1:], 10 ** 9) * 20 < rank[w] for r in cs - {ch}): return True
            return False
        COMMON[0] = {w for w in rank if not junk(w)}
    return COMMON[0]

def spell_fix(text):
    """OCR misreads that spell nothing, corrected by rule (free) wherever they occur in question, passage or speaking
    text: a "n" glued to the front ("nschool"), two words run together when the second is a function word
    ("answerthese", "tothe"), one letter Tesseract confused ("wouid", "essayisis", "wisitors"), one letter it added
    ("intot", "filmas") or dropped ("schoo"). A real word never changes: a token in the dictionary is left alone, and a
    correction must be a common word."""
    known, common = known_words(), common_words()
    glue = {"the", "these", "their", "them", "that", "this", "with", "from", "your", "into", "than", "there", "they", "when", "which", "what", "have", "been", "were", "and", "for", "are", "was", "not", "but", "his", "her", "its", "our", "who", "how", "all", "any", "one"}
    top = common_top()
    def real(k):   # a word the dictionary lacks but whose stem it has ("latitudes", "biases", "stews"), or a compound ("overshoot")
        for suf in ("s", "es", "ed", "ing", "ly", "er", "ers", "ism", "ness", "ies"):
            if k.endswith(suf) and (k[:-len(suf)] in known or (suf == "ies" and k[:-3] + "y" in known) or (suf in ("ed", "er", "ers") and k[:-len(suf)] + "e" in known) or (suf == "ing" and k[:-3] + "e" in known)): return True
        return any(k[:c] in known and k[c:] in known and c >= 4 and len(k) - c >= 4 for c in range(4, len(k) - 3))
    def fix(m):
        x = m.group(0); k = x.lower()
        if k in known or len(k) < 4 or x[1:] != x[1:].lower(): return x
        for c in range(2, len(k) - 1):
            if k[c:] in glue and k[:c] in known: return x[:c] + " " + x[c:]
            if c >= 4 and k[c:] in ("as", "is", "of", "in", "on", "at", "to", "an", "or", "by", "it", "be", "we", "so", "if") and k[:c] in known: return x[:c] + " " + x[c:]   # "filmas"
            if k[:c] in ("to", "of", "in", "on", "at", "a", "and", "for") and k[c:] in known and len(k[c:]) >= 3: return x[:c] + " " + x[c:]
        if real(k) or any(w.endswith(k) and len(w) >= len(k) + 3 for w in top): return x   # a real derived word, or a fragment ("iation")
        cands = set()
        for i, ch in enumerate(k):                                              # one letter confused
            for cs in CONFUSE:
                if ch in cs:
                    for r in cs - {ch}:
                        y = k[:i] + r + k[i + 1:]
                        if y in top and (len(y) >= 5 or {ch, r} in ({"i", "l"}, {"c", "e"})): cands.add(y)   # "fiow" -> "flow", "tcam" -> "team"
        for i in range(len(k)):                                                 # one letter added (not a final s/d/e/y/r)
            y = k[:i] + k[i + 1:]
            if y in top and len(y) >= 4 and not (i == len(k) - 1 and k[-1] in "sdeyr"): cands.add(y)
        if len(k) >= 5:
            for i in range(len(k)):                                             # one letter dropped (not at the end)
                for r in "abcdefghijklmnopqrstuvwxyz":
                    y = k[:i] + r + k[i:]
                    if y in top: cands.add(y)
        if len(k) >= 6:                                                          # a first letter lost ("emingly" -> "seemingly")
            for r in "abcdefghijklmnopqrstuvwxyz":
                for pre in (r, r + "e", r + "s"):
                    if (pre + k) in top: cands.add(pre + k)
        if len(cands) == 1 and not x[0].isupper():          # a capitalised token is a name ("Kandy", "Sternberg"): never touched
            return cands.pop()
        if k[0] == "n" and k[1:] in known and len(k) >= 5 and not x[0].isupper(): return x[1:]
        if x[0] in "AI" and k[1:] in known and len(k) >= 5: return x[0] + " " + x[1:]          # "Aphysician", "Ofall" -> "A physician"
        if x[:2] == "Of" and k[2:] in known and len(k) >= 5: return "Of " + x[2:]
        return x
    text = re.sub(r"(?<=[a-z])\](?=\s|$)", lambda m: "l", text) if re.search(r"[a-z]\](?=\s|$)", text) else text   # "schoo]" -> "school"
    return re.sub(r"(?<![\w'’\\\]-])[A-Za-z]{4,}(?![\w'’-])", fix, text)

def spell_fix_all(o):
    """spell_fix over every text field of a test, except answers and things that are not prose."""
    if isinstance(o, dict):
        return {k: (v if k in ("answers", "audio", "transcript", "flags", "type", "label", "figure_pdf_page") else spell_fix_all(v)) for k, v in o.items()}
    if isinstance(o, list): return [spell_fix_all(v) for v in o]
    if isinstance(o, str): return spell_fix(tidy(re.sub(r"(?<![\w\[])(\d{1,2})\s*(\|\s*)?(\[\[\1\]\])", r"\2\3", o)))
    return o

def tidy(t):
    """Symbol debris OCR leaves in prose, fixed everywhere: "~" for a dash, a margin letter "[E]" inside a sentence,
    "#" for a hyphen, a stray brace; a literal backslash-n outside a table row is a real line break (inside a row it is
    the cell line break the app expects)."""
    t = "\n".join(l if "|" in l else l.replace("\\n", "\n") for l in t.split("\n"))
    t = re.sub(r"^~\s+", "", t)                                       # "~ Crop-growing skyscrapers"
    t = re.sub(r"(?<!\S)~(?!\S)", "\u2013", t)                       # " ~ " between words: an en dash
    t = re.sub(r"(?<=\S) \[[A-J]\] (?=\S)", " ", t)                   # a margin letter OCR dropped into a sentence
    t = re.sub(r"(?<=[a-z])#(?=[a-z])", "-", t)
    t = re.sub(r"(?<!\S)[{}](?!\S)\s*", "", t)
    t = re.sub(r"\[([A-Za-z])\]\1(?=[a-z])", r"[\1]", t, flags=re.I)             # "[P]providing" -> "[P]roviding"
    t = re.sub(r"\b([Nn])ifio(s?)\b", lambda m: m.group(1) + "iño" + m.group(2), t)   # OCR reads "ñ" as "fi": "El Nifio" -> "El Niño"
    return t

PROOF_SCHEMA = {"type": "object", "properties": {"fixes": {"type": "array", "items": {"type": "object", "properties": {
    "passage": {"type": "integer"}, "para": {"type": "integer"}, "context": {"type": "string"}, "wrong": {"type": "string"}, "right": {"type": "string"}},
    "required": ["passage", "para", "context", "wrong", "right"]}}}, "required": ["fixes"]}

def proofread(book, text_spec):
    """One text call per test (paid, cached in units/t{N}_proof.json): the model lists OCR misreads in the three reading
    passages that spell a real word or a near-word ("the wells sere fundamental" -> "were"). Nothing is rewritten here;
    apply_proofread() takes only small letter-level fixes whose context is found exactly once."""
    w = work(book)
    for t in "1234":
        cache = w / "units" / f"t{t}_proof.json"
        if cache.exists(): continue
        blocks = []
        for i in (1, 2, 3):
            ps = J(w / "units" / f"t{t}_reading_passage_{i}.A.json")
            for j, q in enumerate(ps["paragraphs"]):
                blocks.append(f"[passage {i} para {j}] {q['text']}")
        prompt = ("These reading passages were OCR'd from a scanned exam book. Find ONLY OCR misreads: a word that came out as a "
                  "different word or a near-word (e.g. 'sere' for 'were', 'father' for 'rather', 'tcam' for 'team', 'modem' for 'modern'), "
                  "letters run together or split ('filmas' for 'film as'), or a stray scrap of letters. Do NOT change British spellings, "
                  "names, quotations, the author's wording, grammar or style, and do not report anything you are unsure about. For each "
                  "misread give passage, para, context (the exact text as it appears, the misread plus about three words either side), "
                  "wrong (exactly as it appears) and right.\n\n" + "\n\n".join(blocks))
        W(cache, model_json(text_spec, prompt, PROOF_SCHEMA) or {"fixes": []})
        print(f"  test {t} proofread ({len(J(cache)['fixes'])} suggestions)")
    print(f"model tokens this run: {TOKENS[0]:,}")

def ocr_shape(wrong, right):
    """The difference between two spellings is a shape Tesseract confuses: rn/m, cl/d, li/h, vv/w, or one letter among
    l, i, t, f, r, j, 1, I, T ("modem"/"modern", "ail"/"all", "Tn"/"In"). A vowel swap or an added ending is not."""
    a, b = wrong.lower(), right.lower()
    for x, y in (("rn", "m"), ("cl", "d"), ("li", "h"), ("vv", "w"), ("in", "m"), ("ri", "n")):
        if a.replace(x, y) == b or b.replace(x, y) == a: return True
    if len(a) == len(b):
        diff = [(x, y) for x, y in zip(a, b) if x != y]
        return len(diff) == 1 and (set(diff[0]) <= set("litfrj1") or set(diff[0]) == set("vw"))
    return False

def apply_proofread(w, t, passages):
    """Apply a test's cached proofread: each fix must be found exactly once (context within its paragraph) and change only
    a word or two by a few letters, so a suggestion can never rewrite a sentence or 'correct' a British spelling."""
    f = w / "units" / f"t{t}_proof.json"
    if not f.exists(): return 0
    m = J(w / "map.json")
    def sure(i):   # words Tesseract read with confidence 90+ on the passage's pages: the book really prints them
        a, z = m["tests"][str(t)][f"reading_passage_{i}"]
        out = set()
        for n_ in range(a, z + 1):
            c = w / "ocr" / f"p{n_:03d}.conf90up.json"
            if not c.exists():
                W(c, sorted({re.sub(r"[^a-z]", "", r[11].lower()) for r in ocr.tsv(w / "pages" / f"p{n_:03d}.png", 3) if float(r[10]) >= 90} - {""}))
            out |= set(J(c))
        return out
    n, done, sure_sets = 0, {}, {}
    for fx in J(f)["fixes"]:
        try: q = passages[fx["passage"] - 1]["paragraphs"][fx["para"]]
        except (IndexError, KeyError, TypeError): continue
        ctx, wrong, right = fx["context"], fx["wrong"], fx["right"]
        for a_, b_ in done.get(id(q), []):                     # an earlier fix in the same spot ("the pwells sere" after "pwells" -> "stepwells")
            if a_ != wrong: ctx = ctx.replace(a_, b_, 1)
        if q["text"].count(ctx) != 1:   # the model wrote straight quotes where the page has curly ones ("university's")
            pat = re.escape(ctx).replace("'", "['‘’]").replace('\\"', '["“”]').replace('"', '["“”]')
            found = re.findall(pat, q["text"])
            if len(found) == 1: ctx = found[0]; wrong = wrong if wrong in ctx else wrong
        if not wrong or wrong == right or wrong not in ctx or q["text"].count(ctx) != 1: continue
        ww, rw = wrong.split(), right.split()
        if abs(len(ww) - len(rw)) > 1 or len(ww) > 5: continue
        lw, lr = letters(wrong), letters(right)
        if lw != lr:
            s_ = sure_sets.setdefault(fx["passage"], sure(fx["passage"]))
            ww_, rw_ = wrong.split(), right.split()
            scrap_dropped = len(rw_) == len(ww_) - 1 and any(ww_[:k] + ww_[k + 1:] == rw_ and len(ww_[k].strip(".,")) <= 2 for k in range(len(ww_)))
            accent = bool(re.search(r"[^\x00-\x7f]", right)) and not re.search(r"[^\x00-\x7f]", wrong)
            if all(letters(x) in s_ for x in wrong.split() if letters(x)) and not (ocr_shape(wrong, right) or scrap_dropped or accent): continue   # "Rapu Nui", "agriculture shocks": printed so
        lost_front = lr.endswith(lw) and len(lr) - len(lw) <= 3 and len(lw) >= 4      # "pwells" -> "stepwells"
        if re.search(r"[^\x00-\x7f]", right): lost_front = lost_front or edit_distance(lw, lr) <= 2   # "Nifios" -> "Niños"
        if lw != lr and not lost_front:
            if edit_distance(lw, lr) > max(2, len(lr) // 4): continue
            if re.sub(r"(ise|isation|our|re|ll|ogue|ence)", "", lr) == re.sub(r"(ize|ization|or|er|l|og|ense)", "", lw): continue   # a spelling variant
        q["text"] = q["text"].replace(ctx, ctx.replace(wrong, right, 1), 1); n += 1
        done.setdefault(id(q), []).append((wrong, right))
    return n

T1_KINDS = ["process", "pie_chart", "bar_chart", "line_graph", "table", "map", "mixed"]
T2_KINDS = ["opinion", "discussion", "advantages_disadvantages", "problem_solution", "two_part_question"]
SPK_KINDS = ["person", "place", "object", "event", "experience", "activity", "media", "other"]
TAGS_SCHEMA = {"type": "object", "properties": {"tests": {"type": "array", "items": {"type": "object", "properties": {
    "test": {"type": "integer"}, "task1": {"type": "string", "enum": T1_KINDS}, "task2": {"type": "string", "enum": T2_KINDS},
    "speaking": {"type": "string", "enum": SPK_KINDS}}, "required": ["test", "task1", "task2", "speaking"]}}}, "required": ["tests"]}

def tags(book, text_spec):
    """One text call per book (paid, cached in units/tags.json): what each Writing task and Part 2 cue card IS, so the
    Practice page can offer "process diagrams" or "pie charts" the way it offers "map labelling" for Listening."""
    w = work(book)
    cache = w / "units" / "tags.json"
    if cache.exists(): return J(cache)
    blocks = []
    for t in "1234":
        t1, t2 = J(w / "units" / f"t{t}_writing_task_1.A.json"), J(w / "units" / f"t{t}_writing_task_2.A.json")
        spk = J(w / "units" / f"t{t}_speaking.A.json")
        blocks.append(f"TEST {t}\nTask 1: {t1['prompt'][:500]}\nTask 2: {t2['prompt'][:500]}\nSpeaking Part 2 cue: {spk['part2']['cue']}")
    out = model_json(text_spec, "Classify each IELTS Academic test below.\n"
                     "task1: what the Task 1 visual is (process = a diagram of stages or how something is made or works; "
                     "map = maps or plans of a place, usually over time; mixed = two different visual kinds in one task).\n"
                     "task2: the essay question type.\nspeaking: what the Part 2 cue card asks the candidate to describe.\n\n"
                     + "\n\n".join(blocks), TAGS_SCHEMA)
    W(cache, out)
    print(f"  tags: {[(x['test'], x['task1'], x['task2'], x['speaking']) for x in out['tests']]}")
    return out

def assemble(book):
    w, m = work(book), J(work(book) / "map.json")
    U = lambda uid: J(w / "units" / f"{uid}.A.json")
    D = lambda uid: J(p) if (p := w / "units" / f"{uid}.diff.json").exists() else []
    keys, kflags = {}, []
    a, b = m["answer_keys"]
    # keys are printed in test order; the book's own test numbers (Cambridge 12 prints 5-8) and misread ones are ignored.
    # A block whose question numbers continue the previous one of its module (a key split over two pages) is the same test.
    seen = {}   # module -> (test, last question number)
    for n in range(a, b + 1):
        for blk in U(f"keys_p{n}")["blocks"]:
            if not blk["answers"]: continue
            first = min(x["n"] for x in blk["answers"])
            t, last = seen.get(blk["module"], (0, 99))
            if first <= last: t += 1
            seen[blk["module"]] = (t, max(x["n"] for x in blk["answers"]))
            keys.setdefault((t, blk["module"]), {}).update({x["n"]: x["answer"] for x in blk["answers"]})
        kflags += D(f"keys_p{n}")
    tr = U("transcripts") if (w / "units" / "transcripts.A.json").exists() else J(w / "units" / "transcripts.json")
    outdir = ROOT / "content" / f"cam{book:02d}"; (outdir / "figures").mkdir(parents=True, exist_ok=True)
    tagged = J(w / "units" / "tags.json")["tests"] if (w / "units" / "tags.json").exists() else []
    for t, secs in m["tests"].items():
        tg = next((x for x in tagged if x["test"] == int(t)), None)
        test = {"book": book, "test": int(t), "module": "academic",
                "listening": {**U(f"t{t}_listening"), "answers": keys.get((int(t), "listening"), {}),
                              "audio": audio_files(book, int(t)), "transcript": tr.get(t, [])},
                "reading": {"passages": [U(f"t{t}_reading_passage_{i}") for i in (1, 2, 3)], "answers": keys.get((int(t), "reading"), {})},
                "writing": [{**U(f"t{t}_writing_task_1"), **({"kind": tg["task1"]} if tg else {})},
                            {**U(f"t{t}_writing_task_2"), **({"kind": tg["task2"]} if tg else {})}],
                "speaking": {**U(f"t{t}_speaking"), **({"kind": tg["speaking"]} if tg else {})},
                "flags": {s: D(f"t{t}_{s}") for s in secs} | {"keys": kflags}}
        apply_proofread(w, t, test["reading"]["passages"])
        test = spell_fix_all(test)
        known = known_words()
        for g in [g for p in test["listening"]["parts"] for g in p["groups"]] + [g for ps in test["reading"]["passages"] for g in ps["groups"]]:
            for q in g["questions"]:
                toks = q.get("text", "").split()
                odd = lambda x: (lx := letters(x)) == "" or (lx not in known and not re.fullmatch(r"[A-Z][a-z]{3,}[.,?]?", x)) or (len(lx) <= 2 and lx not in SHORT) or x in ("i", "?", "a")
                k = len(toks)
                while k and odd(toks[k - 1]): k -= 1
                run = toks[k:]
                if len(run) >= 3 and sum(bool(re.search(r"[A-Za-z]", x)) and odd(x) for x in run) >= 2:
                    q["text"] = " ".join(toks[:k]).rstrip(" ,;:")
                if q.get("text") and "[[" not in q["text"]: q["text"] = re.sub(r"_{3,}|\.{4,}", f"[[{q['n']}]]", q["text"], count=1)
        figures(w, test, outdir / "figures")
        W(outdir / f"test{t}.json", test)
        la, ra = len(test["listening"]["answers"]), len(test["reading"]["answers"])
        print(f"content/cam{book:02d}/test{t}.json  answers L{la}/40 R{ra}/40  flags {sum(len(v) for v in test['flags'].values())}")

def figures(w, node, figdir):
    """Every figure_pdf_page > 0 becomes a whole-page image path (bbox cropping is a later luxury)."""
    if isinstance(node, dict):
        if node.get("figure_pdf_page"):
            n = node["figure_pdf_page"]; dst = figdir / f"p{n:03d}.png"
            if not dst.exists(): dst.write_bytes((w / "pages" / f"p{n:03d}.png").read_bytes())
            node["image"] = f"figures/{dst.name}"
        for v in node.values(): figures(w, v, figdir)
    elif isinstance(node, list):
        for v in node: figures(w, v, figdir)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["ocr", "map", "units", "scripts", "proofread", "turns", "tags", "assemble", "all"])
    ap.add_argument("--book", type=int, required=True)
    ap.add_argument("--text", help="provider:model for question/speaking structuring (required for units)")
    ap.add_argument("--vision", help="provider:model for answer-key pages (required for units)")
    ap.add_argument("--verify", action="store_true", help="also run a second (B) model pass per unit and diff it")
    a = ap.parse_args()
    if a.step in ("units", "all") and not (a.text and a.vision): ap.error("--text and --vision are required, no defaults")
    if a.step in ("ocr", "all"): ocr_all(a.book)
    if a.step in ("map", "all"): map_book(a.book)
    VERIFY[0] = a.verify
    if a.step in ("units", "all"): units(a.book, a.text, a.vision); print(f"model tokens this run: {TOKENS[0]:,}")
    if a.step == "scripts": scripts(a.book)
    if a.step == "turns":
        if not a.text: ap.error("--text is required for turns, no defaults")
        speaker_turns(a.book, a.text)
    if a.step == "proofread":
        if not a.text: ap.error("--text is required for proofread, no defaults")
        proofread(a.book, a.text)            # rebuild only the audioscripts (no model calls)
    if a.step == "tags":
        if not a.text: ap.error("--text is required for tags, no defaults")
        tags(a.book, a.text); print(f"model tokens this run: {TOKENS[0]:,}")
    if a.step in ("assemble", "all"): assemble(a.book)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selfcheck":
        A = {"groups": [{"first": 1, "questions": [{"n": 1, "text": "The Sun"}, {"n": 2, "text": "x"}]}]}
        B = {"groups": [{"first": 1, "questions": [{"n": 2, "text": "x"}, {"n": 1, "text": "the sun."}]}]}
        assert compare(A, B) == [] and compare(A, {"groups": []})[0]["path"] == ".groups[1].first"
        print("selfcheck ok"); sys.exit()
    main()
