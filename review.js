// Word bank entries: a word saved while reading gets a learner-dictionary definition from the model; book words bring their own.
import { complete } from "./providers.js";

export async function define(settings, { word, sentence, source, definition }) {
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
  return { word, sentence: sentence || "", definition, source: source || "", created_at: now, due: now };
}
