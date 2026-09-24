import { appendHistory, createPatternState, MAX_UNDO_HISTORY } from "./state.js";
import type { PatternState, PatternChange } from "./state.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Completed = { state: PatternState; result: { applied_changes: { kind: string }[] } };

// Called once at acceptance, after every edit pass and any required sample load.
export function recordUndoUnit<T extends Completed>(before: PatternState, completed: T, request: string): T {
  if (completed.result.applied_changes.some(change => change.kind === "undo")
    || (JSON.stringify(before.pattern) === JSON.stringify(completed.state.pattern) && before.tempo_bpm === completed.state.tempo_bpm && JSON.stringify(before.preset_context) === JSON.stringify(completed.state.preset_context))) return completed;
  return { ...completed, state: { ...completed.state, undo_history: [
    ...(before.undo_history ?? []),
    { request, pattern: clone(before.pattern), tempo_bpm: before.tempo_bpm, ...(before.recent_take ? { recent_take: clone(before.recent_take) } : {}), ...(before.preset_context ? { preset_context: clone(before.preset_context) } : {}) },
  ].slice(-MAX_UNDO_HISTORY) } };
}

export function undoLastChange(initialState: PatternState, request = "Undo") {
  const state = createPatternState(initialState);
  const unit = state.undo_history.at(-1);
  const changes: PatternChange[] = unit ? [{ kind: "undo", request: unit.request }] : [];
  const historyEntry = { request, applied_changes: unit ? [`Undid: ${unit.request}`.slice(0, 300)] : [], rejected_changes: [] };
  const restored = unit ? {
    ...state,
    pattern: clone(unit.pattern),
    recent_take: unit.recent_take ? clone(unit.recent_take) : undefined,
    tempo_bpm: unit.tempo_bpm ?? state.tempo_bpm,
    preset_context: unit.preset_context ? clone(unit.preset_context) : null,
    undo_history: state.undo_history.slice(0, -1),
  } : state;
  return {
    state: appendHistory(restored, historyEntry),
    result: { applied_changes: changes, rejected_changes: [], ignored_changes: [], candidates: [], planned_operations: 0, history_entry: historyEntry },
    passes: [], plan: null,
    message: unit ? `Undid: ${unit.request}` : "Nothing to undo yet.",
    usage: {} as Record<string, number>, latency_ms: 0, question_count: 0, model: null as string | null,
  };
}
