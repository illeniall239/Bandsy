// Word bank: words saved while reading (defined in context by the model) and words added from the vocabulary book.
import { complete } from "./providers.js";

export function makeVocab(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vocab (id INTEGER PRIMARY KEY, word TEXT UNIQUE, sentence TEXT, definition TEXT, source TEXT, created_at TEXT,
      interval INTEGER DEFAULT 0, due TEXT, reviews INTEGER DEFAULT 0)`);

  async function addWord(settings, { word, sentence, source, definition }) {
    word = word.trim().toLowerCase().replace(/[^a-z' -]/g, "");
    if (!word) throw new Error("no word");
    if (!definition) {
      const r = await complete(settings, { job: "small",
        schema: { type: "object", properties: { definition: { type: "string" }, example: { type: "string" } }, required: ["definition", "example"] },
        system: "You write learner-dictionary entries for IELTS candidates: a plain-English definition of the word as used in the given sentence (one line), then one new example sentence at band 7-8 level.",
        prompt: `Word: ${word}\nSentence: ${sentence}` });
      definition = `${r.definition}\nExample: ${r.example}`;
    }
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO vocab (word, sentence, definition, source, created_at, due) VALUES (?,?,?,?,?,?)").run(word, sentence || "", definition, source || "", now, now);
    return db.prepare("SELECT * FROM vocab WHERE word=?").get(word);
  }

  const words = () => db.prepare("SELECT * FROM vocab ORDER BY id DESC").all();
  return { addWord, words };
}
