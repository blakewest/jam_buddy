import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeTake } from "../src/core/recording/analysis.js";
import { tempoCandidates, mapRecording } from "../src/core/recording/rhythm.js";

// Explicit local replay: raw user audio stays outside committed fixtures.
const fixture = process.env.JAM_RECORDING_FIXTURE;
const latestFixture = process.env.JAM_DUPLICATE_RECORDING_FIXTURE;
test("second exported take does not split decaying kick and snare tails", { skip: !latestFixture }, () => {
  const wav = readFileSync(latestFixture!);
  const rate = wav.readUInt32LE(24);
  const samples = Float32Array.from({ length: wav.readUInt32LE(40) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  const hits = analyzeTake(samples, rate).filter(hit => hit.onset_seconds >= 2.32);
  const expected = [2.362, 2.967, 3.302, 3.604, 4.244, 4.906, 5.518, 5.843, 6.129, 6.740];
  assert.equal(hits.length, expected.length, JSON.stringify(hits.map(hit => hit.onset_seconds)));
  hits.forEach((hit, i) => assert.ok(Math.abs(hit.onset_seconds - expected[i]) < 0.025));
  assert.deepEqual(hits.map(hit => hit.instrument), ["kick", "snare", "kick", "kick", "snare", "kick", "snare", "kick", "kick", "snare"]);
});
test("exported duplicate-hit take retains ten demonstrated hits", { skip: !fixture }, () => {
  const wav = readFileSync(fixture!);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  const rate = wav.readUInt32LE(24);
  const samples = Float32Array.from({ length: wav.readUInt32LE(40) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  const expected = [2.267, 2.907, 3.212, 3.519, 4.154, 4.768, 5.382, 5.669, 5.969, 6.586];
  const hits = analyzeTake(samples, rate).filter(hit => hit.onset_seconds >= 2.26);
  assert.equal(hits.length, expected.length, JSON.stringify(hits.map(hit => hit.onset_seconds)));
  hits.forEach((hit, i) => assert.ok(Math.abs(hit.onset_seconds - expected[i]) < 0.025));
  assert.deepEqual(hits.map(hit => hit.instrument), ["kick", "snare", "kick", "kick", "snare", "kick", "snare", "kick", "kick", "snare"]);
  const tempo = tempoCandidates(hits.map(hit => hit.onset_seconds), 120)[0].tempo_bpm;
  assert.ok(Math.abs(tempo - 97) <= 1);
  const mapped = mapRecording({ hits, start_context_seconds: 0, mode: "replace", tempo_bpm: tempo, start_seconds: 2.26, rotation_slots: 0, instrument: "automatic",
    transport: { playing: false, tempo_bpm: 120, bars: 1, origin_context_seconds: 0, captured_context_seconds: 0, output_latency_seconds: 0, output_context_seconds: 0, output_performance_ms: 0, input_correction_ms: 0 } });
  assert.equal(mapped.bars, 2);
  assert.deepEqual(mapped.notes.map(note => (note.bar - 1) * 16 + note.tick / 240 + 1), [1, 5, 7, 9, 13, 17, 21, 23, 25, 29]);
});
