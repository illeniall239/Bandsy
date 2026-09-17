// Model providers behind one call: complete({job, system, prompt, schema, image}) -> parsed JSON.
// Settings (keys, base URLs, per-job model) live in the settings table; nothing has a default (design Q38).
// Providers: "claude-code" = Claude Code subprocess on the subscription (no API key);
//            everything else speaks the OpenAI chat shape (OpenAI, Groq, Gemini, Ollama, custom base URL).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const PROVIDERS = {
  "claude-code": { label: "Claude (subscription via Claude Code)", models: ["opus", "sonnet", "haiku"] },
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", key: true },
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", key: true },
  gemini: { label: "Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", key: true },
  ollama: { label: "Ollama (local)", base: "http://localhost:11434/v1" },
  custom: { label: "Custom OpenAI-compatible", base: "", key: true },
};
export const JOBS = { grading: "Writing grading (needs vision for Task 1 charts)", examiner: "Speaking: Part 3 follow-ups, tutor mode, feedback (a fast model keeps tutor mode conversational)",
  small: "Small tasks: Explain on Listening/Reading answers, word definitions, checking error-card rewrites" };

export function makeSettings(db) {
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const get = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='app'").get()?.value || '{"providers":{},"jobs":{}}');
  const set = s => db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s));
  return { get, set };
}

const conf = (settings, id) => ({ ...PROVIDERS[id], ...(settings.providers[id] || {}) });

export async function listModels(settings, id) {
  const c = conf(settings, id);
  if (id === "claude-code") return c.models;
  const r = await fetch(`${c.base}/models`, { headers: c.key && c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {} });
  if (!r.ok) throw new Error(`${id}: ${r.status} ${await r.text()}`);
  return (await r.json()).data.map(m => m.id).sort();
}

/** job -> "provider:model" from settings; throws a plain message the UI shows verbatim. */
export async function complete(settings, { job, system, prompt, schema, image }) {
  const spec = settings.jobs[job];
  if (!spec) throw new Error(`No model chosen for "${JOBS[job] || job}" — pick one in Settings.`);
  const [id, model] = spec.split(/:(.+)/);
  if (id === "claude-code") return claudeCode(model, system, prompt, schema, image);
  return openaiCompatible(conf(settings, id), model, system, prompt, schema, image);
}

// Windows: the `claude` shim is a .cmd; spawning through a shell breaks the JSON argument quoting, so call the exe it wraps.
const CLAUDE = [path.join(process.env.APPDATA || "", "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe")].find(p => fs.existsSync(p)) || "claude";

function claudeCode(model, system, prompt, schema, image) {
  // same token diet as the extraction pipeline: own system prompt, no settings, no tools (Read only for an image)
  const args = ["-p", "--model", model, "--output-format", "json", "--json-schema", JSON.stringify(schema), "--system-prompt", system,
    "--setting-sources=", "--no-session-persistence", "--tools", image ? "Read" : "", "--max-turns", image ? "3" : "2"];
  return new Promise((resolve, reject) => {
    const p = spawn(CLAUDE, args, { cwd: image ? path.dirname(image) : undefined });
    let out = "", err = "";
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("close", () => {
      let o; try { o = JSON.parse(out); } catch { return reject(new Error(`Claude Code gave no result: ${err.slice(-300)}`)); }
      // a rate limit arrives as is_error with the CLI's message — surfaced as-is, never retried on another model (design Q39)
      if (o.is_error || !o.structured_output) return reject(new Error(o.result || "Claude Code returned nothing"));
      resolve(o.structured_output);
    });
    p.stdin.end((image ? `Read ${path.basename(image)} (the task's figure).\n` : "") + prompt);
  });
}

async function openaiCompatible(c, model, system, prompt, schema, image) {
  const content = image
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(image).toString("base64")}` } }]
    : prompt;
  const r = await fetch(`${c.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: "out", schema, strict: false } }, temperature: 0.2 }),
  });
  if (!r.ok) throw new Error(`${c.label}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const text = (await r.json()).choices[0].message.content;
  try { return JSON.parse(text.replace(/^```json\s*|```$/g, "")); } catch { throw new Error(`${c.label} did not return JSON: ${text.slice(0, 200)}`); }
}
