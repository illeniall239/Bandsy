// "Explain" on a Listening/Reading result row: finds the question in the test JSON, hands the model the question,
// the candidate's answer, the key and the transcript part / passage it comes from, and caches the explanation
// per (test, question, answer) so a second click costs nothing.
import fs from "node:fs";
import path from "node:path";
import { complete } from "./providers.js";

const SCHEMA = {
  type: "object",
  properties: {
    evidence: { type: "string", description: "the exact sentence(s) from the transcript/passage that give the answer, quoted verbatim" },
    location: { type: "string", description: "where it is, e.g. 'Paragraph C' or 'about two-thirds through Part 3, when the tutor mentions...'" },
    why_correct: { type: "string", description: "why the key answer is right, 1-2 sentences" },
    why_yours: { type: "string", description: "if the candidate's answer is wrong or blank: exactly why (distractor, wrong word form, over the word limit, misheard, paraphrase missed). Empty string if they were right." },
    tip: { type: "string", description: "one transferable tip for this question type" },
  },
  required: ["evidence", "location", "why_correct", "why_yours", "tip"],
};

/** store: explained(key) / saveExplained(key, body), a cache shared by everyone (the explanation doesn't depend on who asks). */
export async function explain(settings, store, { test, module, n, answer }) {
    const ans = [].concat(answer ?? []).join(", ").trim();
    const key = { test, module, n, answer: ans.toLowerCase() };
    const hit = await store.explained(key);
    if (hit) return { ...hit, cached: true };

    const t = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "content", `${test}.json`), "utf8"));
    const keyAnswer = t[module].answers[n];
    let group, source;
    if (module === "listening") {
      const part = t.listening.parts.find(p => p.groups.some(g => g.first <= n && n <= g.last));
      group = part.groups.find(g => g.first <= n && n <= g.last);
      source = `AUDIOSCRIPT, Part ${part.part}:\n${t.listening.transcript.find(x => x.part === part.part)?.text || "(transcript missing)"}`;
    } else {
      const passage = t.reading.passages.find(p => p.groups.some(g => g.first <= n && n <= g.last));
      group = passage.groups.find(g => g.first <= n && n <= g.last);
      source = `READING PASSAGE: ${passage.title}\n\n` + passage.paragraphs.map(p => (p.label ? `[Paragraph ${p.label}] ` : "") + p.text).join("\n\n");
    }
    const q = group.questions.find(x => x.n === n);
    const opts = [...group.options, ...(q?.options || [])].map(o => `${o.key}: ${o.text}`).join("\n");
    const prompt = [
      `IELTS ${module} question ${n} (${group.type.replace(/_/g, " ")}).`,
      `Instructions: ${group.instructions}`,
      group.body && `Question text:\n${group.body}`,
      q?.text && `Question ${n}: ${q.text}`,
      opts && `Options:\n${opts}`,
      `Answer key: ${keyAnswer}`,
      `Candidate's answer: ${ans || "(blank)"}`,
      source,
    ].filter(Boolean).join("\n\n");

    const r = await complete(settings, { job: "small", schema: SCHEMA, prompt,
      system: "You are an IELTS tutor explaining one Listening or Reading answer to a candidate. Quote the evidence exactly from the source. " +
              "Be concrete and short. If the candidate's answer is acceptable in substance but was marked wrong on a technicality (spelling, word limit, form), say so plainly." });
    await store.saveExplained(key, r);
    return r;
}
