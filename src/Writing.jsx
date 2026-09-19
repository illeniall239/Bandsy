import { useEffect, useRef, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";

const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const wc = t => t.trim().split(/\s+/).filter(Boolean).length;
const writingBand = (t1, t2) => Math.round(((t1 + 2 * t2) / 3) * 2) / 2;

/** CD-IELTS Writing: task left (figure for Task 1), plain editor right, live word count, spell-check off, 60 min shared. */
export function WritingScreen({ test, id, mode, only, onDone }) {
  const base = `/content/${id.split("/")[0]}/`;
  const tasks = only ? [only] : [1, 2];     // a drill is one task
  const [task, setTask] = useState(tasks[0]);
  const [text, setText] = useState({ 1: "", 2: "" });
  const [pane, setPane] = useState("task");   // phones: task or answer
  const [left, setLeft] = useState(only ? (only === 1 ? 20 : 40) * 60 : 60 * 60);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const started = useRef(new Date().toISOString());

  const submit = async () => {
    setError("");
    const marks = {};
    for (const t of tasks) {
      if (!text[t].trim()) continue;
      setBusy(`Grading Task ${t}…`);
      const r = await fetch("/api/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: id, task: t, text: text[t] }) }).then(r => r.json());
      if (r.error) { setBusy(""); return setError(r.error); }
      marks[t] = r;
    }
    setBusy("");
    if (!marks[1] && !marks[2]) return setError("Nothing to grade — both tasks are empty.");
    const band = marks[1] && marks[2] ? writingBand(marks[1].band, marks[2].band) : (marks[1] || marks[2]).band;
    const result = { test: id, module: "writing", mode: only ? `drill-t${only}` : mode, started_at: started.current, finished_at: new Date().toISOString(),
      answers: text, marks, score: 0, band: only ? null : band, task_band: band };   // one task is not a Writing band
    fetch("/api/attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) }).catch(() => {});
    onDone(result);
  };
  useEffect(() => {
    if (mode !== "mock" || busy) return;
    if (left <= 0) return void submit();
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  });

  const w = test.writing.find(x => x.task === task);
  const min = task === 1 ? 150 : 250;
  return (
    <div className="test">
      <header className="bar">
        <span className="left">Cambridge {test.book} · Test {test.test} · Writing</span>
        <span className="clock">{mode === "mock" ? fmt(left) : ""}</span>
        <span><button className="primary" disabled={!!busy} onClick={() => confirm("Submit for grading?") && submit()}>{busy || "Submit"}</button></span>
      </header>
      {error && <div className="error">{error}</div>}
      <div className={"stage writing show-" + pane}>
        <div className="panes">{[["task", "Task"], ["answer", "Answer"]].map(([k, l]) =>
          <button key={k} className={pane === k ? "on" : ""} onClick={() => setPane(k)}>{l}</button>)}</div>
        <div className="task">
          <div className="tabs">{tasks.map(t => <button key={t} className={task === t ? "on" : ""} onClick={() => setTask(t)}>Task {t}</button>)}</div>
          <p className="body">{w.prompt}</p>
          {w.image && <img className="figure" src={base + w.image} alt="Task figure" />}
        </div>
        <div className="editor">
          <textarea value={text[task]} spellCheck={false} autoCorrect="off" autoCapitalize="off" placeholder="Type your answer here"
            onChange={e => setText({ ...text, [task]: e.target.value })} />
          <div className="count">Words: {wc(text[task])}{wc(text[task]) < min && <span className="short"> · minimum {min}</span>}</div>
        </div>
      </div>
    </div>);
}

/** Bands per criterion, the answer with errors marked (hover for the fix), band-8 rewrite beside it. */
export function WritingResult({ test, result }) {
  const [task, setTask] = useState(result.marks[1] ? 1 : 2);
  const m = result.marks[task];
  return (
    <main className="home result wresult">
      <TopNav />
      <PageHead eyebrow={`Cambridge ${test.book} · Test ${test.test} · Writing`} title={<>Band <span className="bandnum">{result.band ?? m.band}</span></>}
        meta={result.band == null ? "One task only — not a full Writing band" : "Task 2 counts double"}><a className="btn primary" href="#/">Back to Home</a></PageHead>
      <div className="tabs">{[1, 2].map(t => result.marks[t] && <button key={t} className={task === t ? "on" : ""} onClick={() => setTask(t)}>Task {t} · band {result.marks[t].band}</button>)}</div>
      <table className="criteria"><tbody>
        {Object.entries({ task: task === 1 ? "Task Achievement" : "Task Response", coherence: "Coherence & Cohesion", lexical: "Lexical Resource", grammar: "Grammatical Range & Accuracy" }).map(([k, label]) => (
          <tr key={k}><th>{label}</th><td className="band">{m.criteria[k].band}</td><td>{m.criteria[k].comment}</td></tr>))}
      </tbody></table>
      <div className="side">
        <section>
          <h3>Your answer <small>({m.words} words · {m.errors.length} marks)</small></h3>
          <p className="body">{markErrors(result.answers[task], m.errors)}</p>
        </section>
        <section>
          <h3>Band-8 rewrite</h3>
          <p className="body">{m.rewrite}</p>
        </section>
      </div>
      <section>
        <h3>Corrections</h3>
        <ol className="errors">{m.errors.map((e, i) => <li key={i}><span className={"kind " + e.kind}>{e.kind}</span> <s>{e.quote}</s> → <b>{e.correction}</b><br /><small>{e.explanation}</small></li>)}</ol>
      </section>
    </main>);
}

function markErrors(text, errors) {
  const spans = [];
  for (const [i, e] of errors.entries()) {
    const at = text.indexOf(e.quote);
    if (at >= 0 && !spans.some(s => at < s.e && at + e.quote.length > s.s)) spans.push({ s: at, e: at + e.quote.length, i });
  }
  spans.sort((a, b) => a.s - b.s);
  const out = []; let pos = 0;
  for (const s of spans) {
    out.push(text.slice(pos, s.s));
    out.push(<mark key={s.i} className={"err " + errors[s.i].kind} title={`${errors[s.i].correction} — ${errors[s.i].explanation}`}>{text.slice(s.s, s.e)}</mark>);
    pos = s.e;
  }
  out.push(text.slice(pos));
  return out;
}
