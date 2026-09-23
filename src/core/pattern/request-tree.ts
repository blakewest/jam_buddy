import { appendHistory, createPatternState } from "./state.js";
import { undoLastChange } from "./undo.js";
import { getKit, KITS } from "./kits.js";
import type { Candidate, HistoryEntry, PatternChange, PatternState } from "./state.js";
import type { PatternPass, PatternPlan, PatternRunResult } from "./runner.js";

export type RequestNodeId = "root" | "change_kit";
export type NodeAnswer = { selection?: { type: "choice"; choice: string } };
export type NodeOutcome = { next_node: "change_kit"; handler?: never; selection?: never } | { next_node?: never; handler: string; selection: string };
export type NodeDecision = { answers: NodeAnswer; model?: string; usage?: Record<string, number>; latency_ms?: number; question_count?: number };
type CommandOptions = { initialState: PatternState; request: string; decideNode: (nodeId: RequestNodeId, state: { request: string; kit_id: string; recent_history: HistoryEntry[] }) => Promise<NodeDecision>; editPattern?: () => Promise<PatternRunResult> };
export type RouteDecision = NodeDecision & { node_id: RequestNodeId; sent_state: { request: string; kit_id: string; recent_history: HistoryEntry[] }; outcome: NodeOutcome };
export type CommandResult = {
  state: PatternState;
  result: {
    applied_changes: PatternChange[];
    rejected_changes: PatternChange[];
    ignored_changes: PatternChange[];
    candidates: Candidate[];
    history_entry: HistoryEntry;
    reset_probability?: number;
    planned_operations?: number;
    pass_count?: number;
  };
  plan: PatternPlan | null;
  passes: PatternPass[];
  model: string | null;
  usage: Record<string, number>;
  latency_ms: number;
  question_count: number;
  message?: string | null;
  routing?: RouteDecision[];
};

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

export function nodeOutcome(nodeId: RequestNodeId, answers: NodeAnswer): NodeOutcome {
  const answer = answers?.selection;
  if (answer?.type !== "choice" || !NODE_CHOICES[nodeId]?.includes(answer.choice)) throw new Error("Invalid request decision.");
  if (nodeId === "root" && answer.choice === "change_kit") return { next_node: "change_kit" };
  return { handler: nodeId === "root" ? answer.choice : "change_kit", selection: answer.choice };
}

export function changeKit(initialState: PatternState, kitId: string, request: string) {
  getKit(kitId);
  const state = createPatternState(initialState);
  const before = state.pattern.kit_id;
  const changes: PatternChange[] = before === kitId ? [] : [{ kind: "kit", before_kit: before, after_kit: kitId }];
  const historyEntry = { request, applied_changes: changes.map(() => `Changed kit from ${getKit(before).name} to ${getKit(kitId).name}`), rejected_changes: [] };
  return {
    state: appendHistory({ ...state, pattern: { ...state.pattern, kit_id: kitId } }, historyEntry),
    result: { applied_changes: changes, rejected_changes: [], ignored_changes: [], candidates: [], planned_operations: 0, history_entry: historyEntry },
    passes: [], plan: null,
    message: changes.length ? null : `${getKit(kitId).name} is already selected.`,
    usage: {} as Record<string, number>, latency_ms: 0, question_count: 0, model: null as string | null,
  };
}

export async function runPatternCommand({ initialState, request, decideNode, editPattern }: CommandOptions): Promise<CommandResult> {
  const state = createPatternState(initialState);
  const sentState = { request, kit_id: state.pattern.kit_id, recent_history: state.recent_history };
  const routing: RouteDecision[] = [];
  let nodeId: RequestNodeId = "root";
  let outcome: NodeOutcome;
  do {
    const decision = await decideNode(nodeId, sentState);
    outcome = nodeOutcome(nodeId, decision.answers);
    routing.push({ node_id: nodeId, sent_state: sentState, ...decision, outcome });
    if (!outcome.next_node) break;
    nodeId = outcome.next_node;
  } while (true);

  let completed;
  if (outcome.handler === "edit_pattern") {
    if (!editPattern) throw new Error("Pattern editing is unavailable.");
    completed = await editPattern();
  } else if (outcome.handler === "undo") {
    completed = undoLastChange(state, request);
  } else {
    const kitId = KITS.some(kit => kit.id === outcome.selection) ? outcome.selection : state.pattern.kit_id;
    completed = changeKit(state, kitId, request);
    if (outcome.handler === "unsupported" || outcome.selection === "unsupported") completed.message = unsupportedGuidance();
  }
  const usage: Record<string, number> = { ...completed.usage };
  let latencyMs = completed.latency_ms ?? 0;
  let questionCount = completed.question_count ?? 0;
  for (const decision of routing) {
    for (const [key, value] of Object.entries(decision.usage ?? {})) if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
    latencyMs += decision.latency_ms ?? 0;
    questionCount += decision.question_count ?? 0;
  }
  return { ...completed, routing, usage, latency_ms: latencyMs, question_count: questionCount, model: completed.model ?? routing.at(-1)?.model ?? null };
}
