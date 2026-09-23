import { appendHistory, createPatternState } from "./state.js";
import { undoLastChange } from "./undo.js";
import { getKit, KITS } from "./kits.js";

export const REQUEST_CATEGORIES = Object.freeze({
  edit_pattern: "edit drum notes, rhythms, velocities, or phrase length",
  change_kit: "switch the whole drum kit",
  undo: "undo the most recent completed change as one unit",
});
export const NODE_CHOICES = Object.freeze({
  root: [...Object.keys(REQUEST_CATEGORIES), "unsupported"],
  change_kit: [...KITS.map(kit => kit.id), "keep_current", "unsupported"],
});
export const unsupportedGuidance = () => `I can ${Object.values(REQUEST_CATEGORIES).join(" or ")}. Ask for one kind of change at a time. Available kits: ${KITS.map(kit => kit.name).join(", ")}.`;

export function nodeOutcome(nodeId, answers) {
  const answer = answers?.selection;
  if (answer?.type !== "choice" || !NODE_CHOICES[nodeId]?.includes(answer.choice)) throw new Error("Invalid request decision.");
  if (nodeId === "root" && answer.choice === "change_kit") return { next_node: "change_kit" };
  return { handler: nodeId === "root" ? answer.choice : "change_kit", selection: answer.choice };
}

export function changeKit(initialState, kitId, request) {
  getKit(kitId);
  const state = createPatternState(initialState);
  const before = state.pattern.kit_id;
  const changes = before === kitId ? [] : [{ kind: "kit", before_kit: before, after_kit: kitId }];
  const historyEntry = { request, applied_changes: changes.map(() => `Changed kit from ${getKit(before).name} to ${getKit(kitId).name}`), rejected_changes: [] };
  return {
    state: appendHistory({ ...state, pattern: { ...state.pattern, kit_id: kitId } }, historyEntry),
    result: { applied_changes: changes, rejected_changes: [], ignored_changes: [], candidates: [], planned_operations: 0, history_entry: historyEntry },
    passes: [], plan: null,
    message: changes.length ? null : `${getKit(kitId).name} is already selected.`,
  };
}

export async function runPatternCommand({ initialState, request, decideNode, editPattern }) {
  const state = createPatternState(initialState);
  const sentState = { request, kit_id: state.pattern.kit_id, recent_history: state.recent_history };
  const routing = [];
  let nodeId = "root";
  let outcome;
  do {
    const decision = await decideNode(nodeId, sentState);
    outcome = nodeOutcome(nodeId, decision.answers);
    routing.push({ node_id: nodeId, sent_state: sentState, ...decision, outcome });
    nodeId = outcome.next_node;
  } while (nodeId);

  let completed;
  if (outcome.handler === "edit_pattern") {
    completed = await editPattern();
  } else if (outcome.handler === "undo") {
    completed = undoLastChange(state, request);
  } else {
    const kitId = KITS.some(kit => kit.id === outcome.selection) ? outcome.selection : state.pattern.kit_id;
    completed = changeKit(state, kitId, request);
    if (outcome.handler === "unsupported" || outcome.selection === "unsupported") completed.message = unsupportedGuidance();
  }
  const usage = { ...completed.usage };
  let latencyMs = completed.latency_ms ?? 0;
  let questionCount = completed.question_count ?? 0;
  for (const decision of routing) {
    for (const [key, value] of Object.entries(decision.usage ?? {})) if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
    latencyMs += decision.latency_ms ?? 0;
    questionCount += decision.question_count ?? 0;
  }
  return { ...completed, routing, usage, latency_ms: latencyMs, question_count: questionCount, model: completed.model ?? routing.at(-1)?.model };
}
