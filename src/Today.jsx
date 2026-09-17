import { useEffect, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";

// Swiss Neutral charts stay monochrome: modules differ by grey step and dash, and every line is labelled at its end.
const SERIES = { listening: ["#111111", ""], reading: ["#8A8A85", ""], writing: ["#111111", "6 5"], speaking: ["#8A8A85", "6 5"] };
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
  const title = s.label.replace(/^Diagnostic\s*·\s*/, "");
  const attempts = module ? d.history.filter(a => a.module === module).length : 0;
  const count = { listening: [40, "Questions"], reading: [40, "Questions"], writing: [2, "Tasks"], speaking: [3, "Parts"] }[module];
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
  const eyebrow = d.phase === "diagnostic" ? "Up next — Diagnostic" : `Up next — ${new Date().toLocaleDateString(undefined, { weekday: "long" })}`;

  return (
    <main className="home today">
      <TopNav />
      <div className="dash">
        <section className="card hero">
          <div className="top">
            <span className="eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
            <p className="sub">{s.mode === "rest"
              ? <>Nothing scheduled today. Browse the <a href="#/vocab">word bank</a> or pick any test if you feel like it.</>
              : d.weakest && d.phase === "rotation" ? `Your weakest module right now is ${NAME[d.weakest]}.`
              : "Your result sets the starting band for your study plan."}</p>
          </div>
          {s.mode !== "rest" && (
            <div className="bottom">
              <div className="stats">
                <span><b>{s.minutes} min</b><small>Duration</small></span>
                {count && <span><b>{count[0]}</b><small>{count[1]}</small></span>}
                <span><b>{attempts}</b><small>Attempts</small></span>
              </div>
              {s.done
                ? <span className="done">Done for today <a className="btn" href={s.href}>Go again</a></span>
                : <a className="start" href={s.href}>Start <span aria-hidden="true">→</span></a>}
            </div>)}
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

      <section className="card graph">
        <div className="head"><span>Band over time</span></div>
        <BandChart history={d.history} />
      </section>
    </main>);
}

/** One line per module over attempt date; y = band 4–9. Hover a point for the exact value. */
function BandChart({ history }) {
  const [hover, setHover] = useState(null);
  const pts = [...history].reverse().filter(a => a.band != null);
  if (!pts.length) return <p className="muted empty">No full attempts yet — the diagnostic puts the first point here.</p>;
  const W = 1000, H = 240, L = 40, R = 120, T = 14, B = 28;
  const t0 = new Date(pts[0].finished_at).getTime(), t1 = Math.max(new Date(pts[pts.length - 1].finished_at).getTime(), t0 + 864e5 * 7);
  const x = t => L + (W - L - R) * (new Date(t).getTime() - t0) / (t1 - t0);
  const y = b => T + (H - T - B) * (9 - b) / 5;
  const byMod = {};
  for (const a of pts) (byMod[a.module] ||= []).push(a);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Band by module over time">
        {[4, 5, 6, 7, 8, 9].map(b => <g key={b}><line x1={L} x2={W - R} y1={y(b)} y2={y(b)} className="grid" /><text x={L - 12} y={y(b) + 4} className="tick">{b}</text></g>)}
        {(() => {
          const ends = Object.entries(byMod).map(([m, list]) => ({ m, y: y(list[list.length - 1].band) })).sort((a, b) => a.y - b.y);
          for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 16) ends[i].y = ends[i - 1].y + 16;
          return Object.entries(byMod).map(([m, list]) => ({ m, list, ly: ends.find(e => e.m === m).y }));
        })().map(({ m, list, ly }) => {
          const path = list.map((a, i) => `${i ? "L" : "M"}${x(a.finished_at)},${y(a.band)}`).join(" ");
          const last = list[list.length - 1];
          const [stroke, dash] = SERIES[m];
          return (
            <g key={m}>
              <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeDasharray={dash} strokeLinejoin="round" />
              {list.map(a => <circle key={a.id} cx={x(a.finished_at)} cy={y(a.band)} r="4.5" fill={stroke} stroke="#fff" strokeWidth="2"
                onMouseEnter={() => setHover(a)} onMouseLeave={() => setHover(null)} />)}
              <text x={x(last.finished_at) + 12} y={ly + 4} className="label">{NAME[m]} <tspan className="lv">{last.band}</tspan></text>
            </g>);
        })}
        {hover && <text x={Math.min(x(hover.finished_at), W - R - 90)} y={y(hover.band) - 12} className="tip">{NAME[hover.module]} {hover.band} · {hover.finished_at.slice(0, 10)}</text>}
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
      <table>
        <thead><tr><th>When</th><th>Test</th><th>Module</th><th>Mode</th><th>Score</th><th>Band</th></tr></thead>
        <tbody>{list.map(a => (
          <tr key={a.id}><td>{a.finished_at.slice(0, 16).replace("T", " ")}</td><td>{a.test}</td><td>{NAME[a.module]}</td><td>{a.mode}</td>
            <td>{a.module === "writing" ? "" : a.score}</td><td><a className="bandlink" href={`#/r/${a.id}`}>{a.band ?? "—"}</a></td></tr>))}</tbody>
      </table>
    </main>);
}
