import { appendHistory, createPatternState, MAX_UNDO_HISTORY } from "./state.js";

const clone = value => JSON.parse(JSON.stringify(value));

// Called once at acceptance, after every edit pass and any required sample load.
export function recordUndoUnit(before, completed, request) {
  if (completed.result.applied_changes.some(change => change.kind === "undo")
    || JSON.stringify(before.pattern) === JSON.stringify(completed.state.pattern)) return completed;
  return { ...completed, state: { ...completed.state, undo_history: [
    ...(before.undo_history ?? []),
    { request, pattern: clone(before.pattern) },
  ].slice(-MAX_UNDO_HISTORY) } };
}

export function undoLastChange(initialState, request = "Undo") {
  const state = createPatternState(initialState);
  const unit = state.undo_history.at(-1);
  const changes = unit ? [{ kind: "undo", request: unit.request }] : [];
  const historyEntry = { request, applied_changes: unit ? [`Undid: ${unit.request}`.slice(0, 300)] : [], rejected_changes: [] };
  const restored = unit ? {
    ...state,
    pattern: clone(unit.pattern),
    undo_history: state.undo_history.slice(0, -1),
  } : state;
  return {
    state: appendHistory(restored, historyEntry),
    result: { applied_changes: changes, rejected_changes: [], ignored_changes: [], candidates: [], planned_operations: 0, history_entry: historyEntry },
    passes: [], plan: null,
    message: unit ? `Undid: ${unit.request}` : "Nothing to undo yet.",
  };
}
