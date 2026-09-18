export const INSTRUMENTS = Object.freeze(["kick", "snare", "closed_hat", "open_hat"]);
export const SLOTS_PER_BAR = 16;
export const MAX_BARS = 4;
export const MAX_HISTORY = 8;
export const MAX_OPERATIONS = 4;
export const POSITIONS = Object.freeze([
  "beat_1", "beat_1_e", "beat_1_and", "beat_1_a",
  "beat_2", "beat_2_e", "beat_2_and", "beat_2_a",
  "beat_3", "beat_3_e", "beat_3_and", "beat_3_a",
  "beat_4", "beat_4_e", "beat_4_and", "beat_4_a",
]);
export const MUSIC_REFERENCE = Object.freeze({
  all_eighths: ["beat_1", "beat_1_and", "beat_2", "beat_2_and", "beat_3", "beat_3_and", "beat_4", "beat_4_and"],
  four_on_the_floor: { kick: ["beat_1", "beat_2", "beat_3", "beat_4"] },
  backbeat: { snare: ["beat_2", "beat_4"] },
  edit_example: { request: "remove the snare from beat 4", result: "Remove only the existing snare at beat_4 and preserve every other note." },
});

export const positionForSlot = slot => POSITIONS[slot - 1];
export const slotForPosition = position => {
  const index = POSITIONS.indexOf(position);
  return index === -1 ? Number.NaN : index + 1;
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const clone = value => JSON.parse(JSON.stringify(value));

function nextIdFor(notes) {
  return notes.reduce((maximum, item) => Math.max(maximum, Number(item.id.match(/^note_(\d+)$/)?.[1] ?? 0)), 0) + 1;
}

export function createPatternState(saved = {}) {
  const pattern = saved.pattern ?? saved;
  const bars = Number.isInteger(pattern.bars) && pattern.bars >= 1 && pattern.bars <= MAX_BARS ? pattern.bars : 1;
  const notes = Array.isArray(pattern.notes) ? clone(pattern.notes)
    .map(note => ({ ...note, bar: Number.isInteger(note.bar) ? note.bar : 1 }))
    .filter(note => note.bar >= 1 && note.bar <= bars) : [];
  return {
    pattern: { bars, slots_per_bar: SLOTS_PER_BAR, notes },
    recent_history: Array.isArray(saved.recent_history) ? clone(saved.recent_history).slice(-MAX_HISTORY) : [],
    next_note_id: Math.max(Number(saved.next_note_id) || 1, nextIdFor(notes)),
  };
}

export function resizePattern(inputState, bars) {
  const state = createPatternState(inputState);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) throw new Error("Phrase length must be between one and four bars.");
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
  const match = /^(earlier|later)_([1-4])$/.exec(value ?? "");
  if (!match) return 0;
  return Number(match[2]) * (match[1] === "earlier" ? -1 : 1);
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
  const match = /^add_(kick|snare|closed_hat|open_hat)_in_bar_([1-4])_at_(beat_[1-4](?:_(?:e|and|a))?)$/.exec(action.choice);
  if (!match) return null;
  const noAddition = action.probabilities?.no_addition;
  const score = Number.isFinite(noAddition) ? clamp(1 - noAddition, 0, 1) : clamp(Number(action.confidence) || 0, 0, 1);
  const velocityMatch = /^layer_([1-5])$/.exec(choice(answers, `addition_${instrument}_velocity`, ""));
  return {
    kind: "add",
    source: `addition_${instrument}`,
    score,
    order,
    proposed: {
      instrument: match[1],
      bar: Number(match[2]),
      slot: slotForPosition(match[3]),
      velocity_layer: Number(velocityMatch?.[1]),
    },
  };
}

function shiftedTiming(item, delta, bars) {
  const totalSlots = bars * SLOTS_PER_BAR;
  const current = (item.bar - 1) * SLOTS_PER_BAR + item.slot - 1;
  const shifted = ((current + delta) % totalSlots + totalSlots) % totalSlots;
  return { bar: Math.floor(shifted / SLOTS_PER_BAR) + 1, slot: shifted % SLOTS_PER_BAR + 1 };
}

function noteCandidate(answers, item, order, bars) {
  const operation = answers[`${item.id}_operation`];
  if (!operation || operation.choice === "no_op" || !["remove", "modify"].includes(operation.choice)) return null;
  const candidate = { kind: operation.choice, source: item.id, note_id: item.id, score: alterationConfidence(operation), order };
  if (operation.choice === "modify") {
    const requestedInstrument = choice(answers, `${item.id}_instrument`, "keep_current");
    const timing = shiftedTiming(item, timingDelta(choice(answers, `${item.id}_timing`, "no_change")), bars);
    candidate.proposed = {
      id: item.id,
      instrument: requestedInstrument === "keep_current" ? item.instrument : requestedInstrument,
      ...timing,
      velocity_layer: clamp(item.velocity_layer + velocityDelta(choice(answers, `${item.id}_velocity`, "no_change")), 1, 5),
    };
  }
  return candidate;
}

const occupied = (notes, proposed, exceptId = null) => notes.some(item => item.id !== exceptId && item.instrument === proposed.instrument && item.bar === proposed.bar && item.slot === proposed.slot);

function validProposed(item, bars) {
  return INSTRUMENTS.includes(item.instrument) && Number.isInteger(item.bar) && item.bar >= 1 && item.bar <= bars && Number.isInteger(item.slot) && item.slot >= 1 && item.slot <= SLOTS_PER_BAR && Number.isInteger(item.velocity_layer) && item.velocity_layer >= 1 && item.velocity_layer <= 5;
}

function describe(change) {
  if (change.kind === "reset") return "Cleared the whole pattern";
  if (change.kind === "remove") return `Removed ${change.before.instrument} from slot ${change.before.slot}`;
  if (change.kind === "add") return `Added ${change.after.instrument} in bar ${change.after.bar} at slot ${change.after.slot}, velocity layer ${change.after.velocity_layer}`;
  return `Changed ${change.before.instrument} in bar ${change.before.bar} at slot ${change.before.slot} to ${change.after.instrument} in bar ${change.after.bar} at slot ${change.after.slot}, velocity layer ${change.after.velocity_layer}`;
}

export function applyPatternAnswers(inputState, answers, request = "", { maxOperations = MAX_OPERATIONS, recordHistory = true } = {}) {
  const state = createPatternState(inputState);
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

    if (!validProposed(candidate.proposed, state.pattern.bars)) {
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
    .map(note => ({ id: note.id, bar: note.bar, position: positionForSlot(note.slot), velocity_layer: note.velocity_layer }))]));
  return {
    request,
    pattern: { bars: state.pattern.bars, slots_per_bar: SLOTS_PER_BAR, parts },
    music_reference: clone(MUSIC_REFERENCE),
    recent_history: clone(state.recent_history).slice(-MAX_HISTORY),
  };
}
