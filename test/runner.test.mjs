import test from "node:test";
import assert from "node:assert/strict";
import { createRun } from "../src/core/timing/runner.js";
import { makeFixture, CONFIG } from "../src/core/timing/session.js";

function fakeAudio() {
  return { time: 0, piano: [], drums: [], stops: 0, start: async () => {}, nowMs() { return this.time; }, schedulePiano(e) { this.piano.push(e); }, scheduleDrum(e) { this.drums.push(e); }, stopDrums() { this.stops++; }, stopAll() {}, isRunning: () => true };
}

test("slow decisions do not queue and stopping invalidates late answers", async () => {
  const audio = fakeAudio();
  let resolve, calls = 0;
  const run = createRun({ mode: "live", audio, autoTimers: false, requestDecision: () => { calls++; return new Promise(done => { resolve = done; }); } });
  await run.start();
  audio.time = 4100;
  const pending = run.poll();
  audio.time = 4200;
  await run.poll();
  run.tick();
  assert.equal(calls, 1);
  assert.equal(run.recording.skipped_ticks, 1);
  assert.ok(audio.piano.length > 0);
  run.stop();
  resolve({ answer: { choice: "start_next_bar" }, model: "test" });
  await pending;
  assert.equal(run.recording.actions.length, 0);
});

test("replay schedules recorded intervals and makes no decisions", async () => {
  const audio = fakeAudio();
  const recording = { version: 1, mode: "live", duration_ms: 16000, config: CONFIG, fixture: makeFixture(), requests: [], actions: [
    { action: "start_next_bar", received_ms: 5200, effective_ms: 6000 },
    { action: "stop", received_ms: 7300, effective_ms: 7300 },
    { action: "start_next_bar", received_ms: 8100, effective_ms: 10000 },
    { action: "stop", received_ms: 8500, effective_ms: 8500 },
  ] };
  const run = createRun({ mode: "replay", audio, recording, autoTimers: false, requestDecision: () => { throw new Error("Replay must not call the API"); } });
  await run.start();
  for (let time = 0; time <= 16000; time += 25) { audio.time = time; run.tick(); await run.poll(); }
  assert.ok(audio.drums.some(hit => hit.time_ms === 6000 && hit.instrument === "kick"));
  assert.ok(audio.drums.every(hit => hit.time_ms >= 6000 && hit.time_ms < 7300));
  assert.equal(run.active, false);
});

test("mock run reveals real-time snapshots and records starts/stops", async () => {
  const audio = fakeAudio();
  const run = createRun({ mode: "mock", audio, autoTimers: false });
  await run.start();
  for (let time = 0; time <= 16000; time += 25) {
    audio.time = time; run.tick();
    if (time % 100 === 0) await run.poll();
  }
  assert.ok(run.recording.actions.some(a => a.action === "start_next_bar" && a.effective_ms === 6000));
  assert.ok(run.recording.actions.some(a => a.action === "stop"));
  assert.ok(run.recording.requests.every(row => row.state.piano.recent_events.every(e => e.time_ms <= row.snapshot_ms)));
  run.stop();
});

test("transient upstream 503 preserves playback and retries fresh state after backoff", async () => {
  const audio = fakeAudio();
  let calls = 0;
  const run = createRun({ mode: "live", audio, autoTimers: false, requestDecision: async () => { calls++; const error = new Error("Temporary outage"); error.status = 503; throw error; } });
  await run.start();
  await run.poll();
  assert.equal(run.active, true);
  audio.time = 500; await run.poll();
  assert.equal(calls, 1);
  audio.time = 1100; await run.poll();
  assert.equal(calls, 2);
  run.stop();
});

test("a transient rate limit respects retry-after without queuing snapshots", async () => {
  const audio = fakeAudio();
  const seen = [];
  const run = createRun({ mode: "live", audio, autoTimers: false, requestDecision: async state => {
    seen.push(state);
    if (seen.length === 1) { const error = new Error("Rate limited"); error.status = 429; error.retryMs = 3000; throw error; }
    return { answer: { type: "choice", choice: "keep_current" }, model: "test" };
  } });
  await run.start(); await run.poll();
  audio.time = 2000; await run.poll();
  assert.equal(seen.length, 1);
  assert.equal(run.recording.backoff_ticks, 1);
  assert.equal(run.recording.skipped_ticks, 0);
  audio.time = 4100; await run.poll();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].piano.recent_events.length, 3);
  run.stop();
});
