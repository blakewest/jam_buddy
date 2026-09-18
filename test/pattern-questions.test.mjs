import test from "node:test";
import assert from "node:assert/strict";
import { buildPatternQuestions, PLANNING_QUESTIONS } from "../pattern-questions.mjs";
import { createPatternState, stateForJev } from "../public/pattern-state.js";

const emptyState = stateForJev(createPatternState(), "Start a beat");

test("operation planning offers zero through eight atomic edits", () => {
  assert.deepEqual(Object.keys(PLANNING_QUESTIONS.operation_count.criteria), Array.from({ length: 9 }, (_, count) => `operations_${count}`));
  assert.match(PLANNING_QUESTIONS.operation_count.instructions.atomic_operation, /same note.*one operation/i);
  assert.match(PLANNING_QUESTIONS.operation_count.criteria.operations_1.examples.join(" "), /move the first snare/i);
});

test("planning chooses phrase length and independently detects involved instruments", () => {
  assert.deepEqual(Object.keys(PLANNING_QUESTIONS), ["operation_count", "phrase_length", "involves_kick", "involves_snare", "involves_closed_hat", "involves_open_hat"]);
  assert.deepEqual(Object.keys(PLANNING_QUESTIONS.phrase_length.criteria), ["keep_current", "bars_1", "bars_2", "bars_3", "bars_4"]);
  for (const instrument of ["kick", "snare", "closed_hat", "open_hat"]) assert.equal(PLANNING_QUESTIONS[`involves_${instrument}`].type, "noul");
});

test("an empty four-bar pattern offers 64 positions for one planned instrument", () => {
  const state = { ...emptyState, pattern: { ...emptyState.pattern, bars: 4 } };
  const questions = buildPatternQuestions(state, ["closed_hat"]);
  assert.deepEqual(Object.keys(questions), ["reset_pattern", "addition_closed_hat_action", "addition_closed_hat_velocity"]);
  assert.equal(Object.keys(questions.addition_closed_hat_action.criteria).length, 65);
  assert.ok(questions.addition_closed_hat_action.criteria.add_closed_hat_in_bar_1_at_beat_1);
  assert.ok(questions.addition_closed_hat_action.criteria.add_closed_hat_in_bar_4_at_beat_4_a);
  assert.deepEqual(Object.keys(questions.addition_closed_hat_velocity.criteria), ["layer_1", "layer_2", "layer_3", "layer_4", "layer_5"]);
});

test("occupied instrument-position additions are omitted", () => {
  const state = stateForJev(createPatternState({ bars: 2, notes: [{ id: "note_1", instrument: "closed_hat", bar: 2, slot: 3, velocity_layer: 3 }] }), "more hats");
  const criteria = buildPatternQuestions(state, ["closed_hat"]).addition_closed_hat_action.criteria;
  assert.equal(criteria.add_closed_hat_in_bar_2_at_beat_1_and, undefined);
  assert.ok(criteria.add_closed_hat_in_bar_1_at_beat_1_and);
  assert.equal(Object.keys(criteria).length, 32);
});

test("each existing note adds four questions with its full meaning", () => {
  const note = { id: "note_7", instrument: "open_hat", bar: 1, slot: 16, velocity_layer: 2 };
  const questions = buildPatternQuestions(stateForJev(createPatternState({ notes: [note] }), "change it"), ["open_hat"]);
  assert.equal(Object.keys(questions).length, 7);
  const sentNote = { id: "note_7", instrument: "open_hat", bar: 1, position: "beat_4_a", velocity_layer: 2 };
  for (const suffix of ["operation", "timing", "velocity", "instrument"]) assert.deepEqual(questions[`note_7_${suffix}`].instructions.note, sentNote);
  assert.deepEqual(Object.keys(questions.note_7_operation.criteria), ["remove", "modify", "no_op"]);
  assert.deepEqual(Object.keys(questions.note_7_timing.criteria), ["earlier_4", "earlier_3", "earlier_2", "earlier_1", "no_change", "later_1", "later_2", "later_3", "later_4"]);
});

test("only notes from planned instruments receive edit questions", () => {
  const notes = [
    { id: "note_4", instrument: "snare", bar: 1, slot: 5, velocity_layer: 4 },
    { id: "note_9", instrument: "kick", bar: 1, slot: 1, velocity_layer: 5 },
  ];
  const keys = Object.keys(buildPatternQuestions(stateForJev(createPatternState({ notes }), "change the snare"), ["snare"]));
  assert.deepEqual(keys.slice(3), ["note_4_operation", "note_4_timing", "note_4_velocity", "note_4_instrument"]);
});
