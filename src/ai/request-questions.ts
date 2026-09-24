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

function hasKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isRecord(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
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

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validHitOnsets(value: unknown, hitCount: number): boolean {
  return Array.isArray(value)
    && value.length === hitCount
    && value.every((time, index) => boundedNumber(time, 0, 30)
      && (index === 0 || time >= value[index - 1]));
}

function validWordTiming(value: unknown): boolean {
  return hasKeys(value, ["word", "start", "end"])
    && boundedText(value.word, 200)
    && boundedNumber(value.start, 0, 30.1)
    && boundedNumber(value.end, value.start, 30.1);
}

function validRecordingContext(value: unknown): value is RecordingContext {
  if (!hasKeys(value, ["transcript", "hit_count"], ["hit_onsets_seconds", "words"])) return false;
  if (!boundedText(value.transcript, 5000)) return false;
  if (!boundedNumber(value.hit_count, 0, 256) || !Number.isInteger(value.hit_count)) return false;
  if (Object.hasOwn(value, "hit_onsets_seconds") && !validHitOnsets(value.hit_onsets_seconds, value.hit_count)) return false;
  if (Object.hasOwn(value, "words")) {
    if (!Array.isArray(value.words) || value.words.length > 32 || !value.words.every(validWordTiming)) return false;
  }
  return true;
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
    "A request to nudge a hit 'just a hair', 'a touch', or 'just slightly' early or late selects edit_pattern. So does moving a hit a little earlier or later; the editor decides the timing amount.",
    "A speech-only request for a complete genre/style groove or a simple backbeat selects load_preset; edits to specific notes or instruments select edit_pattern. A request to reproduce an accompanying demonstration selects recorded_rhythm instead of load_preset, even if it begins with give me a beat.",
    "If recording is present, inspect recording.transcript, recording.words and recording.hit_onsets_seconds together. The transcript can OMIT the entire beatbox demonstration. An introduction such as give me a beat like... followed by a sequence of measured hits selects recorded_rhythm, not a generic preset. Word timestamps are approximate: Whisper can stretch the final word across the demonstration. Pure beatboxing also selects recorded_rhythm. Hit count alone does not establish beatboxing because speech produces transients too. Speech-only instructions such as can you swing it or load a funk beat select their normal branches. Corrections to prior take notes use edit_pattern.",
    "Requests like 'Undo that', 'undo', 'revert the last change' and 'take that back' select undo.",
    "Undo restores the complete latest change locally; never route these to note editing.",
    "Requests to redo, undo several changes at once, or selectively undo an older change are unsupported.",
    "Adding or adjusting swing on the current groove selects change_swing, including 'no, swing it harder'. Explicitly asking to load a new swing-style beat still selects load_preset.",
    "Making the whole beat slower or faster, or setting a specific BPM, selects change_tempo. A new preset requested by style still selects load_preset.",
    "A kit change selects sounds while preserving every note. A note edit changes the rhythm or velocity.",
    "Make drums punchier, add compression, or make this hit harder selects add_compression. Polish it up or master it selects polish_mix. These are whole-mix effects, not note velocity edits.",
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

function buildTempoQuestions() {
  return { selection: { type: "choice", instructions: {
    question: "What tempo change does `request` ask for? Choose the operation; code handles the BPM value.",
    inspect: ["request"],
    focus: "A stated target such as 'speed it up to like 130 bpm' means set_exact, not increase. Slower or faster without a target means decrease or increase. Do not change individual note velocity or swing here.",
  }, criteria: {
    increase: "Speed up the whole beat without a specific target BPM.",
    decrease: "Slow down the whole beat without a specific target BPM.",
    set_exact: "Set the whole beat to one stated target BPM, even if phrased as speed up or slow down.",
    unsupported: "No clear whole-beat tempo action, or a different kind of change.",
  } } };
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
  change_tempo: {
    id: "change_tempo",
    buildQuestions: buildTempoQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("change_tempo", answers),
  },
  change_kit: {
    id: "change_kit",
    buildQuestions: buildKitQuestions,
    validate: (answers: RequestAnswers) => nodeOutcome("change_kit", answers),
  },
});

export function validRequestState(state: unknown, nodeId = "root"): state is RequestState {
  if (nodeId === "change_swing" || nodeId === "change_tempo") return hasKeys(state, ["request"])
    && boundedText(state.request, 500) && Boolean(state.request.trim());
  if (!hasKeys(state, ["request", "kit_id", "recent_history"], ["recording"])) return false;
  if (Object.hasOwn(state, "recording") && !validRecordingContext(state.recording)) return false;

  if (!boundedText(state.request, 500) || !state.request.trim()) return false;
  if (!KITS.some(kit => kit.id === state.kit_id)) return false;
  return Array.isArray(state.recent_history)
    && state.recent_history.length <= 8
    && state.recent_history.every(validHistoryEntry);
}

export const isRequestQuestion = (id: unknown): id is keyof typeof REQUEST_QUESTIONS => typeof id === "string" && Object.hasOwn(QUESTION_CHOICES, id);
