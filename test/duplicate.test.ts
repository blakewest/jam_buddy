import test from "node:test";
import assert from "node:assert/strict";
import { runPatternCommand } from "../src/core/pattern/request-tree.js";
import { createPatternState } from "../src/core/pattern/state.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";
import type { BeatSelection } from "../src/core/pattern/selection.js";

const before = createPatternState({ bars: 2, notes: [
  { id: "note_1", instrument: "snare", bar: 1, tick: 3000, velocity: 53 },
  { id: "note_2", instrument: "snare", bar: 2, tick: 320, velocity: 71 },
  { id: "note_3", instrument: "kick", bar: 2, tick: 0, velocity: 100 },
  { id: "note_4", instrument: "kick", bar: 2, tick: 960, velocity: 88 },
] });
const selection: BeatSelection = { instruments: ["snare"], start_beat: 3, end_beat: 5, beats_per_bar: 4 };
const decideNode = async () => ({ answers: { selection: { type: "choice" as const, choice: "duplicate" } } });

test("duplicate inserts the exact selection and shifts all later lanes", async () => {
  const result = await runPatternCommand({ initialState: before, request: "copy this", selection, decideNode });
  assert.equal(result.state.pattern.bars, 3);
  const notes = result.state.pattern.notes;
  assert.deepEqual(notes.filter(n => ["note_1", "note_2", "note_3"].includes(n.id)), before.pattern.notes.slice(0, 3));
  assert.equal(notes.find(n => n.id === "note_4")?.tick, 2880);
  assert.deepEqual(notes.filter(n => !before.pattern.notes.some(old => old.id === n.id)).map(n => [n.instrument, n.bar, n.tick, n.velocity]), [
    ["snare", 2, 1080, 53], ["snare", 2, 2240, 71],
  ]);
  assert.equal(new Set(notes.map(n => n.id)).size, notes.length);
  const accepted = recordUndoUnit(before, result, "copy this");
  assert.deepEqual(undoLastChange(accepted.state).state.pattern, before.pattern);
  assert.equal(before.pattern.bars, 2);
});

test("without a selection duplicate doubles the whole groove", async () => {
  const result = await runPatternCommand({ initialState: before, request: "duplicate this beat", decideNode });
  assert.equal(result.state.pattern.bars, 4);
  assert.equal(result.state.pattern.notes.length, 8);
  assert.deepEqual(result.state.pattern.notes.slice(4).map(({ id, ...note }) => note), before.pattern.notes.map(({ id, ...note }) => ({ ...note, bar: note.bar + 2 })));
});

test("duplicate handles eighth-note meters and empty selected time", async () => {
  const state = createPatternState({ bars: 1, meter: { numerator: 6, denominator: 8 }, notes: [{ id: "note_1", instrument: "kick", bar: 1, tick: 480, velocity: 80 }] });
  const selected: BeatSelection = { instruments: ["snare"], start_beat: 0, end_beat: 1, beats_per_bar: 6 };
  const result = await runPatternCommand({ initialState: state, request: "duplicate this", selection: selected, decideNode });
  assert.equal(result.state.pattern.bars, 2);
  assert.equal(result.state.pattern.notes.length, 1);
  assert.equal(result.state.pattern.notes[0].tick, 960);
});

test("duplicate rejects overflow and invalid selection without mutating state", async () => {
  const full = createPatternState({ ...before, pattern: { ...before.pattern, bars: 8 } });
  await assert.rejects(runPatternCommand({ initialState: full, request: "duplicate", decideNode }), /eight bars/i);
  await assert.rejects(runPatternCommand({ initialState: before, request: "copy this", selection: { ...selection, end_beat: 12 }, decideNode }), /selection/i);
  assert.equal(full.pattern.notes.length, 4);
});
