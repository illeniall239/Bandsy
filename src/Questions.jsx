// Renders one extracted question group in the CD-IELTS idiom: numbered boxes, inline gaps, letter selects.
const TFNG = { true_false_not_given: ["TRUE", "FALSE", "NOT GIVEN"], yes_no_not_given: ["YES", "NO", "NOT GIVEN"] };
const isMatching = t => t.startsWith("matching_");

export function Group({ g, answers, setAnswer, flags, toggleFlag, labels, base }) {
  const ns = g.questions.map(q => q.n);
  // plain functions, not components: a component defined per render would remount its input on every keystroke
  const bodyParts = g.body.split(/\[\[(\d+)\]\]/);   // odd indexes are gap numbers
  const hasGaps = bodyParts.length > 1;

  let content;
  if (hasGaps) {
    content = <div className="body">{rich(g.body, n => gap(n, answers, setAnswer, flags, toggleFlag))}</div>;
  } else if (g.type === "multiple_choice_multi") {
    const opts = g.options.length ? g.options : g.questions[0].options;
    const chosen = [].concat(answers[ns[0]] || []);
    content = (
      <div className="q">
        <div className="qhead"><span className="nums">{ns.map(n => <span key={n}>{num(n, flags, toggleFlag)}</span>)}</span><span>{g.questions[0].text}</span></div>
        {opts.map(o => (
          <label key={o.key} className="opt"><input type="checkbox" checked={chosen.includes(o.key)}
            onChange={e => { const next = e.target.checked ? [...chosen, o.key].slice(-ns.length) : chosen.filter(k => k !== o.key); setAnswer(ns[0], next); }} />
            <b>{o.key}</b> {o.text}</label>))}
      </div>);
  } else {
    const selectKeys = TFNG[g.type] || (isMatching(g.type) ? (g.options.length ? g.options.map(o => o.key) : labels)
      : /labelling/.test(g.type) && g.options.length ? g.options.map(o => o.key) : null);
    content = (
      <>
        {isMatching(g.type) && g.options.length > 0 && (
          <div className="optlist">{g.options.map(o => <div key={o.key}><b>{o.key}</b> {o.text}</div>)}</div>)}
        {g.questions.map(q => {
          const qParts = q.text.split(/\[\[(\d+)\]\]/);
          const opts = q.options.length ? q.options : g.options;
          return (
            <div className="q" key={q.n}>
              {qParts.length > 1 ? (
                <p className="body">{qParts.map((p, i) => i % 2 ? <span key={i}>{gap(+p, answers, setAnswer, flags, toggleFlag)}</span> : <span key={i}>{p}</span>)}</p>
              ) : g.type === "multiple_choice" ? (
                <>
                  <div className="qhead">{num(q.n, flags, toggleFlag)}<span>{q.text}</span></div>
                  {opts.map(o => (
                    <label key={o.key} className="opt"><input type="radio" name={`q${q.n}`} checked={answers[q.n] === o.key}
                      onChange={() => setAnswer(q.n, o.key)} /><b>{o.key}</b> {o.text}</label>))}
                </>
              ) : selectKeys ? (
                <div className="qhead">{num(q.n, flags, toggleFlag)}<span>{q.text}</span>
                  <select value={answers[q.n] || ""} onChange={e => setAnswer(q.n, e.target.value)}>
                    <option value="">–</option>{selectKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  </select></div>
              ) : (
                <div className="qhead">{num(q.n, flags, toggleFlag)}<span>{q.text}</span>
                  <input id={`q${q.n}`} value={answers[q.n] || ""} spellCheck={false} autoComplete="off" onChange={e => setAnswer(q.n, e.target.value)} /></div>
              )}
            </div>);
        })}
      </>);
  }
  return (
    <section className="group">
      <h3>Questions {g.first}{g.last > g.first ? `–${g.last}` : ""}</h3>
      <p className="instructions">{g.instructions}</p>
      {g.image && /labelling/.test(g.type) && <img className="figure" src={base + g.image} alt="" />}   {/* page scan only for map/diagram labelling: the picture is the question */}
      {content}
    </section>);
}

/** Body text with [[n]] gaps; runs of lines containing "|" render as a table (tables and forms are stored as rows). */
function rich(text, gapEl) {
  const inline = (s, k) => s.split(/\[\[(\d+)\]\]/).map((p, j) => j % 2 ? <span key={`${k}g${j}`}>{gapEl(+p)}</span> : <span key={`${k}t${j}`}>{p}</span>);
  const lines = text.split("\n"), out = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i].includes("|")) {
      const start = i;
      while (i < lines.length && !lines[i].includes("|")) i++;
      out.push(<span key={`p${start}`}>{inline(lines.slice(start, i).join("\n") + (i < lines.length ? "\n" : ""), `p${start}`)}</span>);
      continue;
    }
    const start = i, rows = [];
    // a literal "\n" (backslash n) inside a cell is a line break within that cell
    while (i < lines.length && lines[i].includes("|")) rows.push(lines[i++].split("|").map(c => c.trim().replaceAll("\\n", "\n")));
    const cols = Math.max(...rows.map(r => r.length));
    // header row: no gaps, not a form label ("Name:"), and more rows follow
    const head = rows.length > 2 && !rows[0].some(c => /\[\[\d+\]\]/.test(c) || /:$/.test(c));
    out.push(
      <table key={`t${start}`} className="qtable"><tbody>{rows.map((r, ri) => (
        <tr key={ri} className={head && ri === 0 ? "head" : ""}>{Array.from({ length: cols }, (_, ci) => <td key={ci}>{inline(r[ci] || "", `t${start}r${ri}c${ci}`)}</td>)}</tr>))}
      </tbody></table>);
  }
  return out;
}

const num = (n, flags, toggleFlag) => (
  <button type="button" className={"num" + (flags.has(n) ? " flagged" : "")} title="Flag for review" onClick={() => toggleFlag(n)}>{n}</button>);
const gap = (n, answers, setAnswer, flags, toggleFlag) => (
  <span className="gap">{num(n, flags, toggleFlag)}<input id={`q${n}`} value={answers[n] || ""} spellCheck={false} autoComplete="off"
    onChange={e => setAnswer(n, e.target.value)} /></span>);

/** Every answer slot a test has, in order — what the review screen and marker iterate. */
export const groupNumbers = g => g.questions.map(q => q.n);
