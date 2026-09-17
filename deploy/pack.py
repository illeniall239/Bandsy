"""Pack Bandsy for the server (Speaking stays on the PC, so no speech models go up).
  python deploy/pack.py          -> bandsy-deploy.tar: code, content, listening audio, and your database as seed/bandsy.db
  python deploy/pack.py --code   -> code and content only, for updates"""
import json, sys, tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
full = "--code" not in sys.argv
files = [*ROOT.glob("*.js"), *ROOT.glob("package*.json"), ROOT / "index.html", *(ROOT / "src").rglob("*"), *(ROOT / "content").rglob("*"), *(ROOT / "deploy").glob("*")]
if full:
    for f in (ROOT / "content").glob("cam*/test*.json"):
        files += [ROOT / a for a in json.loads(f.read_text(encoding="utf-8"))["listening"]["audio"]]
out = ROOT / "bandsy-deploy.tar"
with tarfile.open(out, "w") as tar:
    for f in files:
        if f.is_file(): tar.add(f, f.relative_to(ROOT).as_posix())
    if full and (ROOT / "bandsy.db").exists(): tar.add(ROOT / "bandsy.db", "seed/bandsy.db")
print(f"{out.name}: {out.stat().st_size / 1e6:.0f} MB")
