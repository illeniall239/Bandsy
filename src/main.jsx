import { useEffect, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";
import { createRoot } from "react-dom/client";
import { TestScreen } from "./Test.jsx";
import { WritingScreen, WritingResult } from "./Writing.jsx";
import { Settings } from "./Settings.jsx";
import { Today, History } from "./Today.jsx";
import { SpeakingScreen, SpeakingResult } from "./Speaking.jsx";
import { Vocabulary } from "./Vocabulary.jsx";
import "./style.css";

// hash routes: #/            home
//              #/t/cam15/test1/listening?mode=mock|drill
const route = () => { const [p, q] = location.hash.slice(1).split("?"); const u = new URLSearchParams(q); return { path: p || "/", mode: u.get("mode") || "mock", section: +u.get("section") || 0, task: +u.get("task") || 0 }; };

function App() {
  const [r, setR] = useState(route());
  useEffect(() => { const f = () => setR(route()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  if (r.path === "/settings") return <Settings />;
  if (r.path === "/tests") return <Home />;
  if (r.path === "/history") return <History />;
  if (r.path === "/vocab" || r.path === "/review") return <Vocabulary />;   // #/review: old link
  let m = r.path.match(/^\/r\/(\d+)$/);
  if (m) return <Saved key={m[1]} id={m[1]} />;
  m = r.path.match(/^\/t\/([^/]+\/[^/]+)\/(listening|reading|writing|speaking)$/);
  return m ? <Attempt key={location.hash} id={m[1]} module={m[2]} mode={r.mode} section={r.section} task={r.task} /> : <Today />;
}

function Home() {
  const [tests, setTests] = useState([]);
  const [attempts, setAttempts] = useState([]);
  useEffect(() => { fetch("/api/tests").then(r => r.json()).then(setTests); fetch("/api/attempts").then(r => r.json()).then(setAttempts); }, []);
  const last = (id, module) => attempts.find(a => a.test === id && a.module === module);
  return (
    <main className="home">
      <TopNav />
      <PageHead eyebrow="Cambridge IELTS · Academic" title="Tests" meta="Mock = the whole module under exam conditions, for a band. Drill = one part, passage or task, untimed, for practice." />
      <div className="testgrid">{tests.map(t => (
        <section className="testcard" key={t.id}>
          <h2>Cambridge {t.book} <span>Test {t.test}</span></h2>
          {[["listening", "Part", 4], ["reading", "Passage", 3], ["writing", "Task", 2], ["speaking", null, 0]].map(([mod, unit, n]) => {
            const a = last(t.id, mod);
            const drill = k => `#/t/${t.id}/${mod}?mode=drill&${mod === "writing" ? "task" : "section"}=${k}`;
            return (
              <div className="modrow" key={mod}>
                <span className="modname">{mod[0].toUpperCase() + mod.slice(1)}</span>
                <span className="chips">
                  {mod === "speaking"
                    ? <><a className="chip" href={`#/t/${t.id}/speaking?mode=exam`}>Exam</a><a className="chip ghost" href={`#/t/${t.id}/speaking?mode=tutor`}>Tutor</a></>
                    : <><a className="chip" href={`#/t/${t.id}/${mod}?mode=mock`}>Mock</a>
                        <span className="drill">{Array.from({ length: n }, (_, i) => <a key={i} className="chip ghost" href={drill(i + 1)}>{unit} {i + 1}</a>)}</span></>}
                </span>
                <span className="last">{a ? <>{["writing", "speaking"].includes(mod) ? "" : `${a.score}/40 · `}band <b>{a.band ?? "—"}</b></> : ""}</span>
              </div>);
          })}
        </section>))}</div>
    </main>);
}

function Attempt({ id, module, mode, section, task }) {
  const [test, setTest] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => { fetch(`/content/${id}.json`).then(r => r.json()).then(setTest); }, [id]);
  if (!test) return <p className="home">Loading…</p>;
  if (result) return module === "writing" ? <WritingResult test={test} result={result} /> : module === "speaking" ? <SpeakingResult result={result} /> : <Result test={test} module={module} result={result} />;
  if (module === "writing") return <WritingScreen test={test} id={id} mode={mode} only={task} onDone={setResult} />;
  if (module === "speaking") return <SpeakingScreen test={test} id={id} mode={mode === "tutor" ? "tutor" : "exam"} onDone={setResult} />;
  return <TestScreen test={test} id={id} module={module} mode={mode} section={section} onDone={setResult} />;
}

/** A stored attempt, shown with the same result screens. */
function Saved({ id }) {
  const [a, setA] = useState(null);
  const [test, setTest] = useState(null);
  useEffect(() => { fetch(`/api/attempts/${id}`).then(r => r.json()).then(x => { setA(x); fetch(`/content/${x.test}.json`).then(r => r.json()).then(setTest); }); }, [id]);
  if (!a || !test) return <p className="home">Loading…</p>;
  return a.module === "writing" ? <WritingResult test={test} result={a} /> : a.module === "speaking" ? <SpeakingResult result={a} /> : <Result test={test} module={a.module} result={a} />;
}

function Result({ test, module, result }) {
  const [showScript, setShowScript] = useState(false);
  const key = test[module].answers;
  const numbers = Object.keys(result.marks).map(Number).sort((a, b) => a - b);   // a drill covers one section
  // "choose TWO" answers are stored once under the group's first number
  const groups = module === "listening" ? test.listening.parts.flatMap(p => p.groups) : test.reading.passages.flatMap(p => p.groups);
  const answerFor = n => { const g = groups.find(g => g.first <= n && n <= g.last); return result.answers[n] ?? (g?.type === "multiple_choice_multi" ? result.answers[g.first] : undefined); };
  const shown = n => { const v = answerFor(n); return Array.isArray(v) ? v.join(", ") : v || ""; };
  return (
    <main className="home result">
      <TopNav />
      <PageHead eyebrow={`Cambridge ${test.book} · Test ${test.test} · ${module[0].toUpperCase() + module.slice(1)}`}
        title={<>{result.score}<span className="of"> / {numbers.length}</span></>}
        meta={result.band != null ? <>Band <b className="bandnum">{result.band}</b></> : "One section — no band"}>
        {module === "listening" && <button onClick={() => setShowScript(s => !s)}>{showScript ? "Hide transcript" : "Check transcript"}</button>}
        <a className="btn primary" href="#/">Back to Home</a>
      </PageHead>
      <table className="results">
        <thead><tr><th>#</th><th>Your answer</th><th>Key</th><th></th><th></th></tr></thead>
        <tbody>{numbers.map(n => (
          <Row key={n} n={n} ok={result.marks[n]} yours={shown(n)} keyAnswer={key[n]} test={result.test} module={module} answer={answerFor(n)} />
        ))}</tbody>
      </table>
      {showScript && test.listening.transcript.map(p => (
        <section key={p.part} className="script"><h3>Part {p.part}</h3><Script text={p.text} /></section>))}
    </main>);
}

/** A transcript as turns: "NAME: words" starts a turn with the name in bold, printed line breaks inside a turn are joined,
 *  and a blank line starts a new paragraph (monologues). */
function Script({ text }) {
  const turns = [];
  let open = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { open = false; continue; }
    const m = line.match(/^([A-Z][A-Z ]{1,30}):\s*(.*)$/);
    if (m) { turns.push({ who: m[1], text: m[2] }); open = true; }
    else if (open) turns[turns.length - 1].text += " " + line;
    else { turns.push({ who: "", text: line }); open = true; }
  }
  return turns.map((t, i) => (
    <p key={i} className={"turn" + (t.who ? " said" : "")}>{t.who && <b className="who">{t.who}</b>}<span>{t.text}</span></p>));
}

/** One result row; "Explain" fetches (and caches server-side) where the answer is and why yours did or didn't fit. */
function Row({ n, ok, yours, keyAnswer, test, module, answer }) {
  const [open, setOpen] = useState(false);
  const [exp, setExp] = useState(null);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (exp) return;
    setBusy(true);
    const r = await fetch("/api/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test, module, n, answer }) }).then(r => r.json());
    setBusy(false); setExp(r);
  };
  return (
    <>
      <tr className={ok ? "ok" : "bad"}>
        <td>{n}</td><td>{yours || <em className="muted">blank</em>}</td><td>{keyAnswer}</td><td className="mark">{ok ? "✓" : "✗"}</td>
        <td className="explain-cell"><button className={"chip-btn" + (ok ? " ghost" : "")} onClick={toggle} aria-expanded={open}>{open ? "Hide" : "Explain"}</button></td>
      </tr>
      {open && (
        <tr className="explain-row"><td colSpan={5}>
          {busy ? <p className="muted">Finding the answer in the {module === "listening" ? "transcript" : "passage"}…</p>
            : exp?.error ? <p className="error-inline">{exp.error}</p>
            : exp && (
              <div className="explain">
                <blockquote>{exp.evidence}<cite>{exp.location}</cite></blockquote>
                <p><b>Why "{keyAnswer}"</b> {exp.why_correct}</p>
                {!ok && exp.why_yours && <p><b>{yours ? `Why "${yours}" didn't work` : "Why it matters"}</b> {exp.why_yours}</p>}
                <p className="tip"><b>Tip</b> {exp.tip}</p>
              </div>)}
        </td></tr>)}
    </>);
}

createRoot(document.getElementById("root")).render(<App />);
