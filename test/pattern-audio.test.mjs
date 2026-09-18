import test from "node:test";
import assert from "node:assert/strict";
import { eventsForWindow, splitPatternWindow } from "../src/core/pattern/audio-schedule.js";

const pattern = (bars, notes) => ({ bars, slots_per_bar: 16, notes });

test("a two-bar phrase repeats every four seconds", () => {
  const hits = eventsForWindow(pattern(2, [
    { id: "note_1", instrument: "kick", bar: 1, slot: 1, velocity_layer: 5 },
    { id: "note_2", instrument: "snare", bar: 2, slot: 5, velocity_layer: 3 },
  ]), 0, 8, 0);
  assert.deepEqual(hits.map(hit => [hit.id, hit.time]), [
    ["note_1", 0], ["note_2", 2.5],
    ["note_1", 4], ["note_2", 6.5],
  ]);
});

test("a pending phrase begins at the current phrase boundary", () => {
  const activePattern = pattern(2, [{ id: "note_1", instrument: "kick", bar: 2, slot: 16, velocity_layer: 3 }]);
  const pendingPattern = pattern(4, [{ id: "note_2", instrument: "snare", bar: 1, slot: 1, velocity_layer: 4 }]);
  const result = splitPatternWindow({ activePattern, pendingPattern, fromTime: 3.8, toTime: 4.2, originTime: 0, boundaryTime: 4 });
  assert.deepEqual(result.events.map(hit => [hit.instrument, hit.time]), [["kick", 3.875], ["snare", 4]]);
  assert.equal(result.didSwap, true);
  assert.equal(result.activePattern.notes[0].instrument, "snare");
  assert.equal(result.pendingPattern, null);
});

test("a pending pattern remains pending before the phrase boundary", () => {
  const activePattern = pattern(2, [{ id: "note_1", instrument: "kick", bar: 1, slot: 1, velocity_layer: 3 }]);
  const pendingPattern = pattern(4, [{ id: "note_2", instrument: "snare", bar: 1, slot: 1, velocity_layer: 4 }]);
  const result = splitPatternWindow({ activePattern, pendingPattern, fromTime: 0.1, toTime: 3.9, originTime: 0, boundaryTime: 4 });
  assert.equal(result.didSwap, false);
  assert.equal(result.pendingPattern.notes[0].instrument, "snare");
});
