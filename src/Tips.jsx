// Strategy tips per question type, shown under a group's instructions (and under a Writing task). Standard advice from
// the official IELTS guidance and the public band descriptors; "listening:" / "reading:" keys override the shared ones.
const LIMIT = "Check the word limit in the instructions. One word over it makes the answer wrong, even if the words are right.";
const ORDER = "Within this group, the answers come in the same order as the questions. A new group starts again from the top.";
const EXACT = "Copy the words exactly as they appear in the passage. Don't change their form.";
const PREDICT = "Before you start, guess what kind of word fits each gap: a noun, a number, a plural, a name?";
const L_SPELL = "Spelling and singular/plural count. A misspelt answer is wrong.";
const L_MOVE = "You hear it once. If you miss an answer, leave it and move on, or you'll miss the next one as well.";

export const TIPS = {
  "listening:form_completion": ["Names are often spelt out and numbers read in pairs (\"double 5\" means 55). Write exactly what you hear.", "Watch for corrections: \"It's Tuesday… oh no, sorry, Thursday.\" The second one counts.", L_SPELL, L_MOVE],
  "listening:note_completion": [PREDICT, ORDER, L_SPELL, L_MOVE],
  "listening:table_completion": ["Read the column and row headings first. They tell you what each gap needs.", PREDICT, L_SPELL, LIMIT],
  "listening:flow_chart_completion": ["Follow the arrows. The stages are spoken in order.", PREDICT, L_SPELL, LIMIT],
  "listening:summary_completion": [PREDICT, ORDER, L_SPELL, LIMIT],
  "listening:sentence_completion": ["Your answer must make the sentence grammatically correct.", ORDER, L_SPELL, LIMIT],
  "listening:short_answer": [LIMIT, ORDER, L_SPELL],
  "listening:multiple_choice": ["The options are usually all mentioned. The recording rules some of them out. Listen for \"but\", \"actually\", \"in fact\".", "The right answer is usually reworded, not the exact words in the option.", "Underline what makes each option different before the audio starts."],
  "listening:multiple_choice_multi": ["Each correct letter is one mark, in any order.", "Several options will be mentioned. Pick the two the speakers actually agree on or confirm."],
  "listening:matching_features": [ORDER, "The options box is not in order, and some options may not be used.", "Listen for the reworded meaning, not the exact word in the box."],
  "listening:map_labelling": ["Before the audio starts, find the starting point (\"you are here\", the entrance) and check which way is north.", "Listen for position words: opposite, next to, beyond, on the corner, at the far end.", ORDER],
  "listening:diagram_labelling": ["Look at the diagram first and name the parts you can see.", ORDER, L_SPELL],

  true_false_not_given: ["TRUE = the passage says so. FALSE = the passage says the opposite. NOT GIVEN = the passage doesn't say.", "Use only the passage, never what you already know.", "Watch the qualifiers: all/some, always/usually, may/will. One word can turn TRUE into FALSE.", ORDER],
  yes_no_not_given: ["These are about the writer's opinion, not facts. YES = the writer agrees, NO = the writer disagrees, NOT GIVEN = no view either way.", "Look for opinion language: argues, believes, \"it is clear that\", \"surprisingly\".", ORDER],
  matching_headings: ["The heading is the paragraph's main idea, not a detail in it. Read the first and last sentences.", "There are more headings than paragraphs. Cross off each one you use.", "A heading that repeats a word from the paragraph is often a trap. Match the meaning instead."],
  matching_information: ["These are NOT in passage order. Do them last, once you know the passage.", "Each question names a type of information (\"an example of…\", \"a reason for…\"). Scan for that, not the topic.", "Check the instructions: a letter may be used more than once."],
  matching_features: ["Find every name in the passage first and mark it. The questions aren't in order.", "The statements are reworded. Match what each person said, not the same words."],
  matching_sentence_endings: [ORDER, "The ending must fit both the meaning and the grammar.", "There are extra endings. Some fit the grammar but say something the passage doesn't."],
  sentence_completion: [EXACT, LIMIT, ORDER],
  summary_completion: ["The summary may cover only one part of the passage. Find that part first.", PREDICT, "With a word box, the words are reworded. Without one, copy words from the passage.", LIMIT],
  note_completion: [EXACT, PREDICT, LIMIT],
  table_completion: ["Use the headings to work out what each gap needs.", EXACT, LIMIT],
  flow_chart_completion: ["The stages usually follow the passage in order.", EXACT, LIMIT],
  diagram_labelling: ["The answers usually come from one or two paragraphs that describe the object. Find them first.", EXACT, LIMIT],
  short_answer: [LIMIT, ORDER, EXACT],
  multiple_choice: [ORDER, "An option that repeats the passage's exact words is often a trap. The right one is usually reworded.", "Rule out the options you can prove wrong, then check the one that's left."],
  multiple_choice_multi: ["Each correct letter is one mark, in any order.", "Check each option against the passage on its own."],

  task1: ["Write at least 150 words in about 20 minutes. Task 2 is worth twice as much.", "Write an overview of the main trends or features. Without one, Task Achievement stays below band 7.", "Describe and compare only. Don't give opinions or reasons the chart doesn't show.", "Choose the key features and support them with figures. Don't list every number."],
  task2: ["Write at least 250 words in about 40 minutes. Spend the first 5 minutes planning.", "Answer every part of the question. A partly answered question limits Task Response.", "One main idea per paragraph, explained and backed by an example.", "Keep your position clear and the same from the introduction to the conclusion."],
  task1_process: ["Say how many stages there are, and where the process starts and ends, in your overview.", "Use the passive (\"is heated\", \"are collected\") and sequence words (first, then, once, finally)."],
  task1_map: ["Your overview gives the biggest overall change (\"more developed\", \"more residential\").", "Use the passive for changes: \"was demolished\", \"has been replaced\". Use positions: \"to the north of\"."],
  task1_line_graph: ["Your overview gives the overall trend of each line and which one ends highest.", "Mix verbs and nouns: \"rose sharply\" / \"a sharp rise\". Keep the time phrases accurate."],
  task1_bar_chart: ["Your overview gives the largest and smallest categories, or the clearest pattern.", "Group bars that behave alike instead of describing each one."],
  task1_pie_chart: ["Your overview gives the biggest and smallest shares, and the biggest changes if there are several pies.", "Vary how you give proportions: a quarter, just under half, the majority."],
  task1_table: ["Don't list every cell. Pick the highest, lowest and most striking differences.", "Your overview gives the pattern across the whole table."],
  task1_mixed: ["Your overview covers both charts and how they relate.", "Usually one paragraph per chart, linked where the data connect."],
  task2_opinion: ["Say clearly how far you agree in the introduction, and keep the same view to the end.", "Every body paragraph should support your position."],
  task2_discussion: ["Discuss BOTH views, a paragraph each, then give your own opinion if the question asks for it.", "Make your opinion clear by the conclusion at the latest."],
  task2_advantages_disadvantages: ["If the question asks whether the advantages outweigh the disadvantages, you must say which, clearly.", "One paragraph for advantages and one for disadvantages works well."],
  task2_problem_solution: ["Make each solution match a problem you described.", "Explain how the solution would work, not just what it is."],
  task2_two_part_question: ["There are two questions. Answer both, roughly one body paragraph each.", "Underline both questions before you plan."],
};

/** Tips for one question group or Writing task; collapsed in a full test (the real exam has none). */
export function Tips({ keys, mock }) {
  const list = [...new Set(keys.flatMap(k => TIPS[k] || []))];
  if (!list.length) return null;
  return (
    <details className="tips" open={!mock}>
      <summary>Tips</summary>
      <ul>{list.map(t => <li key={t}>{t}</li>)}</ul>
    </details>);
}
