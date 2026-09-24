import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTake } from "../src/core/recording/analysis.js";

function fixture(frequency: number) {
  const rate = 16000;
  const samples = new Float32Array(rate * 2);
  for (const start of [0.2, 0.7, 1.2]) {
    for (let i = 0; i < rate * 0.12; i++) samples[Math.floor(start * rate) + i] = 0.6 * Math.exp(-i / (rate * 0.03)) * Math.sin(2 * Math.PI * frequency * i / rate);
  }
  return samples;
}
for (const [frequency, label] of [[100, "kick"], [1200, "snare"], [6000, "closed_hat"]] as const) {
  test(`separates three ${label} attacks and refines their onsets`, () => {
    const hits = analyzeTake(fixture(frequency), 16000);
    assert.equal(hits.length, 3);
    assert.ok(Math.abs(hits[0].onset_seconds - 0.2) < 0.015);
    assert.deepEqual(hits.map(hit => hit.instrument), [label, label, label]);
    assert.ok(hits.every(hit => Number.isFinite(hit.features.body_low)));
  });
}
test("silence and quiet background produce no hits", () => {
  assert.deepEqual(analyzeTake(new Float32Array(16000), 16000), []);
  assert.deepEqual(analyzeTake(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i) * 0.0001), 16000), []);
});

function addPulse(samples: Float32Array, rate: number, start: number, amplitude: number, frequency = 120) {
  for (let i = 0; i < rate * 0.1; i++) {
    samples[Math.round(start * rate) + i] += amplitude * Math.exp(-i / (rate * 0.02)) * Math.sin(2 * Math.PI * frequency * i / rate);
  }
}
test("a loud spoken prefix does not suppress a later quiet hit", () => {
  const rate = 44100;
  const samples = new Float32Array(rate * 2);
  addPulse(samples, rate, 1, 0.03, 1200);
  assert.equal(analyzeTake(samples, rate).length, 1);
  addPulse(samples, rate, 0.2, 0.8);
  assert.deepEqual(analyzeTake(samples, rate).map(hit => Math.round(hit.onset_seconds * 100)), [20, 100]);
});
test("a volume swell inside one sustained vocalization is not another kick", () => {
  const rate = 44100;
  const samples = new Float32Array(rate * 2);
  for (let i = 0; i < rate * 0.5; i++) {
    const t = i / rate;
    const amplitude = (0.04 + 0.12 * Math.exp(-Math.pow((t - 0.04) / 0.025, 2)) + 0.12 * Math.exp(-Math.pow((t - 0.24) / 0.025, 2))) * Math.min(1, t / 0.005) * Math.min(1, (0.5 - t) / 0.01);
    samples[Math.round(0.3 * rate) + i] = amplitude * Math.sin(2 * Math.PI * 120 * t);
  }
  assert.equal(analyzeTake(samples, rate).length, 1);
});
test("small bumps in audible kick and snare tails do not rearm detection", () => {
  const rate = 44100;
  const envelope = [[0, 0], [0.01, 0.25], [0.04, 0.25], [0.08, 0.04], [0.10, 0.04], [0.11, 0.06], [0.18, 0]];
  for (const frequency of [120, 1200]) {
    const samples = new Float32Array(rate);
    let segment = 0;
    for (let i = 0; i < rate * 0.18; i++) {
      const time = i / rate;
      while (segment < envelope.length - 2 && time > envelope[segment + 1][0]) segment++;
      const [start, from] = envelope[segment];
      const [end, to] = envelope[segment + 1];
      const amplitude = from + (to - from) * (time - start) / (end - start);
      samples[Math.round(rate * 0.2) + i] = amplitude * Math.sin(2 * Math.PI * frequency * time);
    }
    assert.equal(analyzeTake(samples, rate).length, 1, `frequency ${frequency}`);
  }
});
test("distinct fast double kicks survive at multiple sample rates", () => {
  for (const rate of [16000, 44100, 48000]) {
    const samples = new Float32Array(rate);
    addPulse(samples, rate, 0.2, 0.3);
    addPulse(samples, rate, 0.325, 0.3);
    const hits = analyzeTake(samples, rate);
    assert.equal(hits.length, 2);
    assert.ok(Math.abs(hits[1].onset_seconds - 0.325) < 0.015);
  }
});
test("body classification covers the requested duration consistently across sample rates", () => {
  const features = [16000, 44100, 48000].map(rate => {
    const samples = new Float32Array(rate);
    for (let i = 0; i < rate * 0.1; i++) {
      const t = i / rate;
      // Low attack and early body, then a mid-frequency body after 45 ms.
      samples[Math.round(0.2 * rate) + i] = 0.3 * Math.sin(2 * Math.PI * (t < 0.045 ? 120 : 1200) * t);
    }
    return analyzeTake(samples, rate)[0].features;
  });
  assert.ok(features.every(feature => feature.body_mid > 0.65));
  assert.ok(Math.max(...features.map(feature => feature.body_mid)) - Math.min(...features.map(feature => feature.body_mid)) < 0.08);
});
test("a distinct kick can interrupt the decaying tail of the previous kick", () => {
  const rate = 44100;
  for (const gap of [0.065, 0.08, 0.1]) {
    const samples = new Float32Array(rate);
    for (const start of [0.2, 0.2 + gap]) {
      for (let i = 0; i < rate * 0.25; i++) {
        samples[Math.round(start * rate) + i] += 0.3 * Math.exp(-i / (rate * 0.06)) * Math.sin(2 * Math.PI * 120 * i / rate);
      }
    }
    const hits = analyzeTake(samples, rate);
    assert.equal(hits.length, 2, `gap ${gap}`);
    assert.ok(Math.abs(hits[1].onset_seconds - (0.2 + gap)) < 0.015);
  }
});
test("quieter fast kicks survive the preceding kick's decay", () => {
  const rate = 44100;
  for (const [gap, amplitude] of [[0.15, 0.12], [0.125, 0.08]]) {
    const samples = new Float32Array(rate);
    for (const [start, level] of [[0.2, 0.3], [0.2 + gap, amplitude]]) {
      for (let i = 0; i < rate * 0.25; i++) samples[Math.round(start * rate) + i] += level * Math.exp(-i / (rate * 0.06)) * Math.sin(2 * Math.PI * 120 * i / rate);
    }
    assert.equal(analyzeTake(samples, rate).length, 2, `gap ${gap}, amplitude ${amplitude}`);
  }
});
test("a rounder kick after silence is not a tail of the preceding clickier kick", () => {
  const rate = 44100;
  const samples = new Float32Array(rate);
  addPulse(samples, rate, 0.2, 0.3);
  addPulse(samples, rate, 0.4, 0.3);
  for (let i = 0; i < rate * 0.025; i++) samples[Math.round(0.2 * rate) + i] += 0.15 * Math.exp(-i / (rate * 0.01)) * Math.sin(2 * Math.PI * 1200 * i / rate);
  assert.deepEqual(analyzeTake(samples, rate).map(hit => [Math.round(hit.onset_seconds * 100), hit.instrument]), [[20, "kick"], [40, "kick"]]);
});
