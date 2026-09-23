import test from "node:test";
import assert from "node:assert/strict";
import { createPatternPlayer } from "../src/frontend/pattern/audio.js";

const pattern = notes => ({ bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes });
const note = (id, instrument, midi_pitch) => ({ id, instrument, midi_pitch, bar: 1, tick: 0, velocity: 80 });

function fakeAudio() {
  const oldWindow = globalThis.window;
  const oldFetch = globalThis.fetch;
  const requested = [];
  const starts = [];
  let context;
  let tick;
  const manifest = { families: { kick: ["kick-layer-1.wav", "kick-layer-2.wav"], snare_side: ["snare_side-layer-1.wav"] } };
  globalThis.window = {
    AudioContext: class {
      constructor() { context = this; }
      currentTime = 0;
      destination = {};
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
      createBufferSource() { return { connect() {}, start(time) { starts.push(time); }, stop() {} }; }
      decodeAudioData() { return Promise.resolve({}); }
      resume() { return Promise.resolve(); }
    },
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() {},
  };
  globalThis.fetch = async path => {
    requested.push(path);
    if (path.endsWith("manifest.json")) return { ok: true, json: async () => manifest };
    if (path.includes("snare_side")) return { ok: false };
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  return { requested, starts, advance(time) { context.currentTime = time; tick(); }, restore() { globalThis.window = oldWindow; globalThis.fetch = oldFetch; } };
}

test("player fetches only samples used by the current pattern", async () => {
  const fake = fakeAudio();
  try {
    const player = createPatternPlayer();
    await player.start(pattern([note("kick", "kick", 36)]));
    assert.deepEqual(fake.requested, ["/assets/virtuosity/manifest.json", "/assets/virtuosity/kick-layer-2.wav"]);
    player.stop();
  } finally { fake.restore(); }
});

test("failed sample load leaves the current pattern playing", async () => {
  const fake = fakeAudio();
  try {
    const player = createPatternPlayer();
    await player.start(pattern([note("kick", "kick", 36)]));
    await assert.rejects(player.stage(pattern([note("side", "snare", 37)])));
    assert.equal(player.isPlaying(), true);
    assert.equal(player.hasPendingPattern(), false);
    player.stop();
  } finally { fake.restore(); }
});

test("tempo changed during sample loading applies to the staged pattern", async () => {
  const fake = fakeAudio();
  try {
    const player = createPatternPlayer();
    await player.start(pattern([note("kick", "kick", 36)]), 120);
    const requested = Promise.withResolvers();
    const response = Promise.withResolvers();
    globalThis.fetch = () => { requested.resolve(); return response.promise; };
    const staging = player.stage(pattern([{ ...note("side", "snare", 37), tick: 960 }]), 120);
    await requested.promise;
    player.setTempo(90);
    response.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    await staging;
    fake.advance(2.0);
    fake.advance(2.5);
    fake.advance(2.65);
    assert.equal(fake.starts.length, 2);
    assert.ok(Math.abs(fake.starts[1] - 2.7166666667) < 0.000001);
    player.stop();
  } finally { fake.restore(); }
});

test("stopping during sample loading prevents a late playback start", async () => {
  const fake = fakeAudio();
  try {
    const player = createPatternPlayer();
    const starting = player.start(pattern([note("kick", "kick", 36)]));
    player.stop();
    await starting;
    assert.equal(player.isPlaying(), false);
    assert.deepEqual(fake.starts, []);
  } finally { fake.restore(); }
});
