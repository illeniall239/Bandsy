// "Write a band-8 version" on a Writing result: the model chosen for it rewrites the candidate's answer at band 8-9, keeping their ideas,
// then the grader marks the rewrite like any answer, so the page shows the band it actually earned instead of taking the label on trust.
import { complete } from "./providers.js";
import { gradeTask } from "./grading.js";

/** @param feedback the grading's criterion comments and corrections  @param references the book's answers, for the check's calibration */
export async function rewrite(settings, { task, prompt, image, text, feedback, references }) {
  const min = task === 1 ? 150 : 250;
  const r = await complete(settings, { job: "rewrite", image,
    schema: { type: "object", properties: { essay: { type: "string" } }, required: ["essay"] },
    system: "You are an IELTS examiner and writing teacher. You write answers that meet the band 8-9 descriptors: the task fully addressed, " +
            "a clear position (Task 2) or overview (Task 1), cohesion that attracts no attention, precise and natural less common vocabulary, " +
            "and a wide range of accurate structures.",
    prompt: `Academic Writing Task ${task}${image ? " (the figure is provided as an image)" : ""}.\n\nTASK:\n${prompt}\n\n` +
            `A CANDIDATE'S ANSWER:\n${text}\n\nTHE EXAMINER'S FEEDBACK ON IT:\n${feedback}\n\n` +
            `Rewrite it as a band 8-9 answer. Keep the candidate's position and main ideas where they are sound, so they can see how their own ` +
            `answer could be lifted, but fix everything the feedback names and develop the ideas properly. At least ${min} words and not much over ` +
            `${Math.round(min * 1.5)}. Plain paragraphs separated by a blank line, no headings.` });
  const check = await gradeTask(settings, { task, prompt, image, text: r.essay, references });
  return { essay: r.essay, band: check.band, criteria: check.criteria };
}
