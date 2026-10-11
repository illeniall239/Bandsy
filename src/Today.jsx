import { useEffect, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";

const NAME = { listening: "Listening", reading: "Reading", writing: "Writing", speaking: "Speaking" };
const MODULES = ["listening", "reading", "writing", "speaking"];

/** Live countdown to 09:00 on the test date (the usual morning session), on the lime card. */
function Countdown({ date, onClick }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, new Date(`${date}T09:00:00`) - now);
  const units = [["days", Math.floor(ms / 864e5)], ["hrs", Math.floor(ms / 36e5) % 24], ["min", Math.floor(ms / 6e4) % 60], ["sec", Math.floor(ms / 1e3) % 60]];
  return (
    <button className="countdown" onClick={onClick} title="Change test date">
      <span className="lbl">Exam in</span>
      <span className="units">{units.map(([u, v], i) => (
        <span key={u} className="unit"><b>{i ? String(v).padStart(2, "0") : v}</b><small>{u}</small></span>))}</span>
    </button>);
}

/** A band as nine segments: whole bands filled, a half band in grey, the rest empty. */
function Segments({ band }) {
  const b = typeof band === "number" ? band : parseFloat(band);
  return (
    <span className="segments" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => (
      <i key={i} className={!isNaN(b) && i + 1 <= b ? "full" : !isNaN(b) && i < b ? "half" : ""} />))}</span>);
}

/** The only screen you're meant to see daily: today's session, the countdown, bands, and the band graph. */
export function Today() {
  const [d, setD] = useState(null);
  useEffect(() => { fetch("/api/today").then(r => r.json()).then(setD); }, []);
  if (!d) return <main className="home"><TopNav /><p className="muted">Loading…</p></main>;
  const s = d.session;
  const module = s.module || s.href?.match(/\/(listening|reading|writing|speaking)(\?|$)/)?.[1];
  const attempts = module ? d.history.filter(a => a.module === module).length : 0;
  const count = s.questions ? [s.questions, "Questions"] : module === "speaking" ? [3, "Parts"] : null;
  const bands = (d.modules || MODULES).map(m => [m, d.bands[m]]);
  const numeric = bands.map(([, b]) => parseFloat(b)).filter(b => !isNaN(b));
  const overall = numeric.length === bands.length ? (Math.round(numeric.reduce((a, b) => a + b, 0) / bands.length * 2) / 2).toFixed(1) : "—";
  const setDate = async () => {
    const v = prompt("Test date (YYYY-MM-DD):", d.test_date);
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    const cur = await fetch("/api/settings").then(r => r.json());
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers: cur.providers, jobs: cur.jobs, test_date: v }) });
    setD({ ...d, test_date: v });
  };
  const eyebrow = `Up next — ${new Date().toLocaleDateString(undefined, { weekday: "long" })}`;

  return (
    <main className="home today">
      <TopNav />
      <div className="dash">
        <section className="card hero">
          <div className="top">
            <span className="eyebrow">{eyebrow}</span>
            <h1>{s.label}</h1>
            <p className="sub">{s.questions ? "Your weakest question type, on a group you haven't done yet."
              : d.bands[d.weakest] != null ? `Your weakest module right now is ${NAME[d.weakest]}.`
              : "Today's session from your weekly rotation. Every test you do is tracked below."}</p>
          </div>
          <div className="bottom">
            <div className="stats">
              <span><b>{s.minutes} min</b><small>Duration</small></span>
              {count && <span><b>{count[0]}</b><small>{count[1]}</small></span>}
              <span><b>{attempts}</b><small>Attempts</small></span>
            </div>
            {s.done
              ? <span className="done">Done for today <a className="btn" href={s.href}>Go again</a></span>
              : <a className="start" href={s.href}>Start <span aria-hidden="true">→</span></a>}
          </div>
        </section>

        <aside className="side">
          <Countdown date={d.test_date} onClick={setDate} />
          <section className="card bandcard">
            <div className="head"><span>Band</span><span>Overall {overall}</span></div>
            <div className="rows">{bands.map(([m, b]) => {
              const has = b != null && b !== "" && !isNaN(parseFloat(b));
              return (
                <div key={m} className={"bandrow" + (has ? "" : " empty")}>
                  <span className="m">{NAME[m]}</span><Segments band={has ? parseFloat(b) : NaN} /><b className="v">{has ? b : "—"}</b>
                </div>);
            })}</div>
          </section>
        </aside>
      </div>

      <Progress history={d.history} drills={d.drills || []} modules={d.modules || MODULES} />
    </main>);
}

const UNIT = { listening: ["Part", 4], reading: ["Passage", 3] };

/** Band over time for one module, or % correct over time for one Listening part / Reading passage drill.
 *  Starts on whatever you practised last. */
function Progress({ history, drills, modules }) {
  const done = modules.filter(m => history.some(a => a.module === m) || drills.some(a => a.module === m));
  const last = [...history, ...drills].sort((a, b) => b.finished_at.localeCompare(a.finished_at)).find(a => modules.includes(a.module));
  const [module, setModule] = useState(last?.module || modules[0]);
  const [part, setPart] = useState(last?.section || 0);   // 0 = full tests
  const unit = UNIT[module];
  const list = part
    ? drills.filter(a => a.module === module && a.section === part).reverse().map(a => ({ ...a, v: Math.round(100 * a.score / a.total) }))
    : [...history].reverse().filter(a => a.module === module).map(a => ({ ...a, v: a.band }));
  const fmt = v => part ? `${v}%` : v;
  return (
    <section className="card graph">
      <div className="head">
        <span>Progress</span>
        <span className="picks">
          <select value={module} onChange={e => { const m = e.target.value; setModule(m); setPart(p => UNIT[m] && p <= UNIT[m][1] ? p : 0); }} aria-label="Module">
            {modules.map(m => <option key={m} value={m}>{NAME[m]}{done.includes(m) ? "" : " (nothing yet)"}</option>)}
          </select>
          {unit && <select value={part} onChange={e => setPart(+e.target.value)} aria-label={unit[0]}>
            <option value={0}>Full tests</option>
            {Array.from({ length: unit[1] }, (_, i) => <option key={i} value={i + 1}>{unit[0]} {i + 1}</option>)}
          </select>}
        </span>
      </div>
      {list.length
        ? <><p className="summary"><b>{fmt(list[list.length - 1].v)}</b> latest · <b>{fmt(Math.max(...list.map(a => a.v)))}</b> best · <b>{list.length}</b> {part ? "session" : "test"}{list.length === 1 ? "" : "s"}</p>
            <BandChart list={list} pct={!!part} /></>
        : <p className="muted empty">{part ? `No ${NAME[module]} ${unit[0]} ${part} drills yet.` : `No full ${NAME[module]} tests yet.`} Finish one and it shows up here.</p>}
    </section>);
}

/** Bands (or % correct with pct) over attempt date; each point is {id, finished_at, test, v}. Hover a point for the exact value. */
function BandChart({ list, pct }) {
  const [hover, setHover] = useState(null);
  const W = innerWidth < 640 ? 360 : 1000, H = innerWidth < 640 ? 220 : 240, L = 40, R = 24, T = 14, B = 34;   // phones: fewer units across, same text size
  const lo = pct ? 0 : Math.min(4, Math.ceil(Math.min(...list.map(a => a.v))) - 1), hi = pct ? 100 : 9, step = pct ? 20 : 1;   // a band-4 point sits above the bottom line
  const t0 = new Date(list[0].finished_at).getTime(), t1 = Math.max(new Date(list[list.length - 1].finished_at).getTime(), t0 + 864e5 * 7);
  const x = t => L + (W - L - R) * (new Date(t).getTime() - t0) / (t1 - t0);
  const y = v => T + (H - T - B) * (hi - v) / (hi - lo);
  const path = list.map((a, i) => `${i ? "L" : "M"}${x(a.finished_at)},${y(a.v)}`).join(" ");
  const day = t => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={pct ? "Percent correct over time" : "Band over time"}>
        {Array.from({ length: (hi - lo) / step + 1 }, (_, i) => lo + i * step).map(b => <g key={b}><line x1={L} x2={W - R} y1={y(b)} y2={y(b)} className="grid" /><text x={L - 12} y={y(b) + 4} className="tick">{b}</text></g>)}
        <text x={L} y={H - 8} className="tick start">{day(t0)}</text>
        <text x={W - R} y={H - 8} className="tick">{day(t1)}</text>
        <path d={path} fill="none" stroke="#111" strokeWidth="2" strokeLinejoin="round" />
        {list.map(a => <circle key={a.id} cx={x(a.finished_at)} cy={y(a.v)} r="5" fill="#111" stroke="#fff" strokeWidth="2"
          onMouseEnter={() => setHover(a)} onMouseLeave={() => setHover(null)} onClick={() => setHover(h => h === a ? null : a)} />)}
        {hover && <text x={Math.min(Math.max(x(hover.finished_at) - 60, L), W - R - 150)} y={y(hover.v) - 14} className="tip">{pct ? `${hover.score}/${hover.total}` : `Band ${hover.v}`} · {hover.test} · {hover.finished_at.slice(0, 10)}</text>}
      </svg>
    </div>);
}

export function History() {
  const [list, setList] = useState([]);
  useEffect(() => { fetch("/api/attempts").then(r => r.json()).then(setList); }, []);
  return (
    <main className="home">
      <TopNav />
      <PageHead eyebrow="Every attempt" title="History" meta="Open any row to see its marked result again." />
      <table className="history">
        <thead><tr><th>When</th><th>Test</th><th>Module</th><th>Mode</th><th>Score</th><th>Band</th></tr></thead>
        <tbody>{list.map(a => (
          <tr key={a.id}><td>{a.finished_at.slice(0, 16).replace("T", " ")}</td><td>{a.test}</td><td>{NAME[a.module]}</td><td>{a.mode}</td>
            <td>{a.module === "writing" ? "" : a.score}</td><td><a className="bandlink" href={`#/r/${a.id}`}>{a.band ?? "—"}</a></td></tr>))}</tbody>
      </table>
    </main>);
}
