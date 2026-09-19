// The /api routes, shared by the local server (server.js: SQLite, Speaking) and the hosted Vercel function (api/index.js: Supabase).
// `store` is one person's data: attempts, settings, word bank and the shared explanation cache.
import fs from "node:fs";
import path from "node:path";
import { PROVIDERS, JOBS, listModels } from "./providers.js";
import { gradeTask } from "./grading.js";
import { plan, MODULES } from "./plan.js";
import * as examiner from "./examiner.js";
import { define } from "./review.js";
import { explain } from "./explain.js";

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

export const json = (res, data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
const raw = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const body = async req => "body" in req ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {})   // Vercel parses JSON bodies itself
  : JSON.parse((await raw(req)).toString() || "{}");

/** Handles one /api request. hosted: no Speaking, and only providers reachable from the internet. */
export async function api(req, res, { store, hosted }) {
  const url = new URL(req.url, "http://x");
  const p = url.searchParams.get("__path") != null ? `/api/${url.searchParams.get("__path")}` : decodeURIComponent(url.pathname);   // Vercel rewrite
  const modules = hosted ? MODULES.filter(m => m !== "speaking") : MODULES;
  const catalog = hosted ? Object.fromEntries(Object.entries(PROVIDERS).filter(([id]) => id !== "claude-code" && id !== "ollama")) : PROVIDERS;
  const mine = () => store.settings();
  const fail = e => json(res, { error: e.message }, 502);   // shown verbatim; the user decides what to do (design Q39)
  let m;
  try {
    if (p === "/api/tests") return json(res, tests());
    if (p === "/api/attempts" && req.method === "POST") return json(res, { id: await store.addAttempt(await body(req)) });
    if (p === "/api/attempts") return json(res, await store.attempts());
    if (m = p.match(/^\/api\/attempts\/(\d+)$/)) {
      const a = await store.attempt(+m[1]);
      return a ? json(res, a) : json(res, { error: "no such attempt" }, 404);
    }
    if (p === "/api/today") {
      const list = await store.attempts();
      return json(res, { ...plan(new Date(), tests(), list, modules), modules, test_date: (await mine()).test_date || "2026-12-31", history: list.filter(a => a.band != null) });
    }
    if (p === "/api/settings" && req.method === "PUT") {
      const s = await body(req), old = await mine();
      for (const [id, v] of Object.entries(s.providers || {})) if (v.apiKey?.startsWith(MASK)) v.apiKey = old.providers?.[id]?.apiKey;   // unchanged key
      await store.saveSettings(s); return json(res, { ok: true });
    }
    if (p === "/api/settings") {
      const s = await mine();
      if (hosted) s.providers = Object.fromEntries(Object.entries(s.providers || {}).map(([id, v]) => [id, { ...v, apiKey: v.apiKey ? MASK + v.apiKey.slice(-4) : v.apiKey }]));
      return json(res, { ...s, catalog, jobs_available: JOBS });
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
      const w = content(`${test}.json`).writing.find(x => x.task === task);
      const image = w.image ? path.join(ROOT, "content", test.split("/")[0], w.image) : undefined;
      return json(res, await gradeTask(await mine(), { task, prompt: w.prompt, image, text }));
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
