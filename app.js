// The /api routes, shared by the local server (server.js: SQLite, Speaking) and the hosted Vercel function (api/index.js: Supabase).
// `store` is one person's data: attempts (marked() adds every answer's mark), settings, word bank and the shared explanation cache.
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, JOBS, listModels } from "./providers.js";
import { gradeTask } from "./grading.js";
import { plan, localDay, MODULES } from "./plan.js";
import * as examiner from "./examiner.js";
import { define } from "./review.js";
import { explain } from "./explain.js";
import { rewrite } from "./rewrite.js";

export const ROOT = import.meta.dirname;
const MASK = "••••";   // hosted Settings shows keys as ••••last4
const content = f => JSON.parse(fs.readFileSync(path.join(ROOT, "content", f), "utf8"));

let TESTS;
export function tests() {
  return TESTS ||= fs.readdirSync(path.join(ROOT, "content")).filter(b => b.startsWith("cam")).sort().flatMap(book =>
    fs.readdirSync(path.join(ROOT, "content", book)).filter(f => f.endsWith(".json")).sort().map(f => {
      const t = content(`${book}/${f}`);
      return { id: `${book}/${f.replace(".json", "")}`, book: t.book, test: t.test, module: t.module };
    }));
}

let CATALOG;
/** Every practisable item in the books: one entry per question group, Writing task and Speaking cue card.
 *  The Practice page groups these by type ("map labelling", "process diagram") so a weakness can be drilled directly. */
export function catalog() {
  if (CATALOG) return CATALOG;
  const items = [];
  for (const t of tests()) {
    const d = content(`${t.id}.json`);
    for (const [module, key] of [["listening", "parts"], ["reading", "passages"]])
      d[module][key].forEach((p, i) => p.groups.forEach(g =>
        items.push({ test: t.id, module, type: g.type, section: i + 1, first: g.first, n: g.last - g.first + 1 })));
    d.writing.forEach(w => items.push({ test: t.id, module: "writing", type: `task${w.task}_${w.kind || "other"}`, task: w.task, n: 1 }));
    items.push({ test: t.id, module: "speaking", type: `part2_${d.speaking.kind || "other"}`, n: 1 });
  }
  return CATALOG = items;
}

/** A Writing task's prompt, and its figure's path when it has one. */
function writingTask(test, task) {
  const w = content(`${test}.json`).writing.find(x => x.task === task);
  return { prompt: w.prompt, image: w.image ? path.join(ROOT, "content", test.split("/")[0], w.image) : undefined };
}

/** The book's own answers to a test's Writing tasks, {task: [{kind, band, answer, comment}]} (pipeline/samples.py); {} if not extracted. */
function samples(test) {
  const [book, t] = test.split("/test"), f = path.join(ROOT, "content", book, "samples.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8"))[t] || {} : {};
}

export const json = (res, data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
const raw = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const body = async req => "body" in req ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {})   // Vercel parses JSON bodies itself
  : JSON.parse((await raw(req)).toString() || "{}");

/** Handles one /api request. hosted: no Speaking, and only providers reachable from the internet. */
export async function api(req, res, { store, hosted }) {
  const url = new URL(req.url, "http://x");
  const p = url.searchParams.get("__path") != null ? `/api/${url.searchParams.get("__path")}` : decodeURIComponent(url.pathname);   // Vercel rewrite
  const modules = hosted ? MODULES.filter(m => m !== "speaking") : MODULES;
  const providers = hosted ? Object.fromEntries(Object.entries(PROVIDERS).filter(([id]) => id !== "claude-code" && id !== "ollama")) : PROVIDERS;
  const mine = () => store.settings();
  const fail = e => json(res, { error: e.message }, 502);   // shown verbatim; the user decides what to do (design Q39)
  let m;
  try {
    if (p === "/api/tests") return json(res, tests());
    if (p === "/api/catalog") return json(res, catalog());
    if (p === "/api/attempts" && req.method === "POST") return json(res, { id: await store.addAttempt(await body(req)) });
    if (p === "/api/attempts") return json(res, await store.attempts());
    if (m = p.match(/^\/api\/attempts\/(\d+)$/)) {
      const a = await store.attempt(+m[1]);
      return a ? json(res, a) : json(res, { error: "no such attempt" }, 404);
    }
    if (p === "/api/today") {
      const list = await store.attempts();
      const total = (test, module, section) => catalog().filter(i => i.test === test && i.module === module && i.section === section).reduce((n, i) => n + i.n, 0);
      const drills = list.filter(a => /^drill-s\d+$/.test(a.mode)).map(a => { const section = +a.mode.slice(7); return { ...a, section, total: total(a.test, a.module, section) }; });   // part/passage drills, for the per-part trend
      const tz = Math.max(-840, Math.min(840, +url.searchParams.get("tz") || 0));   // the viewer's offset east of UTC, minutes: "today" is their day
      const { test_date } = await mine();   // the real date only: an unset one leaves the plan in its skill-building phase
      return json(res, { ...plan(localDay(new Date().toISOString(), tz), await store.marked(), catalog(), { modules, tz, examDate: test_date }),
        modules, test_date: test_date || "2026-12-31", history: list.filter(a => a.band != null), drills });
    }
    if (p === "/api/settings" && req.method === "PUT") {
      const s = await body(req), old = await mine();
      // unchanged key: kept only while the base URL is too, or anyone with the link could point a saved key at their own server
      for (const [id, v] of Object.entries(s.providers || {})) if (v.apiKey?.startsWith(MASK)) v.apiKey = v.base === old.providers?.[id]?.base ? old.providers?.[id]?.apiKey : "";
      await store.saveSettings(s); return json(res, { ok: true });
    }
    if (p === "/api/settings") {
      const s = await mine();
      if (hosted) s.providers = Object.fromEntries(Object.entries(s.providers || {}).map(([id, v]) => [id, { ...v, apiKey: v.apiKey ? MASK + v.apiKey.slice(-4) : v.apiKey }]));
      return json(res, { ...s, catalog: providers, jobs_available: JOBS });
    }
    if (p === "/api/vocab/book") return json(res, fs.existsSync(path.join(ROOT, "content", "vocab.json")) ? content("vocab.json") : []);
    if (p === "/api/vocab" && req.method === "POST") return json(res, await store.addWord(await define(await mine(), await body(req))));
    if (p === "/api/vocab") return json(res, await store.words());
  } catch (e) { return fail(e); }
  // model jobs
  try {
    if (p === "/api/models") return json(res, await listModels(await mine(), url.searchParams.get("provider")));
    if (p === "/api/grade" && req.method === "POST") {
      const { test, task, text } = await body(req);
      return json(res, await gradeTask(await mine(), { task, ...writingTask(test, task), text, references: samples(test)[task] || [] }));
    }
    if (p === "/api/rewrite" && req.method === "POST") {
      const { test, task, text, marks } = await body(req);
      const feedback = [...Object.entries(marks.criteria).map(([k, c]) => `${k} (band ${c.band}): ${c.comment}`),
        ...(marks.errors || []).slice(0, 15).map(e => `"${e.quote}" -> "${e.correction}" (${e.explanation})`)].join("\n");
      return json(res, await rewrite(await mine(), { task, ...writingTask(test, task), text, feedback, references: samples(test)[task] || [] }));
    }
    if (p === "/api/explain" && req.method === "POST") return json(res, await explain(await mine(), store, await body(req)));
    if (p.startsWith("/api/speaking/") && !hosted) {
      if (p.endsWith("/start")) {
        const { test, mode } = await body(req);
        return json(res, await examiner.start(await mine(), { test, speaking: content(`${test}.json`).speaking, mode }));
      }
      if (p.endsWith("/turn")) return json(res, await examiner.turn(await mine(), { session: url.searchParams.get("session"), audio: await raw(req) }));
      if (p.endsWith("/finish")) return json(res, await examiner.finish(await mine(), await body(req)));
    }
  } catch (e) { return fail(e); }
  return json(res, { error: "not found" }, 404);
}
