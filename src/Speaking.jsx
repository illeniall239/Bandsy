import { useEffect, useRef, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";

const post = (path, data, raw) => fetch(path, { method: "POST", headers: { "Content-Type": raw ? "audio/webm" : "application/json" }, body: raw ? data : JSON.stringify(data) }).then(r => r.json());
const wav = b64 => `data:audio/wav;base64,${b64}`;
const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const pref = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

/** Exam mode: the scripted 3-part test with the examiner's voice. Tutor mode: free conversation with corrections. */
export function SpeakingScreen({ test, id, mode, onDone }) {
  const [u, setU] = useState(null);            // current examiner utterance
  const [state, setState] = useState("idle");  // idle | speaking | listening | thinking | prep | grading
  const [level, setLevel] = useState(0);
  const [clock, setClock] = useState(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [ptt, setPtt] = useState(pref("ptt", false));
  const [threshold, setThreshold] = useState(pref("threshold", 0.02));
  const S = useRef({});   // mutable session bits: session id, filler, recorder, stream, timers

  useEffect(() => () => stop(), []);
  const stop = () => { const s = S.current; s.rec?.state === "recording" && s.rec.stop(); s.stream?.getTracks().forEach(t => t.stop()); clearInterval(s.tick); cancelAnimationFrame(s.raf); };

  const start = async () => {
    setError("");
    try { S.current.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return setError("Microphone access is needed for the speaking test."); }
    const r = await post("/api/speaking/start", { test: id, mode });
    if (r.error) return setError(r.error);
    S.current.session = r.session; S.current.filler = r.filler;
    say(r);
  };

  const say = async utt => {
    setU(utt); setState("speaking");
    const a = new Audio(wav(utt.audio));
    await new Promise(res => { a.onended = res; a.onerror = res; a.play(); });
    if (utt.kind === "end") return finish();
    if (utt.kind === "cue") return prep();
    listen(utt.kind === "talk" ? 120 : null);
  };

  const prep = () => {   // Part 2: one minute to prepare, then the examiner tells you to start
    setState("prep"); let n = 60; setClock(n);
    S.current.tick = setInterval(() => { n--; setClock(n); if (n <= 0) { clearInterval(S.current.tick); setClock(null); sendTurn(new Blob()); } }, 1000);
  };

  const listen = limit => {
    const s = S.current;
    const ctx = new AudioContext(), src = ctx.createMediaStreamSource(s.stream), an = ctx.createAnalyser();
    an.fftSize = 1024; src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const chunks = [];
    s.rec = new MediaRecorder(s.stream, { mimeType: "audio/webm;codecs=opus" });
    s.rec.ondataavailable = e => chunks.push(e.data);
    s.rec.onstop = () => { ctx.close(); sendTurn(new Blob(chunks, { type: "audio/webm" })); };
    s.rec.start();
    setState("listening");
    let spoke = 0, quiet = 0, last = performance.now();
    if (limit) { let n = limit; setClock(n); s.tick = setInterval(() => { n--; setClock(n); if (n <= 0) { clearInterval(s.tick); setClock(null); s.rec.state === "recording" && s.rec.stop(); } }, 1000); }
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
      setLevel(rms);
      const now = performance.now(), dt = now - last; last = now;
      if (rms > threshold) { spoke += dt; quiet = 0; } else if (spoke > 800) quiet += dt;
      // end of turn: they've spoken for a bit and then gone quiet for 1.5 s (unless push-to-talk owns the decision)
      if (!ptt && !limit && quiet > 1500 && s.rec.state === "recording") return s.rec.stop();
      if (s.rec.state === "recording") s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);
  };
  const done = () => { const s = S.current; clearInterval(s.tick); setClock(null); s.rec?.state === "recording" && s.rec.stop(); };

  const sendTurn = async blob => {
    setState("thinking"); setLevel(0);
    const filler = new Audio(wav(S.current.filler)); filler.play().catch(() => {});   // "Mm-hm." while the next line loads
    const r = await post(`/api/speaking/turn?session=${S.current.session}`, blob, true);
    if (r.error) { setState("idle"); return setError(r.error); }
    say(r);
  };

  const finish = async () => {
    setState("grading"); stop();
    const r = await post("/api/speaking/finish", { session: S.current.session });
    if (r.error) { setState("idle"); return setError(r.error); }
    fetch("/api/attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) }).catch(() => {});
    onDone(r);
  };

  return (
    <div className="test speaking">
      <header className="bar">
        <span className="left">Cambridge {test.book} · Test {test.test} · Speaking · {mode === "exam" ? "exam" : "tutor"}</span>
        <span className="clock">{clock != null ? fmt(clock) : ""}</span>
        <span>{state !== "idle" && state !== "grading" && <button onClick={() => confirm("End the test now and get feedback?") && finish()}>End test</button>}</span>
      </header>
      {error && <div className="error">{error}</div>}
      <div className="room">
        {state === "idle" ? (
          <div className="intro">
            <h2>{mode === "exam" ? "Speaking test" : "Tutor conversation"}</h2>
            <p className="muted">{mode === "exam" ? "Three parts, 11–14 minutes, the examiner follows the official frame. Speak naturally; a pause of 1.5 seconds ends your turn." : "Free conversation on IELTS topics. The tutor corrects you as you go."}</p>
            <label className="row"><input type="checkbox" checked={ptt} onChange={e => { setPtt(e.target.checked); localStorage.setItem("ptt", e.target.checked); }} /> Push-to-talk (I'll press Done after each answer — for noisy rooms)</label>
            <label className="row">Silence threshold <input type="range" min="0.005" max="0.08" step="0.005" value={threshold} onChange={e => { setThreshold(+e.target.value); localStorage.setItem("threshold", e.target.value); }} /> {threshold}</label>
            <button className="primary" onClick={start}>Start</button>
          </div>
        ) : (
          <>
            <div className={"examiner " + state}><span className="avatar">E</span>
              <p>{state === "grading" ? "Grading…" : u?.text}</p></div>
            {u?.kind === "cue" && u.cue && state !== "speaking" && (
              <div className="cue">
                <h3>{u.cue.cue}</h3><p>You should say:</p><ul>{u.cue.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                <textarea placeholder="Notes (one minute)" value={notes} onChange={e => setNotes(e.target.value)} />
              </div>)}
            {u?.kind === "talk" && state === "listening" && <div className="cue small"><b>{u.cue?.cue}</b>{notes && <pre>{notes}</pre>}</div>}
            <div className="you">
              <div className="meter"><i style={{ transform: `scaleX(${Math.min(1, level * 15)})` }} /></div>
              <span className="muted">{{ speaking: "Examiner speaking…", listening: "Listening — your turn", thinking: "…", prep: "Prepare your talk", grading: "Working out your bands…" }[state]}</span>
              {state === "listening" && <button onClick={done}>Done</button>}
              {state === "prep" && <button onClick={() => { clearInterval(S.current.tick); setClock(null); sendTurn(new Blob()); }}>I'm ready</button>}
            </div>
          </>)}
      </div>
    </div>);
}

export function SpeakingResult({ result }) {
  const m = result.marks;
  const [showBetter, setShowBetter] = useState(false);
  return (
    <main className="home result wresult">
      <TopNav />
      <PageHead eyebrow="Speaking test" title={<>Band <span className="bandnum">{result.band}</span></>}
        meta="Fluency, vocabulary and grammar · pronunciation not assessed"><a className="btn primary" href="#/">Back to Home</a></PageHead>
      <table className="criteria"><tbody>
        {Object.entries({ fluency: "Fluency & Coherence", lexical: "Lexical Resource", grammar: "Grammatical Range & Accuracy" }).map(([k, label]) => (
          <tr key={k}><th>{label}</th><td className="band">{m.criteria[k].band}</td><td>{m.criteria[k].comment}</td></tr>))}
        <tr><th>Pronunciation</th><td className="band muted">—</td><td className="muted">Not assessed: the examiner only hears a transcript. Add an audio-capable model later to score it.</td></tr>
      </tbody></table>
      <p className="muted">{m.stats.words} words in {m.stats.seconds}s · {m.stats.wpm} wpm · {m.stats.long_pauses} pauses over 1 s (longest {m.stats.longest_pause}s)</p>
      <section>
        <h3>Transcript</h3>
        {result.answers.map(t => <div key={t.index} className="turn"><p className="muted">Part {t.part} · {t.question}</p><p>{t.text || <em>(no speech)</em>}</p></div>)}
      </section>
      <section>
        <h3>Corrections</h3>
        <ol className="errors">{m.errors.map((e, i) => <li key={i}><s>{e.quote}</s> → <b>{e.correction}</b><br /><small>{e.explanation}</small></li>)}</ol>
      </section>
      <section>
        <h3>Band-8 answers <button onClick={() => setShowBetter(s => !s)}>{showBetter ? "hide" : "show"}</button></h3>
        {showBetter && m.better.map((b, i) => <div key={i} className="turn"><p className="muted">{b.question}</p><p>{b.answer}</p></div>)}
      </section>
    </main>);
}
