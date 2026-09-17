// Writing grading: band per criterion against the public IELTS descriptors, inline errors, band-8 rewrite.
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
      correction: { type: "string" }, explanation: { type: "string", description: "one line" },
      kind: { type: "string", enum: ["grammar", "vocabulary", "spelling", "punctuation", "cohesion", "task"] } },
      required: ["quote", "correction", "explanation", "kind"] } },
    rewrite: { type: "string", description: "the same essay rewritten at band 8: same ideas and structure, improved language; same paragraphing" },
  },
  required: ["criteria", "errors", "rewrite"],
};

export async function gradeTask(settings, { task, prompt, image, text }) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const system = `You are a certified IELTS Writing examiner. Mark strictly against the descriptors; do not inflate. Quote errors exactly as written by the candidate.\n\n${DESCRIPTORS}`;
  const user = `Academic Writing Task ${task}${image ? " (the figure is provided as an image)" : ""}.\n\nTASK:\n${prompt}\n\nCANDIDATE'S ANSWER (${words} words):\n${text}\n\n` +
    `Grade all four criteria, list every error worth fixing (up to 20, most important first), then write the band-8 rewrite.`;
  const r = await complete(settings, { job: "grading", system, prompt: user, schema: SCHEMA, image });
  const bands = Object.values(r.criteria).map(c => c.band);
  r.band = Math.round((bands.reduce((a, b) => a + b, 0) / 4) * 2) / 2;  // criterion mean to the nearest half band
  r.words = words;
  return r;
}

/** Writing overall: Task 2 counts double; IELTS rounding to the nearest half band. */
export const writingBand = (t1, t2) => Math.round(((t1 + 2 * t2) / 3) * 2) / 2;
