import { appendHistory, applyPatternAnswers, createPatternState, INSTRUMENTS, resizePattern, stateForJev } from "./pattern-state.js";

function withPass(items, pass) {
  return items.map(item => ({ ...item, pass }));
}

export async function runPatternRequest({ initialState, request, decide, estimateOperations, maxPasses = 8, onPass = () => {} }) {
  let workingState = createPatternState(initialState);
  const passes = [];
  const result = { reset_probability: 0, candidates: [], applied_changes: [], rejected_changes: [], ignored_changes: [], pass_count: 0 };
  const historyEntry = { request, applied_changes: [], rejected_changes: [] };
  const usage = {};
  let questionCount = 0;
  let latencyMs = 0;
  let model = null;
  let plan = null;
  let plannedOperations = maxPasses;
  let relevantInstruments = [...INSTRUMENTS];

  const addMetrics = decision => {
    for (const [key, value] of Object.entries(decision.usage ?? {})) if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
    questionCount += Number(decision.question_count) || 0;
    latencyMs += Number(decision.latency_ms) || 0;
    model = decision.model ?? model;
  };

  if (estimateOperations) {
    const sentState = stateForJev(workingState, request);
    const decision = await estimateOperations(sentState);
    if (!Number.isInteger(decision.operation_count) || decision.operation_count < 0 || decision.operation_count > 8) throw new Error("Jev returned an invalid operation count.");
    if (!Number.isInteger(decision.phrase_bars) || decision.phrase_bars < 1 || decision.phrase_bars > 4) throw new Error("Jev returned an invalid phrase length.");
    if (!Array.isArray(decision.relevant_instruments) || !decision.relevant_instruments.length || decision.relevant_instruments.some(instrument => !INSTRUMENTS.includes(instrument))) throw new Error("Jev returned invalid relevant instruments.");
    plannedOperations = Math.min(decision.operation_count, maxPasses);
    relevantInstruments = [...new Set(decision.relevant_instruments)];
    plan = { sent_state: sentState, ...decision };
    addMetrics(decision);
    if (decision.phrase_bars !== workingState.pattern.bars) {
      const before = workingState.pattern.bars;
      const removedNotes = workingState.pattern.notes.filter(note => note.bar > decision.phrase_bars).length;
      workingState = resizePattern(workingState, decision.phrase_bars);
      const resize = { kind: "resize", before_bars: before, after_bars: decision.phrase_bars, removed_notes: removedNotes };
      result.applied_changes.push(resize);
      historyEntry.applied_changes.push(`Changed phrase length from ${before} ${before === 1 ? "bar" : "bars"} to ${decision.phrase_bars} ${decision.phrase_bars === 1 ? "bar" : "bars"}`);
    }
  }
  result.planned_operations = plannedOperations;

  for (let pass = 1; pass <= plannedOperations; pass++) {
    const sentState = stateForJev(workingState, request);
    const decision = await decide(sentState, pass, { relevant_instruments: relevantInstruments });
    const applied = applyPatternAnswers(workingState, decision.answers, request, { maxOperations: 1, recordHistory: false });
    const passRecord = { pass, sent_state: sentState, ...decision, result: applied.result };
    passes.push(passRecord);
    await onPass(passRecord);

    workingState = applied.state;
    result.reset_probability = Math.max(result.reset_probability, applied.result.reset_probability);
    result.candidates.push(...withPass(applied.result.candidates, pass));
    result.applied_changes.push(...withPass(applied.result.applied_changes, pass));
    result.rejected_changes.push(...withPass(applied.result.rejected_changes, pass));
    result.ignored_changes.push(...withPass(applied.result.ignored_changes, pass));
    historyEntry.applied_changes.push(...applied.result.history_entry.applied_changes);
    historyEntry.rejected_changes.push(...applied.result.history_entry.rejected_changes);
    addMetrics(decision);
    result.pass_count = pass;

    const resetApplied = applied.result.applied_changes.some(change => change.kind === "reset");
    if (resetApplied || applied.result.applied_changes.length === 0) break;
  }

  result.history_entry = historyEntry;
  return {
    state: appendHistory(workingState, historyEntry),
    result,
    plan,
    passes,
    model,
    usage,
    question_count: questionCount,
    latency_ms: latencyMs,
  };
}
