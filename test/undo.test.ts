import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { runPatternRequest } from "../src/core/pattern/runner.js";
import { changeKit, runPatternCommand } from "../src/core/pattern/request-tree.js";
import { validRequestState } from "../src/ai/request-questions.js";

const pick = (choice: string) => ({ type: "choice" as const, choice, confidence: 1, probabilities: { [choice]: 1 } });

test("undoing a long request leaves history valid for the next request", async () => {
  const { recordUndoUnit, undoLastChange } = await import("../src/core/pattern/undo.js");
  const before = createPatternState();
  const request = "Use the 808. ".padEnd(500, "x");
  const accepted = recordUndoUnit(before, changeKit(before, "tr_808", request), request);
  const restored = undoLastChange(accepted.state).state;
  assert.equal(validRequestState({ request: "Use the 505", kit_id: restored.pattern.kit_id, recent_history: restored.recent_history }), true);
});

test("one undo reverses all passes of one request and keeps note IDs monotonic", async () => {
  const { recordUndoUnit, undoLastChange } = await import("../src/core/pattern/undo.js");
  const before = createPatternState();
  const completed = await runPatternRequest({ initialState: before, request: "add two kicks", maxPasses: 2, decide: async (_state, pass) => ({ answers: {
    addition_kick_action: pick(`add_kick_in_bar_1_at_beat_${pass}`), addition_kick_velocity: pick("velocity_4"),
  } }) });
  const accepted = recordUndoUnit(before, completed, "add two kicks");
  assert.equal(accepted.state.pattern.notes.length, 2);
  assert.equal(accepted.state.undo_history.length, 1);
  const undone = undoLastChange(accepted.state, "Undo that");
  assert.deepEqual(undone.state.pattern, before.pattern);
  assert.equal(undone.state.undo_history.length, 0);
  assert.equal(undone.state.next_note_id, 3);
});

test("undo walks backwards across kits, resizing and clear, survives reload, and is not itself undoable", async () => {
  const { recordUndoUnit, undoLastChange } = await import("../src/core/pattern/undo.js");
  const original = createPatternState({ bars: 2, notes: [{ id: "note_1", instrument: "snare", bar: 2, slot: 5, velocity_layer: 3 }] });
  const kit = recordUndoUnit(original, changeKit(original, "tr_505", "505"), "505").state;
  const cleared = recordUndoUnit(kit, { state: createPatternState({ ...kit, pattern: { ...kit.pattern, bars: 1, notes: [] } }), result: { applied_changes: [{ kind: "reset" }] } }, "clear").state;
  const restored = undoLastChange(createPatternState(JSON.parse(JSON.stringify(cleared))), "undo");
  assert.deepEqual(restored.state.pattern, kit.pattern);
  const acceptedUndo = recordUndoUnit(cleared, restored, "undo");
  assert.equal(acceptedUndo.state.undo_history.length, 1);
  assert.deepEqual(undoLastChange(acceptedUndo.state, "undo").state.pattern, original.pattern);
});

test("no-ops do not bury the last change and undo history is bounded", async () => {
  const { recordUndoUnit, undoLastChange } = await import("../src/core/pattern/undo.js");
  let state = createPatternState();
  assert.deepEqual(state.undo_history, []);
  assert.match(undoLastChange(state, "undo").message, /nothing to undo/i);
  for (let index = 0; index < 25; index++) state = recordUndoUnit(state, changeKit(state, index % 2 ? "tr_505" : "tr_808", "switch"), "switch").state;
  assert.equal(state.undo_history.length, 20);
  const unchanged = recordUndoUnit(state, changeKit(state, state.pattern.kit_id, "same"), "same");
  assert.equal(unchanged.state.undo_history.length, 20);
  assert.equal(undoLastChange(unchanged.state, "undo").state.pattern.kit_id, "tr_505");
  assert.equal(createPatternState().undo_history.length, 0);
});

test("undo routes directly to local restoration without note-edit API calls", async () => {
  const { recordUndoUnit } = await import("../src/core/pattern/undo.js");
  const before = createPatternState();
  const state = recordUndoUnit(before, changeKit(before, "tr_808", "808"), "808").state;
  let calls = 0;
  const restored = await runPatternCommand({ initialState: state, request: "Undo that", decideNode: async node => {
    assert.equal(node, "root"); calls++;
    return { answers: { selection: pick("undo") } };
  }, editPattern: () => { throw new Error("Undo must not call note editor"); } });
  assert.equal(calls, 1);
  assert.equal(restored.state.pattern.kit_id, "acoustic");
  assert.equal(restored.result.applied_changes[0].kind, "undo");
});

test("a failed multi-pass request cannot create an undo unit or mutate accepted state", async () => {
  const before = createPatternState();
  await assert.rejects(runPatternRequest({ initialState: before, request: "two kicks", maxPasses: 2, decide: async (_state, pass) => {
    if (pass === 2) throw new Error("network failed");
    return { answers: { addition_kick_action: pick("add_kick_in_bar_1_at_beat_1"), addition_kick_velocity: pick("velocity_4") } };
  } }), /network failed/);
  assert.deepEqual(before.pattern.notes, []);
  assert.deepEqual(before.undo_history, []);
});
