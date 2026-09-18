import test from "node:test";
import assert from "node:assert/strict";
import { createSession, advanceSession, buildState, ingestEvent, applyDecision, makeRequest, expectedAction, summarize, validateRecording, makeFixture } from "../public/session.js";

test("fixture reveals only elapsed events and repeats on the shared timeline", () => {
  const s = createSession("a");
  advanceSession(s, 3900);
  assert.deepEqual(buildState(s, 3900).piano, { recent_events: [], silent_for_ms: 3900 });
  advanceSession(s, 4100);
  assert.equal(buildState(s, 4100).piano.recent_events.length, 3);
  assert.ok(buildState(s, 4100).piano.recent_events.every(e => e.time_ms <= 4100));
  advanceSession(s, 20100);
  assert.ok(buildState(s, 20100).piano.recent_events.some(e => e.time_ms === 20000));
});

test("pedal, velocity-zero release and history eviction preserve silence bookkeeping", () => {
  const s = createSession("a", []);
  ingestEvent(s, { time_ms: 0, type: "note_on", note: 60, velocity: 90 });
  ingestEvent(s, { time_ms: 100, type: "sustain", value: 127 });
  ingestEvent(s, { time_ms: 200, type: "note_on", note: 60, velocity: 0 });
  assert.equal(buildState(s, 12000).piano.silent_for_ms, 0);
  assert.equal(buildState(s, 12000).piano.recent_events.length, 0);
  ingestEvent(s, { time_ms: 12500, type: "sustain", value: 0 });
  assert.equal(buildState(s, 13500).piano.silent_for_ms, 1000);
});

test("history is capped at 500 events", () => {
  const s = createSession("a", []);
  for (let i = 0; i < 600; i++) ingestEvent(s, { time_ms: i, type: "note_off", note: 60, velocity: 0 });
  assert.equal(buildState(s, 600).piano.recent_events.length, 500);
});

test("start binds to original bar, duplicates do not reschedule, stop cancels", () => {
  const s = createSession("a");
  const r = makeRequest(s, 5300, 1);
  assert.equal(r.target_bar_ms, 6000);
  assert.equal(applyDecision(s, "start_next_bar", r, 5800).effective_ms, 6000);
  assert.equal(applyDecision(s, "start_next_bar", makeRequest(s, 6100, 2), 6200).accepted, false);
  assert.equal(s.scheduledStart, 6000);
  advanceSession(s, 6200);
  assert.equal(s.drumStatus, "playing");
  assert.equal(applyDecision(s, "stop", makeRequest(s, 6250, 3), 6300).accepted, true);
  assert.equal(s.scheduledStart, null);
  assert.equal(s.drumStatus, "stopped");
});

test("late, superseded, and previous-run responses have no effect", () => {
  const s = createSession("a");
  assert.equal(applyDecision(s, "start_next_bar", makeRequest(s, 5300, 1), 5950).reason, "missed_deadline");
  assert.equal(applyDecision(s, "start_next_bar", { ...makeRequest(s, 6001, 2), run_id: "old" }, 6200).reason, "stale_run");
  applyDecision(s, "keep_current", makeRequest(s, 6100, 4), 6300);
  assert.equal(applyDecision(s, "start_next_bar", makeRequest(s, 6001, 3), 6400).reason, "stale_response");
  assert.equal(s.scheduledStart, null);
});

test("explicit policy treats the one-second boundary correctly", () => {
  const state = { piano: { recent_events: [{ type: "note_on", velocity: 80 }], silent_for_ms: 999 }, drums: { status: "stopped", scheduled_start: false } };
  assert.equal(expectedAction(state), "start_next_bar");
  state.drums.scheduled_start = true;
  assert.equal(expectedAction(state), "keep_current");
  state.piano.silent_for_ms = 1000;
  assert.equal(expectedAction(state), "stop");
});

test("metrics keep failures separate from successful durations", () => {
  const rows = [100, 200, 300, 400, 500].map(round_trip_ms => ({ round_trip_ms, response: { choice: "keep_current" }, expected: "keep_current" }));
  rows.push({ error: "timeout", round_trip_ms: 2000 });
  const m = summarize(rows);
  assert.equal(m.median, 300);
  assert.equal(m.p95, 500);
  assert.equal(m.errors, 1);
  assert.equal(m.agreement, 100);
});

test("recordings round-trip and reject invalid event/action timestamps", () => {
  const r = { version: 1, mode: "mock", duration_ms: 16000, config: { tempo_bpm: 120, beats_per_bar: 4, cycle_ms: 16000 }, fixture: makeFixture(), requests: [], actions: [{ action: "start_next_bar", effective_ms: 6000 }] };
  assert.deepEqual(validateRecording(JSON.stringify(r)), r);
  assert.throws(() => validateRecording(JSON.stringify({ ...r, version: 2 })));
  assert.throws(() => validateRecording(JSON.stringify({ ...r, actions: [{ action: "start_next_bar", effective_ms: -1 }] })));
});

test("recording imports require real decision or error rows", () => {
  const r = { version: 1, mode: "live", duration_ms: 1000, config: { tempo_bpm: 120, beats_per_bar: 4, cycle_ms: 16000 }, fixture: makeFixture(), actions: [], requests: [{ snapshot_ms: 100, received_ms: 200, round_trip_ms: 100 }] };
  assert.throws(() => validateRecording(JSON.stringify(r)));
});

test("a start exactly at the lookahead boundary is accepted", () => {
  const s = createSession("a");
  const request = makeRequest(s, 5300, 1);
  assert.equal(applyDecision(s, "start_next_bar", request, 5900).effective_ms, 6000);
  assert.equal(makeRequest(s, 6000, 2).target_bar_ms, 8000);
});
