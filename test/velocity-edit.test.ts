import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { runPatternTree as runTree } from "../src/core/pattern/request-runner.js";
const runPatternTree = (options: unknown) => runTree(options as Parameters<typeof runTree>[0]);
import { applyVelocityEdit } from "../src/core/pattern/velocity-edit.js";
const intent = { instruments: ["closed_hat", "open_hat"], bars: [1], beats: [3, 4], subdivision: "onbeats", delta: 16 };

test("structured velocity edit updates both target hats once and bypasses the edit loop", async () => {
  const initial = loadPreset(createPatternState(), presetById("simple_backbeat"), "backbeat");
  initial.pattern.notes.filter(n => n.instrument === "closed_hat").forEach(n => { n.velocity = 96; });
  const calls: any[] = [];
  const completed = await runPatternTree({ state: initial, request: "Make hi hats louder on beats 3 and 4", route: async () => { calls.push("root"); return { route: { category: "edit_pattern" } }; }, interpretEdit: async () => { calls.push("interpret"); return { intent }; }, runEdit: async () => { throw new Error("Must not enter the iterative loop"); } });
  assert.deepEqual(calls, ["root", "interpret"]);
  assert.equal(completed.result.applied_changes.length, 2);
  for (const note of completed.state.pattern.notes) {
    const before = initial.pattern.notes.find(n => n.id === note.id);
    const targeted = note.instrument === "closed_hat" && [1920, 2880].includes(note.tick);
    assert.deepEqual(note, { ...before, velocity: targeted ? 112 : before!.velocity });
  }
});

test("velocity edits clamp at MIDI limits and preserve human timing and articulations", () => {
  const initial = createPatternState({ pattern: { bars: 2, notes: [{ id: "note_1", instrument: "closed_hat", bar: 1, tick: 1930, velocity: 120, midi_pitch: 44 }, { id: "note_2", instrument: "closed_hat", bar: 2, tick: 1930, velocity: 120, midi_pitch: 42 }] } });
  const result = applyVelocityEdit(initial, intent, "louder");
  assert.deepEqual(result.state.pattern.notes[0], { ...initial.pattern.notes[0], velocity: 127 });
  assert.deepEqual(result.state.pattern.notes[1], initial.pattern.notes[1]);
});

test("unsupported edit interpretations continue into the existing edit loop", async () => {
  const initial = createPatternState();
  let called = false;
  await runPatternTree({ state: initial, request: "move the snare", route: async () => ({ route: { category: "edit_pattern" } }), interpretEdit: async () => ({ intent: null }), runEdit: async () => { called = true; return { state: initial, result: {} }; } });
  assert.equal(called, true);
});
