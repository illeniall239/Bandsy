// Picks today's one session from a fixed weekly rotation weighted to the weakest module. 7 days/week, chunks only (no mocks),
// Thursday and Saturday drill the weakest question type from the Practice catalogue.
export const MODULES = ["listening", "reading", "writing", "speaking"];
const LABEL = { listening: "Listening", reading: "Reading", writing: "Writing", speaking: "Speaking" };
// question types by their finer kind (shared with the Practice page)
export const KIND_LABEL = {
  multiple_choice: "One answer", multiple_choice_multi: "Choose TWO letters",
  matching_features: "Matching features", matching_information: "Matching information", matching_headings: "Matching headings",
  matching_sentence_endings: "Matching sentence endings", map_labelling: "Map or plan", diagram_labelling: "Diagram",
  note_completion: "Notes", form_completion: "Form", table_completion: "Table", flow_chart_completion: "Flow chart",
  summary_completion: "Summary", sentence_completion: "Sentences", short_answer: "Short answer",
  true_false_not_given: "True / False / Not Given", yes_no_not_given: "Yes / No / Not Given",
  task1_process: "Process diagram", task1_pie_chart: "Pie chart", task1_bar_chart: "Bar chart", task1_line_graph: "Line graph",
  task1_table: "Table", task1_map: "Maps and plans", task1_mixed: "Two charts together", task1_other: "Other",
  task2_opinion: "Opinion (agree or disagree)", task2_discussion: "Discuss both views", task2_advantages_disadvantages: "Advantages and disadvantages",
  task2_problem_solution: "Problems and solutions", task2_two_part_question: "Two-part question", task2_other: "Other",
  part2_person: "Part 2 card: a person", part2_place: "Part 2 card: a place", part2_object: "Part 2 card: an object",
  part2_event: "Part 2 card: an event", part2_experience: "Part 2 card: an experience", part2_activity: "Part 2 card: an activity",
  part2_media: "Part 2 card: a book, film or website", part2_other: "Part 2 card: other",
};

/** The Listening/Reading question group to drill today: the type with the lowest accuracy, its next undone group.
 *  @param items catalogue entries ({test,module,type,first,n})  @param attempts [{test,module,mode,score}] */
export function pickType(items, attempts) {
  const best = new Map();   // best score per item, so a repeat counts once (same as the Practice page)
  for (const a of attempts) { const k = `${a.test}|${a.module}|${a.mode}`; best.set(k, Math.max(best.get(k) ?? 0, a.score ?? 0)); }
  const key = i => `${i.test}|${i.module}|drill-g${i.first}`;
  const types = new Map();
  for (const i of items) if (i.first) { const k = `${i.module}|${i.type}`; types.set(k, [...(types.get(k) || []), i]); }
  // ponytail: untried types count as 60%, so a type under 60% keeps coming back and new types get a turn once you pass it
  const acc = list => { const hit = list.filter(i => best.has(key(i)));
    return hit.length ? hit.reduce((s, i) => s + best.get(key(i)), 0) / hit.reduce((s, i) => s + i.n, 0) : 0.6; };
  const list = [...types.values()].sort((a, b) => acc(a) - acc(b))[0];
  return list.find(i => !best.has(key(i))) || list[0];
}

/** Latest band per module, from full attempts only (band is null for section drills). */
export function latestBands(attempts) {
  const out = {};
  for (const a of attempts) if (a.band != null && !(a.module in out)) out[a.module] = a.band;  // attempts arrive newest first
  return out;
}

const weakest = (bands, modules) => modules.filter(m => m in bands).sort((a, b) => bands[a] - bands[b])[0] || modules[0];

/** Test with the fewest attempts in this module (ties: lowest id); drills also get the next section index. */
export function pickTest(tests, attempts, module, sections) {
  const count = id => attempts.filter(a => a.test === id && a.module === module).length;
  const t = [...tests].sort((a, b) => count(a.id) - count(b.id) || a.id.localeCompare(b.id))[0];
  const drills = attempts.filter(a => a.test === t.id && a.module === module && a.mode.startsWith("drill")).length;
  return { test: t.id, section: sections ? (drills % sections) + 1 : null };
}

/** @param {Date} today  @param tests [{id}]  @param attempts newest-first [{test,module,mode,score,band,finished_at}]  @param items the Practice catalogue */
export function plan(today, tests, attempts, modules = MODULES, items = []) {
  const bands = latestBands(attempts);
  const day = today.toISOString().slice(0, 10);
  const doneToday = attempts.filter(a => a.finished_at.slice(0, 10) === day);
  const S = (module, mode, minutes, opts = {}) => {
    const { test, section } = pickTest(tests, attempts, module, opts.sections);
    const q = new URLSearchParams({ mode, ...(section ? { section } : {}), ...(opts.task ? { task: opts.task } : {}) });
    const label = opts.label || `${LABEL[module]} ${mode}${section ? ` · ${opts.unit} ${section}` : ""}`;
    return { module, mode, minutes, label, href: `#/t/${test}/${module}?${q}`, done: doneToday.some(a => a.module === module) };
  };
  const week = Math.floor((today - new Date(today.getFullYear(), 0, 1)) / 6048e5);
  const w = weakest(bands, modules);
  const speaking = modules.includes("speaking");
  const drill = { listening: () => S("listening", "drill", 15, { sections: 4, unit: "Part" }), reading: () => S("reading", "drill", 20, { sections: 3, unit: "Passage" }),
                  writing: () => S("writing", "drill", 40, { task: 2, label: "Writing drill · Task 2" }),
                  speaking: () => S("speaking", "exam", 14, { label: "Speaking test" }) };
  const type = () => {
    const i = pickType(items, attempts);
    return { module: i.module, mode: "drill", minutes: i.module === "listening" ? 10 : 15, questions: i.n,
      label: `${LABEL[i.module]} · ${KIND_LABEL[i.type] || i.type}`, href: `#/t/${i.test}/${i.module}?mode=drill&group=${i.first}`,
      done: doneToday.some(a => a.mode.startsWith("drill-g")) };
  };
  const byDay = [
    drill.listening,
    () => S("writing", "drill", 40, { task: 2, label: "Writing drill · Task 2" }),
    drill.reading,
    drill[w],
    type,
    () => week % 2 && speaking ? S("speaking", "exam", 14, { label: "Speaking test" }) : S("writing", "drill", 20, { task: 1, label: "Writing drill · Task 1" }),
    type,
  ];
  return { phase: "rotation", bands, weakest: w, session: byDay[today.getDay()]() };
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("plan.js")) {
  const tests = [{ id: "cam15/test1" }, { id: "cam15/test2" }];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (() => { throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); })();
  let p = plan(new Date("2026-09-14T10:00:00Z"), tests, []);   // Monday, nothing attempted yet: straight into the rotation
  eq([p.phase, p.session.module], ["rotation", "writing"]);
  const A = (module, mode, band, test = "cam15/test1", d = "2026-09-13T10:00:00Z") => ({ test, module, mode, band, finished_at: d });
  const done = [A("speaking", "exam", 6.5), A("writing", "mock", 6), A("reading", "mock", 7), A("listening", "mock", 6.5)];
  p = plan(new Date("2026-09-16T10:00:00Z"), tests, done);              // Wednesday -> weakest (writing 6)
  eq([p.phase, p.weakest, p.session.module], ["rotation", "writing", "writing"]);
  p = plan(new Date("2026-09-15T10:00:00Z"), tests, [A("reading", "drill-s1", null), ...done]);  // Tuesday reading drill, next passage
  eq(p.session.href, "#/t/cam15/test2/reading?mode=drill&section=1");   // fresh material before repeats
  eq(plan(new Date("2026-09-13T10:00:00Z"), tests, done).session.module, "listening");   // Sunday: no rest day
  const items = [{ test: "cam15/test1", module: "listening", type: "form_completion", first: 1, n: 5 },
                 { test: "cam15/test2", module: "listening", type: "form_completion", first: 1, n: 5 },
                 { test: "cam15/test1", module: "reading", type: "matching_headings", first: 1, n: 6 },
                 { test: "cam15/test1", module: "writing", type: "task2_opinion", task: 2, n: 1 }];
  const thu = new Date("2026-09-17T10:00:00Z");
  eq(plan(thu, tests, [], MODULES, items).session.href, "#/t/cam15/test1/listening?mode=drill&group=1");   // nothing tried: first type
  const G = (test, module, score) => ({ test, module, mode: "drill-g1", score, band: null, finished_at: "2026-09-16T10:00:00Z" });
  eq(plan(thu, tests, [G("cam15/test1", "listening", 2)], MODULES, items).session.href, "#/t/cam15/test2/listening?mode=drill&group=1");   // 40%: same type, next group
  p = plan(thu, tests, [G("cam15/test1", "listening", 5)], MODULES, items);   // 100%: an untried type gets its turn
  eq([p.session.label, p.session.questions], ["Reading · Matching headings", 6]);
  eq(plan(new Date("2026-09-19T10:00:00Z"), tests, [{ ...G("cam15/test1", "reading", 3), finished_at: "2026-09-19T09:00:00Z" }], MODULES, items).session.done, true);   // Saturday, done
  eq(latestBands([A("reading", "drill-s2", null), A("reading", "mock", 7), A("reading", "mock", 5)]).reading, 7);
  const noSpeak = ["listening", "reading", "writing"];
  eq(plan(new Date("2026-09-18T10:00:00Z"), tests, done.slice(1), noSpeak).session.module, "writing");   // odd-week Friday: Task 1, not Speaking
  console.log("plan.js ok");
}
