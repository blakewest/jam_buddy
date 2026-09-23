import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Import the browser player with its URL imports resolved for Node.
const source = (await readFile(new URL("../src/frontend/pattern/audio.js", import.meta.url), "utf8"))
  .replaceAll('"/core/pattern/audio-schedule.js"', JSON.stringify(new URL("../src/core/pattern/audio-schedule.js", import.meta.url).href))
  .replaceAll('"/core/pattern/kits.js"', JSON.stringify(new URL("../src/core/pattern/kits.js", import.meta.url).href));
const { createPatternPlayer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const pattern = kit => ({ kit_id: kit, bars: 1, slots_per_bar: 16, notes: [1, 16].map((slot, index) => ({ id: `note_${index + 1}`, instrument: "kick", slot, bar: 1, velocity_layer: 4 })) });

function harness(t, fetchOverride) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const hits = [];
  const stops = [];
  const fetched = [];
  let tick;
  let context;
  class AudioContext {
    currentTime = 0;
    destination = {};
    constructor() { context = this; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { connect(gain) { this.output = gain; }, start(time) { hits.push({ time, url: this.buffer.url, gain: this.output.gain.value }); }, stop(time) { stops.push({ time, url: this.buffer?.url }); } }; }
    async decodeAudioData(url) { return { url }; }
    async resume() {}
  }
  globalThis.window = { AudioContext, setInterval(fn) { tick = fn; return 1; }, clearInterval() {} };
  globalThis.fetch = async url => {
    fetched.push(url);
    if (fetchOverride) await fetchOverride(url);
    return { ok: true, arrayBuffer: async () => url };
  };
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch; });
  return { hits, stops, fetched, tick: time => { context.currentTime = time; tick(); } };
}

test("one scheduling window keeps old-kit hits before and new-kit hits after the boundary", async t => {
  const h = harness(t);
  const player = createPatternPlayer();
  await player.start(pattern("acoustic"));
  await player.load("tr_808");
  player.stage(pattern("tr_808"));
  h.tick(1.97);
  const oldHit = h.hits.find(hit => hit.time > 1 && hit.time < 2.05);
  const newHit = h.hits.find(hit => Math.abs(hit.time - 2.05) < 0.001);
  assert.match(oldHit.url, /osdk/);
  assert.match(newHit.url, /tr_808/);
  assert.ok(newHit.gain < oldHit.gain);
  const count = h.fetched.length;
  await player.load("tr_808");
  assert.equal(h.fetched.length, count);
  player.stop();
});

test("stop during kit loading prevents an asynchronous start", async t => {
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
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
  const h = harness(t, url => { if (fail && url.includes("tr_505/snare")) throw new Error("offline"); });
  const player = createPatternPlayer();
  await player.start(pattern("acoustic"));
  await assert.rejects(player.load("tr_505"), /offline/);
  assert.equal(player.isPlaying(), true);
  fail = false;
  await player.load("tr_505");
  player.stage(pattern("tr_505"));
  h.tick(1.97);
  assert.ok(h.hits.some(hit => hit.url.includes("tr_505")));
  player.stop();
});


test("closed hats choke an old-kit open hat across a kit boundary", async t => {
  const h = harness(t);
  const player = createPatternPlayer();
  const active = { ...pattern("tr_808"), notes: [{ id: "note_1", instrument: "open_hat", slot: 16, bar: 1, velocity_layer: 4 }] };
  const next = { ...pattern("tr_505"), notes: [{ id: "note_2", instrument: "closed_hat", slot: 1, bar: 1, velocity_layer: 4 }] };
  await player.start(active);
  await player.load("tr_505");
  player.stage(next);
  h.tick(1.97);
  assert.ok(h.stops.some(stop => stop.url.includes("tr_808/open_hat") && Math.abs(stop.time - 2.06) < 0.001));
  assert.ok(h.hits.some(hit => hit.url.includes("tr_505/closed_hat") && Math.abs(hit.time - 2.05) < 0.001));
  player.stop();
});
