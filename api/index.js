// The hosted /api (Vercel): the same routes as the local server (app.js), with the signed-in Supabase user's data.
// Row Level Security does the access control: the client is created with the user's own token, so every query sees only their rows.
import { createClient } from "@supabase/supabase-js";
import { api, json } from "../app.js";

const URL_ = process.env.VITE_SUPABASE_URL, KEY = process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(res, { error: "signed out" }, 401);
  const sb = createClient(URL_, KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return json(res, { error: "signed out" }, 401);

  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const store = {
    attempts: async () => ok(await sb.from("attempts").select("id, test, module, mode, started_at, finished_at, score, band").order("id", { ascending: false })),
    attempt: async id => ok(await sb.from("attempts").select("*").eq("id", id).maybeSingle()),
    addAttempt: async ({ test, module, mode, started_at, finished_at, answers, marks, score, band }) =>
      ok(await sb.from("attempts").insert({ user_id: user.id, test, module, mode, started_at, finished_at, answers, marks, score, band }).select("id").single()).id,
    settings: async () => ok(await sb.from("settings").select("value").maybeSingle())?.value || { providers: {}, jobs: {} },
    saveSettings: async value => ok(await sb.from("settings").upsert({ user_id: user.id, value })),
    words: async () => ok(await sb.from("vocab").select("*").order("id", { ascending: false })),
    addWord: async w => {
      ok(await sb.from("vocab").upsert({ ...w, user_id: user.id }, { onConflict: "user_id,word", ignoreDuplicates: true }));
      return ok(await sb.from("vocab").select("*").eq("word", w.word).single());
    },
    explained: async k => ok(await sb.from("explanations").select("body").match(k).maybeSingle())?.body,
    saveExplained: async (k, body) => ok(await sb.from("explanations").upsert({ ...k, body })),
  };
  return api(req, res, { store, hosted: true });
}
