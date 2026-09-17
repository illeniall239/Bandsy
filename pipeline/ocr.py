"""Tesseract OCR of one scanned book page -> plain text with paragraph letters restored.

Cambridge pages print paragraph labels (A, B, C..) as lone bold glyphs in the left margin; Tesseract's
layout pass drops them, so the margin strip is OCR'd separately and merged back by vertical position.
A candidate letter counts only if it sits left of the body text's left edge.
"""
import re, subprocess, sys
from collections import Counter
from pathlib import Path
import pymupdf

TESS = r"C:\Program Files\Tesseract-OCR\tesseract.exe" if sys.platform == "win32" else "tesseract"
HEADER = re.compile(r"^(Reading|Listening|Writing|Speaking|Test \d|\d{1,3}|[A-Z][a-z]+ \d)$")
STRIP = (0.03,)  # left edge of the margin strip, fraction of page width

def tsv(png, psm, extra=()):
    out = subprocess.run([TESS, str(png), "-", "--psm", str(psm), *extra, "tsv"], capture_output=True, text=True, encoding="utf-8").stdout
    rows = [l.split("\t") for l in out.splitlines()[1:]]
    return [r for r in rows if len(r) == 12 and r[11].strip()]

def ocr_page(pdf, n, cache_dir, dpi=130):
    """n is the 1-based PDF page. Returns text; blank line between paragraphs, [A] labels where printed."""
    cache = Path(cache_dir) / f"p{n:03d}.txt"
    if cache.exists(): return cache.read_text(encoding="utf-8")
    page = pdf[n - 1]; r = page.rect
    body = Path(cache_dir) / f"p{n:03d}.png"; strip = Path(cache_dir) / f"p{n:03d}.strip.png"
    page.get_pixmap(dpi=dpi).save(body)
    words = tsv(body, 3)
    # group words into lines (block, par, line); keep top y and left x
    lines, cur = [], None
    for w in words:
        key = (w[2], w[3], w[4])
        if key != cur:
            lines.append({"par": (w[2], w[3]), "top": int(w[7]), "left": int(w[6]), "words": []}); cur = key
        lines[-1]["words"].append(w[11])
    if not lines: cache.write_text("", encoding="utf-8"); return ""
    body_left = Counter(l["left"] // 10 * 10 for l in lines).most_common(1)[0][0]  # px at this dpi
    x0, x1 = r.width * STRIP[0], (body_left - 6) * 72 / dpi  # margin strip stops just short of the body text
    page.get_pixmap(dpi=dpi, clip=pymupdf.Rect(x0, 0, max(x1, x0 + 10), r.height)).save(strip)
    letters = [(int(w[7]), w[11]) for w in tsv(strip, 6, ("-c", "tessedit_char_whitelist=ABCDEFGHIJ")) if len(w[11]) == 1]
    for top, L in letters:  # attach to the first line at or below the letter, if it is a prose line
        cand = [l for l in lines if l["top"] >= top - 12]
        if cand:
            line = min(cand, key=lambda l: l["top"])
            if len(line["words"]) >= 7: line["words"].insert(0, f"[{L}]")
    text, last_par = [], None
    for l in lines:
        s = " ".join(l["words"])
        if HEADER.match(s): continue
        # a block break is a real paragraph break only after a sentence end
        if l["par"] != last_par and text and re.search(r"[.!?:\"\u2019\u201d)\]]$", text[-1]): text.append("")
        text.append(s); last_par = l["par"]
    out = "\n".join(text).strip() + "\n"
    if two_columns(lines, page.get_pixmap(dpi=dpi).width):
        out = columns(page, dpi, out, Path(cache_dir) / f"p{n:03d}.col.png")
    strip.unlink(); body.unlink()
    cache.write_text(out, encoding="utf-8")
    return out

def two_columns(lines, width):
    """A two-column passage (Cambridge 12 'Cork'): many lines start left of centre AND many start right of centre,
    each group short. Tesseract's page mode reads such a page straight across both columns."""
    left = [l for l in lines if l["left"] < width * 0.45 and len(l["words"]) >= 3]
    right = [l for l in lines if width * 0.5 < l["left"] < width * 0.65 and len(l["words"]) >= 3]
    return len(left) >= 12 and len(right) >= 12

def gutter(page):
    """Where the white gap between the two columns is, as a fraction of page width. A fixed half-way split cuts letters
    off when the scan sits off-centre (Cambridge 10 T4 P1: "uilding", "jrowth"). Measured on the page body: the band
    between 35% and 65% of the width with the fewest dark pixels."""
    pix = page.get_pixmap(dpi=60, colorspace=pymupdf.csGRAY)
    w, h, data = pix.width, pix.height, pix.samples
    top, bottom = int(h * 0.3), int(h * 0.92)
    dark = [sum(1 for y in range(top, bottom) if data[y * w + x] < 140) for x in range(w)]
    lo, hi, band = int(w * 0.35), int(w * 0.65), 3
    best = min(range(lo, hi - band), key=lambda x: (sum(dark[x:x + band]), abs(x + band / 2 - w / 2)))
    return (best + band / 2) / w

def columns(page, dpi, fallback, tmp):
    """Re-OCR the page as two halves (heading band kept from the full read) and stitch left then right."""
    r = page.rect
    parts = []
    mid = gutter(page)
    # each half overlaps the gutter a little, so a slightly tilted scan can't cut a letter off at the edge ("toda" for
    # "today"); a word whose centre lies on the other side of the gutter belongs to the other column and is dropped
    pad = 0.02
    for side, (x0, x1) in enumerate(((0.04, mid + pad), (mid - pad, 0.97))):
        page.get_pixmap(dpi=200, clip=pymupdf.Rect(r.width * x0, 0, r.width * x1, r.height)).save(tmp)
        # lines from the TSV so paragraph breaks survive: a line that ends a sentence and is shorter than the column ends a paragraph
        centre = lambda w: x0 + (int(w[6]) + int(w[8]) / 2) * 72 / 200 / r.width
        rows = [w for w in tsv(tmp, 3) if (centre(w) < mid) == (side == 0)]
        lines, cur = [], None
        for w in rows:
            key = (w[2], w[3], w[4])
            if key != cur: lines.append({"words": [], "block": w[2], "right": 0, "top": int(w[7]), "h": int(w[9])}); cur = key
            lines[-1]["words"].append(w[11]); lines[-1]["right"] = max(lines[-1]["right"], int(w[6]) + int(w[8]))
        full = sorted(l["right"] for l in lines)[int(len(lines) * 0.8)] if lines else 0    # a full line's right edge
        out, last = [], None
        for l in lines:
            s = " ".join(l["words"]).strip()
            s = re.sub(r"^[:|.\-]+\s*", "", s)                 # dotted column borders OCR as a leading ": " / "."
            s = re.sub(r"\s+[:|\-]+$|\s+\.$", "", s)           # ...or a trailing one, separated from the last word by a space
            if not re.search(r"[A-Za-z]{4}", s): continue                          # border/watermark debris
            # a paragraph break: the previous line ended a sentence and was short of the column's edge, or there is a
            # gap of more than a line between them, or Tesseract started a new block there
            if last is not None and out and re.search(r"[.!?’”)\]]$", out[-1]) and (
                    last["right"] < full * 0.85 or l["top"] - last["top"] > last["h"] * 2.2 or l["block"] != last["block"]):
                out.append("")
            out.append(s); last = l
        parts.append("\n".join(out).strip())
    # lines that really run across the gutter (a subtitle, not two column lines read side by side): no gap where the gutter is
    page.get_pixmap(dpi=130).save(tmp)
    full_lines = {}
    for w in tsv(tmp, 3): full_lines.setdefault((w[2], w[3], w[4]), []).append(w)
    W = page.get_pixmap(dpi=130).width
    spanning = set()
    for ws in full_lines.values():
        xs = sorted((int(w[6]), int(w[6]) + int(w[8])) for w in ws)
        h = max(int(w[9]) for w in ws)
        if xs[0][0] < W * mid - 20 and xs[-1][1] > W * mid + 20 and all(b[0] - a[1] < h * 1.5 for a, b in zip(xs, xs[1:])):
            spanning.add(re.sub(r"[^a-z]", "", " ".join(w[11] for w in ws).lower())[:30])
    tmp.unlink(missing_ok=True)
    head = fallback.split("\n")
    # keep the lines above the passage (headings, instructions, the title band) from the straight read: they span both
    # columns. The title band is up to three short lines after the instructions (Cambridge 11 "THE STORY OF SILK / The
    # history of the world's most luxurious fabric, / from ancient China to the present day").
    keep, band = [], 0
    for l in head:
        l = re.sub(r"^\[[A-J]\]\s*", "", l)                                    # a margin letter the strip read beside a heading line
        if re.match(r"(?i)^(READING|READING PASSAGE|You should spend|Passage \d|Test \d|\d{1,3}$)", l.strip()) or not l.strip(): keep.append(l)
        elif not re.search(r"[A-Za-z]{4}", l) or (len(l.strip()) >= 3 and l.strip() in "READING") or re.search(r"(?i)www\.|yuce|irlang", l) or (re.search(r"[>|]", l) and not re.search(r"[a-z]{3}", l)): continue   # watermark scrap ("FLFR : v"), badge fragment ("EADING")
        elif band < 6 and ((band == 0 and len(l.split()) <= 10) or any(sp.startswith(re.sub(r"[^a-z]", "", re.sub(r"^\[[A-J]\]\s*", "", l).lower())[:20]) for sp in spanning)) and any(re.match(r"(?i)READING PASSAGE|You should spend", k.strip()) for k in keep): keep.append(l); band += 1
        else: break
    keep = [l for l in keep if not re.fullmatch(r"(Test \d|\d{1,3})", l.strip())]      # the running header ("Test 1", a page number)
    # each column read repeats the heading band, clipped at the column's edge ("READING PASSAGE 1", "You should spend
    # about 20 minutes on Que", "Yr OF SILK", "; most luxurious fabric,", "Jrom ancient China"): drop leading column
    # lines whose letters sit inside a kept line's letters (one wrong letter allowed)
    kept = [re.sub(r"[^a-z0-9]", "", k.lower()) for k in keep if k.strip()]
    def inside(line):
        x = re.sub(r"[^a-z0-9]", "", line.lower())
        if len(x) < 4 or len(line.split()) > 16: return False
        from difflib import SequenceMatcher
        for k in kept:
            for st in range(len(k) - len(x) + 1):
                if sum(a != b for a, b in zip(k[st:st + len(x)], x)) <= 1: return True
            if len(x) >= 10 and SequenceMatcher(None, x, k[:len(x) + 2]).ratio() >= 0.88: return True   # "Passage 71 below."
        return False
    for i in (0, 1):
        lines = parts[i].split("\n")
        while lines and (not lines[0].strip() or re.fullmatch(r"(Test \d|\d{1,3})", lines[0].strip()) or inside(lines[0])
                         or not re.search(r"[a-z]{3}", lines[0]) and len(lines[0].split()) <= 5
                         or len(lines[0].split()) >= 6 and sum(bool(re.fullmatch(r"[A-Z]{2,}|\w*[a-z][A-Z]\w*", x)) for x in lines[0].split()) * 5 >= len(lines[0].split()) * 2):   # a dotted border read as letters   # "ubsl yl gl"
            lines.pop(0)
        parts[i] = "\n".join(lines)
    return "\n".join(keep).strip() + "\n\n" + parts[0] + "\n\n" + parts[1] + "\n"

if __name__ == "__main__":  # python pipeline/ocr.py <pdf> <page> [page ...]
    d = Path("work/_ocrtest"); d.mkdir(parents=True, exist_ok=True)
    pdf = pymupdf.open(sys.argv[1])
    for n in sys.argv[2:]:
        t = ocr_page(pdf, int(n), d)
        labels = re.findall(r"^\[([A-J])\]", t, re.M)
        print(f"--- p{n}: labels {labels}")
