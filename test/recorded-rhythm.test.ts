import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { SUPPORTED_METERS } from "../src/core/pattern/musical-time.js";
import { eventsForWindow } from "../src/core/pattern/audio-schedule.js";
import { tempoCandidates, mapRecording, applyRecording } from "../src/core/recording/rhythm.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";
const hits = [0, 0.5, 1, 1.5].map(onset_seconds => ({ onset_seconds, instrument: "kick" as const }));
const transport = { playing: false, tempo_bpm: 120, bars: 1, origin_context_seconds: 0, captured_context_seconds: 10, output_latency_seconds: 0.04, output_context_seconds: 9.96, output_performance_ms: 0, input_correction_ms: 60 };

test("old patterns migrate to 120 BPM and scheduling uses stored tempo", () => {
  assert.equal(createPatternState().tempo_bpm, 120);
  const pattern = createPatternState({ tempo_bpm: 60, notes: [{ id: "note_1", instrument: "kick", bar: 1, slot: 5, velocity_layer: 3 }] }).pattern;
  assert.equal(eventsForWindow(pattern, 60, 0, 2)[0].time, 1);
});
test("tempo ambiguity keeps current tempo for ties, offers half/double and retains tempo with few hits", () => {
  const result = tempoCandidates(hits.map(hit => hit.onset_seconds), 120);
  assert.equal(result[0].tempo_bpm, 120);
  assert.ok(result.some(candidate => candidate.tempo_bpm === 60));
  assert.equal(tempoCandidates([0, 1], 110)[0].tempo_bpm, 110);
  assert.equal(tempoCandidates([0, 1], 110)[0].uncertain, true);
});
test("running transport subtracts latency and wraps repeated loop passes", () => {
  const mapped = mapRecording({ hits: [{ onset_seconds: 0.1, instrument: "snare" }, { onset_seconds: 2.1, instrument: "snare" }], start_context_seconds: 10, transport: { ...transport, playing: true }, mode: "replace", tempo_bpm: 90, start_seconds: 0, rotation_slots: 0, instrument: "automatic" });
  assert.equal(mapped.tempo_bpm, 120);
  assert.equal(mapped.bars, 1);
  assert.deepEqual(mapped.notes.map(note => [note.bar, note.tick]), [[1, 0]]);
});
test("whole take is atomic, overrides labels, deduplicates cells, and undoes tempo and notes", () => {
  const before = createPatternState();
  const mapped = mapRecording({ hits: Array.from({ length: 16 }, (_, i) => ({ onset_seconds: i * 0.125, instrument: "kick" })), start_context_seconds: 10, transport, mode: "replace", tempo_bpm: 120, start_seconds: 0, rotation_slots: 0, instrument: "closed_hat" });
  const result = recordUndoUnit(before, applyRecording(before, mapped, "take-1", "Beatbox"), "Beatbox");
  assert.equal(result.state.pattern.notes.length, 16);
  assert.ok(result.state.pattern.notes.every(note => note.instrument === "closed_hat" && note.velocity === 64));
  assert.deepEqual(undoLastChange(result.state).state.pattern, before.pattern);
});
test("replacement rejects more than four bars; addition preserves phrase and tempo", () => {
  const args = { hits: [{ onset_seconds: 0, instrument: "kick" }, { onset_seconds: 9, instrument: "kick" }], start_context_seconds: 0, transport, tempo_bpm: 120, start_seconds: 0, rotation_slots: 0, instrument: "automatic" as const };
  assert.throws(() => mapRecording({ ...args, mode: "replace" }), /four bars/);
  const result = mapRecording({ ...args, mode: "add", tempo_bpm: 80 });
  assert.equal(result.tempo_bpm, 120);
  assert.equal(result.bars, 1);
  assert.equal(mapRecording({ ...args, mode: "add", transport: { ...transport, bars: 8 } }).bars, 8);
  assert.equal(mapRecording({ ...args, mode: "replace", transport: { ...transport, playing: true, bars: 8 } }).bars, 8);
});

test("recording collisions never grant ownership of pre-existing notes", async () => {
  const { runPatternRequest } = await import("../src/core/pattern/runner.js");
  const before = createPatternState({ notes: [
    { id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 96 },
    { id: "note_2", instrument: "closed_hat", bar: 1, tick: 960, velocity: 32 },
  ] });
  const added = applyRecording(before, { mode: "add", bars: 1, tempo_bpm: 120, notes: [
    { instrument: "kick", bar: 1, tick: 0, velocity: 64 },
    { instrument: "kick", bar: 1, tick: 960, velocity: 64 },
    { instrument: "kick", bar: 1, tick: 1920, velocity: 64 },
  ] }, "take", "add these").state;
  assert.deepEqual(added.recent_take?.note_ids, ["note_3", "note_4"]);
  const corrected = await runPatternRequest({ initialState: added, request: "Those should be hats",
    estimateOperations: async () => ({ operation_count: 2, phrase_bars: 1, relevant_instruments: ["kick", "closed_hat"], recorded_take_instrument: "closed_hat" }),
    decide: async () => { throw new Error("Unexpected per-note call"); },
  });
  assert.deepEqual(corrected.state.recent_take?.note_ids, ["note_4"]);
  for (const original of before.pattern.notes) assert.deepEqual(corrected.state.pattern.notes.find(note => note.id === original.id), original);
});

test("adjustment reports removals relative to accepted take even when no new cells are inserted", async () => {
  const { recordingDelta } = await import("../src/core/recording/rhythm.js");
  const before = createPatternState({ notes: [{ id: "note_1", instrument: "kick", bar: 1, slot: 1, velocity_layer: 3 }, { id: "note_2", instrument: "kick", bar: 1, slot: 5, velocity_layer: 3 }] }).pattern;
  const after = { ...before, notes: before.notes.slice(0, 1) };
  assert.deepEqual(recordingDelta(before, after).map(change => change.kind), ["remove"]);
});
test("undo restores references to the preceding recorded take", () => {
  const before = createPatternState({ notes: [{ id: "note_1", instrument: "kick", bar: 1, slot: 1, velocity_layer: 3 }], recent_take: { id: "older", note_ids: ["note_1"] } });
  const result = recordUndoUnit(before, applyRecording(before, { notes: [{ instrument: "snare", bar: 1, tick: 960, velocity: 64 }], bars: 1, tempo_bpm: 120, mode: "replace" }, "newer", "New take"), "New take");
  assert.deepEqual(undoLastChange(result.state).state.recent_take, before.recent_take);
});

test("the edit branch can relabel an entire take beyond eight notes while preserving timing", async () => {
  const { runPatternRequest } = await import("../src/core/pattern/runner.js");
  const notes = Array.from({ length: 16 }, (_, i) => ({ id: `note_${i + 1}`, instrument: "kick" as const, bar: 1, slot: i + 1, velocity_layer: 3 }));
  const initial = createPatternState({ notes, recent_take: { id: "take", note_ids: notes.map(note => note.id) } });
  const completed = await runPatternRequest({ initialState: initial, request: "Those should be hi-hats", estimateOperations: async sent => {
    assert.equal(sent.recent_take?.note_ids.length, 16);
    return { operation_count: 8, phrase_bars: 1, relevant_instruments: ["kick", "closed_hat"], recorded_take_instrument: "closed_hat" };
  }, decide: async () => { throw new Error("Relabeling a whole take should not require per-note calls"); } });
  assert.equal(completed.state.pattern.notes.length, 16);
  assert.ok(completed.state.pattern.notes.every(note => note.instrument === "closed_hat"));
  assert.deepEqual(completed.state.pattern.notes.map(note => note.tick), notes.map(note => (note.slot - 1) * 240));
});

test("two suspect retriggers do not stretch a two-bar take to 145 BPM", () => {
  // Actual captured onsets; 2.185 and 3.423 s are suspected duplicate boom tails.
  // This verifies the intended interpretation, not the uninspected raw waveform.
  const onsets = [1.985578231292517, 2.1849659863945576, 2.6131972789115645, 2.918299319727891, 3.2323356009070294, 3.422766439909297, 3.855714285714286, 4.4917687074829935, 5.098616780045352, 5.3926757369614515, 5.707936507936508, 6.307528344671201];
  const candidates = tempoCandidates(onsets, 120);
  assert.ok(Math.abs(candidates[0].tempo_bpm - 97) <= 1, JSON.stringify(candidates));
  assert.ok(candidates.some(candidate => Math.abs(candidate.tempo_bpm - 145) <= 1), "keep the other plausible interpretation available");
  const mapped = mapRecording({ hits: onsets.map(onset_seconds => ({ onset_seconds, instrument: "kick" })), start_context_seconds: 0, transport, mode: "replace", tempo_bpm: candidates[0].tempo_bpm, start_seconds: 1.96, rotation_slots: 0, instrument: "automatic" });
  assert.equal(mapped.bars, 2);
  assert.equal(mapped.notes[0].tick, 0);
});

test("addition preserves nearby humanized notes, including across the loop seam", () => {
  const before = createPatternState({ notes: [
    { id: "note_1", instrument: "kick", bar: 1, tick: 3820, velocity: 90 },
    { id: "note_2", instrument: "snare", bar: 1, tick: 985, velocity: 45 },
  ] });
  const result = applyRecording(before, { mode: "add", bars: 1, tempo_bpm: 120, notes: [
    { instrument: "kick", bar: 1, tick: 0, velocity: 64 },
    { instrument: "snare", bar: 1, tick: 960, velocity: 64 },
    { instrument: "snare", bar: 1, tick: 1200, velocity: 64 },
    { instrument: "closed_hat", bar: 1, tick: 960, velocity: 64 },
  ] }, "take", "add this");
  assert.equal(result.state.pattern.notes.length, 4);
  assert.deepEqual(result.state.pattern.notes.slice(0, 2), before.pattern.notes);
  assert.deepEqual(result.state.recent_take?.note_ids, ["note_3", "note_4"]);
  assert.match(result.result.history_entry.applied_changes[0], /2/);
});

test("recording to a swung groove uses the audible grid, without applying swing twice", () => {
  const swungTransport = { ...transport, playing: true, swing_percent: 75, origin_context_seconds: 0, output_latency_seconds: 0, input_correction_ms: 0 };
  const mapped = mapRecording({ hits: [0, .375, .5, .875].map(onset_seconds => ({onset_seconds, instrument: "closed_hat"})), start_context_seconds: 0, transport: swungTransport, mode: "add", tempo_bpm: 120, start_seconds: 0, rotation_slots: 0, instrument: "automatic" });
  assert.deepEqual(mapped.notes.map(note => note.tick), [0, 480, 960, 1440]);
  const after = applyRecording(createPatternState({ swing_percent: 75 }), mapped, "swing", "play this");
  assert.deepEqual(eventsForWindow(after.state.pattern, 120, 0, 1).map(hit => hit.time), [0, .375, .5, .875]);
});

test("a replacement recorded while stopped resets old swing instead of warping the new take", () => {
  const stoppedTransport = {...transport, swing_percent: 75};
  const mapped = mapRecording({ hits, start_context_seconds: 0, transport: stoppedTransport, mode: "replace", tempo_bpm: 120, start_seconds: 0, rotation_slots: 0, instrument: "automatic" });
  const result = applyRecording(createPatternState({ swing_percent: 75 }), mapped, "straight", "new beat");
  assert.equal(result.state.pattern.swing_percent, 50);
});

test("swing-aware placement round-trips across meters and loop boundaries", () => {
  for (const meter of SUPPORTED_METERS) {
    for (const swing_percent of [50, 65, 85]) {
      const barTicks = meter.numerator * 960 * 4 / meter.denominator;
      const state = createPatternState({ bars: 2, meter, swing_percent, notes: Array.from({ length: barTicks * 2 / 240 }, (_, i) => ({ id: `note_${i + 1}`, instrument: "closed_hat", bar: Math.floor(i * 240 / barTicks) + 1, tick: i * 240 % barTicks, velocity: 64 })) });
      const duration = barTicks * 2 / 1920;
      const observed = eventsForWindow(state.pattern, 120, duration, duration * 2).map(hit => ({ onset_seconds: hit.time, instrument: hit.instrument }));
      const mapped = mapRecording({ hits: observed, start_context_seconds: 0, transport: { ...transport, playing: true, bars: 2, meter, swing_percent, origin_context_seconds: 0, output_latency_seconds: 0, input_correction_ms: 0 }, mode: "add", tempo_bpm: 120, start_seconds: 0, rotation_slots: 0, instrument: "automatic" });
      assert.deepEqual(mapped.notes.map(note => [note.bar, note.tick]), state.pattern.notes.map(note => [note.bar, note.tick]), `${meter.numerator}/${meter.denominator} swing ${swing_percent}`);
    }
  }
});
