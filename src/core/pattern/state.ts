import { describeTick, editPositions, tickForPosition, ticksPerBar, TICKS_PER_QUARTER, validMeter, velocityForLayer } from "./musical-time.js";
import { defaultPitch, pitchForNote, validPitchForInstrument } from "./drum-pitches.js";
import { normalizedSwing, swungTick } from "./swing.js";
import { KITS } from "./kits.js";
import type { Meter } from "./musical-time.js";

export type Instrument = "kick" | "snare" | "closed_hat" | "open_hat" | "ride" | "crash" | "high_tom" | "mid_tom" | "floor_tom";
export type PatternNote = { id: string; instrument: Instrument; bar: number; tick: number; velocity: number; midi_pitch?: number };
export type Pattern = { bars: number; meter: Meter; ticks_per_quarter: number; notes: PatternNote[]; kit_id: string; swing_percent?: number };
export type HistoryEntry = { request: string; applied_changes: string[]; rejected_changes: string[] };
export type PresetAttributes = { genres?: string[]; feels?: string[]; meter?: string };
export type PresetContext = { preset_id: string; attributes: PresetAttributes };
export type RecentTake = { id: string; note_ids: string[] };
export type UndoUnit = { request: string; pattern: Pattern; tempo_bpm?: number; recent_take?: RecentTake; preset_context?: PresetContext };
export type PatternState = { pattern: Pattern; recent_history: HistoryEntry[]; undo_history: UndoUnit[]; next_note_id: number; recent_take?: RecentTake; preset_context?: PresetContext | null; tempo_bpm: number };
export type JevChoiceAnswer = { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> };
export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevAnswers = Record<string, JevChoiceAnswer | JevNoulAnswer | undefined>;
type ProposedNote = Omit<PatternNote, "id"> & { id?: string };
export type Candidate = { kind: "add" | "remove" | "modify"; source: string; score: number; order: number; note_id?: string; proposed?: ProposedNote };
export type PatternChange = { kind: string; source?: string; score?: number; note_id?: string; proposed?: ProposedNote; before?: PatternNote; after?: PatternNote; reason?: string; pass?: number; before_bars?: number; after_bars?: number; removed_notes?: number; before_swing?: number; after_swing?: number; before_bpm?: number; after_bpm?: number; before_kit?: string; after_kit?: string; request?: string; preset_id?: string; preset_name?: string };
export type ApplyPatternResult = { reset_probability: number; candidates: Candidate[]; applied_changes: PatternChange[]; rejected_changes: PatternChange[]; ignored_changes: PatternChange[]; history_entry: HistoryEntry };
export type PatternJevState = { recent_take?: RecentTake; request: string; pattern: { bars: number; meter: Meter; ticks_per_quarter: number; parts: Record<Instrument, { id: string; bar: number; tick: number; position: string; velocity: number }[]> }; music_reference: typeof MUSIC_REFERENCE; recent_history: HistoryEntry[] };
type SavedNote = Partial<PatternNote> & { slot?: number; velocity_layer?: number };
type SavedPattern = Partial<Omit<Pattern, "notes">> & { tempo_bpm?: number; notes?: SavedNote[] };
type SavedState = Partial<Omit<PatternState, "pattern">> & SavedPattern & { pattern?: SavedPattern };
export const MAX_UNDO_HISTORY = 20;

export const INSTRUMENTS: readonly Instrument[] = Object.freeze(["kick", "snare", "closed_hat", "open_hat", "ride", "crash", "high_tom", "mid_tom", "floor_tom"]);
export const DEFAULT_METER = Object.freeze({ numerator: 4, denominator: 4 });
export const MAX_BARS = 8;
export const MAX_HISTORY = 8;
export const MAX_OPERATIONS = 4;
const MICRO_NUDGE_MS = 10;
export const POSITIONS = Object.freeze(editPositions(DEFAULT_METER).map(item => item.id));
export const MUSIC_REFERENCE = Object.freeze({
  all_eighths: ["beat_1", "beat_1_and", "beat_2", "beat_2_and", "beat_3", "beat_3_and", "beat_4", "beat_4_and"],
  four_on_the_floor: { kick: ["beat_1", "beat_2", "beat_3", "beat_4"] },
  backbeat: { snare: ["beat_2", "beat_4"] },
  edit_example: { request: "remove the snare from beat 4", result: "Remove only the existing snare at beat_4 and preserve every other note." },
});

export const positionForTick = (tick: number, meter: Meter = DEFAULT_METER) => describeTick(tick, meter);

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function nextIdFor(notes: PatternNote[]) {
  return notes.reduce((maximum, item) => Math.max(maximum, Number(item.id.match(/^note_(\d+)$/)?.[1] ?? 0)), 0) + 1;
}

export function createPatternState(input: unknown = {}): PatternState {
  const saved = (input ?? {}) as SavedState;
  const pattern = saved.pattern ?? saved;
  const bars = typeof pattern.bars === "number" && Number.isInteger(pattern.bars) && pattern.bars >= 1 && pattern.bars <= MAX_BARS ? pattern.bars : 1;
  const meter = validMeter(pattern.meter) ? clone(pattern.meter) : clone(DEFAULT_METER);
  const notes: PatternNote[] = Array.isArray(pattern.notes) ? clone(pattern.notes).map(note => ({
    id: note.id ?? "",
    instrument: note.instrument as Instrument,
    bar: Number.isInteger(note.bar) ? note.bar! : 1,
    tick: Number.isInteger(note.tick) ? note.tick! : Number.isInteger(note.slot) ? (note.slot! - 1) * TICKS_PER_QUARTER / 4 : Number.NaN,
    velocity: Number.isInteger(note.velocity) ? note.velocity! : velocityForLayer(note.velocity_layer ?? 0),
    ...(note.midi_pitch === undefined ? {} : { midi_pitch: note.midi_pitch }),
  })).filter(note => note.bar >= 1 && note.bar <= bars && INSTRUMENTS.includes(note.instrument)
    && Number.isInteger(note.tick) && note.tick >= 0 && note.tick < ticksPerBar(meter)
    && Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127
    && (note.midi_pitch === undefined || validPitchForInstrument(note.midi_pitch, note.instrument))) : [];
  const tempoBpm = saved.tempo_bpm ?? pattern.tempo_bpm;
  return {
    pattern: { bars, meter, swing_percent: normalizedSwing(pattern.swing_percent), ticks_per_quarter: TICKS_PER_QUARTER, notes, kit_id: KITS.some(kit => kit.id === pattern.kit_id) ? pattern.kit_id! : "acoustic" },
    tempo_bpm: typeof tempoBpm === "number" && Number.isFinite(tempoBpm) && tempoBpm >= 30 && tempoBpm <= 360 ? tempoBpm : 120,
    undo_history: Array.isArray(saved.undo_history) ? saved.undo_history.slice(-MAX_UNDO_HISTORY)
      .filter(unit => unit && typeof unit.request === "string" && unit.pattern && Array.isArray(unit.pattern.notes)
        && unit.pattern.notes.every(note => note && typeof note.id === "string"))
      .map(unit => {
        const restored = createPatternState({ pattern: unit.pattern, tempo_bpm: unit.tempo_bpm ?? (unit.pattern as SavedPattern).tempo_bpm ?? tempoBpm, recent_take: unit.recent_take });
        return { ...clone(unit), request: unit.request.slice(0, 500), pattern: restored.pattern, tempo_bpm: restored.tempo_bpm,
          ...(unit.recent_take ? { recent_take: restored.recent_take } : {}) };
      }) : [],
    recent_history: Array.isArray(saved.recent_history) ? saved.recent_history.slice(-MAX_HISTORY).map(boundedHistory) : [],
    next_note_id: Math.max(Number(saved.next_note_id) || 1, nextIdFor(notes)),
    ...(saved.recent_take && typeof saved.recent_take.id === "string" && Array.isArray(saved.recent_take.note_ids) ? { recent_take: { id: saved.recent_take.id.slice(0, 100), note_ids: saved.recent_take.note_ids.filter(id => notes.some(note => note.id === id)).slice(0, 256) } } : {}),
    ...(saved.preset_context !== undefined ? { preset_context: clone(saved.preset_context) } : {}),
  };
}

export function resizePattern(inputState: PatternState, bars: number) {
  const state = createPatternState(inputState);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) throw new Error("Phrase length must be between one and eight bars.");
  return { ...state, pattern: { ...state.pattern, bars, notes: state.pattern.notes.filter(note => note.bar <= bars) } };
}

function boundedHistory(entry: HistoryEntry): HistoryEntry {
  return { request: entry.request.slice(0, 500), applied_changes: entry.applied_changes.slice(0, 8).map(text => text.slice(0, 300)), rejected_changes: entry.rejected_changes.slice(0, 8).map(text => text.slice(0, 300)) };
}

export function appendHistory(state: PatternState, entry: HistoryEntry): PatternState {
  return {
    ...state,
    recent_history: [...state.recent_history, entry].slice(-MAX_HISTORY).map(boundedHistory),
  };
}

function choice(answers: JevAnswers, key: string, fallback: string) {
  return answers[key]?.type === "choice" ? answers[key].choice : fallback;
}

function alterationConfidence(answer: JevChoiceAnswer) {
  const noOp = answer?.probabilities?.no_op;
  return typeof noOp === "number" && Number.isFinite(noOp) ? clamp(1 - noOp, 0, 1) : 0;
}

function timingDelta(value: string) {
  if (value === "no_change") return 0;
  const match = /^(earlier|later)_(sixteenth|eighth|eighth_triplet|sixteenth_triplet)$/.exec(value ?? "");
  if (!match) return 0;
  const ticks = ({ sixteenth: 240, eighth: 480, eighth_triplet: 320, sixteenth_triplet: 160 } as Record<string, number>)[match[2]];
  return ticks * (match[1] === "earlier" ? -1 : 1);
}

function velocityDelta(value: string) {
  if (value === "no_change") return 0;
  const match = /^(decrease|increase)_([1-2])$/.exec(value ?? "");
  if (!match) return 0;
  return Number(match[2]) * (match[1] === "decrease" ? -1 : 1);
}

function additionCandidate(answers: JevAnswers, instrument: Instrument, order: number, meter: Meter): Candidate | null {
  const action = answers[`addition_${instrument}_action`];
  if (!action || action.type !== "choice" || action.choice === "no_addition") return null;
  const match = /^add_([a-z_]+)_in_bar_([1-8])_at_(beat_\d+(?:_(?:e|and|a|triplet_[23]|sixteenth_triplet_[2-6]))?)$/.exec(action.choice);
  if (!match) return null;
  const noAddition = action.probabilities?.no_addition;
  const score = typeof noAddition === "number" && Number.isFinite(noAddition) ? clamp(1 - noAddition, 0, 1) : clamp(Number(action.confidence) || 0, 0, 1);
  const velocityMatch = /^velocity_([1-5])$/.exec(choice(answers, `addition_${instrument}_velocity`, ""));
  const velocities = [16, 40, 64, 96, 120];
  return {
    kind: "add",
    source: `addition_${instrument}`,
    score,
    order,
    proposed: {
      instrument: match[1] as Instrument,
      bar: Number(match[2]),
      tick: tickForPosition(match[3], meter),
      velocity: velocities[Number(velocityMatch?.[1]) - 1],
    },
  };
}

function shiftedTiming(item: PatternNote, delta: number, bars: number, meter: Meter) {
  const barTicks = ticksPerBar(meter);
  const totalTicks = bars * barTicks;
  const current = (item.bar - 1) * barTicks + item.tick;
  const shifted = ((current + delta) % totalTicks + totalTicks) % totalTicks;
  return { bar: Math.floor(shifted / barTicks) + 1, tick: shifted % barTicks };
}

function microTiming(item: PatternNote, direction: number, bpm: number, swing: number, bars: number, meter: Meter) {
  const barTicks = ticksPerBar(meter);
  const totalTicks = bars * barTicks;
  const current = (item.bar - 1) * barTicks + item.tick;
  const delta = direction * bpm * TICKS_PER_QUARTER * MICRO_NUDGE_MS / 60_000;
  const target = ((swungTick(current, swing) + delta) % totalTicks + totalTicks) % totalTicks;
  const quarterStart = Math.floor(target / TICKS_PER_QUARTER) * TICKS_PER_QUARTER;
  const within = target - quarterStart;
  const ratio = swing / 100;
  const rawWithin = within <= TICKS_PER_QUARTER * ratio
    ? within / (2 * ratio)
    : TICKS_PER_QUARTER / 2 + (within - TICKS_PER_QUARTER * ratio) / (2 * (1 - ratio));
  return shiftedTiming(item, Math.round(quarterStart + rawWithin) - current, bars, meter);
}

function microDirection(request: string) {
  const cue = /\b(?:just\s+)?a\s+(?:hair|touch)\s+(early|earlier|late|later)\b|\bjust\s+slightly\s+(early|earlier|late|later)\b/i.exec(request);
  if (!cue) return 0;
  return /^(early|earlier)$/i.test(cue[1] ?? cue[2]) ? -1 : 1;
}

function noteCandidate(answers: JevAnswers, item: PatternNote, order: number, bars: number, meter: Meter, bpm: number, swing: number, request: string): Candidate | null {
  const operation = answers[`${item.id}_operation`];
  if (!operation || operation.type !== "choice" || operation.choice === "no_op" || !["remove", "modify"].includes(operation.choice)) return null;
  const candidate: Candidate = { kind: operation.choice as "remove" | "modify", source: item.id, note_id: item.id, score: alterationConfidence(operation), order };
  if (operation.choice === "modify") {
    const requestedInstrument = choice(answers, `${item.id}_instrument`, "keep_current");
    let timingChoice = choice(answers, `${item.id}_timing`, "no_change");
    if (timingChoice === "earlier_10ms" || timingChoice === "later_10ms") {
      const direction = timingChoice === "earlier_10ms" ? -1 : 1;
      const requestedDirection = microDirection(request);
      if (!requestedDirection) timingChoice = direction < 0 ? "earlier_sixteenth" : "later_sixteenth";
      else if (requestedDirection !== direction) timingChoice = "no_change";
    }
    const timing = timingChoice === "earlier_10ms" || timingChoice === "later_10ms"
      ? microTiming(item, timingChoice === "earlier_10ms" ? -1 : 1, bpm, swing, bars, meter)
      : shiftedTiming(item, timingDelta(timingChoice), bars, meter);
    candidate.proposed = {
      id: item.id,
      instrument: requestedInstrument === "keep_current" ? item.instrument : requestedInstrument as Instrument,
      ...timing,
      velocity: clamp(item.velocity + velocityDelta(choice(answers, `${item.id}_velocity`, "no_change")) * 16, 1, 127),
      ...(item.midi_pitch === undefined ? {} : { midi_pitch: requestedInstrument === "keep_current" || requestedInstrument === item.instrument ? item.midi_pitch : defaultPitch(requestedInstrument) }),
    };
  }
  return candidate;
}

const occupied = (notes: PatternNote[], proposed: ProposedNote, exceptId?: string) => notes.some(item => item.id !== exceptId && item.instrument === proposed.instrument && item.bar === proposed.bar && item.tick === proposed.tick && pitchForNote(item) === pitchForNote(proposed));

function validProposed(item: ProposedNote | undefined, bars: number, meter: Meter): item is ProposedNote {
  if (!item) return false;
  return INSTRUMENTS.includes(item.instrument) && Number.isInteger(item.bar) && item.bar >= 1 && item.bar <= bars && Number.isInteger(item.tick) && item.tick >= 0 && item.tick < ticksPerBar(meter) && Number.isInteger(item.velocity) && item.velocity >= 1 && item.velocity <= 127 && (item.midi_pitch === undefined || validPitchForInstrument(item.midi_pitch, item.instrument));
}

function describe(change: PatternChange) {
  if (change.kind === "reset") return "Cleared the whole pattern";
  if (change.kind === "remove" && change.before) return `Removed ${change.before.instrument} from tick ${change.before.tick}`;
  if (change.kind === "add" && change.after) return `Added ${change.after.instrument} in bar ${change.after.bar} at tick ${change.after.tick}, velocity ${change.after.velocity}`;
  if (change.before && change.after) return `Changed ${change.before.instrument} in bar ${change.before.bar} at tick ${change.before.tick} to ${change.after.instrument} in bar ${change.after.bar} at tick ${change.after.tick}, velocity ${change.after.velocity}`;
  return change.kind;
}

export function applyPatternAnswers(inputState: PatternState, answers: JevAnswers, request = "", { maxOperations = MAX_OPERATIONS, recordHistory = true } = {}) {
  const state = createPatternState(inputState);
  const resetProbability = answers.reset_pattern?.type === "noul" ? answers.reset_pattern.noul : 0;
  const result: ApplyPatternResult = { reset_probability: resetProbability, candidates: [], applied_changes: [], rejected_changes: [], ignored_changes: [], history_entry: { request, applied_changes: [], rejected_changes: [] } };

  if (resetProbability >= 0.9) {
    const cleared = { kind: "reset", score: resetProbability };
    result.applied_changes.push(cleared);
    const next = { ...state, pattern: { ...state.pattern, notes: [] } };
    result.history_entry = { request, applied_changes: [describe(cleared)], rejected_changes: [] };
    return { state: recordHistory ? appendHistory(next, result.history_entry) : next, result };
  }

  const candidates = [];
  for (const [index, instrument] of INSTRUMENTS.entries()) {
    const candidate = additionCandidate(answers, instrument, index, state.pattern.meter);
    if (candidate) candidates.push(candidate);
  }
  state.pattern.notes.forEach((item, index) => {
    const candidate = noteCandidate(answers, item, index + INSTRUMENTS.length, state.pattern.bars, state.pattern.meter, state.tempo_bpm, state.pattern.swing_percent ?? 50, request);
    if (candidate) candidates.push(candidate);
  });
  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  result.candidates = clone(candidates);
  const operationLimit = Math.min(MAX_OPERATIONS, Math.max(0, Number.isInteger(maxOperations) ? maxOperations : MAX_OPERATIONS));
  const selected = candidates.slice(0, operationLimit);
  result.ignored_changes = clone(candidates.slice(operationLimit).map(candidate => ({ ...candidate, reason: "operation_limit" })));

  const notes = clone(state.pattern.notes);
  let nextNoteId = state.next_note_id;
  for (const candidate of selected) {
    if (candidate.kind === "remove") {
      const index = notes.findIndex(item => item.id === candidate.note_id);
      if (index === -1) {
        result.rejected_changes.push({ ...clone(candidate), reason: "missing_note" });
        continue;
      }
      const [before] = notes.splice(index, 1);
      result.applied_changes.push({ ...clone(candidate), before });
      continue;
    }

    if (!validProposed(candidate.proposed, state.pattern.bars, state.pattern.meter)) {
      result.rejected_changes.push({ ...clone(candidate), reason: "invalid_fields" });
      continue;
    }
    if (occupied(notes, candidate.proposed, candidate.note_id)) {
      result.rejected_changes.push({ ...clone(candidate), reason: "collision" });
      continue;
    }

    if (candidate.kind === "add") {
      const after = { ...candidate.proposed, id: `note_${nextNoteId++}` };
      notes.push(after);
      result.applied_changes.push({ ...clone(candidate), note_id: after.id, after });
    } else {
      const index = notes.findIndex(item => item.id === candidate.note_id);
      if (index === -1) {
        result.rejected_changes.push({ ...clone(candidate), reason: "missing_note" });
        continue;
      }
      const before = notes[index];
      notes[index] = { ...clone(candidate.proposed), id: before.id };
      result.applied_changes.push({ ...clone(candidate), before, after: notes[index] });
    }
  }

  const rejectedDescriptions = result.rejected_changes.map(change => `${change.source}: ${change.reason}`);
  result.history_entry = { request, applied_changes: result.applied_changes.map(describe), rejected_changes: rejectedDescriptions };
  const next = { ...state, pattern: { ...state.pattern, notes }, next_note_id: nextNoteId };
  return { state: recordHistory ? appendHistory(next, result.history_entry) : next, result };
}

export function stateForJev(state: PatternState, request: string): PatternJevState {
  const parts = Object.fromEntries(INSTRUMENTS.map(instrument => [instrument, state.pattern.notes
    .filter(note => note.instrument === instrument)
    .map(note => ({ id: note.id, bar: note.bar, tick: note.tick, position: positionForTick(note.tick, state.pattern.meter), velocity: note.velocity }))]));
  return {
    request,
    ...(state.recent_take ? { recent_take: clone(state.recent_take) } : {}),
    pattern: { bars: state.pattern.bars, meter: clone(state.pattern.meter), ticks_per_quarter: TICKS_PER_QUARTER, parts: parts as PatternJevState["pattern"]["parts"] },
    music_reference: clone(MUSIC_REFERENCE),
    recent_history: clone(state.recent_history).slice(-MAX_HISTORY),
  };
}
