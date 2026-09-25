import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { DemoJournal, DemoTimeline, parseDemo, bytesToBase64, base64ToBytes } from "../src/core/demo/recording.js";
import type { DemoView } from "../src/core/demo/recording.js";

const view = (): DemoView => ({ state: createPatternState(), pending_state: null, selection: null, activity: [], request: "", request_status: "Ready", playback_status: "Stopped", playing: false, volume: .8, capturing: false });
const audio = { mime_type: "audio/webm;codecs=opus", base64: "AQID" };

test("recorded preset loads round trip regardless of object property order", () => {
  const loaded = view();
  loaded.state = loadPreset(loaded.state, presetById("simple_kick_snare"), "give me a kick and snare");
  const journal = new DemoJournal(loaded, 0);
  const saved = parseDemo(JSON.stringify(journal.finish(audio, 1000)));
  assert.equal(saved.frames[0].view.state.pattern.notes.length, 4);
});

test("demo saves independent views, complete input audio and responses at their original times", () => {
  const journal = new DemoJournal(view(), 1000);
  const changed = view(); changed.state.pattern.notes.push({ id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 100 });
  journal.view(changed, 1500);
  journal.view(changed, 1600); // Unchanged UI does not grow the recording.
  journal.hit("kick", 1700);
  journal.take({ id: "take_1", at_ms: 100, duration_ms: 200, audio: { mime_type: "audio/wav", base64: "AQID" }, transcript: { text: "give me a kick", words: [] } });
  journal.call({ at_ms: 450, path: "/api/request-decision", status: 200, request: { request: "give me a kick" }, response: { answers: { selection: "load_preset" } } });
  changed.state.pattern.notes[0].velocity = 1;
  const saved = parseDemo(JSON.stringify(journal.finish(audio, 2000)));
  assert.equal(saved.duration_ms, 1000);
  assert.equal(saved.frames.length, 2);
  assert.equal(saved.frames[1].view.state.pattern.notes[0].velocity, 100);
  assert.equal(saved.takes[0].transcript?.text, "give me a kick");
  assert.deepEqual(saved.calls[0].response, { answers: { selection: "load_preset" } });
  assert.deepEqual(saved.audio, audio);
});

test("replay uses only elapsed recorded events, plays each hit once, and can restart", () => {
  const journal = new DemoJournal(view(), 0);
  const changed = view(); changed.request = "Add hats";
  journal.view(changed, 500); journal.hit("snare", 700);
  const timeline = new DemoTimeline(journal.finish(audio, 1000));
  assert.equal(timeline.advance(499).view.request, "");
  assert.equal(timeline.advance(500).view.request, "Add hats");
  assert.deepEqual(timeline.advance(700).hits, ["snare"]);
  assert.deepEqual(timeline.advance(800).hits, []);
  assert.equal(timeline.advance(0).view.request, "");
  assert.deepEqual(timeline.advance(700).hits, ["snare"]);
});

test("demo file rejects unsupported formats, future events and unsafe audio URLs", () => {
  const file = new DemoJournal(view(), 0).finish(audio, 1000);
  for (const invalid of [
    { ...file, version: 2 },
    { ...file, duration_ms: -1 },
    { ...file, frames: [] },
    { ...file, hits: [{ at_ms: 1001, instrument: "kick" }] },
    { ...file, audio: { mime_type: "text/html", base64: "AQID" } },
    { ...file, audio: { mime_type: "audio/webm", base64: "https://example.com/audio" } },
    { ...file, frames: [{ at_ms: 0, view: { ...view(), activity: [{ request: "x", steps: 3, actions: [] }] } }] },
  ]) assert.throws(() => parseDemo(JSON.stringify(invalid)), /demo/i);
});

test("audio encoding preserves every byte, including buffers larger than argument limits", () => {
  const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => index % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
