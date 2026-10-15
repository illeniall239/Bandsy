import { useEffect, useRef, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";
import { Tips } from "./Tips.jsx";
import { saveAttempt } from "./save.js";

const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const wc = t => t.trim().split(/\s+/).filter(Boolean).length;
const writingBand = (t1, t2) => Math.round(((t1 + 2 * t2) / 3) * 2) / 2;

/** CD-IELTS Writing: task left (figure for Task 1), plain editor right, live word count, spell-check off, 60 min shared. */
export function WritingScreen({ test, id, mode, only, onDone }) {
  const base = `/content/${id.split("/")[0]}/`;
  const tasks = only ? [only] : [1, 2];     // a drill is one task
  const [task, setTask] = useState(tasks[0]);
  const draft = `bandsy-draft:${id}`;   // the essay is kept in this browser as you type, until it's graded: a failed grading or leaving the page loses nothing
  const [text, setText] = useState(() => { try { return { 1: "", 2: "", ...JSON.parse(localStorage.getItem(draft)) }; } catch { return { 1: "", 2: "" }; } });
  useEffect(() => { try { localStorage.setItem(draft, JSON.stringify(text)); } catch {} }, [text]);
  const [pane, setPane] = useState("task");   // phones: task or answer
  const [left, setLeft] = useState(only ? (only === 1 ? 20 : 40) * 60 : 60 * 60);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const started = useRef(new Date().toISOString());
  const timeUp = useRef(false);

  const submit = async () => {
    setError("");
    const marks = {};
    for (const t of tasks) {
      if (!text[t].trim()) continue;
      setBusy(`Grading Task ${t}…`);
      const r = await fetch("/api/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: id, task: t, text: text[t] }) }).then(r => r.json())
        .catch(e => ({ error: `Grading request failed: ${e.message}` }));   // server down, or a non-JSON reply (e.g. a hosted timeout page)
      if (r.error) { setBusy(""); return setError(r.error); }
      marks[t] = r;
    }
    setBusy("");
    if (!marks[1] && !marks[2]) return setError("Nothing to grade — both tasks are empty.");
    const band = marks[1] && marks[2] ? writingBand(marks[1].band, marks[2].band) : (marks[1] || marks[2]).band;
    const result = { test: id, module: "writing", mode: only ? `drill-t${only}` : mode, started_at: started.current, finished_at: new Date().toISOString(),
      answers: text, marks, score: 0, band: only ? null : band, task_band: band };   // one task is not a Writing band
    saveAttempt(result);
    try { localStorage.removeItem(draft); } catch {}
    onDone(result);
  };
  useEffect(() => {   // countdown; at zero submit once — if grading fails, the error stays and Submit retries by hand
    if (mode !== "mock" || busy || timeUp.current) return;
    if (left <= 0) { timeUp.current = true; return void submit(); }
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
          <Tips key={task} keys={[`task${task}`, `task${task}_${w.kind}`]} mock={!only} />
        </div>
        <div className="editor">
          <textarea value={text[task]} spellCheck={false} autoCorrect="off" autoCapitalize="off" placeholder="Type your answer here"
            onChange={e => setText({ ...text, [task]: e.target.value })} />
          <div className="count">Words: {wc(text[task])}{wc(text[task]) < min && <span className="short"> · minimum {min}</span>}</div>
        </div>
      </div>
    </div>);
}

/** Bands per criterion, the answer with errors marked (hover for the fix), and beside it the same answer with the corrections applied. */
export function WritingResult({ test, result }) {
  const [task, setTask] = useState(result.marks[1] ? 1 : 2);
  const [book, setBook] = useState({});   // the book's own answers to this test's tasks, if extracted
  useEffect(() => { fetch(`/content/${result.test.split("/")[0]}/samples.json`).then(r => r.ok ? r.json() : {}).then(s => setBook(s[test.test] || {})).catch(() => {}); }, []);
  const m = result.marks[task];
  return (
    <main className="home result wresult">
      <TopNav />
      <PageHead eyebrow={`Cambridge ${test.book} · Test ${test.test} · Writing`} title={<>Band <span className="bandnum">{result.band ?? m.band}</span></>}
        meta={result.band == null ? "One task only — not a full Writing band" : "Task 2 counts double"}><a className="btn primary" href="#/">Back to Home</a></PageHead>
      <div className="tabs">{[1, 2].map(t => result.marks[t] && <button key={t} className={task === t ? "on" : ""} onClick={() => setTask(t)}>Task {t} · band {result.marks[t].band}</button>)}</div>
      {m.calibrated?.length > 0 && <p className="muted">Marked against the book's own Band {m.calibrated.join(" and ")} answer to this task, as a real examiner graded it.</p>}
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
          <h3>Your answer, corrected <small>({fixed(result.answers[task], m.errors).length} fixes)</small></h3>
          <p className="body">{markErrors(result.answers[task], fixed(result.answers[task], m.errors), true)}</p>
        </section>
      </div>
      <section>
        <h3>Corrections</h3>
        <ol className="errors">{m.errors.map((e, i) => <li key={i}><span className={"kind " + e.kind}>{e.kind}</span> <s>{e.quote}</s> → <b>{e.correction}</b><br /><small>{e.explanation}</small></li>)}</ol>
      </section>
      {(book[task] || []).length > 0 && (
        <section className="book">
          <h3>From the book <small>(Cambridge {test.book}, an examiner's marking of this task)</small></h3>
          {book[task].map((s, i) => (
            <div key={i} className="sample">
              <h4>{s.kind === "model" ? "An examiner's model answer" : <>A candidate's answer · Band {s.band}</>}</h4>
              {s.comment && <p><b>Examiner's comment.</b> {s.comment}</p>}
              {s.answer
                ? <details><summary>Read the answer ({s.answer.split(/\s+/).length} words{s.kind === "candidate" ? ", mistakes and all" : ""}{s.source === "ocr" ? "; read from the page by OCR" : ""})</summary><p className="body">{s.answer}</p></details>
                : <p className="muted">Only the examiner's comment could be extracted for this one.</p>}
            </div>))}
        </section>)}
    </main>);
}

/** The errors that can replace their quote in place: a "task" error is advice ("add an overview"), not wording. */
const fixed = (text, errors) => errors.filter(e => e.kind !== "task" && e.quote && text.includes(e.quote));

/** The answer with each error's quote marked (hover: the fix), or with corrected=true each quote replaced by its correction
 *  (hover: what you wrote). First occurrence of each quote, overlapping ones skipped. */
function markErrors(text, errors, corrected = false) {
  const spans = [];
  for (const [i, e] of errors.entries()) {
    const at = text.indexOf(e.quote);
    if (at >= 0 && !spans.some(s => at < s.e && at + e.quote.length > s.s)) spans.push({ s: at, e: at + e.quote.length, i });
  }
  spans.sort((a, b) => a.s - b.s);
  const out = []; let pos = 0;
  for (const s of spans) {
    const e = errors[s.i];
    out.push(text.slice(pos, s.s));
    out.push(corrected
      ? <ins key={s.i} className={"fix " + e.kind} title={`You wrote: ${e.quote} — ${e.explanation}`}>{e.correction}</ins>
      : <mark key={s.i} className={"err " + e.kind} title={`${e.correction} — ${e.explanation}`}>{text.slice(s.s, s.e)}</mark>);
    pos = s.e;
  }
  out.push(text.slice(pos));
  return out;
}
