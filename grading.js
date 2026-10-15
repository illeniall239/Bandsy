// Writing grading: band per criterion against the public IELTS descriptors and the errors to fix. No model-written "band 8" essay: nothing
// checks such a rewrite really is one, and a mid-sized model's often reads worse than the candidate's; the result page shows the
// candidate's own essay with these corrections applied instead.
import { complete } from "./providers.js";

const DESCRIPTORS = `IELTS Writing band descriptors (public version, condensed). Score each criterion 0-9 in whole bands.

TASK ACHIEVEMENT (Task 1) / TASK RESPONSE (Task 2)
9: fully addresses all parts; T1: clear overview, key features fully and accurately covered; T2: fully developed position, ideas relevant, fully extended, well supported.
8: covers requirements sufficiently; T1: clear overview, key features clearly presented and appropriately illustrated; T2: well-developed response, relevant and extended ideas.
7: covers requirements; T1: clear overview of main trends/differences/stages, key features covered but could be more fully extended; T2: clear position throughout, main ideas extended and supported, may over-generalise or lack focus in places.
6: addresses requirements; T1: overview present, key features selected but not adequately covered, details may be irrelevant/inaccurate; T2: relevant position but conclusions may be unclear, main ideas relevant but insufficiently developed.
5: generally addresses; T1: no clear overview or inappropriate format, mechanical recount of detail, may be inaccurate; T2: position expressed but development unclear, ideas limited or not well supported, irrelevant detail.
4: T1: fails to cover key features, format inappropriate, may confuse key features with detail; T2: minimal or unclear position, ideas difficult to identify, repetitive, off-topic.
Under length (T1 < 150 / T2 < 250 words) is penalised; memorised or wholly off-topic answers cap at low bands.

COHERENCE AND COHESION
9: cohesion attracts no attention, skilful paragraphing. 8: sequences information logically, cohesion well managed, paragraphing sufficient and appropriate. 7: logical organisation, clear progression, range of cohesive devices used appropriately with some under/over-use, clear central topic per paragraph. 6: coherent arrangement with clear overall progression, cohesive devices used effectively but faulty or mechanical at times, referencing not always clear, paragraphing may be illogical. 5: some organisation but lack of overall progression, inadequate/inaccurate/over-used cohesive devices, repetitive from lack of referencing, paragraphing inadequate. 4: information not arranged coherently, basic cohesive devices inaccurate or repetitive, no paragraphing or confusing paragraphing.

LEXICAL RESOURCE
9: wide range, natural and sophisticated control, rare minor slips. 8: wide range used fluently and flexibly to convey precise meaning, skilful uncommon items, occasional inaccuracies in word choice/collocation, rare errors. 7: sufficient range for flexibility and precision, less common items with some awareness of style and collocation, occasional errors in word choice, spelling or word formation. 6: adequate range, attempts less common vocabulary with some inaccuracy, some spelling/word formation errors that do not impede communication. 5: limited range, minimally adequate, noticeable errors in spelling/word formation that may cause difficulty. 4: basic vocabulary, repetitive or inappropriate, limited control of word formation/spelling, errors may strain the reader.

GRAMMATICAL RANGE AND ACCURACY
9: wide range of structures with full flexibility and accuracy, rare minor slips. 8: wide range, majority of sentences error-free, very occasional errors. 7: variety of complex structures, frequent error-free sentences, good control with a few errors. 6: mix of simple and complex forms, some errors in grammar and punctuation but they rarely reduce communication. 5: limited range, attempts complex sentences but these tend to be less accurate than simple ones, frequent errors that can cause difficulty. 4: very limited range, rare subordinate clauses, some structures accurate but errors predominate, punctuation often faulty.`;

const SCHEMA = {
  type: "object",
  properties: {
    criteria: { type: "object", properties: Object.fromEntries(["task", "coherence", "lexical", "grammar"].map(k =>
      [k, { type: "object", properties: { band: { type: "integer" }, comment: { type: "string", description: "2-3 sentences: what earned this band and the one thing that would lift it" } }, required: ["band", "comment"] }])),
      required: ["task", "coherence", "lexical", "grammar"] },
    errors: { type: "array", items: { type: "object", properties: {
      quote: { type: "string", description: "exact substring of the candidate's text, short (a phrase or clause)" },
      correction: { type: "string", description: "the corrected wording, a drop-in replacement for the quote (for a 'task' error: what to add or change)" },
      explanation: { type: "string", description: "one line" },
      kind: { type: "string", enum: ["grammar", "vocabulary", "spelling", "punctuation", "cohesion", "task"] } },
      required: ["quote", "correction", "explanation", "kind"] } },
  },
  required: ["criteria", "errors"],
};

/** The book's own answers to the task (content/camNN/samples.json), as a scale to mark against: a real examiner's band and comment. */
function calibration(references) {
  const parts = references.filter(r => r.comment || r.answer).map(r => r.kind === "model"
    ? `An examiner's model of a very good answer to this task:\n${r.answer || "(text not available)"}${r.comment ? `\nExaminer's note: ${r.comment}` : ""}`
    : `Another candidate's answer to this task, which a real IELTS examiner marked Band ${r.band}:\n${r.answer || "(the script itself is not available; the comment says what earned the band)"}\nThe examiner's comment: ${r.comment}`);
  return parts.length ? `CALIBRATION, from the official Cambridge book. Use it to set your scale, then mark the candidate's answer on its own merits against the descriptors: resembling this answer earns nothing.\n\n${parts.join("\n\n")}\n\n` : "";
}

/** @param references the book's answers to this task, [{kind, band, answer, comment}]: they calibrate the marking */
export async function gradeTask(settings, { task, prompt, image, text, references = [] }) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const system = `You are a certified IELTS Writing examiner. Mark strictly against the descriptors; do not inflate. Quote errors exactly as written by the candidate.\n\n${DESCRIPTORS}`;
  const user = `Academic Writing Task ${task}${image ? " (the figure is provided as an image)" : ""}.\n\nTASK:\n${prompt}\n\n${calibration(references)}CANDIDATE'S ANSWER (${words} words):\n${text}\n\n` +
    `Grade all four criteria, then list every error worth fixing (up to 20, most important first).`;
  // Task 1 can have its own model, one that reads the chart, so a strong text-only model can stay on Task 2
  const job = task === 1 && settings.jobs.task1 ? "task1" : "grading";
  const r = await complete(settings, { job, system, prompt: user, schema: SCHEMA, image });
  const bands = Object.values(r.criteria).map(c => c.band);
  r.band = Math.round((bands.reduce((a, b) => a + b, 0) / 4) * 2) / 2;  // criterion mean to the nearest half band
  r.words = words;
  r.calibrated = references.filter(x => x.kind === "candidate" && x.band).map(x => x.band);   // shown on the result: what the marking was anchored to
  return r;
}

/** Writing overall: Task 2 counts double; IELTS rounding to the nearest half band. */
export const writingBand = (t1, t2) => Math.round(((t1 + 2 * t2) / 3) * 2) / 2;
