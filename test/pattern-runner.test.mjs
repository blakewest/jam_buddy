import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { runPatternRequest } from "../src/core/pattern/runner.js";

const choice = (value, probabilities) => ({ type: "choice", choice: value, probabilities, confidence: Math.max(...Object.values(probabilities)) });
const noReset = { type: "noul", noul: 0 };

function addKick(slot, confidence = 0.9) {
  const positions = ["beat_1", "beat_1_e", "beat_1_and", "beat_1_a", "beat_2", "beat_2_e", "beat_2_and", "beat_2_a", "beat_3", "beat_3_e", "beat_3_and", "beat_3_a", "beat_4", "beat_4_e", "beat_4_and", "beat_4_a"];
  const action = `add_kick_at_${positions[slot - 1]}`;
  return {
    reset_pattern: noReset,
    addition_kick_action: choice(action.replace("add_kick_at_", "add_kick_in_bar_1_at_"), { no_addition: 1 - confidence, [action.replace("add_kick_at_", "add_kick_in_bar_1_at_")]: confidence }),
    addition_kick_velocity: choice("velocity_4", { velocity_4: 1 }),
  };
}

const noChange = {
  reset_pattern: noReset,
  addition_kick_action: choice("no_addition", { no_addition: 1 }),
  addition_kick_velocity: choice("velocity_3", { velocity_3: 1 }),
};

const response = answers => ({ answers, model: "test-jev", usage: { input_tokens: 10, output_tokens: 2 }, question_count: 3, latency_ms: 20 });

test("four passes each see the preceding pattern and produce one history entry", async () => {
  const seenCounts = [];
  const slots = [1, 5, 9, 13];
  const completed = await runPatternRequest({
    initialState: createPatternState(),
    request: "four on the floor",
    maxPasses: 4,
    decide: async (sentState, pass) => {
      seenCounts.push(sentState.pattern.parts.kick.length);
      return response(addKick(slots[pass - 1], 0.9 - pass / 100));
    },
  });
  assert.deepEqual(seenCounts, [0, 1, 2, 3]);
  assert.deepEqual(completed.state.pattern.notes.map(note => note.tick), [0, 960, 1920, 2880]);
  assert.equal(completed.state.recent_history.length, 1);
  assert.equal(completed.state.recent_history[0].applied_changes.length, 4);
  assert.equal(completed.passes.length, 4);
  assert.equal(completed.result.applied_changes.length, 4);
});

test("the default run allows eight sequential additions", async () => {
  const slots = [1, 3, 5, 7, 9, 11, 13, 15];
  const completed = await runPatternRequest({
    initialState: createPatternState(),
    request: "kicks on all eighths",
    decide: async (_sentState, pass) => response(addKick(slots[pass - 1], 0.9)),
  });
  assert.equal(completed.passes.length, 8);
  assert.deepEqual(completed.state.pattern.notes.map(note => note.tick), slots.map(slot => (slot - 1) * 240));
});

test("an operation estimate limits a one-note request to one edit pass", async () => {
  let editCalls = 0;
  const completed = await runPatternRequest({
    initialState: createPatternState(),
    request: "add one kick",
    estimateOperations: async sentState => {
      assert.deepEqual(sentState.pattern.parts.kick, []);
      return { operation_count: 1, phrase_bars: 1, relevant_instruments: ["kick"], answers: {}, model: "test-jev", usage: { input_tokens: 5, output_tokens: 1 }, question_count: 6, latency_ms: 10 };
    },
    decide: async (_state, _pass, plan) => { editCalls++; assert.deepEqual(plan.relevant_instruments, ["kick"]); return response(addKick(1)); },
  });
  assert.equal(editCalls, 1);
  assert.equal(completed.result.planned_operations, 1);
  assert.equal(completed.passes.length, 1);
  assert.equal(completed.question_count, 9);
  assert.deepEqual(completed.usage, { input_tokens: 15, output_tokens: 3 });
});

test("a zero-operation estimate records the request without an edit call", async () => {
  const completed = await runPatternRequest({
    initialState: createPatternState(),
    request: "leave it alone",
    estimateOperations: async () => ({ operation_count: 0, phrase_bars: 1, relevant_instruments: ["kick"], question_count: 6 }),
    decide: async () => assert.fail("no edit pass should run"),
  });
  assert.equal(completed.passes.length, 0);
  assert.equal(completed.result.planned_operations, 0);
  assert.equal(completed.state.recent_history.length, 1);
});

test("planning can expand the phrase without running a note edit", async () => {
  const completed = await runPatternRequest({
    initialState: createPatternState({ notes: [{ id: "note_1", instrument: "kick", slot: 1, velocity_layer: 4 }] }),
    request: "I want a four bar phrase",
    estimateOperations: async () => ({ operation_count: 0, phrase_bars: 4, relevant_instruments: ["kick"], question_count: 6 }),
    decide: async () => assert.fail("phrase resizing does not require a note edit"),
  });
  assert.equal(completed.state.pattern.bars, 4);
  assert.equal(completed.state.pattern.notes[0].bar, 1);
  assert.equal(completed.result.applied_changes[0].kind, "resize");
  assert.equal(completed.state.recent_history[0].applied_changes[0], "Changed phrase length from 1 bar to 4 bars");
});

test("a no-edit answer stops the sequence early", async () => {
  let calls = 0;
  const completed = await runPatternRequest({ initialState: createPatternState(), request: "leave it", decide: async () => { calls++; return response(noChange); } });
  assert.equal(calls, 1);
  assert.equal(completed.passes.length, 1);
  assert.equal(completed.result.applied_changes.length, 0);
  assert.equal(completed.state.recent_history.length, 1);
});

test("a whole-pattern reset stops after one pass", async () => {
  let calls = 0;
  const initialState = createPatternState({ notes: [{ id: "note_1", instrument: "kick", slot: 1, velocity_layer: 4 }] });
  const completed = await runPatternRequest({
    initialState,
    request: "wipe it",
    decide: async () => { calls++; return response({ ...noChange, reset_pattern: { type: "noul", noul: 0.95 } }); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(completed.state.pattern.notes, []);
  assert.equal(completed.result.applied_changes[0].kind, "reset");
});
