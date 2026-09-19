// Hosted build (Vercel + Supabase) when VITE_SUPABASE_URL is set at build time; otherwise the local app talking to server.js.
const URL_ = import.meta.env.VITE_SUPABASE_URL;
export const HOSTED = !!URL_;
export const AUDIO = HOSTED ? `${URL_}/storage/v1/object/public/audio/` : "/audio/";   // + "Cambridge-lists-main/..."
if (HOSTED) window.BANDSY_SPEAKING = false;   // Speaking needs the local speech models
