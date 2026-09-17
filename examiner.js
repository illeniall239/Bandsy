// Speaking examiner: a scripted state machine over the extracted Cambridge frame (exam mode) or a model in the
// loop (tutor mode). Audio in/out goes through the local sidecar (sidecar/audio.py). Latency plan: the next scripted
// utterance is synthesized while the candidate is still talking, and transcription runs in the background — a turn
// costs the upload, not the models. The model is only in the loop for Part 3 follow-ups, tutor replies and grading.
import { complete } from "./providers.js";

const SIDECAR = "http://127.0.0.1:3002";
const sessions = new Map();

export async function tts(text, voice = "bf_emma") {
  const r = await fetch(`${SIDECAR}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) });
  if (!r.ok) throw new Error(`sidecar tts: ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}
async function stt(audio) {
  const r = await fetch(`${SIDECAR}/stt`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: audio });
  if (!r.ok) throw new Error(`sidecar stt: ${r.status}`);
  return r.json();
}

/** The official frame, flattened into utterances the examiner says in order. kind drives the client (cue card, timers). */
function script(sp) {
  const u = [];
  u.push({ part: 1, kind: "say", text: "Good afternoon. My name is Emma. Can you tell me your full name, please?" });
  u.push({ part: 1, kind: "ask", text: "Thank you. And what shall I call you?" });
  for (const t of sp.part1) {
    t.questions.forEach((q, i) => u.push({ part: 1, kind: "ask", text: i === 0 ? `Let's talk about ${t.topic.toLowerCase()}. ${q}` : q, topic: t.topic }));
  }
  u.push({ part: 2, kind: "cue", text: "Now, I'm going to give you a topic, and I'd like you to talk about it for one to two minutes. Before you talk, you'll have one minute to think about what you're going to say. You can make some notes if you wish. Here is your topic.", cue: sp.part2 });
  u.push({ part: 2, kind: "talk", text: "All right? Remember, you have one to two minutes for this, so don't worry if I stop you. I'll tell you when the time is up. Can you start speaking now, please?" });
  for (const q of sp.part2.rounding_off || []) u.push({ part: 2, kind: "ask", text: q });
  sp.part3.forEach((t, ti) => t.questions.forEach((q, i) => u.push({ part: 3, kind: "ask", topic: t.topic, followup: true,
    text: i === 0 ? (ti === 0 ? `Thank you. We've been talking about ${sp.part2.cue.replace(/^Describe /i, "").replace(/\.$/, "")}, and I'd like to discuss with you one or two more general questions related to this. Let's consider first of all ${t.topic.toLowerCase()}. ${q}` : `Let's move on to talk about ${t.topic.toLowerCase()}. ${q}`) : q })));
  u.push({ part: 3, kind: "end", text: "Thank you very much. That is the end of the speaking test." });
  return u;
}

async function utterance(s, i) {
  if (!s.audio[i]) s.audio[i] = tts(s.script[i].text);   // memoised promise: prefetch = kick this off early
  const { text, part, kind, cue } = s.script[i];
  return { index: i, text, part, kind, cue: cue || null, audio: await s.audio[i] };
}

export async function start(settings, { test, speaking, mode }) {
  const id = Math.random().toString(36).slice(2);
  const s = { id, test, mode, speaking, script: mode === "exam" ? script(speaking) : [], audio: {}, i: 0, turns: [], pending: [], settings,
              startedAt: new Date().toISOString(), followups: [] };
  sessions.set(id, s);
  if (mode === "tutor") {
    s.script.push({ part: 0, kind: "ask", text: "Hello! I'm your speaking tutor. Let's just talk, and I'll correct you as we go. To start: tell me about a place you like to spend time in." });
  }
  const first = await utterance(s, 0);
  if (s.script[1]) utterance(s, 1);   // prefetch
  return { session: id, ...first, filler: await tts("Mm-hm.") };
}

/** One candidate turn: store audio for background transcription, return the next thing the examiner says. */
export async function turn(settings, { session, audio }) {
  const s = sessions.get(session);
  if (!s) throw new Error("no such session");
  const cur = s.script[s.i];
  const t = { index: s.i, part: cur.part, question: cur.text, text: null, words: [], duration: 0 };
  s.turns.push(t);
  const job = stt(audio).then(r => { t.text = r.text; t.words = r.words; t.duration = r.duration; }).catch(e => { t.text = `[transcription failed: ${e.message}]`; });
  s.pending.push(job);

  if (s.mode === "tutor") {
    await job;
    const reply = await complete(settings, { job: "examiner", schema: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] },
      system: "You are a friendly IELTS speaking tutor in a spoken conversation. Reply in 2-3 short spoken sentences: react to what they said, correct at most one language error briefly (say the better phrasing), then ask a follow-up question on IELTS-style topics. Never use lists or markdown.",
      prompt: s.turns.map(x => `Tutor: ${x.question}\nCandidate: ${x.text}`).join("\n\n") });
    s.script.push({ part: 0, kind: "ask", text: reply.reply }); s.i++;
    return utterance(s, s.i);
  }

  // exam: a Part 3 follow-up referencing the *previous* answer is generated while the candidate answers the scripted
  // question, and slotted in after it — so it can quote them without making them wait.
  if (cur.part === 3 && cur.followup && s.followups.length < 3 && s.turns.length >= 2 && !s.script[s.i + 1]?.generated) {
    const prev = s.turns[s.turns.length - 2];
    if (prev.text && prev.part === 3) {
      complete(settings, { job: "examiner", schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        system: "You are an IELTS Speaking examiner in Part 3. Ask ONE natural follow-up question (max 25 words) that picks up something specific the candidate just said, pushing them to justify, compare or speculate. Spoken register, no preamble.",
        prompt: `Examiner asked: ${prev.question}\nCandidate said: ${prev.text}` })
        .then(r => { s.script.splice(s.i + 1, 0, { part: 3, kind: "ask", text: r.question, generated: true }); s.followups.push(r.question); utterance(s, s.i + 1); })
        .catch(() => {});   // no follow-up is fine; the script continues
    }
  }
  s.i++;
  if (!s.script[s.i]) s.script.push({ part: 3, kind: "end", text: "Thank you very much. That is the end of the speaking test." });
  const next = await utterance(s, s.i);
  if (s.script[s.i + 1]) utterance(s, s.i + 1);   // prefetch the one after
  return next;
}

const SCHEMA = {
  type: "object",
  properties: {
    criteria: { type: "object", properties: Object.fromEntries(["fluency", "lexical", "grammar"].map(k =>
      [k, { type: "object", properties: { band: { type: "integer" }, comment: { type: "string" } }, required: ["band", "comment"] }])), required: ["fluency", "lexical", "grammar"] },
    errors: { type: "array", items: { type: "object", properties: { quote: { type: "string" }, correction: { type: "string" }, explanation: { type: "string" } }, required: ["quote", "correction", "explanation"] } },
    better: { type: "array", items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string", description: "a band-8 answer to this question, 3-5 spoken sentences, same ideas as the candidate where possible" } }, required: ["question", "answer"] },
             description: "for the three weakest answers" },
  },
  required: ["criteria", "errors", "better"],
};
const DESCRIPTORS = `IELTS Speaking band descriptors (public, condensed). Whole bands.
FLUENCY & COHERENCE 9: fluent, rare repetition/self-correction, hesitation only content-related, fully coherent. 8: fluent with only occasional repetition or self-correction, hesitation content-related, topics developed coherently. 7: speaks at length without noticeable effort, some hesitation/repetition, range of connectives with some flexibility. 6: willing to speak at length though loses coherence at times through repetition, self-correction or hesitation; connectives not always appropriate. 5: maintains flow but uses repetition, self-correction and slow speech to keep going; over-uses connectives; simple speech fluent, complex causes problems. 4: noticeable pauses, slow speech, frequent repetition; links basic sentences, breakdowns in coherence.
LEXICAL RESOURCE 9: full flexibility and precision, idiomatic language naturally. 8: wide range, flexible, skilful less common/idiomatic use with occasional inaccuracies, effective paraphrase. 7: flexible on a variety of topics, some less common/idiomatic vocabulary with some awareness of style/collocation, effective paraphrase. 6: wide enough to discuss topics at length, meaning clear despite inappropriacies, generally paraphrases successfully. 5: talks about familiar and unfamiliar topics with limited flexibility, attempts paraphrase with mixed success. 4: basic meaning on familiar topics, frequent errors in word choice, rarely paraphrases.
GRAMMATICAL RANGE & ACCURACY 9: full range, consistently accurate. 8: wide range, flexible, majority error-free with only occasional non-systematic errors. 7: range of complex structures with some flexibility, frequently error-free sentences though some errors persist. 6: mix of simple and complex, limited flexibility, errors in complex structures but rarely impede. 5: basic forms with reasonable accuracy, limited range of complex structures which usually contain errors. 4: basic forms, some correct simple sentences, subordinate structures rare, frequent errors.`;

export async function finish(settings, { session }) {
  const s = sessions.get(session);
  if (!s) throw new Error("no such session");
  await Promise.all(s.pending);
  const spoken = s.turns.filter(t => t.text && !t.text.startsWith("["));
  const words = spoken.reduce((n, t) => n + t.words.length, 0);
  const dur = spoken.reduce((n, t) => n + t.duration, 0);
  const pauses = spoken.flatMap(t => t.words.slice(1).map((w, i) => w.start - t.words[i].end)).filter(g => g > 1);
  const stats = { words, seconds: Math.round(dur), wpm: dur ? Math.round(words / dur * 60) : 0, long_pauses: pauses.length, longest_pause: Math.round(Math.max(0, ...pauses) * 10) / 10 };
  const transcript = s.turns.map(t => `[Part ${t.part}] Examiner: ${t.question}\nCandidate: ${t.text ?? "(no speech)"}`).join("\n\n");
  const r = await complete(settings, { job: "examiner", schema: SCHEMA,
    system: `You are a certified IELTS Speaking examiner. Grade strictly. Pronunciation is NOT assessed (you only have a transcript). Use the fluency statistics given.\n\n${DESCRIPTORS}`,
    prompt: `Speech statistics: ${stats.words} words in ${stats.seconds}s (${stats.wpm} wpm), ${stats.long_pauses} pauses over 1s, longest ${stats.longest_pause}s. Native-like conversational pace is roughly 130-160 wpm.\n\nTRANSCRIPT (automatic; minor mishearings possible):\n${transcript}` });
  const bands = Object.values(r.criteria).map(c => c.band);
  const band = Math.round((bands.reduce((a, b) => a + b, 0) / 3) * 2) / 2;
  sessions.delete(session);
  return { test: s.test, module: "speaking", mode: s.mode, started_at: s.startedAt, finished_at: new Date().toISOString(),
    answers: s.turns.map(({ index, part, question, text }) => ({ index, part, question, text })), marks: { ...r, stats, pronunciation: "not assessed" }, score: 0, band };
}
