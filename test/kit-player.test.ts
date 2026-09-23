import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Pattern } from "../src/core/pattern/state.js";
import { createPatternPlayer } from "../src/frontend/pattern/audio.js";

const pattern = (kit: string): Pattern => ({ kit_id: kit, bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes: [1, 16].map((slot, index) => ({ id: `note_${index + 1}`, instrument: "kick", tick: (slot - 1) * 240, bar: 1, velocity: 96 })) });

function harness(t: TestContext, fetchOverride?: (url: string) => unknown) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const hits: { time: number; url: string; gain: number }[] = [];
  const stops: { time?: number; url: string }[] = [];
  const fetched: string[] = [];
  let tick: () => void;
  let context: AudioContext;
  class AudioContext {
    currentTime = 0;
    destination = {};
    constructor() { context = this; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { buffer: { url: "" }, output: { gain: { value: 1 } }, connect(gain: { gain: { value: number } }) { this.output = gain; }, start(time: number) { hits.push({ time, url: this.buffer.url, gain: this.output.gain.value }); }, stop(time?: number) { stops.push({ time, url: this.buffer?.url }); } }; }
    async decodeAudioData(url: string) { return { url }; }
    async resume() {}
  }
  globalThis.window = { AudioContext, setInterval(fn: () => void) { tick = fn; return 1; }, clearInterval() {} } as unknown as Window & typeof globalThis;
  globalThis.fetch = async url => {
    const path = String(url);
    fetched.push(path);
    if (fetchOverride) await fetchOverride(path);
    if (path.endsWith("manifest.json")) return Response.json({ families: { kick: ["kick.wav"], hat_open: ["open.wav"], hat_closed: ["closed.wav"] } });
    // Minimal fetch/audio mocks carry the sample URL through decoding.
    return { ok: true, arrayBuffer: async () => path } as unknown as Response;
  };
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch; });
  return { hits, stops, fetched, tick: (time: number) => { context.currentTime = time; tick(); } };
}

test("one scheduling window keeps old-kit hits before and new-kit hits after the boundary", async t => {
  const h = harness(t);
  const player = createPatternPlayer();
  await player.start(pattern("acoustic"));
  await player.load(pattern("tr_808"));
  await player.stage(pattern("tr_808"));
  h.tick(1.97);
  const oldHit = h.hits.find(hit => hit.time > 1 && hit.time < 2.05);
  const newHit = h.hits.find(hit => Math.abs(hit.time - 2.05) < 0.001);
  assert.ok(oldHit && newHit);
  assert.match(oldHit.url, /virtuosity/);
  assert.match(newHit.url, /tr_808/);
  assert.ok(newHit.gain < oldHit.gain);
  const count = h.fetched.length;
  await player.load(pattern("tr_808"));
  assert.equal(h.fetched.length, count);
  player.stop();
});

test("stop during kit loading prevents an asynchronous start", async t => {
  let release!: () => void;
  const deferred = new Promise<void>(resolve => { release = resolve; });
  harness(t, () => deferred);
  const player = createPatternPlayer();
  const starting = player.start(pattern("tr_505"));
  player.stop();
  release();
  assert.equal(await starting, false);
  assert.equal(player.isPlaying(), false);
});

test("a failed kit load leaves playback intact and can be retried", async t => {
  let fail = true;
  const h = harness(t, url => { if (fail && url.includes("tr_505/kick")) throw new Error("offline"); });
  const player = createPatternPlayer();
  await player.start(pattern("acoustic"));
  await assert.rejects(player.load(pattern("tr_505")), /offline/);
  assert.equal(player.isPlaying(), true);
  fail = false;
  await player.load(pattern("tr_505"));
  await player.stage(pattern("tr_505"));
  h.tick(1.97);
  assert.ok(h.hits.some(hit => hit.url.includes("tr_505")));
  player.stop();
});


test("closed hats choke an old-kit open hat across a kit boundary", async t => {
  const h = harness(t);
  const player = createPatternPlayer();
  const active: Pattern = { ...pattern("tr_808"), notes: [{ id: "note_1", instrument: "open_hat", tick: 3600, bar: 1, velocity: 96 }] };
  const next: Pattern = { ...pattern("tr_505"), notes: [{ id: "note_2", instrument: "closed_hat", tick: 0, bar: 1, velocity: 96 }] };
  await player.start(active);
  await player.load(next);
  await player.stage(next);
  h.tick(1.97);
  assert.ok(h.stops.some(stop => stop.url.includes("tr_808/open_hat") && Math.abs((stop.time ?? Infinity) - 2.06) < 0.001));
  assert.ok(h.hits.some(hit => hit.url.includes("tr_505/closed_hat") && Math.abs(hit.time - 2.05) < 0.001));
  player.stop();
});
