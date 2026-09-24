import { SWING_CHOICES } from "../core/pattern/swing.js";
import { KITS } from "../core/pattern/kits.js";
import { QUESTION_CHOICES, REQUEST_TREE, nodeOutcome } from "../core/pattern/request-tree.js";
import type { HistoryEntry } from "../core/pattern/state.js";
import type { RecordingContext } from "../core/pattern/request-tree.js";

export type RequestState = {
  recording?: RecordingContext;
  request: string;
  kit_id: string;
  recent_history: HistoryEntry[];
} | { request: string };
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
        inspect: ["request", "kit_id", "recent_history", "recording"],
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
    "Clear every note or start empty selects clear_pattern; never generate note-by-note deletions for this.",
    "Another/different beat, 'no, something else', 'try again', and 'shuffle funk' select shuffle_preset.",
    "Requests for regular quarter/eighth/sixteenth notes on one drum select fill_rhythm, including '16ths on the hi-hats', '16th hats on beat 2', and 'do it on beats 2, 3, 4 as well' following a rhythm fill. This takes precedence over edit_pattern. Relative volume changes still select edit_pattern.",
    "A speech-only request for a complete genre/style groove or a simple backbeat selects load_preset; edits to specific notes or instruments select edit_pattern. A request to reproduce an accompanying demonstration selects recorded_rhythm instead of load_preset, even if it begins with give me a beat.",
    "If recording is present, inspect recording.transcript, recording.words and recording.hit_onsets_seconds together. The transcript can OMIT the entire beatbox demonstration. An introduction such as give me a beat like... followed by a sequence of measured hits selects recorded_rhythm, not a generic preset. Word timestamps are approximate: Whisper can stretch the final word across the demonstration. Pure beatboxing also selects recorded_rhythm. Hit count alone does not establish beatboxing because speech produces transients too. Speech-only instructions such as can you swing it or load a funk beat select their normal branches. Corrections to prior take notes use edit_pattern.",
    "Requests like 'Undo that', 'undo', 'revert the last change' and 'take that back' select undo.",
    "Undo restores the complete latest change locally; never route these to note editing.",
    "Requests to redo, undo several changes at once, or selectively undo an older change are unsupported.",
    "Adding or adjusting swing on the current groove selects change_swing, including 'no, swing it harder'. Explicitly asking to load a new swing-style beat still selects load_preset.",
    "A kit change selects sounds while preserving every note. A note edit changes the rhythm or velocity.",
    "Route requests for unavailable whole kits to change_kit so that node can reject them.",
  ].join(" ");
  return selectionQuestion("Which single supported category does `request` belong to?", focus, criteria);
}

function buildKitQuestions() {
  const criteria: Record<string, unknown> = Object.fromEntries(
    KITS.map(kit => [kit.id, { name: kit.name, sound: kit.description }]),
  );
  criteria.another_kit = { meaning: "The user wants a different/another kit without specifying a name or sound, such as 'Now a different kit', 'switch kits', or 'try another kit'. Code will choose an available kit other than the current one." };
  criteria.keep_current = { meaning: "The user asks to keep this kit, or there is no suitable directional change." };
  criteria.unsupported = {
    meaning: "Explicitly requests an unavailable kit (including LinnDrum or 909), individual drum sound replacement, or a capability beyond whole-kit selection.",
  };
  const focus = [
    "A generic request for a different kit selects another_kit. It is supported; do not select keep_current or the current kit. No particular sound preference is required.",
    "Explicit kit names win. '505' means TR-505. 'Acoustic' or 'natural' means Acoustic.",
    "For generic 'more modern/electronic' from Acoustic choose 808 as this demo's default.",
    "'Another electronic kit' changes between 808 and TR-505.",
    "Never substitute another kit for an explicitly named unavailable kit.",
    "'Back' can refer to a previous kit in history.",
  ].join(" ");
  return selectionQuestion("Which available whole drum kit best satisfies `request`, given the current `kit_id`?", focus, criteria);
}

function buildSwingQuestions() {
  return { selection: { type: "choice", instructions: {
    question: "Does `request` ask to increase, decrease, remove, or explicitly set eighth-note swing? Choose the operation, not the resulting amount.",
    inspect: ["request"],
    focus: "Choose relative increase/decrease for comparative requests. 'No, swing it harder' means increase, not remove. 'Add a little swing' means light. Explicit amounts must match 50 (remove), 55, 65, 75 or 85; other amounts are unsupported. Swing is applied to the whole groove. 50 means no added swing.",
  }, criteria: SWING_CHOICES } };
}

// Question builders for the decision nodes in REQUEST_TREE. Local branches need no questions.
export const REQUEST_QUESTIONS = Object.freeze({
  root: {
    id: "root",
    buildQuestions: buildRootQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("root", answers),
  },
  change_swing: {
    id: "change_swing",
    buildQuestions: buildSwingQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("change_swing", answers),
  },
  change_kit: {
    id: "change_kit",
    buildQuestions: buildKitQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("change_kit", answers),
  },
});

export function validRequestState(state: unknown, nodeId = "root"): state is RequestState {
  if (nodeId === "change_swing") return hasKeys(state, ["request"])
    && boundedText(state.request, 500) && Boolean(state.request.trim());
  if (!isRecord(state)) return false;
  const keys = ["request", "kit_id", "recent_history"];
  if (state.recording !== undefined) {
    keys.push("recording");
    if (!isRecord(state.recording)) return false;
    const recordingKeys = ["transcript", "hit_count"];
    if (state.recording.hit_onsets_seconds !== undefined) {
      recordingKeys.push("hit_onsets_seconds");
      const onsets = state.recording.hit_onsets_seconds;
      if (!Array.isArray(onsets) || onsets.length !== state.recording.hit_count || onsets.length > 256
        || !onsets.every((time, index) => Number.isFinite(time) && time >= 0 && time <= 30 && (!index || time >= onsets[index - 1]))) return false;
    }
    if (state.recording.words !== undefined) {
      recordingKeys.push("words");
      const words = state.recording.words;
      if (!Array.isArray(words) || words.length > 32 || !words.every(word => hasKeys(word, ["word", "start", "end"])
        && boundedText(word.word, 200) && typeof word.start === "number" && typeof word.end === "number"
        && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start && word.end <= 30.1)) return false;
    }
    if (!hasKeys(state.recording, recordingKeys) || !boundedText(state.recording.transcript, 5000) || !Number.isInteger(state.recording.hit_count) || Number(state.recording.hit_count) < 0 || Number(state.recording.hit_count) > 256) return false;
  }
  if (!hasKeys(state, keys)) return false;

  if (!boundedText(state.request, 500) || !state.request.trim()) return false;
  if (!KITS.some(kit => kit.id === state.kit_id)) return false;
  return Array.isArray(state.recent_history)
    && state.recent_history.length <= 8
    && state.recent_history.every(validHistoryEntry);
}

export const isRequestQuestion = (id: unknown): id is keyof typeof REQUEST_QUESTIONS => typeof id === "string" && Object.hasOwn(QUESTION_CHOICES, id);
