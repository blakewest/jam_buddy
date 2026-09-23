import { KITS } from "../core/pattern/kits.js";
import { QUESTION_CHOICES, REQUEST_TREE, nodeOutcome } from "../core/pattern/request-tree.js";
import type { HistoryEntry } from "../core/pattern/state.js";

export type RequestState = {
  request: string;
  kit_id: string;
  recent_history: HistoryEntry[];
};
type RequestAnswers = { selection?: { type: "choice"; choice: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
const boundedText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const boundedDescriptions = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 8 && value.every(item => boundedText(item, 300));

function validHistoryEntry(value: unknown): value is HistoryEntry {
  return hasKeys(value, ["request", "applied_changes", "rejected_changes"])
    && boundedText(value.request, 500)
    && boundedDescriptions(value.applied_changes)
    && boundedDescriptions(value.rejected_changes);
}

function selectionQuestion(question: string, focus: string, criteria: Record<string, unknown>) {
  return {
    selection: {
      type: "choice",
      instructions: {
        question,
        focus,
        inspect: ["request", "kit_id", "recent_history"],
        context: "The current request is authoritative. History only resolves references. Never act on an older request instead.",
      },
      criteria,
    },
  };
}

function buildRootQuestions() {
  const criteria: Record<string, unknown> = Object.fromEntries(
    Object.entries(REQUEST_TREE.root.children).map(([id, branch]) => [id, { meaning: branch.description }]),
  );
  const focus = [
    "Requests like 'Undo that', 'undo', 'revert the last change' and 'take that back' select undo.",
    "Undo restores the complete latest change locally; never route these to note editing.",
    "Requests to redo, undo several changes at once, or selectively undo an older change are unsupported.",
    "A kit change selects sounds while preserving every note. A note edit changes the rhythm or velocity.",
    "Route requests for unavailable whole kits to change_kit so that node can reject them.",
  ].join(" ");
  return selectionQuestion("Which single supported category does `request` belong to?", focus, criteria);
}

function buildKitQuestions() {
  const criteria: Record<string, unknown> = Object.fromEntries(
    KITS.map(kit => [kit.id, { name: kit.name, sound: kit.description }]),
  );
  criteria.keep_current = { meaning: "The user asks to keep this kit, or there is no suitable directional change." };
  criteria.unsupported = {
    meaning: "Explicitly requests an unavailable kit (including LinnDrum or 909), individual drum sound replacement, or a capability beyond whole-kit selection.",
  };
  const focus = [
    "Explicit kit names win. '505' means TR-505. 'Acoustic' or 'natural' means Acoustic.",
    "For generic 'more modern/electronic' from Acoustic choose 808 as this demo's default.",
    "'Another electronic kit' changes between 808 and TR-505.",
    "Never substitute another kit for an explicitly named unavailable kit.",
    "'Back' can refer to a previous kit in history.",
  ].join(" ");
  return selectionQuestion("Which available whole drum kit best satisfies `request`, given the current `kit_id`?", focus, criteria);
}

// Question builders for the decision nodes in REQUEST_TREE. Local branches need no questions.
export const REQUEST_QUESTIONS = Object.freeze({
  root: {
    id: "root",
    buildQuestions: buildRootQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("root", answers),
  },
  change_kit: {
    id: "change_kit",
    buildQuestions: buildKitQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("change_kit", answers),
  },
});

export function validRequestState(state: unknown): state is RequestState {
  if (!hasKeys(state, ["request", "kit_id", "recent_history"])) return false;
  if (!boundedText(state.request, 500) || !state.request.trim()) return false;
  if (!KITS.some(kit => kit.id === state.kit_id)) return false;
  return Array.isArray(state.recent_history)
    && state.recent_history.length <= 8
    && state.recent_history.every(validHistoryEntry);
}

export const isRequestQuestion = (id: unknown): id is keyof typeof REQUEST_QUESTIONS => typeof id === "string" && Object.hasOwn(QUESTION_CHOICES, id);
