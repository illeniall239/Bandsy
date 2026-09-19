// The hosted /api (Vercel): the same routes as the local server (app.js), with the data in Supabase.
// No sign-in: one owner. The service key and the owner id are Vercel secrets (never sent to the browser), and the tables stay
// closed to the public anon key by Row Level Security, so only this function can read them.
import { createClient } from "@supabase/supabase-js";
import { api } from "../app.js";

const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const OWNER = process.env.BANDSY_OWNER_ID;

const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const store = {
  attempts: async () => ok(await sb.from("attempts").select("id, test, module, mode, started_at, finished_at, score, band").eq("user_id", OWNER).order("id", { ascending: false })),
  attempt: async id => ok(await sb.from("attempts").select("*").eq("user_id", OWNER).eq("id", id).maybeSingle()),
  addAttempt: async ({ test, module, mode, started_at, finished_at, answers, marks, score, band }) =>
    ok(await sb.from("attempts").insert({ user_id: OWNER, test, module, mode, started_at, finished_at, answers, marks, score, band }).select("id").single()).id,
  settings: async () => ok(await sb.from("settings").select("value").eq("user_id", OWNER).maybeSingle())?.value || { providers: {}, jobs: {} },
  saveSettings: async value => ok(await sb.from("settings").upsert({ user_id: OWNER, value })),
  words: async () => ok(await sb.from("vocab").select("*").eq("user_id", OWNER).order("id", { ascending: false })),
  addWord: async w => {
    ok(await sb.from("vocab").upsert({ ...w, user_id: OWNER }, { onConflict: "user_id,word", ignoreDuplicates: true }));
    return ok(await sb.from("vocab").select("*").eq("user_id", OWNER).eq("word", w.word).single());
  },
  explained: async k => ok(await sb.from("explanations").select("body").match(k).maybeSingle())?.body,
  saveExplained: async (k, body) => ok(await sb.from("explanations").upsert({ ...k, body })),
};

export default (req, res) => api(req, res, { store, hosted: true });
