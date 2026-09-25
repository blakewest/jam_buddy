import test from "node:test";
import assert from "node:assert/strict";
import { eventsForWindow, patternDurationSeconds, splitPatternWindow } from "../src/core/pattern/audio-schedule.js";

const pattern = (bars: number, meter: import("../src/core/pattern/musical-time.js").Meter, notes: any) => ({ bars, meter, ticks_per_quarter: 960, notes });
const note = (id: string, instrument: import("../src/core/pattern/state.js").Instrument, bar: number, tick: number, velocity = 96) => ({ id, instrument, bar, tick, velocity });

test("soft ghost notes retain their velocity within the selected sample layer", () => {
  const notes = [note("ghost", "snare", 1, 0, 5), note("soft", "snare", 1, 240, 25), note("medium", "snare", 1, 480, 40), note("loud", "snare", 1, 720, 127)];
  const hits = eventsForWindow(pattern(1, { numerator: 4, denominator: 4 }, notes), 120, 0, 0.5);
  assert.deepEqual(hits.map(hit => [hit.id, hit.layer, hit.gain]), [["ghost", 1, 0.2], ["soft", 1, 1], ["medium", 2, 0.8], ["loud", 5, 1]]);
});

test("simultaneous MIDI articulations choose distinct sample families", () => {
  const notes = [
    { ...note("side", "snare", 1, 0), midi_pitch: 37 },
    { ...note("center", "snare", 1, 0), midi_pitch: 38 },
    { ...note("pedal", "closed_hat", 1, 0), midi_pitch: 44 },
  ];
  const hits = eventsForWindow(pattern(1, { numerator: 4, denominator: 4 }, notes), 120, 0, 0.1);
  assert.deepEqual(hits.map(hit => hit.sample_family), ["snare_side", "snare_center", "hat_pedal"]);
});

test("humanized tick timing repeats at the session tempo", () => {
  const hits = eventsForWindow(pattern(1, { numerator: 4, denominator: 4 }, [note("note_1", "kick", 1, 487)]), 120, 0, 4.1, 0);
  assert.deepEqual(hits.map(hit => [hit.id, Number(hit.time.toFixed(6))]), [["note_1", 0.253646], ["note_1", 2.253646]]);
});

test("3/4 and 6/8 phrase duration follows meter and tempo", () => {
  assert.equal(patternDurationSeconds(pattern(1, { numerator: 3, denominator: 4 }, []), 120), 1.5);
  assert.equal(patternDurationSeconds(pattern(1, { numerator: 6, denominator: 8 }, []), 120), 1.5);
  assert.equal(patternDurationSeconds(pattern(2, { numerator: 4, denominator: 4 }, []), 90), 16 / 3);
});

test("a pending meter begins at the active phrase boundary", () => {
  const activePattern = pattern(1, { numerator: 4, denominator: 4 }, [note("note_1", "kick", 1, 3600)]);
  const pendingPattern = pattern(1, { numerator: 3, denominator: 4 }, [note("note_2", "snare", 1, 0)]);
  const result = splitPatternWindow({ activePattern, activeBpm: 120, pendingPattern, pendingBpm: 120, fromTime: 1.8, toTime: 2.2, originTime: 0, boundaryTime: 2 });
  assert.deepEqual(result.events.map(hit => [hit.instrument, hit.time]), [["kick", 1.875], ["snare", 2]]);
  assert.equal(result.didSwap, true);
  assert.equal(result.activePattern.meter.numerator, 3);
});

test("a pending pattern remains pending before the phrase boundary", () => {
  const activePattern = pattern(1, { numerator: 4, denominator: 4 }, [note("note_1", "kick", 1, 0)]);
  const pendingPattern = pattern(1, { numerator: 3, denominator: 4 }, [note("note_2", "snare", 1, 0)]);
  const result = splitPatternWindow({ activePattern, activeBpm: 120, pendingPattern, pendingBpm: 90, fromTime: 0.1, toTime: 1.9, originTime: 0, boundaryTime: 2 });
  assert.equal(result.didSwap, false);
  assert.equal(result.pendingPattern!.notes[0].instrument, "snare");
});

test("next-beat tempo changes retain musical position without duplicate hits", () => {
  const activePattern = pattern(2, { numerator: 4, denominator: 4 }, [note("old", "kick", 1, 960)]);
  const pendingPattern = pattern(2, { numerator: 4, denominator: 4 }, [note("new", "snare", 1, 960), note("later", "snare", 1, 1920)]);
  const result = splitPatternWindow({ activePattern, activeBpm: 120, pendingPattern, pendingBpm: 60, fromTime: .4, toTime: 1.6, originTime: 0, boundaryTime: .5, preservePhase: true });
  assert.deepEqual(result.events.map(hit => [hit.id, hit.time]), [["new", .5], ["later", 1.5]]);
});

test("changing phrase length preserves position in the current loop", () => {
  const activePattern = pattern(1, { numerator: 4, denominator: 4 }, []);
  const pendingPattern = pattern(2, { numerator: 4, denominator: 4 }, [note("new", "kick", 1, 960)]);
  const result = splitPatternWindow({ activePattern, activeBpm: 120, pendingPattern, pendingBpm: 120, fromTime: 2.4, toTime: 2.6, originTime: 0, boundaryTime: 2.5, preservePhase: true });
  assert.deepEqual(result.events.map(hit => [hit.id, hit.time]), [["new", 2.5]]);
});
