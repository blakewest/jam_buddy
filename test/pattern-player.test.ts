import test from "node:test";
import assert from "node:assert/strict";
import { createPatternPlayer } from "../src/frontend/pattern/audio.js";

const pattern = (notes: any) => ({ bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes });
const note = (id: string, instrument: import("../src/core/pattern/state.js").Instrument, midi_pitch: number) => ({ id, instrument, midi_pitch, bar: 1, tick: 0, velocity: 80 });

function deferred() {
  let resolve!: (value?: Response) => void;
  const promise = new Promise<Response>(done => { resolve = value => done(value!); });
  return { promise, resolve };
}

function fakeAudio() {
  const param = (value: number) => ({ value, setValueAtTime(next: number) { this.value = next; }, cancelScheduledValues() {} });
  const oldWindow = globalThis.window;
  const oldFetch = globalThis.fetch;
  const requested: any[] = [];
  const starts: any[] = [];
  let context: any;
  let tick: () => void;
  const manifest = { families: { kick: ["kick-layer-1.wav", "kick-layer-2.wav"], snare_side: ["snare_side-layer-1.wav"] } };
  globalThis.window = {
    AudioContext: class {
      constructor() { context = this; }
      currentTime = 0;
      destination = {};
      createGain() { return { gain: param(0), connect() {}, disconnect() {} }; }
      createBiquadFilter() { return { type: "", frequency: param(0), gain: param(0), connect() {} }; }
      createDynamicsCompressor() { return { threshold: param(0), ratio: param(1), attack: param(0), release: param(0), connect() {} }; }
      createBufferSource() { return { connect() {}, start(time: number) { starts.push(time); }, stop() {} }; }
      decodeAudioData() { return Promise.resolve({}); }
      resume() { return Promise.resolve(); }
    },
    setInterval(callback: any) { tick = callback; return 1; },
    clearInterval() {},
  } as unknown as Window & typeof globalThis;
  globalThis.fetch = async input => {
    const path = String(input);
    requested.push(path);
    if (path.endsWith("manifest.json")) return Response.json(manifest);
    if (path.includes("snare_side")) return new Response(null, { status: 404 });
    return new Response(new ArrayBuffer(8));
  };
  return { requested, starts, advance(time: number) { context.currentTime = time; tick(); }, restore() { globalThis.window = oldWindow; globalThis.fetch = oldFetch; } };
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
    const requested = deferred();
    const response = deferred();
    globalThis.fetch = () => { requested.resolve(); return response.promise; };
    const staging = player.stage(pattern([{ ...note("side", "snare", 37), tick: 960 }]), 120);
    await requested.promise;
    player.setTempo(90);
    response.resolve(new Response(new ArrayBuffer(8)));
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
