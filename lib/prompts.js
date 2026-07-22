// prompts.js — LLM prompt templates for anki-quizzer v2.
//
// Two prompts:
//   1. SESSION_PROMPT — given a session summary + memory, output 1–3 concepts
//      with 5 MC questions each. Used by /api/session-quiz.
//   2. CLUSTER_PROMPT — given a cluster of related Anki cards, output rich MC
//      questions with coherent distractors. Used by /api/quiz mode="mc".

const SESSION_PROMPT = `You are helping a learner solidify their understanding of work they just did in a coding session. Below is the project's summary and recent session memory. From this material, identify 1-3 concepts, decisions, or pieces of new knowledge that are genuinely worth retaining — skip trivial or purely administrative details.

<summary>
{{summary_md}}
</summary>

<memory>
{{memory_md}}
</memory>

For EACH concept, produce:

1. "background": 2-4 sentences explaining what existed before, or what problem prompted this. Assume the reader worked on this but may be fuzzy on details a few days later.
2. "intuition": 2-3 sentences giving the core idea in plain terms, with a concrete example if possible. No jargon without explanation.
3. "quiz": exactly 5 multiple-choice questions testing whether the reader actually understood the concept — not trivia, not gotchas. Medium difficulty: answerable only if you understood the substance. Each question has exactly 4 options, exactly one correct.

Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:

{
 "concepts": [
 {
 "title": "short concept title",
 "background": "...",
 "intuition": "...",
 "quiz": [
 {
 "question": "...",
 "options": [
 { "text": "...", "correct": false, "explanation": "why this is wrong" },
 { "text": "...", "correct": true, "explanation": "why this is right" },
 { "text": "...", "correct": false, "explanation": "why this is wrong" },
 { "text": "...", "correct": false, "explanation": "why this is wrong" }
 ]
 }
 ]
 }
 ]
}

Write in clear, engaging prose — think clarity of explanation, not a dry spec. Shuffle option order yourself so the correct answer isn't always in the same position.`;

const CLUSTER_PROMPT = `You are helping someone review flashcards from their Anki deck. Below is a cluster of related cards (same tag/topic). Most learners find isolated flashcard MC options weak because the distractors are arbitrary and the questions feel disconnected. Fix that.

<cards>
{{cards_json}}
</cards>

First, write:

1. "background": 2-3 sentences on what ties these cards together conceptually.
2. "intuition": 2-3 sentences giving the core mental model for this cluster, with a concrete example.

Then, for EACH card, produce a multiple-choice question:
- The question should be derivable from the card's front, but phrased so it requires understanding the cluster's concept, not just pattern-matching the original wording.
- Generate 3 plausible, coherent WRONG options — distractors that reflect real misconceptions or adjacent-but-wrong facts, not random noise. Avoid options that are obviously silly or unrelated.
- Include the card's original back-text as the correct option, lightly reworded if needed to fit as a clean multiple-choice answer.
- Give a one-sentence explanation for why each option is right or wrong.

Return ONLY valid JSON, no markdown fences, no preamble:

{
 "background": "...",
 "intuition": "...",
 "cards": [
 {
 "id": "<original card id, unchanged>",
 "question": "...",
 "options": [
 { "text": "...", "correct": true, "explanation": "..." },
 { "text": "...", "correct": false, "explanation": "..." },
 { "text": "...", "correct": false, "explanation": "..." },
 { "text": "...", "correct": false, "explanation": "..." }
 ]
 }
 ]
}`;

function fillSessionPrompt(summaryMd, memoryMd) {
  return SESSION_PROMPT
    .replace('{{summary_md}}', summaryMd || '')
    .replace('{{memory_md}}', memoryMd || '');
}

function fillClusterPrompt(cards) {
  return CLUSTER_PROMPT.replace('{{cards_json}}', JSON.stringify(cards, null, 2));
}

module.exports = { fillSessionPrompt, fillClusterPrompt };
