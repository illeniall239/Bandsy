// The local app: static files (dist/, content/, the book audio) + the /api routes (app.js) over SQLite, and the Speaking sidecar.
// `node server.js --dev` also spawns the Vite dev server (which proxies /api, /content, /audio here).
// The hosted copy runs the same routes on Vercel over Supabase (api/index.js).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { makeSettings } from "./providers.js";
import { api, ROOT } from "./app.js";

const db = new Database(process.env.BANDSY_DB || path.join(ROOT, "bandsy.db"));   // BANDSY_DB=scratch file for test runs; never test against your real history
db.exec(`CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, test TEXT NOT NULL, module TEXT NOT NULL, mode TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL, answers TEXT NOT NULL, marks TEXT NOT NULL,
  score INTEGER NOT NULL, band REAL)`);   // band null for section drills
if (!db.prepare("SELECT 1 FROM pragma_table_info('attempts') WHERE name='user_id'").get()) db.exec("ALTER TABLE attempts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
const vocabTable = `CREATE TABLE IF NOT EXISTS vocab (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL DEFAULT 1, word TEXT, sentence TEXT, definition TEXT,
    source TEXT, created_at TEXT, interval INTEGER DEFAULT 0, due TEXT, reviews INTEGER DEFAULT 0, UNIQUE(user_id, word))`;
// words used to be unique globally: rebuild the table once so the unique key includes the user
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='vocab'").get() && !db.prepare("SELECT 1 FROM pragma_table_info('vocab') WHERE name='user_id'").get())
  db.transaction(() => {
    db.exec("ALTER TABLE vocab RENAME TO vocab_old");
    db.exec(vocabTable);
    db.exec("INSERT INTO vocab (id, word, sentence, definition, source, created_at, interval, due, reviews) SELECT id, word, sentence, definition, source, created_at, interval, due, reviews FROM vocab_old");
    db.exec("DROP TABLE vocab_old");
  })();
db.exec(vocabTable);
db.exec(`CREATE TABLE IF NOT EXISTS explanations (test TEXT, module TEXT, n INTEGER, answer TEXT, body TEXT, created_at TEXT, PRIMARY KEY (test, module, n, answer))`);
const settings = makeSettings(db);

// one local user
const uid = 1;
const store = {
  attempts: () => db.prepare("SELECT id, test, module, mode, started_at, finished_at, score, band FROM attempts WHERE user_id=? ORDER BY id DESC").all(uid),
  attempt: id => { const a = db.prepare("SELECT * FROM attempts WHERE id=? AND user_id=?").get(id, uid); return a && { ...a, answers: JSON.parse(a.answers), marks: JSON.parse(a.marks) }; },
  addAttempt: a => db.prepare(`INSERT INTO attempts (user_id, test, module, mode, started_at, finished_at, answers, marks, score, band)
      VALUES (@user_id, @test, @module, @mode, @started_at, @finished_at, @answers, @marks, @score, @band)`)
    .run({ ...a, user_id: uid, answers: JSON.stringify(a.answers), marks: JSON.stringify(a.marks) }).lastInsertRowid,
  settings: () => settings.get(uid),
  saveSettings: s => settings.set(uid, s),
  words: () => db.prepare("SELECT * FROM vocab WHERE user_id=? ORDER BY id DESC").all(uid),
  addWord: w => {
    db.prepare("INSERT OR IGNORE INTO vocab (user_id, word, sentence, definition, source, created_at, due) VALUES (@uid, @word, @sentence, @definition, @source, @created_at, @due)").run({ ...w, uid });
    return db.prepare("SELECT * FROM vocab WHERE user_id=? AND word=?").get(uid, w.word);
  },
  explained: k => { const r = db.prepare("SELECT body FROM explanations WHERE test=@test AND module=@module AND n=@n AND answer=@answer").get(k); return r && JSON.parse(r.body); },
  saveExplained: (k, body) => db.prepare("INSERT OR REPLACE INTO explanations VALUES (@test, @module, @n, @answer, @body, @at)").run({ ...k, body: JSON.stringify(body), at: new Date().toISOString() }),
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wma": "audio/x-ms-wma", ".svg": "image/svg+xml" };
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

http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.startsWith("/api/")) return api(req, res, { store, hosted: false });
  if (p.startsWith("/content/")) return sendFile(res, under("content", p.slice(9)));
  if (p.startsWith("/audio/Cambridge-lists-main/")) return sendFile(res, under("Cambridge-lists-main", p.slice(28)), req.headers.range);
  const file = under("dist", p === "/" ? "index.html" : p);   // SPA build
  sendFile(res, file && fs.existsSync(file) ? file : path.join(ROOT, "dist", "index.html"));
}).listen(+process.env.PORT || 3001, () => console.log(`api on http://localhost:${process.env.PORT || 3001}`));   // PORT for side-by-side test runs

if (process.argv.includes("--dev")) spawn("npx", ["vite"], { stdio: "inherit", shell: true });
if (!process.argv.includes("--no-sidecar")) spawn(process.env.PYTHON || "python", [path.join(ROOT, "sidecar/audio.py")], { stdio: "inherit" });  // STT/TTS on :3002
