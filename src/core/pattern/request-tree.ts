import { appendHistory, createPatternState } from "./state.js";
import { undoLastChange } from "./undo.js";
import { SWING_CHOICES, nextSwingPercent } from "./swing.js";
import type { SwingAction } from "./swing.js";
import { getKit, KITS } from "./kits.js";
import type { Candidate, HistoryEntry, PatternChange, PatternState } from "./state.js";
import type { PatternPass, PatternPlan, PatternRunResult } from "./runner.js";

export type RequestBranchId = "recorded_rhythm" | "fill_rhythm" | "change_swing" | "edit_pattern" | "change_kit" | "undo" | "unsupported" | "load_preset" | "shuffle_preset" | "clear_pattern";
export type RequestQuestionId = "root" | "change_kit" | "change_swing";
export type NodeAnswer = { selection?: { type: "choice"; choice: string } };
export type NodeOutcome =
  | { next_node: RequestBranchId }
  | { handler: "change_kit"; selection: string }
  | { handler: "change_swing"; selection: SwingAction };
export type NodeDecision = {
  answers: NodeAnswer;
  model?: string;
  usage?: Record<string, number>;
  latency_ms?: number;
  question_count?: number;
};
export type RecordingContext = {
  transcript: string;
  hit_count: number;
  hit_onsets_seconds?: number[];
  words?: { word: string; start: number; end: number }[];
};
export type RequestContext = {
  recording?: RecordingContext;
  request: string;
  kit_id: string;
  recent_history: HistoryEntry[];
} | { request: string; recording?: never };
type CommandOptions = {
  initialState: PatternState;
  request: string;
  decideNode: (questionId: RequestQuestionId, state: RequestContext) => Promise<NodeDecision>;
  editPattern?: () => Promise<PatternRunResult>;
  recording?: RecordingContext;
  recordedRhythm?: () => Promise<CommandResult>;
  grooveRequest?: (route: RootRoute) => Promise<import("./request-runner.js").TreeResult>;
};
type BranchContext = {
  state: PatternState;
  request: string;
  ask: (questionId: RequestQuestionId) => Promise<NodeOutcome>;
  editPattern: CommandOptions["editPattern"];
  grooveRequest: CommandOptions["grooveRequest"];
  recordedRhythm: CommandOptions["recordedRhythm"];
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
    message?: string | null;
    tempo_bpm?: number;
    preset_id?: string;
  };
  plan: PatternPlan | null;
  passes: PatternPass[];
  model: string | null;
  usage: Record<string, number>;
  latency_ms: number;
  question_count: number;
  message?: string | null;
  routing?: RouteDecision[];
  visits?: { node: string; response: unknown }[];
};

// The full request tree. Each child owns its execution; only decision branches ask Jev.
export const REQUEST_TREE = {
  root: {
    id: "root" as const,
    children: {
      recorded_rhythm: { description: "insert a recorded beatbox demonstration; speech-only instructions use the other categories", execute: recordedRhythmBranch },
      fill_rhythm: { description: "fill regular quarter, eighth or sixteenth notes for one drum across requested beats or bars, including repeating the latest rhythm fill on more beats", execute: (context: BranchContext) => grooveBranch(context, "fill_rhythm") },
      edit_pattern: {
        description: "edit drum notes, rhythms, velocities, or phrase length",
        execute: editPatternBranch,
      },
      change_swing: {
        description: "add, increase, decrease, or remove eighth-note swing across the whole groove",
        execute: changeSwingBranch,
      },
      change_kit: {
        description: "switch the whole drum kit",
        execute: changeKitBranch,
      },
      load_preset: { description: "load a complete beat preset by genre or style", execute: (context: BranchContext) => grooveBranch(context, "load_preset") },
      shuffle_preset: { description: "shuffle to a different beat, including 'no, something else'", execute: (context: BranchContext) => grooveBranch(context, "shuffle_preset") },
      clear_pattern: { description: "clear every note and start with an empty beat", execute: (context: BranchContext) => grooveBranch(context, "clear_pattern") },
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
  change_swing: Object.keys(SWING_CHOICES),
  change_kit: [...KITS.map(kit => kit.id), "another_kit", "keep_current", "unsupported"],
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
  if (questionId === "change_swing") return { handler: "change_swing", selection: answer.choice as SwingAction };
  return { handler: "change_kit", selection: answer.choice };
}

function recordedRhythmBranch({ recordedRhythm }: BranchContext): Promise<CommandResult> {
  if (!recordedRhythm) throw new Error("Hold the record button to demonstrate a rhythm first.");
  return recordedRhythm();
}

function editPatternBranch(context: BranchContext): Promise<PatternRunResult | CommandResult> {
  if (context.grooveRequest) return grooveBranch(context, "edit_pattern");
  const { editPattern } = context;
  if (!editPattern) throw new Error("Pattern editing is unavailable.");
  return editPattern();
}

async function grooveBranch(context: BranchContext, category: RequestBranchId): Promise<CommandResult> {
  if (!context.grooveRequest) throw new Error("Groove tools are unavailable.");
  const completed = await context.grooveRequest(resolveRoot(category));
  return {
    ...completed,
    result: { candidates: [], rejected_changes: [], ignored_changes: [], history_entry: { request: context.request, applied_changes: [], rejected_changes: [] }, ...completed.result },
    passes: completed.passes ?? [], plan: completed.plan ?? null,
    message: completed.result.message,
  };
}

export type RootRoute = { category: RequestBranchId; next_node: string | null; message: string | null };
const nextNodes: Record<RequestBranchId, string | null> = { recorded_rhythm: "recorded_rhythm", fill_rhythm: "rhythm_fill", change_swing: "change_swing", edit_pattern: "edit_plan", change_kit: "change_kit", undo: "undo", load_preset: "preset_search", clear_pattern: "pattern_clear", shuffle_preset: "preset_shuffle", unsupported: null };
export const REQUEST_CATEGORIES = Object.freeze(Object.fromEntries(Object.entries(REQUEST_TREE.root.children).map(([id, branch]) => [id, { description: branch.description, next_node: nextNodes[id as RequestBranchId] }])));
export const unsupportedMessage = unsupportedGuidance;
export function resolveRoot(category: string): RootRoute {
  if (!Object.hasOwn(REQUEST_CATEGORIES, category)) throw new Error("Invalid request category.");
  return { category: category as RequestBranchId, next_node: REQUEST_CATEGORIES[category].next_node, message: category === "unsupported" ? unsupportedGuidance() : null };
}

async function changeSwingBranch(context: BranchContext): Promise<CommandResult> {
  const outcome = await context.ask("change_swing");
  if (!("handler" in outcome) || outcome.handler !== "change_swing") throw new Error("Invalid swing decision.");
  const before = context.state.pattern.swing_percent ?? 50;
  const after = nextSwingPercent(before, outcome.selection);
  const changes: PatternChange[] = before === after ? [] : [{ kind: "swing", before_swing: before, after_swing: after }];
  const message = outcome.selection === "unsupported" ? "Swing supports the whole groove in eighth notes: light (55%), medium (65%), strong (75%), maximum (85%), more, less, or off." : before === after ? `Swing is already ${after}%.` : `Swing: ${before}% → ${after}%.`;
  const historyEntry = { request: context.request, applied_changes: changes.map(() => message), rejected_changes: [] };
  return {
    state: appendHistory({ ...context.state, pattern: { ...context.state.pattern, swing_percent: after } }, historyEntry),
    result: { applied_changes: changes, rejected_changes: [], ignored_changes: [], candidates: [], history_entry: historyEntry },
    passes: [], plan: null, message, usage: {}, latency_ms: 0, question_count: 0, model: null,
  };
}

async function changeKitBranch(context: BranchContext): Promise<CommandResult> {
  const outcome = await context.ask("change_kit");
  if (!("selection" in outcome)) throw new Error("Invalid kit decision.");
  if (outcome.selection === "unsupported") return unsupportedBranch(context);
  const currentKit = context.state.pattern.kit_id;
  if (outcome.selection === "another_kit") {
    const nextIndex = (KITS.findIndex(kit => kit.id === currentKit) + 1) % KITS.length;
    return changeKit(context.state, KITS[nextIndex].id, context.request);
  }
  const kitId = outcome.selection === "keep_current" ? currentKit : outcome.selection;
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

export async function runPatternCommand({ initialState, request, decideNode, editPattern, grooveRequest, recording, recordedRhythm }: CommandOptions): Promise<CommandResult> {
  const state = createPatternState(initialState);
  const routing: RouteDecision[] = [];
  const ask = async (questionId: RequestQuestionId): Promise<NodeOutcome> => {
    const sentState = questionId === "change_swing"
      ? { request }
      : { ...(questionId === "root" && recording ? { recording } : {}), request, kit_id: state.pattern.kit_id, recent_history: state.recent_history };
    const decision = await decideNode(questionId, sentState);
    const outcome = nodeOutcome(questionId, decision.answers);
    routing.push({ node_id: questionId, sent_state: sentState, ...decision, outcome });
    return outcome;
  };

  const route = await ask(REQUEST_TREE.root.id);
  if (!("next_node" in route)) throw new Error("Invalid root decision.");
  const branch = REQUEST_TREE.root.children[route.next_node];
  const completed = await branch.execute({ state, request, ask, editPattern, grooveRequest, recordedRhythm });

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
