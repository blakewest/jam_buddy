import test from "node:test";
import assert from "node:assert/strict";
import { eventsForWindow, patternDurationSeconds, splitPatternWindow } from "../src/core/pattern/audio-schedule.js";

const pattern = (bars, meter, notes) => ({ bars, meter, ticks_per_quarter: 960, notes });
const note = (id, instrument, bar, tick, velocity = 96) => ({ id, instrument, bar, tick, velocity });

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
  assert.equal(result.pendingPattern.notes[0].instrument, "snare");
});
