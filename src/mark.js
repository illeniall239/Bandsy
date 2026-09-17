// Marks answers against an extracted answer key, IELTS-style: exact word, case-insensitive, alternatives on "/",
// optional words in brackets, hyphen/space-insensitive, "IN EITHER ORDER" pairs marked as a set.

const clean = s => String(s ?? "").toLowerCase().replace(/[\s\-–—]+/g, "").replace(/[.,'’"]/g, "");

// "(land) surface" -> ["land surface", "surface"]; "car (-) sharing" -> ["car sharing"]; "10/ten" -> ["10", "ten"]
export function acceptable(key) {
  const k = key.replace(/\[.*?\]/g, "").replace(/IN EITHER ORDER/i, "").replace(/\(-\)/g, "").trim();
  const out = new Set();
  for (const alt of k.split("/")) {
    const a = alt.trim();
    if (!a) continue;
    out.add(a.replace(/\(.*?\)/g, "").trim());       // without optional words
    out.add(a.replace(/[()]/g, "").trim());           // with optional words
  }
  return [...out].filter(Boolean).map(clean);
}

const eitherOrder = key => /EITHER ORDER/i.test(key);

/** groups: [{first,last,type,questions:[{n}]}], key: {n: answer}, answers: {n: string | string[]}.
 *  Returns {marks: {n: true|false}, score}. Multi-select groups take an array of letters under the group's first n. */
export function mark(groups, key, answers) {
  const marks = {};
  for (const g of groups) {
    const ns = g.questions.map(q => q.n);
    if (g.type === "multiple_choice_multi" || (ns.length > 1 && ns.every(n => eitherOrder(key[n] || "")))) {
      const wanted = new Set(ns.flatMap(n => acceptable(key[n] || "")));
      const chosen = [].concat(answers[ns[0]] || []).map(clean);
      // each correct pick is one mark, credited to the group's numbers in order
      let hits = chosen.filter(c => wanted.has(c)).length;
      hits = Math.min(hits, ns.length);
      ns.forEach((n, i) => marks[n] = i < hits);
      continue;
    }
    for (const n of ns) marks[n] = key[n] != null && acceptable(key[n]).includes(clean(answers[n]));
  }
  return { marks, score: Object.values(marks).filter(Boolean).length };
}

// Official approximate raw-score to band tables (Academic).
const LISTENING = [[39, 9], [37, 8.5], [35, 8], [32, 7.5], [30, 7], [26, 6.5], [23, 6], [18, 5.5], [16, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5], [0, 2]];
const READING = [[39, 9], [37, 8.5], [35, 8], [33, 7.5], [30, 7], [27, 6.5], [23, 6], [19, 5.5], [15, 5], [13, 4.5], [10, 4], [8, 3.5], [6, 3], [4, 2.5], [0, 2]];
export const band = (module, score) => (module === "listening" ? LISTENING : READING).find(([min]) => score >= min)[1];

if (typeof process !== "undefined" && process.argv[1]?.endsWith("mark.js")) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (() => { throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); })();
  eq(acceptable("(land) surface"), ["surface", "landsurface"]);
  eq(acceptable("car (-) sharing"), ["carsharing"]);
  eq(acceptable("10/ten"), ["10", "ten"]);
  eq(acceptable("uncontacted / isolated"), ["uncontacted", "isolated"]);
  const key = { 1: "Jamieson", 2: "grass(es)", 29: "B/D IN EITHER ORDER", 30: "B/D IN EITHER ORDER", 23: "C [IN EITHER ORDER with 24]", 24: "D [IN EITHER ORDER with 23]" };
  const groups = [
    { type: "note_completion", questions: [{ n: 1 }, { n: 2 }] },
    { type: "multiple_choice_multi", questions: [{ n: 29 }, { n: 30 }] },
    { type: "multiple_choice_multi", questions: [{ n: 23 }, { n: 24 }] },
  ];
  const r = mark(groups, key, { 1: " jamieson ", 2: "grass", 29: ["D", "B"], 23: ["C", "A"] });
  eq(r.marks, { 1: true, 2: true, 29: true, 30: true, 23: true, 24: false }); eq(r.score, 5);
  eq(band("listening", 30), 7); eq(band("reading", 30), 7); eq(band("reading", 29), 6.5); eq(band("listening", 40), 9);
  console.log("mark.js ok");
}
