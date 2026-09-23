import { Fragment, useEffect, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";
import { createRoot } from "react-dom/client";
import { TestScreen } from "./Test.jsx";
import { WritingScreen, WritingResult } from "./Writing.jsx";
import { Settings } from "./Settings.jsx";
import { Today, History } from "./Today.jsx";
import { SpeakingScreen, SpeakingResult } from "./Speaking.jsx";
import { Vocabulary } from "./Vocabulary.jsx";
import "./hosted.js";
import "./style.css";

// hash routes: #/            home
//              #/t/cam15/test1/listening?mode=mock|drill
const route = () => { const [p, q] = location.hash.slice(1).split("?"); const u = new URLSearchParams(q); return { path: p || "/", mode: u.get("mode") || "mock", section: +u.get("section") || 0, task: +u.get("task") || 0, group: +u.get("group") || 0 }; };

function App() {
  const [r, setR] = useState(route());
  useEffect(() => { const f = () => setR(route()); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  if (r.path === "/settings") return <Settings />;
  if (r.path === "/practice") return <Practice />;
  if (r.path === "/tests") return <Home />;
  if (r.path === "/history") return <History />;
  if (r.path === "/vocab" || r.path === "/review") return <Vocabulary />;   // #/review: old link
  let m = r.path.match(/^\/r\/(\d+)$/);
  if (m) return <Saved key={m[1]} id={m[1]} />;
  m = r.path.match(window.BANDSY_SPEAKING === false ? /^\/t\/([^/]+\/[^/]+)\/(listening|reading|writing)$/ : /^\/t\/([^/]+\/[^/]+)\/(listening|reading|writing|speaking)$/);
  return m ? <Attempt key={location.hash} id={m[1]} module={m[2]} mode={r.mode} section={r.section} task={r.task} group={r.group} /> : <Today />;
}

/** The official task types (ielts.org): six in Listening, eleven in Reading, where every layout of a completion
 *  task counts as one type. Each holds the finer kinds we can drill separately. */
const OFFICIAL = {
  listening: [
    ["Multiple choice", ["multiple_choice", "multiple_choice_multi"]],
    ["Matching", ["matching_features"]],
    ["Plan, map or diagram labelling", ["map_labelling", "diagram_labelling"]],
    ["Form, note, table, flow-chart or summary completion", ["note_completion", "form_completion", "table_completion", "flow_chart_completion", "summary_completion"]],
    ["Sentence completion", ["sentence_completion"]],
    ["Short-answer questions", ["short_answer"]],
  ],
  reading: [
    ["Multiple choice", ["multiple_choice", "multiple_choice_multi"]],
    ["Identifying information (True / False / Not Given)", ["true_false_not_given"]],
    ["Identifying the writer's views (Yes / No / Not Given)", ["yes_no_not_given"]],
    ["Matching information", ["matching_information"]],
    ["Matching headings", ["matching_headings"]],
    ["Matching features", ["matching_features"]],
    ["Matching sentence endings", ["matching_sentence_endings"]],
    ["Sentence completion", ["sentence_completion"]],
    ["Summary, note, table or flow-chart completion", ["summary_completion", "note_completion", "table_completion", "flow_chart_completion"]],
    ["Diagram label completion", ["diagram_labelling"]],
    ["Short-answer questions", ["short_answer"]],
  ],
  writing: [
    ["Task 1 (150 words, describe a visual)", ["task1_process", "task1_pie_chart", "task1_bar_chart", "task1_line_graph", "task1_table", "task1_map", "task1_mixed", "task1_other"]],
    ["Task 2 (250 words, essay)", ["task2_opinion", "task2_discussion", "task2_advantages_disadvantages", "task2_problem_solution", "task2_two_part_question", "task2_other"]],
  ],
  speaking: [
    ["The whole test (Parts 1 to 3)", ["part2_person", "part2_place", "part2_object", "part2_event", "part2_experience", "part2_activity", "part2_media", "part2_other"]],
  ],
};
// the finer kinds, shown when a type is opened
const KIND_LABEL = {
  multiple_choice: "One answer", multiple_choice_multi: "Choose TWO letters",
  matching_features: "Matching features", matching_information: "Matching information", matching_headings: "Matching headings",
  matching_sentence_endings: "Matching sentence endings", map_labelling: "Map or plan", diagram_labelling: "Diagram",
  note_completion: "Notes", form_completion: "Form", table_completion: "Table", flow_chart_completion: "Flow chart",
  summary_completion: "Summary", sentence_completion: "Sentences", short_answer: "Short answer",
  true_false_not_given: "True / False / Not Given", yes_no_not_given: "Yes / No / Not Given",
  task1_process: "Process diagram", task1_pie_chart: "Pie chart", task1_bar_chart: "Bar chart", task1_line_graph: "Line graph",
  task1_table: "Table", task1_map: "Maps and plans", task1_mixed: "Two charts together", task1_other: "Other",
  task2_opinion: "Opinion (agree or disagree)", task2_discussion: "Discuss both views", task2_advantages_disadvantages: "Advantages and disadvantages",
  task2_problem_solution: "Problems and solutions", task2_two_part_question: "Two-part question", task2_other: "Other",
  part2_person: "Part 2 card: a person", part2_place: "Part 2 card: a place", part2_object: "Part 2 card: an object",
  part2_event: "Part 2 card: an event", part2_experience: "Part 2 card: an experience", part2_activity: "Part 2 card: an activity",
  part2_media: "Part 2 card: a book, film or website", part2_other: "Part 2 card: other",
};
const MODULE_NAME = { listening: "Listening", reading: "Reading", writing: "Writing", speaking: "Speaking" };

/** The link that practises one catalogue item, and the attempt mode it will be saved under. */
const itemHref = i => i.module === "writing" ? `#/t/${i.test}/writing?mode=drill&task=${i.task}`
  : i.module === "speaking" ? `#/t/${i.test}/speaking?mode=exam`
  : `#/t/${i.test}/${i.module}?mode=drill&group=${i.first}`;
const itemMode = i => i.module === "writing" ? `drill-t${i.task}` : i.module === "speaking" ? "exam" : `drill-g${i.first}`;
const itemName = i => `${i.test.replace("cam", "C").replace("/test", " T")}${i.first ? ` Q${i.first}` : ""}`;

/** Practice by question type: the official task types, each openable into the finer kinds and the individual items. */
function Practice() {
  const [items, setItems] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => { fetch("/api/catalog").then(r => r.json()).then(setItems); fetch("/api/attempts").then(r => r.json()).then(setAttempts); }, []);
  if (!items) return <main className="home"><TopNav /><p className="muted">Loading…</p></main>;

  const best = new Map();   // "test|module|mode" -> best score, so a repeat counts once
  for (const a of attempts) {
    const k = `${a.test}|${a.module}|${a.mode}`;
    if (!best.has(k) || (a.score ?? 0) > best.get(k)) best.set(k, a.score ?? 0);
  }
  const key = i => `${i.test}|${i.module}|${itemMode(i)}`;
  const stats = list => {
    const hit = list.filter(i => best.has(key(i)));
    const scored = hit.filter(i => i.module === "listening" || i.module === "reading");
    return { items: list, done: hit.length, questions: list.reduce((n, i) => n + i.n, 0),
      accuracy: scored.length ? Math.round(100 * scored.reduce((s, i) => s + best.get(key(i)), 0) / scored.reduce((s, i) => s + i.n, 0)) : null };
  };
  const next = list => list.find(i => !best.has(key(i))) || list[0];
  const cells = row => (
    <>
      <td>{row.questions}</td>
      <td>{row.done} / {row.items.length}</td>
      <td>{row.accuracy == null ? <span className="muted">—</span> : <b className={row.accuracy < 60 ? "weak" : ""}>{row.accuracy}%</b>}</td>
    </>);

  return (
    <main className="home practice">
      <TopNav />
      <PageHead eyebrow="By task type" title="Practice"
        meta="The official IELTS task types, with everything in the books sorted into them. Pick the one you keep losing marks on and it serves the ones you have not done yet." />
      {Object.entries(OFFICIAL).filter(([m]) => m !== "speaking" || window.BANDSY_SPEAKING !== false).map(([m, types]) => (
        <section key={m}>
          <h2>{MODULE_NAME[m]}</h2>
          <table>
            <thead><tr><th>Task type</th><th>Questions</th><th>Done</th><th>Accuracy</th><th></th></tr></thead>
            <tbody>{types.map(([label, kinds]) => {
              const row = stats(items.filter(i => i.module === m && kinds.includes(i.type)));
              if (!row.items.length) return null;
              const id = m + label;
              const subs = kinds.map(k => [k, stats(row.items.filter(i => i.type === k))]).filter(([, s]) => s.items.length);
              return (
                <Fragment key={id}>
                  <tr>
                    <th>{label}</th>
                    {cells(row)}
                    <td className="explain-cell">
                      <a className="chip" href={itemHref(next(row.items))}>{row.done ? "Next" : "Start"}</a>
                      <button className="chip-btn ghost" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>{open === id ? "Hide" : "Break down"}</button>
                    </td>
                  </tr>
                  {open === id && subs.length === 1 && (
                    <tr className="sub"><th /><td colSpan={4}>
                      <div className="items">{row.items.map(i => (
                        <a key={key(i)} className={"chip ghost" + (best.has(key(i)) ? " did" : "")} href={itemHref(i)}>{itemName(i)}</a>))}</div>
                    </td></tr>)}
                  {open === id && subs.length > 1 && subs.map(([k, s]) => (
                    <tr key={k} className="sub">
                      <th>{KIND_LABEL[k] || k}</th>
                      {cells(s)}
                      <td className="explain-cell">
                        <a className="chip" href={itemHref(next(s.items))}>{s.done ? "Next" : "Start"}</a>
                        <div className="items">{s.items.map(i => (
                          <a key={key(i)} className={"chip ghost" + (best.has(key(i)) ? " did" : "")} href={itemHref(i)}>{itemName(i)}</a>))}</div>
                      </td>
                    </tr>))}
                </Fragment>);
            })}
            </tbody>
          </table>
        </section>))}
    </main>);
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
          {[["listening", "Part", 4], ["reading", "Passage", 3], ["writing", "Task", 2], ["speaking", null, 0]].filter(([mod]) => mod !== "speaking" || window.BANDSY_SPEAKING !== false).map(([mod, unit, n]) => {
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

function Attempt({ id, module, mode, section, task, group }) {
  const [test, setTest] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => { fetch(`/content/${id}.json`).then(r => r.json()).then(setTest); }, [id]);
  if (!test) return <p className="home">Loading…</p>;
  if (result) return module === "writing" ? <WritingResult test={test} result={result} /> : module === "speaking" ? <SpeakingResult result={result} /> : <Result test={test} module={module} result={result} />;
  if (module === "writing") return <WritingScreen test={test} id={id} mode={mode} only={task} onDone={setResult} />;
  if (module === "speaking") return <SpeakingScreen test={test} id={id} mode={mode === "tutor" ? "tutor" : "exam"} onDone={setResult} />;
  return <TestScreen test={test} id={id} module={module} mode={mode} section={section} group={group} onDone={setResult} />;
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
