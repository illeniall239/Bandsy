// One process: static files (dist/, content/, the book audio) + a small JSON API over SQLite, behind a login.
// `node server.js --dev` also spawns the Vite dev server (which proxies /api, /content, /audio, /login here).
// Accounts only on the hosted copy (BANDSY_LOGIN=on): `node server.js adduser <name> <password>`; the first account owns the existing history.
// On the PC there is no login: everything is user 1.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { PROVIDERS, JOBS, makeSettings, listModels } from "./providers.js";
import { gradeTask } from "./grading.js";
import { plan, MODULES } from "./plan.js";
import * as examiner from "./examiner.js";
import { makeVocab } from "./review.js";
import { makeExplain } from "./explain.js";

const ROOT = import.meta.dirname;
const db = new Database(process.env.BANDSY_DB || path.join(ROOT, "bandsy.db"));   // BANDSY_DB=scratch file for test runs; never test against your real history
db.exec(`CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, test TEXT NOT NULL, module TEXT NOT NULL, mode TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL, answers TEXT NOT NULL, marks TEXT NOT NULL,
  score INTEGER NOT NULL, band REAL)`);   // band null for section drills
if (!db.prepare("SELECT 1 FROM pragma_table_info('attempts') WHERE name='user_id'").get()) db.exec("ALTER TABLE attempts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, pass TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL)`);
const SPEAKING = process.env.BANDSY_SPEAKING !== "off";   // off on the hosted site: no speech models there
const modules = SPEAKING ? MODULES : MODULES.filter(m => m !== "speaking");
const settings = makeSettings(db);
const vocab = makeVocab(db);
const explain = makeExplain(db, ROOT);

const hash = (pw, salt = crypto.randomBytes(16).toString("hex")) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
const verify = (pw, stored) => { const [salt, h] = stored.split(":"); return crypto.timingSafeEqual(Buffer.from(h, "hex"), crypto.scryptSync(pw, salt, 32)); };
if (process.argv[2] === "adduser" || process.argv[2] === "passwd") {
  const [, , cmd, name, pw] = process.argv;
  if (!name || !pw || pw.length < 8) { console.error(`usage: node server.js ${cmd} <name> <password of 8+ characters>`); process.exit(1); }
  if (cmd === "adduser") db.prepare("INSERT INTO users (name, pass) VALUES (?, ?)").run(name.toLowerCase(), hash(pw));
  else if (!db.prepare("UPDATE users SET pass=? WHERE name=?").run(hash(pw), name.toLowerCase()).changes) { console.error("no such user"); process.exit(1); }
  console.log(`${cmd} ${name}: ok`); process.exit(0);
}

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

const under = (base, rel) => { const f = path.join(ROOT, base, rel); return f.startsWith(path.join(ROOT, base) + path.sep) ? f : "" };   // no "..%2f" escapes
function sendFile(res, file, range) {
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
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
const text = req => new Promise(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => r(s)); });
const body = async req => JSON.parse(await text(req) || "{}");
const raw = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

// ---- login: a session cookie per browser; everything but the login page needs one ----
const failures = new Map();   // ip -> {n, until}: 10 wrong passwords lock that address out for 15 minutes
const LOGIN = err => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bandsy · Sign in</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#EDEDEA;color:#111;font:500 15px/1.5 Manrope,system-ui,sans-serif}
form{width:100%;max-width:380px;background:#fff;border-radius:24px;padding:40px;display:grid;gap:14px}b{font-weight:800;letter-spacing:3px;font-size:14px}
h1{margin:18px 0 6px;font-size:44px;font-weight:800;letter-spacing:-2px;line-height:1}label{display:grid;gap:6px;font-size:13px;font-weight:700;color:#555}
input{font:inherit;color:#111;padding:12px 14px;border:1px solid #DADAD5;border-radius:12px}input:focus{outline:none;border-color:#111}
button{font:700 15px/1 Manrope,system-ui,sans-serif;margin-top:6px;padding:16px;border:0;border-radius:14px;background:#111;color:#fff;cursor:pointer}
p{margin:0;color:#C2410C;font-size:14px}</style></head><body><form method="post" action="/login"><b>BANDSY</b><h1>Sign in</h1>
${err ? `<p role="alert">${err}</p>` : ""}<label>Name<input name="name" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></body></html>`;
const cookie = req => /(?:^|;\s*)bandsy=([a-f0-9]{64})/.exec(req.headers.cookie || "")?.[1];
const whoami = req => { const t = cookie(req); return t && db.prepare("SELECT users.id, users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE token=?").get(t); };
const html = (res, s, code = 200) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }); res.end(s); };
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };

async function login(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return html(res, LOGIN("Too many wrong passwords. Try again in 15 minutes."), 429);
  const q = new URLSearchParams(await text(req));
  const u = db.prepare("SELECT * FROM users WHERE name=?").get((q.get("name") || "").trim().toLowerCase());
  if (!u || !verify(q.get("password") || "", u.pass)) {
    const n = (f && !f.until ? f.n : 0) + 1;   // an expired lockout starts the count again
    failures.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60e3 : 0 });
    return html(res, LOGIN("Wrong name or password."), 401);
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(token, u.id, new Date().toISOString());
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  redirect(res, "/", { "Set-Cookie": `bandsy=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}` });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  let m;
  if (p === "/login") return req.method === "POST" ? login(req, res) : html(res, LOGIN(""));
  if (p === "/logout") {
    const t = cookie(req); if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(t);
    return redirect(res, "/login", { "Set-Cookie": "bandsy=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }
  const user = process.env.BANDSY_LOGIN === "on" ? whoami(req) : { id: 1, name: "" };
  if (!user) return p.startsWith("/api/") ? json(res, { error: "signed out" }, 401) : redirect(res, "/login");
  const uid = user.id, mine = () => settings.get(uid);

  if (p === "/api/tests") return json(res, tests());
  if (p === "/api/attempts" && req.method === "POST") {
    const a = await body(req);
    const r = db.prepare(`INSERT INTO attempts (user_id, test, module, mode, started_at, finished_at, answers, marks, score, band)
      VALUES (@user_id, @test, @module, @mode, @started_at, @finished_at, @answers, @marks, @score, @band)`)
      .run({ ...a, user_id: uid, answers: JSON.stringify(a.answers), marks: JSON.stringify(a.marks) });
    return json(res, { id: r.lastInsertRowid });
  }
  const list = () => db.prepare("SELECT id, test, module, mode, started_at, finished_at, score, band FROM attempts WHERE user_id=? ORDER BY id DESC").all(uid);
  if (p === "/api/attempts") return json(res, list());
  if (m = p.match(/^\/api\/attempts\/(\d+)$/)) {
    const a = db.prepare("SELECT * FROM attempts WHERE id=? AND user_id=?").get(+m[1], uid);
    return a ? json(res, { ...a, answers: JSON.parse(a.answers), marks: JSON.parse(a.marks) }) : json(res, { error: "no such attempt" }, 404);
  }
  if (p === "/api/today") {
    return json(res, { ...plan(new Date(), tests(), list(), modules), modules, test_date: mine().test_date || "2026-12-31", history: list().filter(a => a.band != null) });
  }
  if (p === "/api/settings" && req.method === "PUT") { settings.set(uid, await body(req)); return json(res, { ok: true }); }
  if (p === "/api/settings") return json(res, { ...mine(), user: user.name, catalog: PROVIDERS, jobs_available: JOBS });
  if (p === "/api/models") {
    try { return json(res, await listModels(mine(), url.searchParams.get("provider"))); }
    catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p === "/api/grade" && req.method === "POST") {
    const { test, task, text } = await body(req);
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, "content", `${test}.json`), "utf8"));
    const w = t.writing.find(x => x.task === task);
    const image = w.image ? path.join(ROOT, "content", test.split("/")[0], w.image) : undefined;
    try { return json(res, await gradeTask(mine(), { task, prompt: w.prompt, image, text })); }
    catch (e) { return json(res, { error: e.message }, 502); }  // shown verbatim; the user decides what to do (design Q39)
  }
  if (p === "/api/explain" && req.method === "POST") {
    try { return json(res, await explain(mine(), await body(req))); } catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p === "/api/vocab" && req.method === "POST") {
    try { return json(res, await vocab.addWord(mine(), uid, await body(req))); } catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p === "/api/vocab") return json(res, vocab.words(uid));
  if (p === "/api/vocab/book") { const f = path.join(ROOT, "content", "vocab.json"); return json(res, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []); }
  if (p.startsWith("/api/speaking/") && SPEAKING) {
    try {
      if (p.endsWith("/start")) {
        const { test, mode } = await body(req);
        const t = JSON.parse(fs.readFileSync(path.join(ROOT, "content", `${test}.json`), "utf8"));
        return json(res, await examiner.start(mine(), { test, speaking: t.speaking, mode }));
      }
      if (p.endsWith("/turn")) return json(res, await examiner.turn(mine(), { session: url.searchParams.get("session"), audio: await raw(req) }));
      if (p.endsWith("/finish")) return json(res, await examiner.finish(mine(), await body(req)));
    } catch (e) { return json(res, { error: e.message }, 502); }
  }
  if (p.startsWith("/api/")) return json(res, { error: "not found" }, 404);
  if (p.startsWith("/content/")) return sendFile(res, under("content", p.slice(9)));
  if (p.startsWith("/audio/Cambridge-lists-main/")) return sendFile(res, under("Cambridge-lists-main", p.slice(28)), req.headers.range);
  // SPA build
  const file = under("dist", p === "/" ? "index.html" : p);
  if (file && fs.existsSync(file) && !file.endsWith("index.html")) return sendFile(res, file);
  html(res, fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8").replace("</head>", `<script>window.BANDSY_SPEAKING=${SPEAKING}</script></head>`));
}).listen(+process.env.PORT || 3001, process.env.HOST, () => console.log(`api on http://localhost:${process.env.PORT || 3001}`));   // PORT for side-by-side test runs

if (process.argv.includes("--dev")) spawn("npx", ["vite"], { stdio: "inherit", shell: true });
if (SPEAKING && !process.argv.includes("--no-sidecar")) spawn(process.env.PYTHON || "python", [path.join(ROOT, "sidecar/audio.py")], { stdio: "inherit" });  // STT/TTS on :3002
