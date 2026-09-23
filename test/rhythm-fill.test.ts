import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { runPatternTree } from "../src/core/pattern/request-runner.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";

const initial = () => loadPreset(createPatternState(), presetById("simple_backbeat"), "backbeat");
const intent = { instrument: "closed_hat", note_value: "sixteenths", bars: [1], beats: [1, 2, 3, 4], velocity: 64 };
async function fill(state: ReturnType<typeof initial>, targets: unknown = intent) {
  const forbidden = async () => { throw new Error("Rhythm fill must not use the note editor or presets"); };
  const options = { state, request: "Can I get 16ths on the hi-hats?", route: async () => ({ route: { category: "fill_rhythm", next_node: "rhythm_fill", message: null } }), interpretRhythm: async () => ({ intent: targets }), runEdit: forbidden, searchPresets: forbidden, selectPreset: forbidden };
  return runPatternTree(options as unknown as Parameters<typeof runPatternTree>[0]);
}

test("sixteenth hats fill all four beats in one operation and repeat requests add nothing", async () => {
  const before = initial();
  const result = await fill(before);
  assert.equal(result.result.applied_changes.length, 8);
  assert.deepEqual(result.state.pattern.notes.filter(n => n.instrument === "closed_hat").map(n => n.tick).sort((a,b) => a-b), [0,240,480,720,960,1200,1440,1680,1920,2160,2400,2640,2880,3120,3360,3600]);
  for (const note of before.pattern.notes) assert.deepEqual(result.state.pattern.notes.find(n => n.id === note.id), note);
  assert.equal((await fill(result.state)).result.applied_changes.length, 0);
  const accepted = recordUndoUnit(before, result, "16th hats");
  assert.deepEqual(undoLastChange(accepted.state).state.pattern, before.pattern);
});

test("beat-two fills only its missing hats; subsequent rest-of-bar fill covers remaining beats", async () => {
  const before = initial();
  const result = await fill(before, { ...intent, beats: [2] });
  assert.deepEqual(result.result.applied_changes.map(c => c.after?.tick), [1200,1680]);
  const rest = await fill(result.state);
  assert.equal(rest.result.applied_changes.length, 6);
  assert.deepEqual(rest.state.pattern.notes.filter(n => n.instrument === "kick"), before.pattern.notes.filter(n => n.instrument === "kick"));
});

test("fill respects selected bars and preserves human timing, velocity, kit and swing", async () => {
  const before = createPatternState({ tempo_bpm: 110, bars: 2, kit_id: "tr_505", swing_percent: 65, notes: [{ id: "note_1", instrument: "closed_hat", bar: 2, tick: 10, velocity: 20 }] });
  const result = await fill(before, { ...intent, bars: [2], beats: [1] });
  assert.equal(result.result.applied_changes.length, 3);
  assert.deepEqual(result.state.pattern.notes[0], before.pattern.notes[0]);
  assert.ok(result.state.pattern.notes.every(n => n.bar === 2));
  assert.equal(result.state.pattern.kit_id, "tr_505");
  assert.equal(result.state.pattern.swing_percent, 65);
  assert.equal(result.state.tempo_bpm, 110);
});

test("invalid fill targets reject atomically and uncertain interpretations make no changes", async () => {
  const before = initial();
  for (const invalid of [{...intent,beats:[5]}, {...intent,bars:[0]}, {...intent,instrument:"unknown"}, {...intent,note_value:"other"}, {...intent,velocity:NaN}]) await assert.rejects(fill(before, invalid), /invalid/i);
  const result = await fill(before, null);
  assert.deepEqual(result.state.pattern, before.pattern);
  assert.equal(result.result.applied_changes.length, 0);
  assert.ok(result.result.message);
});

test("an already-filled request remains the reference for the next fill, without an undo entry", async () => {
  const { rhythmFillContext } = await import("../src/ai/rhythm-fill-questions.js");
  const { stateForJev, appendHistory } = await import("../src/core/pattern/state.js");
  const full = (await fill(initial())).state;
  const before = appendHistory(full, { request: "add a kick", applied_changes: ["Added kick"], rejected_changes: [] });
  const completed = await fill(before);
  const accepted = recordUndoUnit(before, completed, "Can I get 16ths on the hi-hats?");
  assert.deepEqual(accepted.state.undo_history, before.undo_history);
  const context = rhythmFillContext(stateForJev(accepted.state, "Do it on beats 2, 3 and 4 as well"));
  assert.equal(context.previous_change?.request, "Can I get 16ths on the hi-hats?");
});
