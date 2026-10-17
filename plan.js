// Plans each day's practice: a few steps adding up to 45–60 minutes, chosen from how you're actually doing, not at random.
// Every attempt is marked question by question, so the plan knows which question types are costing you marks and how each module
// stands; it serves material you haven't seen (nothing repeats until its kind runs out), spreads the days across tests, brings back
// what you got wrong a few days later, and measures a full module each week. See plan() below for the week.
import { band as rawBand } from "./src/mark.js";
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

const UNIT = { listening: "Part", reading: "Passage" };
/** One Listening part at a time, hardest first (chosen 17 Oct 2026): every Part 4 in the books before any Part 3, then Part 2,
 *  then Part 1. Saturday stays a full Listening check-up; once every part is done the plan goes back to the mixed week. */
export const TRACK = [4, 3, 2, 1];
const PART_WHY = {
  4: "A lecture with no break: keep hold of the talk through ten notes",
  3: "Two or three speakers discussing: follow who thinks what",
  2: "One speaker giving information, often round a map or plan",
  1: "A conversation filling in a form or notes: spellings and numbers",
};
const SKILL = ["listening", "reading"];   // the modules marked question by question

/** The calendar day an ISO time falls on for a viewer tz minutes east of UTC. */
export const localDay = (iso, tz = 0) => new Date(new Date(iso).getTime() + tz * 6e4).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
const shortDate = day => new Date(Date.parse(day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// ---------- what you've done ----------

/** The material an attempt used, as piece keys: "test|module|s2" a part or passage, "test|module|g14" a question group,
 *  "test|writing|t1" a task, "test|speaking" a speaking test. A mock covers its whole module, and a group drill also counts
 *  against its part, so a part drill never serves questions you have already seen.  @param items the Practice catalogue */
export function covered(a, items) {
  const m = a.mode.match(/^drill-([sgt])(\d+)$/);
  if (a.module === "speaking") return a.mode === "exam" ? [`${a.test}|speaking`] : [];   // tutor mode doesn't use the test's questions
  if (a.module === "writing") return (m?.[1] === "t" ? [+m[2]] : [1, 2]).map(t => `${a.test}|writing|t${t}`);
  return items.filter(i => i.test === a.test && i.module === a.module && i.first && (!m || (m[1] === "s" ? i.section === +m[2] : i.first === +m[2])))
    .flatMap(g => [`${a.test}|${a.module}|s${g.section}`, `${a.test}|${a.module}|g${g.first}`]);
}

const later = (map, k, t) => { if (!(map.get(k) >= t)) map.set(k, t); };
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const order = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const TAKEN = "~";
/** Test 4 of every book is kept for the weekly check-ups, so a check-up is on material you haven't seen and its band means something.
 *  Practice uses the other tests first and only reaches these once its kind has run out there. */
export const reserved = test => /\/test4$/.test(test);   // sorts after every timestamp: a piece already in today's plan counts as the most recently done

/** When each piece was last done, when each test was last touched (in any module, and per module), and how often each part/passage number was done. */
function history(attempts, items) {
  const last = new Map(), touched = new Map(), module = new Map(), slots = new Map();
  for (const a of attempts) {
    const keys = covered(a, items);
    keys.forEach(k => later(last, k, a.finished_at));
    if (keys.length) { later(touched, a.test, a.finished_at); later(module, `${a.test}|${a.module}`, a.finished_at); }
  }
  for (const k of last.keys()) { const [, m, s] = k.split("|"); if (s?.[0] === "s") slots.set(`${m}|${s}`, (slots.get(`${m}|${s}`) || 0) + 1); }
  return { last, touched, module, slots };
}

/** Puts a picked piece in today's plan, so the day's other steps go to other tests and other material. */
function take(h, c) {
  h.last.set(c.key, TAKEN); h.touched.set(c.test, TAKEN); h.module.set(`${c.test}|${c.module}`, TAKEN);
  if (c.within) h.last.set(c.within, TAKEN);
  if (c.slot) h.slots.set(c.slot, (h.slots.get(c.slot) || 0) + 1);
  return c;
}

/** The freshest candidate: never done before done (then done longest ago), so nothing repeats until its kind runs out; outside the
 *  check-up tests while there's fresh material elsewhere; on a test not already in today's plan; for a question group, one whose part/passage you haven't seen either; then the test you've gone longest without touching in any
 *  module, so days don't keep landing on one test; then the part/passage number you've done least, so it isn't always Part 1;
 *  then a shuffle that changes daily, so it isn't always Cambridge 10. */
function freshest(cands, h, day) {
  const score = c => [h.last.get(c.key) || "", +reserved(c.test), +(h.touched.get(c.test) === TAKEN), h.last.get(c.within) || "", h.touched.get(c.test) || "",
    h.slots.get(c.slot) || 0, hash(`${day}|${c.key}`)];
  return take(h, cands.map(c => [score(c), c]).sort(([a], [b]) => order(a, b))[0][1]);
}

// ---------- what you could do ----------

const tests = (items, module) => [...new Set(items.filter(i => i.module === module).map(i => i.test))];
const sectionPieces = (items, module) => [...new Map(items.filter(i => i.module === module && i.first).map(i => [`${i.test}|${i.section}`, i])).values()]
  .map(({ test, section: n }) => ({ test, module, key: `${test}|${module}|s${n}`, slot: `${module}|s${n}`, mode: `drill-s${n}`,
    minutes: module === "listening" ? 10 : 20, label: `${LABEL[module]} ${UNIT[module]} ${n}`, href: `#/t/${test}/${module}?mode=drill&section=${n}` }));
const taskPieces = (items, task) => tests(items, "writing").map(test => ({ test, module: "writing", key: `${test}|writing|t${task}`, mode: `drill-t${task}`,
  minutes: task === 1 ? 20 : 40, label: `Writing Task ${task}`, href: `#/t/${test}/writing?mode=drill&task=${task}` }));
const speakingPieces = items => tests(items, "speaking").map(test => ({ test, module: "speaking", key: `${test}|speaking`, mode: "exam",
  minutes: 14, label: "Speaking test", href: `#/t/${test}/speaking?mode=exam` }));
const groupPiece = i => ({ test: i.test, module: i.module, key: `${i.test}|${i.module}|g${i.first}`, within: `${i.test}|${i.module}|s${i.section}`,
  mode: `drill-g${i.first}`, minutes: i.module === "listening" ? 10 : 12, questions: i.n, label: `${LABEL[i.module]} · ${KIND_LABEL[i.type] || i.type}`,
  href: `#/t/${i.test}/${i.module}?mode=drill&group=${i.first}` });
/** The exam's conditions on a part, passage or task: a clock (20 min a passage, the task's time), a recording played once. */
const timed = c => ({ ...c, timed: true, href: c.href.replace("mode=drill", "mode=mock") });

// ---------- how you're doing ----------

/** Every marked Listening/Reading answer, newest first: {module, type, test, first, ok, at}. Drills, mocks and retries all count. */
function answers(attempts, items) {
  const groups = new Map();
  for (const i of items) if (i.first) groups.set(`${i.test}|${i.module}`, [...(groups.get(`${i.test}|${i.module}`) || []), i]);
  const out = [];
  for (const a of attempts) if (SKILL.includes(a.module) && a.marks)
    for (const [n, ok] of Object.entries(a.marks)) {
      const g = groups.get(`${a.test}|${a.module}`)?.find(g => g.first <= +n && +n < g.first + g.n);
      if (g) out.push({ module: a.module, type: g.type, test: a.test, first: g.first, ok: !!ok, at: a.finished_at });
    }
  return out;
}

const PRIOR = 0.6, PRIOR_WEIGHT = 3, RECENT = 30;
/** Which question types to practise, most useful first. lost = marks you lose on the type in a typical test: (1 − your accuracy on
 *  its last 30 answers) × how many questions of that type a test has. The order uses (1 − accuracy)² × that count, so frequency
 *  still matters (a rare type you're bad at waits behind a common one) but a type you're weak at clearly outranks a common one you
 *  mostly get right, where the lost marks are slips rather than something to learn. A type you've barely tried is taken as 60%,
 *  pulled towards your real accuracy as answers come in. */
export function losses(ans, items, modules) {
  const count = new Set(items.map(i => i.test)).size || 1, perTest = new Map(), recent = new Map();
  for (const i of items) if (i.first && modules.includes(i.module)) perTest.set(`${i.module}|${i.type}`, (perTest.get(`${i.module}|${i.type}`) || 0) + i.n / count);
  for (const x of ans) { const k = `${x.module}|${x.type}`, l = recent.get(k) || []; if (l.length < RECENT) l.push(x.ok); recent.set(k, l); }
  return [...perTest].map(([k, q]) => {
    const l = recent.get(k) || [], right = l.filter(Boolean).length, acc = (right + PRIOR * PRIOR_WEIGHT) / (l.length + PRIOR_WEIGHT);
    const [module, type] = k.split("|");
    return { module, type, perTest: q, seen: l.length, right, lost: (1 - acc) * q, priority: (1 - acc) ** 2 * q };
  }).sort((a, b) => b.priority - a.priority);
}

/** Latest band per module, from full attempts only (band is null for drills). */
export function latestBands(attempts) {
  const out = {};
  for (const a of attempts) if (a.band != null && !(a.module in out)) out[a.module] = a.band;  // attempts arrive newest first
  return out;
}

/** Your level per module from everything you've practised, not just mocks: Listening/Reading from your last 40 marked answers
 *  (as a raw score out of 40), Writing from your last four graded tasks (Task 2 counting double), Speaking from the last test.
 *  A module stays unknown until there's enough to go on (10 answers, one task). */
export function levels(attempts, ans, modules) {
  const out = {};
  for (const m of SKILL) { const l = ans.filter(x => x.module === m).slice(0, 40); if (l.length >= 10) out[m] = rawBand(m, Math.round(40 * l.filter(x => x.ok).length / l.length)); }
  const tasks = attempts.filter(a => a.module === "writing" && a.marks).flatMap(a => [2, 1].filter(t => a.marks[t]?.band != null).map(t => [t, a.marks[t].band])).slice(0, 4);
  if (tasks.length) out.writing = Math.round(2 * tasks.reduce((s, [t, b]) => s + t * b, 0) / tasks.reduce((s, [t]) => s + t, 0)) / 2;
  const sp = attempts.find(a => a.module === "speaking" && a.band != null);
  if (sp) out.speaking = sp.band;
  return Object.fromEntries(modules.filter(m => m in out).map(m => [m, out[m]]));
}

/** Friday's focus: a module with no level yet comes first (practising it is how it gets one), the one you've done least in the last
 *  two weeks; then the lowest level. */
function focusModule(level, attempts, modules, day) {
  const recent = m => attempts.filter(a => a.module === m && daysBetween(a.finished_at.slice(0, 10), day) <= 14).length;
  return [...modules].sort((a, b) => (a in level) - (b in level) || (a in level ? level[a] - level[b] : recent(a) - recent(b)))[0];
}

// ---------- the steps a day is made of ----------

/** A question group you got under 60% on, 3 to 21 days ago, and haven't done since: done once more, so the lesson is tested when it's
 *  no longer fresh. Only once: if it's still wrong, the question-type steps keep working on it with new questions. The lowest score
 *  first, then the oldest. */
function retry(ans, items, h, day, tz, only = () => true) {
  const groups = new Map();   // the latest attempt at each group: right, total, when, and how many attempts it has had
  for (const x of ans) {
    const k = `${x.test}|${x.module}|g${x.first}`, g = groups.get(k) || { ...x, key: k, right: 0, total: 0, tries: new Set() };
    g.tries.add(x.at);
    if (x.at === g.at) { g.right += x.ok; g.total++; }
    groups.set(k, g);
  }
  const due = [...groups.values()].filter(g => only(g) && g.right / g.total < 0.6 && g.tries.size < 2
    && daysBetween(localDay(g.at, tz), day) >= 3 && daysBetween(localDay(g.at, tz), day) <= 21)
    .sort((a, b) => a.right / a.total - b.right / b.total || a.at.localeCompare(b.at));
  if (!due.length) return null;
  const g = due[0], c = take(h, groupPiece(items.find(i => i.test === g.test && i.module === g.module && i.first === g.first)));
  return { ...c, kind: "retry", minutes: g.module === "listening" ? 8 : 10,
    why: `You got ${g.right}/${g.total} on ${shortDate(localDay(g.at, tz))}. Answer again before looking at the key, then Explain anything still wrong.` };
}

const why = {
  type: t => t.seen >= 5 ? `${t.right}/${t.seen} right lately, about ${t.lost.toFixed(1)} marks lost a test on this type`
    : `New to you: about ${Math.round(t.perTest)} questions a test are this type`,
  section: (c, module) => c.timed ? (module === "listening" ? "Timed and played once, as in the exam" : "20 minutes on the clock, as in the exam")
    : (module === "listening" ? "A whole part: following the recording from question to question" : "A whole passage: reading for the questions, not every word"),
  task: (c, task, level) => `${task === 2 ? "Task 2 counts double" : "Overview first, then the key features"}${c.timed ? ", timed" : ""}. ${level != null ? `Writing is at about ${level}` : "This gives you a Writing level"}`,
};

/** @param day the viewer's date "YYYY-MM-DD"  @param attempts newest first [{test,module,mode,score,band,finished_at,marks}]
 *  @param items the Practice catalogue  @param tz the viewer's offset east of UTC in minutes  @param examDate "YYYY-MM-DD" if set
 *
 *  A day is a few steps adding up to 45–60 minutes: on four days a week a retry of something you got wrong a few days ago (when there
 *  is one), then the
 *  day's main practice. The week covers every module and puts the most time on Writing, the slowest to move; the question-type steps
 *  go to the type costing you the most marks; Friday goes to your lowest module; Saturday is a timed check-up of one full module,
 *  the one measured longest ago, for a real band. As the exam nears, parts and tasks go on the clock (8 weeks out) and a second
 *  check-up joins the week (3 weeks out).
 *
 *  While a part of the track is still undone, the six other days are the track instead: four parts you haven't done, the current
 *  one first (spilling into the next as it runs out), led by a retry of one you got under 60% on.  @param track [] for the mixed week */
export function plan(day, attempts, items, { modules = MODULES, tz = 0, examDate, track = TRACK } = {}) {
  attempts = [...attempts].sort((a, b) => b.finished_at.localeCompare(a.finished_at));   // newest first, even for one sent late after a failed save
  const today = attempts.filter(a => localDay(a.finished_at, tz) === day);
  const before = attempts.filter(a => localDay(a.finished_at, tz) < day);   // today's work doesn't move today's plan: it stays put all day
  const h = history(before, items), ans = answers(before, items);
  const bands = latestBands(attempts), level = levels(before, ans, modules);
  const weeks = examDate ? daysBetween(day, examDate) / 7 : null;
  const phase = weeks == null || weeks < 0 || weeks > 8 ? "build" : weeks > 3 ? "timed" : "final";
  const clock = c => phase === "build" ? c : timed(c);
  const partsOf = n => sectionPieces(items, "listening").filter(c => c.slot === `listening|s${n}`);
  const stage = modules.includes("listening") ? track.find(n => partsOf(n).some(c => !h.last.has(c.key))) : undefined;

  const part = () => { const c = clock(freshest(sectionPieces(items, "listening"), h, day)); return { ...c, why: why.section(c, "listening") }; };
  const passage = () => { const c = clock(freshest(sectionPieces(items, "reading"), h, day)); return { ...c, why: why.section(c, "reading") }; };
  const task = n => { const c = clock(freshest(taskPieces(items, n), h, day)); return { ...c, why: why.task(c, n, level.writing) }; };
  const speaking = () => ({ ...freshest(speakingPieces(items), h, day), why: "All three parts with the examiner" });
  /** k question groups from the most useful types to practise: at most two of one type, then the next type, so a day mixes them
   *  (and a type whose groups have run out hands over to the next). */
  const types = (ms, k) => {
    const out = [];
    for (const t of losses(ans, items, ms.filter(m => SKILL.includes(m) && modules.includes(m)))) {
      for (let n = 0; n < 2 && out.length < k; n++) {
        const fresh = items.filter(i => i.first && i.module === t.module && i.type === t.type && !h.last.has(`${i.test}|${i.module}|g${i.first}`));
        if (!fresh.length) break;
        out.push({ ...freshest(fresh.map(groupPiece), h, day), why: why.type(t) });
      }
      if (out.length >= k) break;
    }
    return out;
  };
  /** One full module under exam conditions on a test whose module you haven't touched, so the band is a clean measure. The module
   *  measured longest ago goes first (never before anything), then the lowest level. */
  const checkup = only => {
    const measured = m => before.find(a => a.module === m && a.band != null)?.finished_at || "";
    const m = only || [...modules].sort((a, b) => order([measured(a), level[a] ?? 0], [measured(b), level[b] ?? 0]))[0];
    const test = tests(items, m).map(t => [[h.module.get(`${t}|${m}`) || "", +!reserved(t), h.touched.get(t) || "", hash(`${day}|${t}`)], t]).sort(([a], [b]) => order(a, b))[0][1];
    take(h, { test, module: m, key: `${test}|${m}` });
    const last = measured(m);
    return { test, module: m, kind: "checkup", timed: true, mode: m === "speaking" ? "exam" : "mock", minutes: { listening: 40, reading: 60, writing: 60, speaking: 14 }[m],
      label: `${LABEL[m]} check-up`, href: `#/t/${test}/${m}?mode=${m === "speaking" ? "exam" : "mock"}`,
      why: `The full module under exam conditions, for a real band. ${last ? `${LABEL[m]} was last measured ${daysBetween(localDay(last, tz), day)} days ago` : `${LABEL[m]} hasn't been measured yet`}` };
  };

  const focus = focusModule(level, before, modules, day);
  const focusDay = () => focus === "writing" ? [task(2)] : focus === "speaking" ? [speaking(), ...types(SKILL, 2)] : types([focus], focus === "listening" ? 4 : 3);
  const week = [
    /* Sun */ ["Reading and Listening", "A passage and a part, to keep both moving", () => modules.includes("speaking") ? [speaking(), passage()] : [passage(), part(), ...types(SKILL, 1)]],
    /* Mon */ ["Writing", "One full essay: Task 2 is two-thirds of the Writing band", () => [task(2)]],
    /* Tue */ ["Listening", "A whole part, then the question type costing you the most Listening marks", () => [part(), ...types(["listening"], 3)]],
    /* Wed */ phase === "final" ? ["Check-up", "A second check-up this week: the exam is close", () => [checkup()]]
             : ["Reading", "A whole passage, then the question type costing you the most Reading marks", () => [passage(), ...types(["reading"], 2)]],
    /* Thu */ ["Writing and Listening", "A Task 1 report, a Listening part, and the question types costing you the most marks", () => [task(1), part(), ...types(SKILL, 2)]],
    /* Fri */ [`Focus: ${LABEL[focus]}`, focus in level ? `${LABEL[focus]} is your lowest module right now (about ${level[focus]})` : `No ${LABEL[focus]} level yet: today finds out where it is`, focusDay],
    /* Sat */ ["Weekly check-up", stage ? "A full Listening test under exam conditions, to see if the part-by-part practice is moving your band"
      : "One module under exam conditions, to see if the practice is moving your band", () => [checkup(stage && "listening")]],
  ];
  const trackDay = () => {
    const out = [retry(ans, items, h, day, tz, g => g.module === "listening" && Math.ceil(g.first / 10) === stage)];
    for (const n of track.slice(track.indexOf(stage)))
      for (let fresh; out.filter(Boolean).length < 4 && (fresh = partsOf(n).filter(c => !h.last.has(c.key))).length;) {
        const c = clock(freshest(fresh, h, day));
        out.push({ ...c, why: c.timed ? `${PART_WHY[n]}. ${why.section(c, "listening")}` : PART_WHY[n] });
      }
    return out;
  };
  const weekday = new Date(Date.parse(day)).getUTCDay();
  const checkupDay = weekday === 6 || (weekday === 3 && phase === "final");
  const onTrack = stage && !checkupDay, all = history(attempts, items).last;   // progress counts today's work too
  const [title, sub, build] = onTrack ? [`Focus: Listening Part ${stage}`,
    `Every Part ${stage} in the books, one by one, before moving on: ${partsOf(stage).filter(c => all.has(c.key)).length} of ${partsOf(stage).length} done`, trackDay]
    : week[weekday];
  // a retry on the lighter days (Sun, Mon, Wed, Fri), at most four a week, so going back over mistakes never crowds out new material;
  // planned first, so the other steps avoid its test (the track picks its own)
  const first = [0, 1, 3, 5].includes(weekday) && !checkupDay && !onTrack ? retry(ans, items, h, day, tz) : null;
  const steps = [first, ...build()].filter(Boolean).map(s => ({ ...s, kind: s.kind || "practice",
    done: today.some(a => a.test === s.test && a.module === s.module && a.mode === s.mode) }));
  return { phase, title, sub, steps, minutes: steps.reduce((n, s) => n + s.minutes, 0), bands, levels: level, focus };
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("plan.js")) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (() => { throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); })();
  const ok = (c, msg) => c || (() => { throw new Error(msg); })();
  // six tests (Test 4 kept for check-ups): Listening 4 parts (one 10-question group each), Reading 3 passages, two Writing tasks, a Speaking test
  const T = [1, 2, 3, 4, 5, 6].map(n => `cam15/test${n}`);
  const items = T.flatMap(test => [
    ...[1, 2, 3, 4].map(s => ({ test, module: "listening", type: s === 1 ? "form_completion" : "multiple_choice", section: s, first: s * 10 - 9, n: 10 })),
    ...[1, 2, 3].map(s => ({ test, module: "reading", type: s === 2 ? "matching_headings" : "true_false_not_given", section: s, first: [1, 14, 27][s - 1], n: 13 })),
    { test, module: "writing", type: "task1_table", task: 1, n: 1 }, { test, module: "writing", type: "task2_opinion", task: 2, n: 1 },
    { test, module: "speaking", type: "part2_place", n: 1 }]);
  const marks = (from, n, right) => Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, i < right]));
  const A = (test, module, mode, finished_at, extra = {}) => ({ test, module, mode, finished_at, score: 5, band: null, marks: {}, ...extra });
  const NO_SPEAK = { modules: ["listening", "reading", "writing"], track: [] };   // the mixed week; the track is checked at the end
  const SUN = "2026-10-11", MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14", THU = "2026-10-15", FRI = "2026-10-16", SAT = "2026-10-17";
  const all = d => plan(d, [], items, NO_SPEAK);

  // every day is 1-3 steps of about 30-60 minutes, every step on a different test, and the day stays put
  for (const d of [SUN, MON, TUE, WED, THU, FRI, SAT]) {
    const p = all(d);
    ok(p.steps.length >= 1 && p.minutes >= 30 && p.minutes <= 60, `${d}: ${p.minutes} min in ${p.steps.length} steps`);
    eq(new Set(p.steps.map(s => s.test)).size, p.steps.length);
    eq(all(d), p);
  }
  eq(all(MON).steps.map(s => s.label), ["Writing Task 2"]);
  eq(all(SAT).steps[0].kind, "checkup");

  // the reported bug: Listening on one test, then Writing and Reading go to other tests
  const l = all(SUN).steps.find(s => s.module === "listening");
  const h1 = [A(l.test, "listening", l.mode, `${SUN}T08:00:00Z`)];
  const wr = plan(MON, h1, items, NO_SPEAK).steps[0];
  ok(wr.test !== l.test, "Monday's writing went back to Sunday's test");

  // nothing repeats until a kind runs out: 4 tests x 4 parts = 16 different Listening parts
  const seen = new Set(); let hist = [];
  for (let d = 0; d < 16; d++) {
    const day = localDay(new Date(Date.parse(TUE) + d * 7 * 864e5).toISOString());
    const s = plan(day, hist, items, NO_SPEAK).steps.find(s => s.label.startsWith("Listening Part"));
    ok(!seen.has(s.key), `${s.key} served twice before all 16 parts were done`); seen.add(s.key);
    hist = [A(s.test, "listening", s.mode, `${day}T08:00:00Z`, { marks: marks(+s.mode.slice(7) * 10 - 9, 10, 9) }), ...hist];
  }

  // the type step goes where the marks are lost: weak on multiple choice (3 groups a test), strong on forms
  const weakMC = [A("cam15/test1", "listening", "drill-s2", `${SUN}T08:00:00Z`, { marks: marks(11, 10, 2) }), A("cam15/test1", "listening", "drill-s1", `${SUN}T07:00:00Z`, { marks: marks(1, 10, 10) })];
  const tue = plan(TUE, weakMC, items, NO_SPEAK);
  eq(tue.steps.filter(s => s.kind === "practice" && s.questions).map(s => s.label), ["Listening · One answer", "Listening · One answer", "Listening · Form"]);   // two of a type, then the next
  ok(tue.steps.find(s => s.questions).why.startsWith("2/10 right lately"), tue.steps.find(s => s.questions)?.why);

  // a group under 60% comes back 3-21 days later as a retry, once it isn't fresh; not before, and not after a good second go
  const bad = [A("cam15/test2", "reading", "drill-g14", `${MON}T08:00:00Z`, { marks: marks(14, 13, 4) })];
  ok(!plan(TUE, bad, items, NO_SPEAK).steps.some(s => s.kind === "retry"), "retried the next day");
  ok(!plan(THU, bad, items, NO_SPEAK).steps.some(s => s.kind === "retry"), "a retry on Thursday");
  const r = plan(FRI, bad, items, NO_SPEAK).steps[0];
  eq([r.kind, r.key], ["retry", "cam15/test2|reading|g14"]);
  ok(!plan(FRI, [A("cam15/test2", "reading", "drill-g14", `${WED}T08:00:00Z`, { marks: marks(14, 13, 11) }), ...bad], items, NO_SPEAK).steps.some(s => s.kind === "retry"), "retried after a good second go");
  ok(!plan("2026-11-12", bad, items, NO_SPEAK).steps.some(s => s.kind === "retry"), "retried a month later");
  ok(!plan("2026-10-21", [A("cam15/test2", "reading", "drill-g14", `${FRI}T08:00:00Z`, { marks: marks(14, 13, 5) }), ...bad], items, NO_SPEAK).steps.some(s => s.kind === "retry"), "retried twice");

  // levels from practice; Friday goes to an unknown module first, then the lowest
  eq(levels(weakMC, answers(weakMC, items), NO_SPEAK.modules), { listening: 6 });   // 12/20 right -> 24/40 -> band 6
  eq(plan(FRI, weakMC, items, NO_SPEAK).focus, "reading");
  const known = [...weakMC, A("cam15/test3", "reading", "drill-s1", `${MON}T08:00:00Z`, { marks: marks(1, 13, 12) }),
    A("cam15/test3", "writing", "drill-t2", `${MON}T09:00:00Z`, { marks: { 2: { band: 6.5 } } })];
  const fri = plan(FRI, known, items, NO_SPEAK);
  eq([fri.focus, fri.levels], ["listening", { listening: 6, reading: 8.5, writing: 6.5 }]);   // reading 12/13 -> 37/40 -> 8.5
  eq(fri.steps.filter(s => s.kind === "practice").map(s => s.module), ["listening", "listening", "listening", "listening"]);
  eq(new Set(fri.steps.filter(s => s.questions).map(s => s.label)).size, 2);   // two types, two groups each

  // Saturday's check-up: the module measured longest ago, on a test where that module is untouched
  let sat = plan(SAT, h1, items, NO_SPEAK).steps[0];
  eq([sat.module, sat.href.includes("mode=mock")], ["listening", true]);
  ok(sat.test !== l.test, "the check-up reused a test whose Listening was already done");
  sat = plan(SAT, [A("cam15/test4", "listening", "mock", `${MON}T08:00:00Z`, { band: 6.5 })], items, NO_SPEAK).steps[0];
  eq([sat.module, sat.test], ["reading", "cam15/test4"]);   // the check-up test
  ok([SUN, MON, TUE, WED, THU, FRI].every(d => all(d).steps.every(s => !reserved(s.test))), "practice used a check-up test while others were fresh");

  // closer to the exam: parts and tasks on the clock 3-8 weeks out, a second check-up in the last 3
  ok(plan(SUN, [], items, { ...NO_SPEAK, examDate: "2026-11-22" }).steps.filter(s => !s.questions).every(s => s.timed && s.href.includes("mode=mock")), "6 weeks out: untimed parts");
  eq(plan(WED, [], items, { ...NO_SPEAK, examDate: "2026-10-28" }).steps[0].kind, "checkup");
  eq(plan(SUN, [], items, { ...NO_SPEAK, examDate: "2027-06-01" }).phase, "build");

  // the day is the viewer's: 20:00 UTC on Sunday is Monday in Pakistan, so it isn't Sunday's work
  const late = A(l.test, "listening", l.mode, `${SUN}T20:00:00Z`);
  eq(plan(SUN, [late], items, { ...NO_SPEAK, tz: 300 }).steps.find(s => s.key === l.key)?.done, false);
  eq(plan(SUN, [late], items, NO_SPEAK).steps.find(s => s.key === l.key)?.done, true);

  // the track: four Part 4s a day on four tests, never a check-up test while others are fresh
  const TRACKED = { modules: NO_SPEAK.modules };
  const t0 = plan(TUE, [], items, TRACKED);
  eq([t0.title, t0.steps.map(s => s.label)], ["Focus: Listening Part 4", Array(4).fill("Listening Part 4")]);
  ok(t0.sub.endsWith("0 of 6 done"), t0.sub);
  eq(new Set(t0.steps.map(s => s.test)).size, 4);
  ok(t0.steps.every(s => !reserved(s.test)), "the track used a check-up test while others were fresh");
  // the last Part 4s left, then straight on into Part 3; the count includes today's work
  const did = (n, tests, d = MON, right = 9) => tests.map(t => A(t, "listening", `drill-s${n}`, `${d}T08:00:00Z`, { marks: marks(n * 10 - 9, 10, right) }));
  const five = did(4, T.slice(0, 5));
  const t1 = plan(TUE, five, items, TRACKED);
  eq([t1.title, t1.steps.map(s => s.label)], ["Focus: Listening Part 4", ["Listening Part 4", "Listening Part 3", "Listening Part 3", "Listening Part 3"]]);
  ok(plan(TUE, [...did(4, [t1.steps[0].test], TUE), ...five], items, TRACKED).sub.endsWith("6 of 6 done"), "today's part not counted");
  eq(plan(WED, did(4, T), items, TRACKED).title, "Focus: Listening Part 3");
  // a full Listening check-up counts its Part 4 as done
  eq(plan(TUE, [A("cam15/test4", "listening", "mock", `${MON}T08:00:00Z`, { band: 6 }), ...did(4, T.filter(t => !reserved(t)))], items, TRACKED).title, "Focus: Listening Part 3");
  // a Part 4 under 60% comes back as the day's first step, 3+ days later; a weak Part 1 doesn't while on Part 4
  const weak4 = did(4, ["cam15/test1"], SUN, 4), t2 = plan(WED, weak4, items, TRACKED);
  eq([t2.steps[0].kind, t2.steps[0].key, t2.steps.length], ["retry", "cam15/test1|listening|g31", 4]);
  ok(!plan(WED, did(1, ["cam15/test1"], SUN, 3), items, TRACKED).steps.some(s => s.kind === "retry"), "retried a Part 1 during Part 4");
  // Saturday stays a full Listening test, even when Listening was measured more recently than Reading
  const sat2 = plan(SAT, [A("cam15/test5", "listening", "mock", `${FRI}T08:00:00Z`, { band: 6 })], items, TRACKED).steps;
  eq([sat2.length, sat2[0].kind, sat2[0].module], [1, "checkup", "listening"]);
  // every part done: back to the mixed week
  eq(plan(TUE, [4, 3, 2, 1].flatMap(n => did(n, T)), items, TRACKED).title, "Listening");
  console.log("plan.js ok");
}
