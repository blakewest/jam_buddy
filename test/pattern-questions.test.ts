import test from "node:test";
import assert from "node:assert/strict";
import { buildPatternQuestions as buildQuestions, patternSummary, PLANNING_QUESTIONS } from "../src/ai/pattern-questions.js";
import { createPatternState, stateForJev } from "../src/core/pattern/state.js";

const emptyState = stateForJev(createPatternState(), "Start a beat");
const buildPatternQuestions = buildQuestions as (...args: Parameters<typeof buildQuestions>) => Record<string, { type: string; criteria: Record<string, unknown>; instructions: { note?: unknown } }>;

test("scope summaries retain timing and velocity needed to choose between bars", () => {
  const sent = stateForJev(createPatternState({ bars: 2, notes: [
    { id: "note_1", instrument: "snare", bar: 1, tick: 960, velocity: 50 },
    { id: "note_2", instrument: "snare", bar: 2, tick: 2880, velocity: 100 },
  ] }), "remove the snare on beat 4");
  assert.deepEqual(patternSummary(sent).pattern.parts.snare, [
    { bar: 1, notes: 1, hits: [[960, 50]] },
    { bar: 2, notes: 1, hits: [[2880, 100]] },
  ]);
});

test("operation planning offers zero through eight atomic edits", () => {
  assert.deepEqual(Object.keys(PLANNING_QUESTIONS.operation_count.criteria), Array.from({ length: 9 }, (_, count) => `operations_${count}`));
  assert.match(PLANNING_QUESTIONS.operation_count.instructions.atomic_operation, /same note.*one operation/i);
  assert.match(PLANNING_QUESTIONS.operation_count.criteria.operations_1.examples!.join(" "), /move the first snare/i);
});

test("planning chooses phrase length and independently detects involved instruments", () => {
  assert.deepEqual(Object.keys(PLANNING_QUESTIONS), ["operation_count", "phrase_length", "involves_kick", "involves_snare", "involves_closed_hat", "involves_open_hat", "involves_ride", "involves_crash", "involves_high_tom", "involves_mid_tom", "involves_floor_tom"]);
  assert.deepEqual(Object.keys(PLANNING_QUESTIONS.phrase_length.criteria), ["keep_current", "bars_1", "bars_2", "bars_3", "bars_4", "bars_5", "bars_6", "bars_7", "bars_8"]);
  for (const instrument of ["kick", "snare", "closed_hat", "open_hat", "ride", "crash", "high_tom", "mid_tom", "floor_tom"]) assert.equal((PLANNING_QUESTIONS as unknown as import("../src/ai/question-types.js").Questions)[`involves_${instrument}`].type, "noul");
});

test("an eight-bar pattern offers additions in its final bar", () => {
  const state = stateForJev(createPatternState({ bars: 8 }), "add a crash at the end");
  const criteria = buildPatternQuestions(state, ["crash"]).addition_crash_action.criteria;
  assert.ok(criteria.add_crash_in_bar_8_at_beat_4_a);
});

test("an empty four-bar pattern offers straight and triplet positions for one planned instrument", () => {
  const state = { ...emptyState, pattern: { ...emptyState.pattern, bars: 4 } };
  const questions = buildPatternQuestions(state, ["closed_hat"]);
  assert.deepEqual(Object.keys(questions), ["reset_pattern", "addition_closed_hat_action", "addition_closed_hat_velocity"]);
  assert.equal(Object.keys(questions.addition_closed_hat_action.criteria).length, 129);
  assert.ok(questions.addition_closed_hat_action.criteria.add_closed_hat_in_bar_1_at_beat_1);
  assert.ok(questions.addition_closed_hat_action.criteria.add_closed_hat_in_bar_4_at_beat_4_a);
  assert.deepEqual(Object.keys(questions.addition_closed_hat_velocity.criteria), ["velocity_1", "velocity_2", "velocity_3", "velocity_4", "velocity_5"]);
});

test("occupied instrument-position additions are omitted", () => {
  const state = stateForJev(createPatternState({ bars: 2, notes: [{ id: "note_1", instrument: "closed_hat", bar: 2, slot: 3, velocity_layer: 3 }] }), "more hats");
  const criteria = buildPatternQuestions(state, ["closed_hat"]).addition_closed_hat_action.criteria;
  assert.equal(criteria.add_closed_hat_in_bar_2_at_beat_1_and, undefined);
  assert.ok(criteria.add_closed_hat_in_bar_1_at_beat_1_and);
  assert.equal(Object.keys(criteria).length, 64);
});

test("each existing note adds four questions with its full meaning", () => {
  const note = { id: "note_7", instrument: "open_hat", bar: 1, slot: 16, velocity_layer: 2 };
  const questions = buildPatternQuestions(stateForJev(createPatternState({ notes: [note] }), "change it"), ["open_hat"]);
  assert.equal(Object.keys(questions).length, 7);
  const sentNote = { id: "note_7", instrument: "open_hat", bar: 1, tick: 3600, position: "beat_4_a", velocity: 32 };
  for (const suffix of ["operation", "timing", "velocity", "instrument"]) assert.deepEqual(questions[`note_7_${suffix}`].instructions.note, sentNote);
  assert.deepEqual(Object.keys(questions.note_7_operation.criteria), ["remove", "modify", "no_op"]);
  assert.deepEqual(Object.keys(questions.note_7_timing.criteria), ["earlier_eighth", "earlier_sixteenth", "earlier_eighth_triplet", "earlier_sixteenth_triplet", "earlier_10ms", "no_change", "later_10ms", "later_sixteenth_triplet", "later_eighth_triplet", "later_sixteenth", "later_eighth"]);
  assert.match(JSON.stringify(questions.note_7_timing), /just a hair/);
  assert.match(JSON.stringify(questions.note_7_timing), /a little earlier/);
});

test("only notes from planned instruments receive edit questions", () => {
  const notes = [
    { id: "note_4", instrument: "snare", bar: 1, slot: 5, velocity_layer: 4 },
    { id: "note_9", instrument: "kick", bar: 1, slot: 1, velocity_layer: 5 },
  ];
  const keys = Object.keys(buildPatternQuestions(stateForJev(createPatternState({ notes }), "change the snare"), ["snare"]));
  assert.deepEqual(keys.slice(3), ["note_4_operation", "note_4_timing", "note_4_velocity", "note_4_instrument"]);
});
