// Uploads the Listening audio the tests use to the Supabase "audio" bucket, under the same paths the tests reference.
// PowerShell:  $env:SUPABASE_URL="https://<project>.supabase.co"; $env:SUPABASE_SERVICE_KEY="<service_role key>"; node deploy/upload-audio.mjs
// Safe to re-run: files already there are skipped.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(import.meta.dirname, "..");
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error("set SUPABASE_URL and SUPABASE_SERVICE_KEY first"); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const files = new Set();
for (const book of fs.readdirSync(path.join(ROOT, "content")).filter(b => b.startsWith("cam")))
  for (const f of fs.readdirSync(path.join(ROOT, "content", book)).filter(f => f.endsWith(".json")))
    JSON.parse(fs.readFileSync(path.join(ROOT, "content", book, f), "utf8")).listening.audio.forEach(a => files.add(a));

const TYPE = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };
let done = 0;
for (const f of [...files].sort()) {
  const { error } = await sb.storage.from("audio").upload(f, fs.readFileSync(path.join(ROOT, f)), { contentType: TYPE[path.extname(f).toLowerCase()], upsert: false });
  if (error && !/exists/i.test(error.message)) { console.error(`${f}: ${error.message}`); process.exit(1); }
  console.log(`${++done}/${files.size} ${f}${error ? " (already there)" : ""}`);
}
