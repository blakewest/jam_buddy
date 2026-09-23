import type { Instrument, JevAnswers, JevChoiceAnswer, JevNoulAnswer } from "../src/core/pattern/state.js";
import test from "node:test";
import assert from "node:assert/strict";
import { appendHistory, applyPatternAnswers, createPatternState, resizePattern, stateForJev } from "../src/core/pattern/state.js";

const choice = (value: string, probabilities: Record<string, number> = { no_op: 0 }): JevChoiceAnswer => ({ type: "choice", choice: value, probabilities, confidence: Math.max(...Object.values(probabilities)) });
const noul = (value: number): JevNoulAnswer => ({ type: "noul", noul: value });
const note = (id: string, instrument: Instrument, slot: number, velocity_layer = 3, bar = 1) => ({ id, instrument, bar, slot, velocity_layer });

function noReset(extra: JevAnswers = {}) {
  return { reset_pattern: noul(0), ...extra };
}

function modify(id: string, operationProbability: number, timing = "no_change", velocity = "no_change", instrument = "keep_current") {
  return {
    [`${id}_operation`]: choice("modify", { remove: 0, modify: operationProbability, no_op: 1 - operationProbability }),
    [`${id}_timing`]: choice(timing, { [timing]: 1 }),
    [`${id}_velocity`]: choice(velocity, { [velocity]: 1 }),
    [`${id}_instrument`]: choice(instrument, { [instrument]: 1 }),
  };
}

function remove(id: string, probability: number, speculative: { timing?: string; velocity?: string; instrument?: string } = {}) {
  return {
    [`${id}_operation`]: choice("remove", { remove: probability, modify: 0, no_op: 1 - probability }),
    [`${id}_timing`]: choice(speculative.timing ?? "later_4", { later_4: 1 }),
    [`${id}_velocity`]: choice(speculative.velocity ?? "increase_2", { increase_2: 1 }),
    [`${id}_instrument`]: choice(speculative.instrument ?? "snare", { snare: 1 }),
  };
}

function addition(_lane: number, confidence: number, instrument: Instrument, slot: number, velocity: number, bar = 1) {
  const positions = ["beat_1", "beat_1_e", "beat_1_and", "beat_1_a", "beat_2", "beat_2_e", "beat_2_and", "beat_2_a", "beat_3", "beat_3_e", "beat_3_and", "beat_3_a", "beat_4", "beat_4_e", "beat_4_and", "beat_4_a"];
  const action = `add_${instrument}_in_bar_${bar}_at_${positions[slot - 1]}`;
  return {
    [`addition_${instrument}_action`]: choice(action, { no_addition: 1 - confidence, [action]: confidence }),
    [`addition_${instrument}_velocity`]: choice(`layer_${velocity}`, { [`layer_${velocity}`]: 1 }),
  };
}

test("a new pattern is an empty one-bar phrase", () => {
  const state = createPatternState();
  assert.deepEqual(state.pattern, { bars: 1, slots_per_bar: 16, notes: [], kit_id: "acoustic" });
  assert.deepEqual(state.recent_history, []);
});

test("resizing preserves notes when expanding and removes truncated bars when shrinking", () => {
  const state = createPatternState({ bars: 2, notes: [note("note_1", "kick", 1), note("note_2", "snare", 5, 4, 2)] });
  assert.deepEqual(resizePattern(state, 4).pattern, { bars: 4, slots_per_bar: 16, notes: state.pattern.notes, kit_id: "acoustic" });
  assert.deepEqual(resizePattern(state, 1).pattern.notes, [note("note_1", "kick", 1)]);
});

test("whole-pattern reset requires 0.90 and suppresses note edits", () => {
  const initial = createPatternState({ notes: [note("note_1", "kick", 1)] });
  const below = applyPatternAnswers(initial, noReset({ reset_pattern: noul(0.89) }), "maybe start over");
  assert.equal(below.state.pattern.notes.length, 1);

  const reset = applyPatternAnswers(initial, noReset({ reset_pattern: noul(0.9), ...remove("note_1", 1) }), "wipe everything");
  assert.deepEqual(reset.state.pattern.notes, []);
  assert.equal(reset.result.applied_changes.length, 1);
  assert.equal(reset.result.candidates.length, 0);
});

test("only the four highest-confidence alterations are applied", () => {
  const notes = [1, 2, 3, 4, 5].map(slot => note(`note_${slot}`, "kick", slot));
  const state = createPatternState({ notes });
  const answers = noReset();
  [0.51, 0.92, 0.73, 0.84, 0.65].forEach((probability, index) => Object.assign(answers, remove(`note_${index + 1}`, probability)));
  const applied = applyPatternAnswers(state, answers, "remove most of these");
  assert.deepEqual(applied.state.pattern.notes.map(item => item.id), ["note_1"]);
  assert.deepEqual(applied.result.applied_changes.map(item => "note_id" in item ? item.note_id : undefined), ["note_2", "note_4", "note_3", "note_5"]);
  assert.equal(applied.result.ignored_changes.length, 1);
});

test("removal ignores speculative modification answers", () => {
  const state = createPatternState({ notes: [note("note_1", "kick", 1, 1)] });
  const applied = applyPatternAnswers(state, noReset(remove("note_1", 0.8, { timing: "later_4", velocity: "increase_2", instrument: "snare" })), "remove it");
  assert.deepEqual(applied.state.pattern.notes, []);
  assert.equal(applied.result.applied_changes[0].kind, "remove");
});

test("modification wraps timing across the phrase and clamps velocity layers", () => {
  const state = createPatternState({ bars: 2, notes: [note("note_1", "kick", 15, 5, 2), note("note_2", "snare", 2, 1)] });
  const answers = noReset({
    ...modify("note_1", 0.9, "later_3", "increase_2", "open_hat"),
    ...modify("note_2", 0.8, "earlier_3", "decrease_2"),
  });
  const applied = applyPatternAnswers(state, answers, "move them around");
  assert.deepEqual(applied.state.pattern.notes, [
    note("note_1", "open_hat", 2, 5),
    note("note_2", "snare", 15, 1, 2),
  ]);
});

test("a modification cannot collide with an occupied cell", () => {
  const state = createPatternState({ notes: [note("note_1", "kick", 1), note("note_2", "kick", 2)] });
  const answers = noReset({
    ...modify("note_2", 0.9, "earlier_1"),
  });
  const applied = applyPatternAnswers(state, answers, "move the second kick earlier");
  assert.deepEqual(applied.state.pattern.notes, state.pattern.notes);
  assert.equal(applied.result.rejected_changes.length, 1);
  assert.ok("reason" in applied.result.rejected_changes[0]);
  assert.equal(applied.result.rejected_changes[0].reason, "collision");
});

test("a confident addition choice is applied without a separate Noul gate", () => {
  const answers = noReset(addition(1, 0.88, "kick", 5, 4));
  const applied = applyPatternAnswers(createPatternState({ notes: [note("note_1", "kick", 1, 4)] }), answers, "put kicks on every beat");
  assert.deepEqual(applied.state.pattern.notes, [note("note_1", "kick", 1, 4), note("note_2", "kick", 5, 4)]);
  assert.ok("score" in applied.result.applied_changes[0]);
  assert.equal(applied.result.applied_changes[0].score, 0.88);
});

test("a combined addition action maps instrument and position together", () => {
  const answers = noReset({
    addition_closed_hat_action: choice("add_closed_hat_in_bar_2_at_beat_2_and", { no_addition: 0.02, add_closed_hat_in_bar_2_at_beat_2_and: 0.98 }),
    addition_closed_hat_velocity: choice("layer_3", { layer_3: 1 }),
  });
  const applied = applyPatternAnswers(createPatternState({ bars: 2 }), answers, "hat in bar two");
  assert.deepEqual(applied.state.pattern.notes, [note("note_1", "closed_hat", 7, 3, 2)]);
});

test("Jev state groups notes by instrument and includes musical references", () => {
  const state = stateForJev(createPatternState({ notes: [
    note("note_1", "kick", 1, 4),
    note("note_2", "closed_hat", 3, 2),
  ] }), "add the rest of the eighths");
  assert.equal(state.pattern.bars, 1);
  assert.deepEqual(state.pattern.parts.kick, [{ id: "note_1", bar: 1, position: "beat_1", velocity_layer: 4 }]);
  assert.deepEqual(state.pattern.parts.closed_hat, [{ id: "note_2", bar: 1, position: "beat_1_and", velocity_layer: 2 }]);
  assert.deepEqual(state.music_reference.all_eighths, ["beat_1", "beat_1_and", "beat_2", "beat_2_and", "beat_3", "beat_3_and", "beat_4", "beat_4_and"]);
  assert.deepEqual(state.music_reference.four_on_the_floor.kick, ["beat_1", "beat_2", "beat_3", "beat_4"]);
  assert.deepEqual(state.music_reference.backbeat.snare, ["beat_2", "beat_4"]);
});

test("a pass can apply one highest-confidence edit without recording history", () => {
  const answers = noReset({
    ...addition(1, 0.7, "kick", 1, 4),
    ...addition(2, 0.95, "snare", 5, 4),
  });
  const applied = applyPatternAnswers(createPatternState(), answers, "make a beat", { maxOperations: 1, recordHistory: false });
  assert.deepEqual(applied.state.pattern.notes, [note("note_1", "snare", 5, 4)]);
  assert.deepEqual(applied.state.recent_history, []);
  assert.equal(applied.result.ignored_changes.length, 1);
});

test("deleted note IDs are not reused", () => {
  const first = applyPatternAnswers(createPatternState(), noReset(addition(1, 1, "kick", 1, 3)), "add");
  const removed = applyPatternAnswers(first.state, noReset(remove("note_1", 1)), "remove");
  const second = applyPatternAnswers(removed.state, noReset(addition(1, 1, "snare", 5, 4)), "add another");
  assert.equal(second.state.pattern.notes[0].id, "note_2");
});

test("history retains only the newest eight entries", () => {
  let state = createPatternState();
  for (let index = 1; index <= 10; index++) state = appendHistory(state, { request: `request ${index}`, applied_changes: [], rejected_changes: [] });
  assert.equal(state.recent_history.length, 8);
  assert.equal(state.recent_history[0].request, "request 3");
  assert.equal(state.recent_history[7].request, "request 10");
});
