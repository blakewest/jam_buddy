import { describeTick, editPositions, tickForPosition, ticksPerBar, TICKS_PER_QUARTER, validMeter, velocityForLayer } from "./musical-time.js";
import { defaultPitch, pitchForNote, validPitchForInstrument } from "./drum-pitches.js";

export const INSTRUMENTS = Object.freeze(["kick", "snare", "closed_hat", "open_hat", "ride", "crash", "high_tom", "mid_tom", "floor_tom"]);
export const DEFAULT_METER = Object.freeze({ numerator: 4, denominator: 4 });
export const MAX_BARS = 8;
export const MAX_HISTORY = 8;
export const MAX_OPERATIONS = 4;
export const POSITIONS = Object.freeze(editPositions(DEFAULT_METER).map(item => item.id));
export const MUSIC_REFERENCE = Object.freeze({
  all_eighths: ["beat_1", "beat_1_and", "beat_2", "beat_2_and", "beat_3", "beat_3_and", "beat_4", "beat_4_and"],
  four_on_the_floor: { kick: ["beat_1", "beat_2", "beat_3", "beat_4"] },
  backbeat: { snare: ["beat_2", "beat_4"] },
  edit_example: { request: "remove the snare from beat 4", result: "Remove only the existing snare at beat_4 and preserve every other note." },
});

export const positionForTick = (tick, meter = DEFAULT_METER) => describeTick(tick, meter);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const clone = value => JSON.parse(JSON.stringify(value));

function nextIdFor(notes) {
  return notes.reduce((maximum, item) => Math.max(maximum, Number(item.id.match(/^note_(\d+)$/)?.[1] ?? 0)), 0) + 1;
}

export function createPatternState(saved = {}) {
  const pattern = saved.pattern ?? saved;
  const bars = Number.isInteger(pattern.bars) && pattern.bars >= 1 && pattern.bars <= MAX_BARS ? pattern.bars : 1;
  const meter = validMeter(pattern.meter) ? clone(pattern.meter) : clone(DEFAULT_METER);
  const notes = Array.isArray(pattern.notes) ? clone(pattern.notes).map(note => ({
    id: note.id,
    instrument: note.instrument,
    bar: Number.isInteger(note.bar) ? note.bar : 1,
    tick: Number.isInteger(note.tick) ? note.tick : Number.isInteger(note.slot) ? (note.slot - 1) * TICKS_PER_QUARTER / 4 : Number.NaN,
    velocity: Number.isInteger(note.velocity) ? note.velocity : velocityForLayer(note.velocity_layer),
    ...(note.midi_pitch === undefined ? {} : { midi_pitch: note.midi_pitch }),
  })).filter(note => note.bar >= 1 && note.bar <= bars && INSTRUMENTS.includes(note.instrument)
    && Number.isInteger(note.tick) && note.tick >= 0 && note.tick < ticksPerBar(meter)
    && Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127
    && (note.midi_pitch === undefined || validPitchForInstrument(note.midi_pitch, note.instrument))) : [];
  return {
    pattern: { bars, meter, ticks_per_quarter: TICKS_PER_QUARTER, notes },
    recent_history: Array.isArray(saved.recent_history) ? clone(saved.recent_history).slice(-MAX_HISTORY) : [],
    next_note_id: Math.max(Number(saved.next_note_id) || 1, nextIdFor(notes)),
    ...(saved.preset_context ? { preset_context: clone(saved.preset_context) } : {}),
  };
}

export function resizePattern(inputState, bars) {
  const state = createPatternState(inputState);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) throw new Error("Phrase length must be between one and eight bars.");
  return { ...state, pattern: { ...state.pattern, bars, notes: state.pattern.notes.filter(note => note.bar <= bars) } };
}

export function appendHistory(state, entry) {
  return {
    ...state,
    recent_history: [...state.recent_history, clone(entry)].slice(-MAX_HISTORY),
  };
}

function choice(answers, key, fallback) {
  return answers[key]?.type === "choice" ? answers[key].choice : fallback;
}

function alterationConfidence(answer) {
  const noOp = answer?.probabilities?.no_op;
  return Number.isFinite(noOp) ? clamp(1 - noOp, 0, 1) : 0;
}

function timingDelta(value) {
  if (value === "no_change") return 0;
  const match = /^(earlier|later)_(sixteenth|eighth|eighth_triplet|sixteenth_triplet)$/.exec(value ?? "");
  if (!match) return 0;
  const ticks = { sixteenth: 240, eighth: 480, eighth_triplet: 320, sixteenth_triplet: 160 }[match[2]];
  return ticks * (match[1] === "earlier" ? -1 : 1);
}

function velocityDelta(value) {
  if (value === "no_change") return 0;
  const match = /^(decrease|increase)_([1-2])$/.exec(value ?? "");
  if (!match) return 0;
  return Number(match[2]) * (match[1] === "decrease" ? -1 : 1);
}

function additionCandidate(answers, instrument, order) {
  const action = answers[`addition_${instrument}_action`];
  if (!action || action.choice === "no_addition") return null;
  const match = /^add_([a-z_]+)_in_bar_([1-8])_at_(beat_\d+(?:_(?:e|and|a|triplet_[23]|sixteenth_triplet_[2-6]))?)$/.exec(action.choice);
  if (!match) return null;
  const noAddition = action.probabilities?.no_addition;
  const score = Number.isFinite(noAddition) ? clamp(1 - noAddition, 0, 1) : clamp(Number(action.confidence) || 0, 0, 1);
  const velocityMatch = /^velocity_([1-5])$/.exec(choice(answers, `addition_${instrument}_velocity`, ""));
  const velocities = [16, 40, 64, 96, 120];
  return {
    kind: "add",
    source: `addition_${instrument}`,
    score,
    order,
    proposed: {
      instrument: match[1],
      bar: Number(match[2]),
      tick: tickForPosition(match[3], answers.__meter ?? DEFAULT_METER),
      velocity: velocities[Number(velocityMatch?.[1]) - 1],
    },
  };
}

function shiftedTiming(item, delta, bars, meter) {
  const barTicks = ticksPerBar(meter);
  const totalTicks = bars * barTicks;
  const current = (item.bar - 1) * barTicks + item.tick;
  const shifted = ((current + delta) % totalTicks + totalTicks) % totalTicks;
  return { bar: Math.floor(shifted / barTicks) + 1, tick: shifted % barTicks };
}

function noteCandidate(answers, item, order, bars) {
  const operation = answers[`${item.id}_operation`];
  if (!operation || operation.choice === "no_op" || !["remove", "modify"].includes(operation.choice)) return null;
  const candidate = { kind: operation.choice, source: item.id, note_id: item.id, score: alterationConfidence(operation), order };
  if (operation.choice === "modify") {
    const requestedInstrument = choice(answers, `${item.id}_instrument`, "keep_current");
    const timing = shiftedTiming(item, timingDelta(choice(answers, `${item.id}_timing`, "no_change")), bars, answers.__meter ?? DEFAULT_METER);
    candidate.proposed = {
      id: item.id,
      instrument: requestedInstrument === "keep_current" ? item.instrument : requestedInstrument,
      ...timing,
      velocity: clamp(item.velocity + velocityDelta(choice(answers, `${item.id}_velocity`, "no_change")) * 16, 1, 127),
      ...(item.midi_pitch === undefined ? {} : { midi_pitch: requestedInstrument === "keep_current" || requestedInstrument === item.instrument ? item.midi_pitch : defaultPitch(requestedInstrument) }),
    };
  }
  return candidate;
}

const occupied = (notes, proposed, exceptId = null) => notes.some(item => item.id !== exceptId && item.instrument === proposed.instrument && item.bar === proposed.bar && item.tick === proposed.tick && pitchForNote(item) === pitchForNote(proposed));

function validProposed(item, bars, meter) {
  return INSTRUMENTS.includes(item.instrument) && Number.isInteger(item.bar) && item.bar >= 1 && item.bar <= bars && Number.isInteger(item.tick) && item.tick >= 0 && item.tick < ticksPerBar(meter) && Number.isInteger(item.velocity) && item.velocity >= 1 && item.velocity <= 127 && (item.midi_pitch === undefined || validPitchForInstrument(item.midi_pitch, item.instrument));
}

function describe(change) {
  if (change.kind === "reset") return "Cleared the whole pattern";
  if (change.kind === "remove") return `Removed ${change.before.instrument} from tick ${change.before.tick}`;
  if (change.kind === "add") return `Added ${change.after.instrument} in bar ${change.after.bar} at tick ${change.after.tick}, velocity ${change.after.velocity}`;
  return `Changed ${change.before.instrument} in bar ${change.before.bar} at tick ${change.before.tick} to ${change.after.instrument} in bar ${change.after.bar} at tick ${change.after.tick}, velocity ${change.after.velocity}`;
}

export function applyPatternAnswers(inputState, answers, request = "", { maxOperations = MAX_OPERATIONS, recordHistory = true } = {}) {
  const state = createPatternState(inputState);
  answers = { ...answers, __meter: state.pattern.meter };
  const resetProbability = Number(answers.reset_pattern?.noul) || 0;
  const result = { reset_probability: resetProbability, candidates: [], applied_changes: [], rejected_changes: [], ignored_changes: [] };

  if (resetProbability >= 0.9) {
    const cleared = { kind: "reset", score: resetProbability };
    result.applied_changes.push(cleared);
    const next = { ...state, pattern: { ...state.pattern, notes: [] } };
    result.history_entry = { request, applied_changes: [describe(cleared)], rejected_changes: [] };
    return { state: recordHistory ? appendHistory(next, result.history_entry) : next, result };
  }

  const candidates = [];
  for (const [index, instrument] of INSTRUMENTS.entries()) {
    const candidate = additionCandidate(answers, instrument, index);
    if (candidate) candidates.push(candidate);
  }
  state.pattern.notes.forEach((item, index) => {
    const candidate = noteCandidate(answers, item, index + INSTRUMENTS.length, state.pattern.bars);
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
      const after = { id: `note_${nextNoteId++}`, ...candidate.proposed };
      notes.push(after);
      result.applied_changes.push({ ...clone(candidate), note_id: after.id, after });
    } else {
      const index = notes.findIndex(item => item.id === candidate.note_id);
      if (index === -1) {
        result.rejected_changes.push({ ...clone(candidate), reason: "missing_note" });
        continue;
      }
      const before = notes[index];
      notes[index] = clone(candidate.proposed);
      result.applied_changes.push({ ...clone(candidate), before, after: notes[index] });
    }
  }

  const rejectedDescriptions = result.rejected_changes.map(change => `${change.source}: ${change.reason}`);
  result.history_entry = { request, applied_changes: result.applied_changes.map(describe), rejected_changes: rejectedDescriptions };
  const next = { ...state, pattern: { ...state.pattern, notes }, next_note_id: nextNoteId };
  return { state: recordHistory ? appendHistory(next, result.history_entry) : next, result };
}

export function stateForJev(state, request) {
  const parts = Object.fromEntries(INSTRUMENTS.map(instrument => [instrument, state.pattern.notes
    .filter(note => note.instrument === instrument)
    .map(note => ({ id: note.id, bar: note.bar, tick: note.tick, position: positionForTick(note.tick, state.pattern.meter), velocity: note.velocity }))]));
  return {
    request,
    pattern: { bars: state.pattern.bars, meter: clone(state.pattern.meter), ticks_per_quarter: TICKS_PER_QUARTER, parts },
    music_reference: clone(MUSIC_REFERENCE),
    recent_history: clone(state.recent_history).slice(-MAX_HISTORY),
  };
}
