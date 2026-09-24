import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
const initialState = createPatternState({ notes: [{ id: "note_1", instrument: "kick", bar: 1, slot: 1, velocity_layer: 4 }] });
const decision = (value: string) => ({ answers: { selection: { type: "choice" as const, choice: value, probabilities: { [value]: 1 }, confidence: 1 } }, model: "test", latency_ms: 10, question_count: 1, usage: { input_tokens: 5 } });

test("kit branch preserves notes, skips note editor and records routing usage", async () => {
  const { runPatternCommand } = await import("../src/core/pattern/request-tree.js");
  const visited: string[] = [];
  const completed = await runPatternCommand({ initialState, request: "use 808", decideNode: async (node, state) => {
    visited.push(node);
    assert.equal("pattern" in state, false);
    return decision(node === "root" ? "change_kit" : "tr_808");
  }, editPattern: () => { throw new Error("Must not edit notes"); } });
  assert.deepEqual(visited, ["root", "change_kit"]);
  assert.equal(completed.state.pattern.kit_id, "tr_808");
  assert.deepEqual(completed.state.pattern.notes, initialState.pattern.notes);
  assert.equal(completed.result.applied_changes[0].kind, "kit");
  assert.equal(completed.state.recent_history.length, 1);
  assert.equal(completed.usage.input_tokens, 10);
  assert.equal(completed.latency_ms, 20);
});

test("edit branch delegates once and preserves all editor results", async () => {
  const { runPatternCommand } = await import("../src/core/pattern/request-tree.js");
  const { runPatternRequest } = await import("../src/core/pattern/runner.js");
  let edits = 0;
  const completed = await runPatternCommand({ initialState, request: "remove everything", decideNode: async () => decision("edit_pattern"), editPattern: async () => {
    edits++;
    return runPatternRequest({ initialState, request: "remove everything", decide: async () => ({ answers: { reset_pattern: { type: "noul", noul: 1 } } }) });
  } });
  assert.equal(edits, 1);
  assert.deepEqual(completed.state.pattern.notes, []);
  assert.equal(completed.passes.length, 1);
  assert.equal(completed.latency_ms, 10);
});

test("unsupported, keep-current and already-selected requests make no changes", async () => {
  const { runPatternCommand, unsupportedGuidance } = await import("../src/core/pattern/request-tree.js");
  for (const selection of ["unsupported", "keep_current", "acoustic"]) {
    const completed = await runPatternCommand({ initialState, request: "test", decideNode: async node => decision(node === "root" ? "change_kit" : selection) });
    assert.deepEqual(completed.state.pattern, initialState.pattern);
    assert.equal(completed.result.applied_changes.length, 0);
    assert.ok(completed.message);
  }
  assert.match(unsupportedGuidance(), /kit/i);
});

test("tree rejects invalid node answers before any state change", async () => {
  const { runPatternCommand } = await import("../src/core/pattern/request-tree.js");
  await assert.rejects(runPatternCommand({ initialState, request: "test", decideNode: async () => decision("arbitrary_handler") }), /invalid/i);
});

test("root routes every category to its own child branch", async () => {
  const { nodeOutcome } = await import("../src/core/pattern/request-tree.js");
  for (const category of ["edit_pattern", "change_kit", "undo", "unsupported"]) {
    assert.deepEqual(nodeOutcome("root", decision(category).answers), { next_node: category });
  }
});

test("unsupported root branch returns guidance without invoking an editor or another decision", async () => {
  const { runPatternCommand, unsupportedGuidance } = await import("../src/core/pattern/request-tree.js");
  const visited: string[] = [];
  const completed = await runPatternCommand({
    initialState,
    request: "Add distortion",
    decideNode: async node => {
      visited.push(node);
      return decision("unsupported");
    },
    editPattern: () => { throw new Error("Unsupported requests must not edit"); },
  });
  assert.deepEqual(visited, ["root"]);
  assert.deepEqual(completed.state.pattern, initialState.pattern);
  assert.equal(completed.message, unsupportedGuidance());
});

test("another kit cycles through available kits without changing the groove and can be undone", async () => {
  const { runPatternCommand } = await import("../src/core/pattern/request-tree.js");
  const { recordUndoUnit, undoLastChange } = await import("../src/core/pattern/undo.js");
  let state = createPatternState({ ...initialState, pattern: { ...initialState.pattern, swing_percent: 65 } });
  for (const expected of ["tr_808", "tr_505", "acoustic"]) {
    const before = state;
    const completed = await runPatternCommand({ initialState: before, request: "Now a different kit.", decideNode: async node => decision(node === "root" ? "change_kit" : "another_kit") });
    state = recordUndoUnit(before, completed, "Now a different kit.").state;
    assert.equal(state.pattern.kit_id, expected);
    assert.notEqual(state.pattern.kit_id, before.pattern.kit_id);
    assert.deepEqual(state.pattern.notes, before.pattern.notes);
    assert.equal(state.pattern.swing_percent, 65);
    assert.equal(state.tempo_bpm, before.tempo_bpm);
    assert.deepEqual(undoLastChange(state).state.pattern, before.pattern);
  }
});
