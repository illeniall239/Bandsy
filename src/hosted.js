// Hosted build (Vercel + Supabase) when VITE_SUPABASE_URL is set at build time; otherwise the local app talking to server.js.
import { createClient } from "@supabase/supabase-js";

const URL_ = import.meta.env.VITE_SUPABASE_URL;
export const HOSTED = !!URL_;
export const supabase = HOSTED ? createClient(URL_, import.meta.env.VITE_SUPABASE_ANON_KEY) : null;
export const AUDIO = HOSTED ? `${URL_}/storage/v1/object/public/audio/` : "/audio/";   // + "Cambridge-lists-main/..."

if (HOSTED) {
  window.BANDSY_SPEAKING = false;   // Speaking needs the local speech models
  // every /api call carries the user's session token; a rejected one signs out
  const _fetch = window.fetch;
  window.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith("/api/")) return _fetch(url, opts);
    const { data } = await supabase.auth.getSession();
    const r = await _fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${data.session?.access_token || ""}` } });
    if (r.status === 401) { await supabase.auth.signOut(); location.reload(); }
    return r;
  };
}
