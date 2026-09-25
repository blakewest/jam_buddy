import test from "node:test";
import assert from "node:assert/strict";
import { createDemoStudio } from "../src/frontend/pattern/demo.js";
import { DemoJournal } from "../src/core/demo/recording.js";
import type { DemoView } from "../src/core/demo/recording.js";
import { createPatternState } from "../src/core/pattern/state.js";

const view = (): DemoView => ({ state: createPatternState(), pending_state: null, selection: null, activity: [], request: "", request_status: "Ready", playback_status: "Stopped", playing: false, volume: .8, capturing: false });
function harness(t: test.TestContext, authoring = true) {
  let recorder: FakeRecorder;
  let audio: FakeAudio;
  let frame: () => void;
  let disconnected = 0, stoppedTracks = 0, restored = 0;
  const completions: boolean[] = [];
  let rejectPlay = false;
  let silenceStarted = 0, silenceStopped = 0;
  const frames: DemoView[] = [], hits: string[] = [];
  const original = { MediaRecorder: globalThis.MediaRecorder, Audio: globalThis.Audio, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, fetch: globalThis.fetch };
  class FakeRecorder {
    static isTypeSupported() { return true; }
    mimeType = "audio/webm;codecs=opus";
    state = "inactive";
    onstart = () => {}; onstop = () => {}; onerror = () => {};
    ondataavailable = (_: { data: Blob }) => {};
    constructor() { recorder = this; }
    start() { this.state = "recording"; queueMicrotask(() => this.onstart()); }
    stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable({ data: new Blob(["recorded mix"]) }); this.onstop(); }); }
  }
  class FakeAudio {
    currentTime = 0;
    onended: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor() { audio = this; }
    async play() { if (rejectPlay) throw new Error("Playback blocked"); }
    pause() {} removeAttribute() {} load() {}
  }
  globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
  globalThis.requestAnimationFrame = callback => { frame = () => callback(0); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.fetch = async () => { throw new Error("Replay must not call the network"); };
  const destination = { stream: { getTracks: () => [{ stop() { stoppedTracks++; } }] } };
  const studio = createDemoStudio({
    authoring,
    context: async () => ({ createMediaStreamDestination: () => destination,
      createConstantSource: () => ({ offset: { value: 1 }, connect(node: unknown) { assert.equal(node, destination); assert.equal(this.offset.value, 0); },
        start() { silenceStarted++; }, stop() { silenceStopped++; }, disconnect() {} }),
    }) as unknown as AudioContext,
    connectOutput: node => { assert.equal(node, destination); return () => { disconnected++; }; },
    view, onChange() {}, onReplayView: value => frames.push(value), onReplayHit: value => hits.push(value), onReplayEnd: completed => { restored++; completions.push(completed); },
  });
  t.after(() => { studio.stopReplay(); Object.assign(globalThis, original); });
  return { studio, frames, hits, completions, destination, disconnected: () => disconnected, stoppedTracks: () => stoppedTracks, restored: () => restored,
    silenceStarted: () => silenceStarted, silenceStopped: () => silenceStopped,
    advance(time: number) { audio.currentTime = time; frame(); }, ended() { audio.onended?.(); }, rejectPlay() { rejectPlay = true; } };
}

test("demo recording captures the mix, finalizes audio and releases its private audio route", async t => {
  const h = harness(t);
  assert.equal(h.studio.microphoneDestination(), undefined);
  await h.studio.start();
  assert.equal(h.studio.isRecording(), true);
  assert.equal(h.studio.microphoneDestination(), h.destination);
  assert.equal(h.silenceStarted(), 1);
  assert.equal(h.silenceStopped(), 0);
  await h.studio.finish();
  assert.equal(h.studio.isRecording(), false);
  assert.equal(h.studio.hasSaved(), true);
  assert.equal(h.studio.microphoneDestination(), undefined);
  assert.equal(h.disconnected(), 1);
  assert.equal(h.stoppedTracks(), 1);
  assert.equal(h.silenceStopped(), 1);
});

test("public demo mode loads the bundled performance and cannot record or import", async t => {
  const h = harness(t, false);
  const file = new DemoJournal(view(), 0).finish({ mime_type: "audio/webm", base64: "AQID" }, 1000);
  globalThis.fetch = async url => {
    assert.equal(url, "/assets/demo/featured.json");
    return Response.json(file);
  };
  await h.studio.start();
  assert.equal(h.silenceStarted(), 0);
  await h.studio.loadFile(new File(["invalid"], "custom.json"));
  assert.equal(h.studio.hasSaved(), false);
  await h.studio.restore();
  assert.equal(h.studio.hasSaved(), true);
  await h.studio.play();
  assert.equal(h.studio.isReplaying(), true);
});

test("saved replay makes no network calls, follows the audio clock, and restores on finish or stop", async t => {
  const h = harness(t);
  const journal = new DemoJournal(view(), 0);
  const after = view(); after.request = "Add hats";
  journal.view(after, 500); journal.hit("snare", 700);
  const file = journal.finish({ mime_type: "audio/webm", base64: "AQID" }, 1000);
  await h.studio.loadFile(new File([JSON.stringify(file)], "demo.json"));
  await h.studio.play();
  h.advance(.6);
  assert.equal(h.frames.at(-1)?.request, "Add hats");
  assert.deepEqual(h.hits, []);
  h.advance(.7); h.advance(.8);
  assert.deepEqual(h.hits, ["snare"]);
  h.ended();
  assert.equal(h.studio.isReplaying(), false);
  assert.equal(h.restored(), 1);
  await h.studio.play(); h.advance(.7); h.studio.stopReplay();
  assert.deepEqual(h.hits, ["snare", "snare"]);
  assert.equal(h.restored(), 2);
  assert.deepEqual(h.completions, [true, false]);
});

test("rejected audio playback releases replay mode and restores the working view", async t => {
  const h = harness(t);
  const file = new DemoJournal(view(), 0).finish({ mime_type: "audio/webm", base64: "AQID" }, 1000);
  await h.studio.loadFile(new File([JSON.stringify(file)], "demo.json"));
  h.rejectPlay(); await h.studio.play();
  assert.equal(h.studio.isReplaying(), false);
  assert.equal(h.studio.isBusy(), false);
  assert.equal(h.restored(), 1);
  assert.match(h.studio.message(), /Playback blocked/);
  assert.deepEqual(h.completions, [false]);
});

test("replay previews queued notes before the recorded audio switch", async t => {
  const h = harness(t);
  const initial = view(); initial.playing = true;
  const journal = new DemoJournal(initial, 0);
  const queued = structuredClone(initial);
  queued.pending_state = createPatternState({ notes: [{ id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 100 }] });
  queued.request_status = "Accepted changes are waiting for the next beat.";
  journal.view(queued, 500);
  const applied = { ...queued, state: queued.pending_state, pending_state: null, request_status: "Changes are now playing." };
  journal.view(applied, 900);
  const file = journal.finish({ mime_type: "audio/webm", base64: "AQID" }, 1200);
  await h.studio.loadFile(new File([JSON.stringify(file)], "existing-demo.json"));
  const displayedNotes = () => {
    const current = h.frames.at(-1)!;
    return (current.pending_state ?? current.state).pattern.notes;
  };
  await h.studio.play();
  h.advance(.499);
  assert.equal(displayedNotes().length, 0);
  h.advance(.5);
  assert.equal(displayedNotes().length, 1);
  assert.equal(h.frames.at(-1)?.state.pattern.notes.length, 0);
  h.advance(.899);
  assert.equal(displayedNotes().length, 1);
  assert.equal(h.frames.at(-1)?.state.pattern.notes.length, 0);
  h.advance(.9);
  assert.equal(displayedNotes().length, 1);
  assert.equal(h.frames.at(-1)?.state.pattern.notes.length, 1);
  assert.equal(h.frames.at(-1)?.pending_state, null);
  assert.equal(file.frames[1].view.pending_state?.pattern.notes.length, 1);
});
