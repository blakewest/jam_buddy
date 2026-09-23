// Conservative engineering budgets, not tokenizer estimates. UTF-8 bytes bound
// ordinary JSON token counts with room left for provider framing/output.
export const REQUEST_LIMITS = Object.freeze({ questions: 32, bytes: 56000, pairBytes: 28000, choices: 255 });
export function requestBudgetError(state, questions) {
  if (Object.keys(questions).length > REQUEST_LIMITS.questions) return "Too many questions in one request.";
  if (Buffer.byteLength(JSON.stringify({ state, questions, model: "jev-latest" })) > REQUEST_LIMITS.bytes) return "The combined request is too large.";
  for (const question of Object.values(questions)) {
    if (question.type === "choice" && Object.keys(question.criteria).length > REQUEST_LIMITS.choices) return "Too many choices in one question.";
    if (Buffer.byteLength(JSON.stringify({ state, question })) > REQUEST_LIMITS.pairBytes) return "The pattern context and a question are too large.";
  }
  return null;
}
