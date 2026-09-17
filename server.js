// One local process: static files (dist/, content/, the book audio) + a small JSON API over SQLite.
// `node server.js --dev` also spawns the Vite dev server (which proxies /api, /content, /audio here).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { PROVIDERS, JOBS, makeSettings, listModels } from "./providers.js";
import { gradeTask } from "./grading.js";
import { plan } from "./plan.js";
import * as examiner from "./examiner.js";
import { makeVocab } from "./review.js";
import { makeExplain } from "./explain.js";

const ROOT = import.meta.dirname;
const db = new Database(process.env.BANDSY_DB || path.join(ROOT, "bandsy.db"));   // BANDSY_DB=scratch file for test runs; never test against your real history
db.exec(`CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, test TEXT NOT NULL, module TEXT NOT NULL, mode TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL, answers TEXT NOT NULL, marks TEXT NOT NULL,
  score INTEGER NOT NULL, band REAL)`);   // band null for section drills
const settings = makeSettings(db);
const vocab = makeVocab(db);
const explain = makeExplain(db, ROOT);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wma": "audio/x-ms-wma", ".svg": "image/svg+xml" };

function tests() {
  const out = [];
  for (const book of fs.readdirSync(path.join(ROOT, "content")).filter(b => b.startsWith("cam")).sort()) {
    for (const f of fs.readdirSync(path.join(ROOT, "content", book)).filter(f => f.endsWith(".json")).sort()) {
      const t = JSON.parse(fs.readFileSync(path.join(ROOT, "content", book, f), "utf8"));
      out.push({ id: `${book}/${f.replace(".json", "")}`, book: t.book, test: t.test, module: t.module });
    }
  }
  return out;
}

function sendFile(res, file, range) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  const size = fs.statSync(file).size, type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  if (range) {  // <audio> seeks with range requests
    const [s, e] = range.replace("bytes=", "").split("-").map(Number);
    const end = e || size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${s}-${end}/${size}`, "Content-Length": end - s + 1, "Accept-Ranges": "bytes" });
    return fs.createReadStream(file, { start: s, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
}

const json = (res, data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
const body = req => new Promise(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(JSON.parse(s || "{}"))); });
const raw = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  let m;
  if (p === "/api/tests") return json(res, tests());
  if (p === "/api/attempts" && req.method === "POST") {
    const a = await body(req);
    const r = db.prepare(`INSERT INTO attempts (test, module, mode, started_at, finished_at, answers, marks, score, band)
      VALUES (@test, @module, @mode, @started_at, @finished_at, @answers, @marks, @score, @band)`)
      .run({ ...a, answers: JSON.stringify(a.answers), marks: JSON.stringify(a.marks) });
    return json(res, { id: r.lastInsertRowid });
  }
  const list = () => db.prepare("SELECT id, test, module, mode, started_at, finished_at, score, band FROM attempts ORDER BY id DESC").all();
  if (p === "/api/attempts") return json(res, list());
  if (m = p.match(/^\/api\/attempts\/(\d+)$/)) {
    const a = db.prepare("SELECT * FROM attempts WHERE id=?").get(+m[1]);
    return a ? json(res, { ...a, answers: JSON.parse(a.answers), marks: JSON.parse(a.marks) }) : json(res, { error: "no such attempt" }, 404);
  }
  if (p === "/api/today") {
    const s = settings.get();
    return json(res, { ...plan(new Date(), tests(), list()), test_date: s.test_date || "2026-12-31", history: list().filter(a => a.band != null) });
  }
  if (p === "/api/settings" && req.method === "PUT") { settings.set(await body(req)); return json(res, { ok: true }); }
  if (p === "/api/settings") return json(res, { ...settings.get(), catalog: PROVIDERS, jobs_available: JOBS });
  if (p === "/api/models") {
    try { return json(res, await listModels(settings.get(), url.searchParams.get("provider"))); }
    catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p === "/api/grade" && req.method === "POST") {
    const { test, task, text } = await body(req);
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, "content", `${test}.json`), "utf8"));
    const w = t.writing.find(x => x.task === task);
    const image = w.image ? path.join(ROOT, "content", test.split("/")[0], w.image) : undefined;
    try { return json(res, await gradeTask(settings.get(), { task, prompt: w.prompt, image, text })); }
    catch (e) { return json(res, { error: e.message }, 502); }  // shown verbatim; the user decides what to do (design Q39)
  }
  if (p === "/api/explain" && req.method === "POST") {
    try { return json(res, await explain(settings.get(), await body(req))); } catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p === "/api/vocab" && req.method === "POST") {
    try { return json(res, await vocab.addWord(settings.get(), await body(req))); } catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p === "/api/vocab") return json(res, vocab.words());
  if (p === "/api/vocab/book") { const f = path.join(ROOT, "content", "vocab.json"); return json(res, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []); }
  if (p.startsWith("/api/speaking/")) {
    try {
      if (p.endsWith("/start")) {
        const { test, mode } = await body(req);
        const t = JSON.parse(fs.readFileSync(path.join(ROOT, "content", `${test}.json`), "utf8"));
        return json(res, await examiner.start(settings.get(), { test, speaking: t.speaking, mode }));
      }
      if (p.endsWith("/turn")) return json(res, await examiner.turn(settings.get(), { session: url.searchParams.get("session"), audio: await raw(req) }));
      if (p.endsWith("/finish")) return json(res, await examiner.finish(settings.get(), await body(req)));
    } catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p.startsWith("/content/")) return sendFile(res, path.join(ROOT, p));
  if (p.startsWith("/audio/")) return sendFile(res, path.join(ROOT, p.slice(7)), req.headers.range);
  // SPA build
  const file = path.join(ROOT, "dist", p === "/" ? "index.html" : p);
  sendFile(res, fs.existsSync(file) ? file : path.join(ROOT, "dist", "index.html"));
}).listen(+process.env.PORT || 3001, () => console.log(`api on http://localhost:${process.env.PORT || 3001}`));   // PORT for side-by-side test runs

if (process.argv.includes("--dev")) spawn("npx", ["vite"], { stdio: "inherit", shell: true });
if (!process.argv.includes("--no-sidecar")) spawn("python", [path.join(ROOT, "sidecar/audio.py")], { stdio: "inherit" });  // STT/TTS on :3002
