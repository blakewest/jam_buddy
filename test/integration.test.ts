import test from "node:test";
import assert from "node:assert/strict";
import { appendHistory, createPatternState } from "../src/core/pattern/state.js";
import { validRequestState } from "../src/ai/request-questions.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";
import { runPatternCommand, resolveRoot } from "../src/core/pattern/request-tree.js";
import { runPatternTree } from "../src/core/pattern/request-runner.js";

test("undoing the first preset does not resurrect its shuffle filters", async () => {
  const before = createPatternState();
  const loaded = loadPreset(before, presetById("funk_pocket"), "funk");
  loaded.preset_context = { preset_id: "funk_pocket", attributes: { genres: ["funk"] } };
  const accepted = recordUndoUnit(before, { state: loaded, result: { applied_changes: [{ kind: "load_preset" }] } }, "funk");
  const restored = createPatternState(JSON.parse(JSON.stringify(undoLastChange(accepted.state).state)));
  const forbidden = async (): Promise<never> => { throw new Error("unexpected branch call"); };
  const result = await runPatternTree({ state: restored, request: "something else", route: async () => ({ route: resolveRoot("shuffle_preset") }), searchPresets: async () => ({ candidate_ids: [], has_explicit_filters: false }), selectPreset: forbidden, runEdit: forbidden, random: () => 0 });
  assert.deepEqual(result.state.preset_context?.attributes, {});
});

test("large edit history stays valid for the next root request and reload", () => {
  const entry = { request: "edit", applied_changes: Array.from({ length: 9 }, () => "x".repeat(301)), rejected_changes: [] };
  for (const state of [appendHistory(createPatternState(), entry), createPatternState({ recent_history: [entry] })]) {
    assert.equal(validRequestState({ request: "undo", kit_id: state.pattern.kit_id, recent_history: state.recent_history }), true);
  }
  assert.equal(entry.applied_changes.length, 9);
});

test("preset undo restores kit, tempo, human timing and shuffle context", () => {
  const before = createPatternState({ tempo_bpm: 87, preset_context: { preset_id: "funk_pocket", attributes: { genres: ["funk"] } }, pattern: { kit_id: "tr_808", bars: 2, notes: [{ id: "note_1", instrument: "snare", bar: 2, tick: 973, velocity: 7, midi_pitch: 40 }] } });
  const loaded = loadPreset(before, presetById("simple_backbeat"), "backbeat");
  loaded.preset_context = { preset_id: "simple_backbeat", attributes: {} };
  const accepted = recordUndoUnit(before, { state: loaded, result: { applied_changes: [{ kind: "load_preset" }] } }, "backbeat");
  assert.equal(accepted.state.pattern.kit_id, "tr_808");
  assert.equal(accepted.state.tempo_bpm, 100);
  const restored = undoLastChange(createPatternState(JSON.parse(JSON.stringify(accepted.state)))).state;
  assert.deepEqual(restored.pattern, before.pattern);
  assert.equal(restored.tempo_bpm, 87);
  assert.deepEqual(restored.preset_context, before.preset_context);
});

test("the unified root clears a groove locally without a second routing call", async () => {
  const before = loadPreset(createPatternState(), presetById("funk_pocket"), "funk");
  let calls = 0;
  const forbidden = async (): Promise<never> => { throw new Error("unexpected branch call"); };
  const completed = await runPatternCommand({ initialState: before, request: "clear it", decideNode: async () => {
    calls++;
    return { answers: { selection: { type: "choice", choice: "clear_pattern" } } };
  }, grooveRequest: route => runPatternTree({ state: before, request: "clear it", route: async () => ({ route }), searchPresets: forbidden, selectPreset: forbidden, runEdit: forbidden }) });
  assert.equal(calls, 1);
  assert.equal(completed.state.pattern.notes.length, 0);
  assert.equal(resolveRoot("undo").category, "undo");
});
