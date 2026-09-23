import { appendHistory, createPatternState } from "./state.js";
import { undoLastChange } from "./undo.js";
import { getKit, KITS } from "./kits.js";
import type { Candidate, HistoryEntry, PatternChange, PatternState } from "./state.js";
import type { PatternPass, PatternPlan, PatternRunResult } from "./runner.js";

export type RequestBranchId = "edit_pattern" | "change_kit" | "undo" | "unsupported";
export type RequestQuestionId = "root" | "change_kit";
export type NodeAnswer = { selection?: { type: "choice"; choice: string } };
export type NodeOutcome =
  | { next_node: RequestBranchId }
  | { handler: "change_kit"; selection: string };
export type NodeDecision = {
  answers: NodeAnswer;
  model?: string;
  usage?: Record<string, number>;
  latency_ms?: number;
  question_count?: number;
};
type RequestContext = {
  request: string;
  kit_id: string;
  recent_history: HistoryEntry[];
};
type CommandOptions = {
  initialState: PatternState;
  request: string;
  decideNode: (questionId: RequestQuestionId, state: RequestContext) => Promise<NodeDecision>;
  editPattern?: () => Promise<PatternRunResult>;
};
type BranchContext = {
  state: PatternState;
  request: string;
  ask: (questionId: RequestQuestionId) => Promise<NodeOutcome>;
  editPattern: CommandOptions["editPattern"];
};
export type RouteDecision = NodeDecision & {
  node_id: RequestQuestionId;
  sent_state: RequestContext;
  outcome: NodeOutcome;
};
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

// The full request tree. Each child owns its execution; only decision branches ask Jev.
export const REQUEST_TREE = {
  root: {
    id: "root" as const,
    children: {
      edit_pattern: {
        description: "edit drum notes, rhythms, velocities, or phrase length",
        execute: editPatternBranch,
      },
      change_kit: {
        description: "switch the whole drum kit",
        execute: changeKitBranch,
      },
      undo: {
        description: "undo the most recent completed change as one unit",
        execute: undoBranch,
      },
      unsupported: {
        description: "Outside supported capabilities, no actionable request, or combines different actions (such as undo plus editing, or kit swapping plus note editing). Effects, compression, tempo changes and per-instrument sample replacement are unsupported.",
        execute: unsupportedBranch,
      },
    },
  },
};

export const QUESTION_CHOICES = {
  root: Object.keys(REQUEST_TREE.root.children),
  change_kit: [...KITS.map(kit => kit.id), "keep_current", "unsupported"],
};

export function unsupportedGuidance(): string {
  const capabilities = Object.entries(REQUEST_TREE.root.children)
    .filter(([id]) => id !== "unsupported")
    .map(([, branch]) => branch.description);
  return `I can ${capabilities.join(" or ")}. Ask for one kind of change at a time. Available kits: ${KITS.map(kit => kit.name).join(", ")}.`;
}

export function nodeOutcome(questionId: RequestQuestionId, answers: NodeAnswer): NodeOutcome {
  const answer = answers?.selection;
  if (answer?.type !== "choice" || !QUESTION_CHOICES[questionId]?.includes(answer.choice)) {
    throw new Error("Invalid request decision.");
  }
  if (questionId === "root") return { next_node: answer.choice as RequestBranchId };
  return { handler: "change_kit", selection: answer.choice };
}

function editPatternBranch({ editPattern }: BranchContext): Promise<PatternRunResult> {
  if (!editPattern) throw new Error("Pattern editing is unavailable.");
  return editPattern();
}

async function changeKitBranch(context: BranchContext): Promise<CommandResult> {
  const outcome = await context.ask("change_kit");
  if (!("selection" in outcome)) throw new Error("Invalid kit decision.");
  if (outcome.selection === "unsupported") return unsupportedBranch(context);
  const kitId = outcome.selection === "keep_current" ? context.state.pattern.kit_id : outcome.selection;
  return changeKit(context.state, kitId, context.request);
}

function undoBranch({ state, request }: BranchContext): CommandResult {
  return undoLastChange(state, request);
}

function unsupportedBranch({ state, request }: BranchContext): CommandResult {
  const completed = changeKit(state, state.pattern.kit_id, request);
  return { ...completed, message: unsupportedGuidance() };
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
  const ask = async (questionId: RequestQuestionId): Promise<NodeOutcome> => {
    const decision = await decideNode(questionId, sentState);
    const outcome = nodeOutcome(questionId, decision.answers);
    routing.push({ node_id: questionId, sent_state: sentState, ...decision, outcome });
    return outcome;
  };

  const route = await ask(REQUEST_TREE.root.id);
  if (!("next_node" in route)) throw new Error("Invalid root decision.");
  const branch = REQUEST_TREE.root.children[route.next_node];
  const completed = await branch.execute({ state, request, ask, editPattern });

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
