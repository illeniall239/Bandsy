// Picks today's one session. Diagnostic first (one module a day, Listening first), then a fixed weekly
// rotation weighted to the weakest module. 6 days/week, 30-minute cap, Sunday review, mock section every 2nd Saturday.
export const MODULES = ["listening", "reading", "writing", "speaking"];
const LABEL = { listening: "Listening", reading: "Reading", writing: "Writing", speaking: "Speaking" };

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

/** @param {Date} today  @param tests [{id}]  @param attempts newest-first [{test,module,mode,band,finished_at}] */
export function plan(today, tests, attempts, modules = MODULES) {
  const bands = latestBands(attempts);
  const day = today.toISOString().slice(0, 10);
  const doneToday = attempts.filter(a => a.finished_at.slice(0, 10) === day);
  const missing = modules.find(m => !attempts.some(a => a.module === m && (a.mode === "mock" || a.mode === "exam")));
  const S = (module, mode, minutes, opts = {}) => {
    const { test, section } = pickTest(tests, attempts, module, opts.sections);
    const q = new URLSearchParams({ mode, ...(section ? { section } : {}), ...(opts.task ? { task: opts.task } : {}) });
    const label = opts.label || `${LABEL[module]} ${mode}${section ? ` · ${opts.unit} ${section}` : ""}`;
    return { module, mode, minutes, label, href: `#/t/${test}/${module}?${q}`, done: doneToday.some(a => a.module === module) };
  };
  if (missing) return { phase: "diagnostic", bands, session: { ...S(missing, missing === "speaking" ? "exam" : "mock", { listening: 32, reading: 60, writing: 60, speaking: 14 }[missing]), label: `Diagnostic · ${LABEL[missing]} ${missing === "speaking" ? "test" : "mock"}` } };
  const week = Math.floor((today - new Date(today.getFullYear(), 0, 1)) / 6048e5);
  const w = weakest(bands, modules);
  const speaking = modules.includes("speaking");
  const drill = { listening: () => S("listening", "drill", 15, { sections: 4, unit: "Part" }), reading: () => S("reading", "drill", 20, { sections: 3, unit: "Passage" }),
                  writing: () => S("writing", "drill", 40, { task: 2, label: "Writing drill · Task 2" }),
                  speaking: () => S("speaking", "exam", 14, { label: "Speaking test" }) };
  const byDay = [
    () => ({ module: "rest", mode: "rest", minutes: 0, label: "Rest day", href: null, done: false }),
    () => S("writing", "drill", 40, { task: 2, label: "Writing drill · Task 2" }),
    drill.reading,
    drill[w],
    drill.listening,
    () => week % 2 && speaking ? S("speaking", "exam", 14, { label: "Speaking test" }) : S("writing", "drill", 20, { task: 1, label: "Writing drill · Task 1" }),
    () => week % 2 ? S("listening", "mock", 32, { label: "Listening mock" }) : S("reading", "mock", 60, { label: "Reading mock" }),
  ];
  return { phase: "rotation", bands, weakest: w, session: byDay[today.getDay()]() };
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("plan.js")) {
  const tests = [{ id: "cam15/test1" }, { id: "cam15/test2" }];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (() => { throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); })();
  let p = plan(new Date("2026-09-14T10:00:00Z"), tests, []);
  eq([p.phase, p.session.module, p.session.mode], ["diagnostic", "listening", "mock"]);
  const A = (module, mode, band, test = "cam15/test1", d = "2026-09-13T10:00:00Z") => ({ test, module, mode, band, finished_at: d });
  const done = [A("speaking", "exam", 6.5), A("writing", "mock", 6), A("reading", "mock", 7), A("listening", "mock", 6.5)];
  p = plan(new Date("2026-09-16T10:00:00Z"), tests, done);              // Wednesday -> weakest (writing 6)
  eq([p.phase, p.weakest, p.session.module], ["rotation", "writing", "writing"]);
  p = plan(new Date("2026-09-15T10:00:00Z"), tests, [A("reading", "drill-s1", null), ...done]);  // Tuesday reading drill, next passage
  eq(p.session.href, "#/t/cam15/test2/reading?mode=drill&section=1");   // fresh material before repeats
  eq(plan(new Date("2026-09-13T10:00:00Z"), tests, done).session.mode, "rest");
  eq(latestBands([A("reading", "drill-s2", null), A("reading", "mock", 7), A("reading", "mock", 5)]).reading, 7);
  const noSpeak = ["listening", "reading", "writing"];
  eq(plan(new Date("2026-09-16T10:00:00Z"), tests, done.slice(1), noSpeak).phase, "rotation");   // no Speaking diagnostic without Speaking
  eq(plan(new Date("2026-09-18T10:00:00Z"), tests, done.slice(1), noSpeak).session.module, "writing");   // odd-week Friday: Task 1, not Speaking
  console.log("plan.js ok");
}
