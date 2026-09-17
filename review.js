// Word bank: words saved while reading (defined in context by the model) and words added from the vocabulary book.
import { complete } from "./providers.js";

export function makeVocab(db) {
  const table = `CREATE TABLE IF NOT EXISTS vocab (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL DEFAULT 1, word TEXT, sentence TEXT, definition TEXT,
      source TEXT, created_at TEXT, interval INTEGER DEFAULT 0, due TEXT, reviews INTEGER DEFAULT 0, UNIQUE(user_id, word))`;
  // before logins, words were unique globally: rebuild the table once so each user has their own list (old words go to user 1)
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='vocab'").get() && !db.prepare("SELECT 1 FROM pragma_table_info('vocab') WHERE name='user_id'").get())
    db.transaction(() => {
      db.exec("ALTER TABLE vocab RENAME TO vocab_old");
      db.exec(table);
      db.exec("INSERT INTO vocab (id, word, sentence, definition, source, created_at, interval, due, reviews) SELECT id, word, sentence, definition, source, created_at, interval, due, reviews FROM vocab_old");
      db.exec("DROP TABLE vocab_old");
    })();
  db.exec(table);

  async function addWord(settings, uid, { word, sentence, source, definition }) {
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
    db.prepare("INSERT OR IGNORE INTO vocab (user_id, word, sentence, definition, source, created_at, due) VALUES (?,?,?,?,?,?,?)").run(uid, word, sentence || "", definition, source || "", now, now);
    return db.prepare("SELECT * FROM vocab WHERE user_id=? AND word=?").get(uid, word);
  }

  const words = uid => db.prepare("SELECT * FROM vocab WHERE user_id=? ORDER BY id DESC").all(uid);
  return { addWord, words };
}
