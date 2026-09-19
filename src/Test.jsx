import { useEffect, useMemo, useRef, useState } from "react";
import { Group } from "./Questions.jsx";
import { mark, band } from "./mark.js";
import { AUDIO } from "./hosted.js";

const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** module: "listening" | "reading"; mode: "mock" (timed, play-once) | "drill" (no clock). */
export function TestScreen({ test, id, module, mode, section, onDone }) {
  const base = `/content/${id.split("/")[0]}/`;
  const all = module === "listening"
    ? test.listening.parts.map(p => ({ title: `Part ${p.part}`, groups: p.groups, audio: test.listening.audio[p.part - 1] }))
    : test.reading.passages.map((p, i) => ({ title: `Passage ${i + 1}`, groups: p.groups, passage: p }));
  const sections = section ? [all[section - 1]] : all;   // a drill is one section; a band only means something for the whole test
  const groups = sections.flatMap(s => s.groups);
  const numbers = groups.flatMap(g => g.questions.map(q => q.n));
  const key = test[module].answers;

  const [answers, setAnswers] = useState({});
  const [flags, setFlags] = useState(new Set());
  const [sec, setSec] = useState(0);
  const [review, setReview] = useState(false);
  const [hl, setHl] = useState({});          // reading highlights {sec: [{para, s, e, note}]}, lifted so Review doesn't lose them
  const [left, setLeft] = useState(module === "reading" ? 60 * 60 : null);  // listening: clock starts after the audio
  const started = useRef(new Date().toISOString());
  const setAnswer = (n, v) => setAnswers(a => ({ ...a, [n]: v }));
  const toggleFlag = n => setFlags(f => { const s = new Set(f); s.has(n) ? s.delete(n) : s.add(n); return s; });

  const submit = () => {
    const { marks, score } = mark(groups, key, answers);
    const result = { test: id, module, mode: section ? `drill-s${section}` : mode, started_at: started.current, finished_at: new Date().toISOString(),
      answers, marks, score, band: section ? null : band(module, score), total: numbers.length };
    fetch("/api/attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) }).catch(() => {});
    onDone(result);
  };
  useEffect(() => {  // countdown; auto-submit at zero (mock only)
    if (mode !== "mock" || left == null) return;
    if (left <= 0) return submit();
    const t = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(t);
  });

  const answered = n => { const v = answers[n]; return Array.isArray(v) ? v.length > 0 : !!v; };
  const labels = useMemo(() => sections[sec].passage?.paragraphs.map(p => p.label).filter(Boolean) || [], [sec]);
  const s = sections[sec];

  return (
    <div className="test">
      <header className="bar">
        <span className="left">Cambridge {test.book} · Test {test.test} · {module[0].toUpperCase() + module.slice(1)}</span>
        <span className="clock">{mode === "mock" && left != null ? fmt(left) : ""}</span>
        <span>
          <button onClick={() => setReview(r => !r)}>{review ? "Questions" : "Review"}</button>
          <button className="primary" onClick={() => confirm("Submit and finish?") && submit()}>Submit</button>
        </span>
      </header>

      {review ? (
        <div className="review">
          <h2>Review</h2>
          <div className="numstrip">{numbers.map(n => (
            <button key={n} className={(answered(n) ? "done " : "") + (flags.has(n) ? "flagged" : "")}
              onClick={() => { setSec(sections.findIndex(x => x.groups.some(g => g.questions.some(q => q.n === n)))); setReview(false); setTimeout(() => document.getElementById(`q${n}`)?.focus(), 0); }}>{n}</button>))}</div>
          <p>{numbers.filter(answered).length} of {numbers.length} answered · {flags.size} flagged</p>
        </div>
      ) : (
        <div className={"stage " + module}>
          {module === "reading" && <Passage passage={s.passage} sec={sec} hl={hl} setHl={setHl} source={`${id} passage ${sec + 1}`} />}
          <div className="questions">
            {module === "listening" && <Audio key={sec} src={AUDIO + s.audio} playOnce={mode === "mock"}
              onEnded={() => { if (sec === sections.length - 1 && mode === "mock") setLeft(120); }} />}
            {s.groups.map(g => <Group key={g.first} g={g} answers={answers} setAnswer={setAnswer} flags={flags} toggleFlag={toggleFlag} labels={labels} base={base} />)}
          </div>
        </div>
      )}

      <footer className="bar">
        <span className="tabs">{sections.map((x, i) => <button key={i} className={i === sec ? "on" : ""} onClick={() => { setSec(i); setReview(false); }}>{x.title}</button>)}</span>
        <span className="numstrip small">{s.groups.flatMap(g => g.questions.map(q => q.n)).map(n => (
          <button key={n} className={(answered(n) ? "done " : "") + (flags.has(n) ? "flagged" : "")} onClick={() => document.getElementById(`q${n}`)?.focus()}>{n}</button>))}</span>
      </footer>
    </div>);
}

/** In a mock the recording plays once: no seeking, no replay — like the test. */
function Audio({ src, playOnce, onEnded }) {
  const ref = useRef();
  const [done, setDone] = useState(false);
  return (
    <div className="audio">
      <audio ref={ref} src={src} controls controlsList="nodownload noplaybackrate"
        onSeeking={e => { if (playOnce && Math.abs(e.target.currentTime - (ref.current._t || 0)) > 1) e.target.currentTime = ref.current._t || 0; }}
        onTimeUpdate={e => { ref.current._t = e.target.currentTime; }}
        onEnded={() => { setDone(true); onEnded(); }} onPlay={e => { if (playOnce && done) e.target.pause(); }} />
      {playOnce && <small>{done ? "Recording finished — it plays once." : "Plays once. No pausing or replay in a mock."}</small>}
    </div>);
}

/** Passage with highlight + note: select text inside one paragraph, click Highlight; click a highlight to note or remove it. */
function Passage({ passage, sec, hl, setHl, source }) {
  const list = hl[sec] || [];
  const ref = useRef();
  const [pick, setPick] = useState(null);   // {word, sentence} from a double-click
  const [saved, setSaved] = useState("");
  const onDbl = () => {
    const sel = window.getSelection(); const word = sel.toString().trim();
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) return;
    const para = sel.anchorNode?.parentElement?.closest("[data-para]"); const text = para?.textContent || "";
    const at = text.indexOf(word); const s = text.lastIndexOf(". ", at) + 1, e = text.indexOf(". ", at);
    setPick({ word, sentence: text.slice(s < 0 ? 0 : s, e < 0 ? undefined : e + 1).trim() }); setSaved("");
  };
  const saveWord = async () => {
    const r = await fetch("/api/vocab", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...pick, source }) }).then(r => r.json());
    setSaved(r.error ? r.error : `saved: ${r.definition.split("\n")[0]}`); setPick(null);
  };
  const add = () => {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const r = selection.getRangeAt(0);
    const para = r.startContainer.parentElement.closest("[data-para]");
    if (!para || para !== r.endContainer.parentElement.closest("[data-para]")) return;
    const offset = (node, off) => { let n = 0; for (const t of textNodes(para).filter(t => !t.parentElement.closest(".label"))) { if (t === node) return n + off; n += t.length; } return n; };
    const s = offset(r.startContainer, r.startOffset), e = offset(r.endContainer, r.endOffset);
    setHl(h => ({ ...h, [sec]: [...list, { para: +para.dataset.para, s: Math.min(s, e), e: Math.max(s, e), note: "" }] }));
    selection.removeAllRanges();
  };
  const edit = i => {
    const note = prompt("Note (empty removes the highlight):", list[i].note);
    if (note === null) return;
    setHl(h => ({ ...h, [sec]: note ? list.map((x, j) => j === i ? { ...x, note } : x) : list.filter((_, j) => j !== i) }));
  };
  return (
    <div className="passage" ref={ref}>
      <div className="tools"><button onClick={add}>Highlight</button>
        {pick ? <button className="primary" onClick={saveWord}>Save "{pick.word}"</button> : <small>select text, then Highlight · double-click a word to save it</small>}
        {saved && <small className="saved">{saved}</small>}</div>
      <h2>{passage.title.split("\n")[0]}</h2>
      {passage.title.includes("\n") && <p className="subtitle">{passage.title.split("\n").slice(1).join(" ")}</p>}
      {passage.paragraphs.map((p, i) => (
        <p key={i} data-para={i} onDoubleClick={onDbl}>{p.label && <b className="label">{p.label}</b>}{render(p.text, list.map((x, j) => ({ ...x, j })).filter(x => x.para === i), edit)}</p>))}
    </div>);
}
const textNodes = el => { const out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) out.push(n); return out; };
function render(text, marks, edit) {
  const cuts = [...new Set([0, text.length, ...marks.flatMap(m => [m.s, m.e])])].sort((a, b) => a - b);
  return cuts.slice(1).map((end, k) => {
    const start = cuts[k], m = marks.find(x => x.s <= start && x.e >= end);
    const piece = text.slice(start, end);
    return m ? <mark key={k} title={m.note} className={m.note ? "noted" : ""} onClick={() => edit(m.j)}>{piece}</mark> : <span key={k}>{piece}</span>;
  });
}
