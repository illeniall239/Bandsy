import { useEffect, useState } from "react";
import { TopNav, PageHead } from "./Nav.jsx";

/** The word bank: words you saved while reading, and the vocabulary book's topic lists — add any word to your list. */
export function Vocabulary() {
  const [mine, setMine] = useState([]);
  const [book, setBook] = useState([]);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState("");
  const load = () => fetch("/api/vocab").then(r => r.json()).then(setMine);
  useEffect(() => { load(); fetch("/api/vocab/book").then(r => r.json()).then(setBook); }, []);
  const have = new Set(mine.map(w => w.word));
  const add = async w => {
    const r = await fetch("/api/vocab", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: w.word, sentence: w.example, definition: w.definition, source: "book" }) }).then(r => r.json());
    r.error ? setError(r.error) : load();
  };
  return (
    <main className="home vocab">
      <TopNav />
      <PageHead eyebrow="Word bank" title="Vocabulary"
        meta={`${mine.length} saved word${mine.length === 1 ? "" : "s"} · double-click any word in a Reading passage to save it`} />
      {error && <div className="error">{error}</div>}
      <h2>Your words</h2>
      {mine.length > 0
        ? <table><tbody>{mine.map(w => <tr key={w.id}><th>{w.word}</th><td>{w.definition.split("\n")[0]}</td><td className="muted">{w.sentence}</td></tr>)}</tbody></table>
        : <p className="muted">No saved words yet.</p>}
      {book.length > 0 && (
        <section>
          <h2>From the vocabulary book</h2>
          <div className="topics">{book.map((t, k) => <button key={k} className={open === k ? "on" : ""} onClick={() => setOpen(open === k ? null : k)}>{t.topic} <small>{t.words.length}</small></button>)}</div>
          {open != null && <table><tbody>{book[open].words.map((w, j) => (
            <tr key={j}><th>{w.word}</th><td>{w.definition}</td><td className="muted">{w.example}</td>
              <td>{have.has(w.word.toLowerCase()) ? "✓" : <button onClick={() => add(w)}>+ add</button>}</td></tr>))}</tbody></table>}
        </section>)}
    </main>);
}
