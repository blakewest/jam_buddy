import test from "node:test";
import assert from "node:assert/strict";
import {
  TICKS_PER_QUARTER,
  tickForPosition,
  ticksPerBar,
} from "../src/core/pattern/musical-time.js";
import { createPatternState } from "../src/core/pattern/state.js";

test("supported meters use 960 ticks per quarter note", () => {
  assert.equal(TICKS_PER_QUARTER, 960);
  assert.equal(ticksPerBar({ numerator: 3, denominator: 4 }), 2880);
  assert.equal(ticksPerBar({ numerator: 6, denominator: 8 }), 2880);
});

test("straight and triplet positions map to exact ticks", () => {
  const meter = { numerator: 4, denominator: 4 };
  assert.equal(tickForPosition("beat_2_e", meter), 1200);
  assert.equal(tickForPosition("beat_1_triplet_2", meter), 320);
  assert.equal(tickForPosition("beat_1_sixteenth_triplet_2", meter), 160);
});

test("legacy slot patterns migrate to tick timing and MIDI velocity", () => {
  const state = createPatternState({ notes: [{ id: "note_1", instrument: "snare", bar: 1, slot: 7, velocity_layer: 3 }] });
  assert.deepEqual(state.pattern, {
    kit_id: "acoustic",
    bars: 1,
    meter: { numerator: 4, denominator: 4 },
    ticks_per_quarter: 960,
    notes: [{ id: "note_1", instrument: "snare", bar: 1, tick: 1440, velocity: 64 }],
  });
});
