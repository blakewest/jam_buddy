import test from "node:test";
import assert from "node:assert/strict";
import { CaptureBuffer, correctedContextTime, encodeWav } from "../src/core/recording/capture.js";
import { createPatternState } from "../src/core/pattern/state.js";
import { recordingStateKey } from "../src/core/recording/rhythm.js";

test("recording snapshots accept unchanged music despite note field order", () => {
  const state = createPatternState();
  state.pattern.notes = [{ instrument: "kick", bar: 1, tick: 0, velocity: 64, id: "note_1" }];
  const before = createPatternState(state);
  assert.equal(recordingStateKey(state), recordingStateKey(before));
  before.tempo_bpm = 130;
  assert.notEqual(recordingStateKey(state), recordingStateKey(before));
  before.tempo_bpm = state.tempo_bpm;
  before.pattern.notes[0].tick = 240;
  assert.notEqual(recordingStateKey(state), recordingStateKey(before));
});

test("capture retains sample origin, rejects gaps, and bounds memory at 30 seconds", () => {
  const buffer = new CaptureBuffer(8000);
  buffer.append(10, new Float32Array(8000));
  buffer.append(11, new Float32Array(240000));
  const take = buffer.finish();
  assert.equal(take.start_context_seconds, 10);
  assert.equal(take.samples.length, 240000);
  assert.equal(buffer.full, true);
  const broken = new CaptureBuffer(8000);
  broken.append(1, new Float32Array(128));
  assert.throws(() => broken.append(2, new Float32Array(128)), /gap/);
});

test("input correction subtracts capture delay and audible mapping subtracts output delay, never lookahead", () => {
  assert.equal(correctedContextTime(10, 0.5, 0.04, 60), 10.4);
});

test("short microphone gaps preserve elapsed time without discarding captured hits", () => {
  const buffer = new CaptureBuffer(8000);
  buffer.append(10, new Float32Array(128).fill(0.5));
  buffer.append(10.216, new Float32Array(128).fill(0.75));
  const take = buffer.finish();
  assert.equal(take.start_context_seconds, 10);
  assert.equal(take.samples.length, 1856);
  assert.equal(take.samples[127], 0.5);
  assert.ok(take.samples.slice(128, 1728).every(value => value === 0));
  assert.equal(take.samples[1728], 0.75);
});

test("gap padding stays within the take limit and overlapping chunks still reject", () => {
  const buffer = new CaptureBuffer(8000);
  buffer.append(0, new Float32Array(239200));
  buffer.append(30, new Float32Array(128));
  assert.equal(buffer.finish().samples.length, 240000);
  const overlap = new CaptureBuffer(8000);
  overlap.append(1, new Float32Array(128));
  assert.throws(() => overlap.append(1, new Float32Array(128)), /overlap/);
});

test("WAV preserves all samples and declares mono PCM at the capture sample rate", () => {
  const wav = encodeWav(new Float32Array([-1, 0, 1]), 48000);
  const view = new DataView(wav);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});
