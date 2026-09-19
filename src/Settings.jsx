import { useEffect, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";
import { HOSTED, supabase } from "./hosted.js";

/** Providers (keys, base URLs) and one model per job. No defaults: a job without a model refuses to run.
 *  Model lists load by themselves for every provider that is reachable (Claude, Ollama, any provider with a key);
 *  "Reload" only matters after you change a key or URL. */
export function Settings() {
  const [s, setS] = useState(null);
  const [models, setModels] = useState({});   // provider -> [ids] | {error} | "loading"
  const [saved, setSaved] = useState("");
  useEffect(() => { fetch("/api/settings").then(r => r.json()).then(setS); }, []);

  const ready = (settings, id) => id === "claude-code" || id === "ollama" || !!settings.providers[id]?.apiKey;
  const fetchModels = async id => {
    setModels(m => ({ ...m, [id]: "loading" }));
    const r = await fetch(`/api/models?provider=${id}`).then(r => r.json()).catch(e => ({ error: e.message }));
    setModels(m => ({ ...m, [id]: r }));
  };
  useEffect(() => {   // on open: every provider that can answer, at once
    if (!s) return;
    Object.keys(s.catalog).filter(id => ready(s, id)).forEach(fetchModels);
  }, [!!s]);
  if (!s) return <p className="home">Loading…</p>;

  const prov = (id, patch) => setS({ ...s, providers: { ...s.providers, [id]: { ...(s.providers[id] || {}), ...patch } } });
  const save = async () => {
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers: s.providers, jobs: s.jobs, test_date: s.test_date }) });
    setSaved("Saved"); setTimeout(() => setSaved(""), 1500);
  };
  const reload = async id => { await save(); fetchModels(id); };
  const options = Object.entries(models).flatMap(([id, list]) => Array.isArray(list) ? list.map(m => `${id}:${m}`) : []);
  const status = id => {
    const r = models[id];
    if (r === "loading") return "loading…";
    if (Array.isArray(r)) return `${r.length} models`;
    if (r?.error) return r.error;
    return ready(s, id) ? "" : "add a key, then Reload";
  };

  return (
    <main className="home settings">
      <TopNav />
      <PageHead eyebrow="Models & providers" title="Settings" meta="Pick a model for each job. Nothing is chosen for you.">
        {HOSTED && <button onClick={() => supabase.auth.signOut()}>Sign out</button>}
      </PageHead>
      <h2>Providers</h2>
      <table><tbody>{Object.entries(s.catalog).map(([id, c]) => (
        <tr key={id}>
          <th>{c.label}</th>
          <td>
            {c.key !== undefined && c.key && <input type="password" placeholder="API key" value={s.providers[id]?.apiKey || ""} onChange={e => prov(id, { apiKey: e.target.value })} />}
            {(id === "custom" || id === "ollama") && <input placeholder="Base URL" value={s.providers[id]?.base ?? c.base} onChange={e => prov(id, { base: e.target.value })} />}
          </td>
          <td><button onClick={() => reload(id)} disabled={models[id] === "loading"}>Reload</button>
            <small className={"muted" + (models[id]?.error ? " bad" : "")}> {status(id)}</small></td>
        </tr>))}</tbody></table>

      <h2>Model per job</h2>
      <table><tbody>{Object.entries(s.jobs_available).map(([job, label]) => (
        <tr key={job}><th>{label}</th><td>
          <select value={s.jobs[job] || ""} onChange={e => setS({ ...s, jobs: { ...s.jobs, [job]: e.target.value } })}>
            <option value="">— not set —</option>
            {s.jobs[job] && !options.includes(s.jobs[job]) && <option value={s.jobs[job]}>{s.jobs[job]}</option>}
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select></td></tr>))}</tbody></table>
      <p><button className="primary" onClick={save}>Save</button> <span className="muted">{saved}</span></p>
    </main>);
}
