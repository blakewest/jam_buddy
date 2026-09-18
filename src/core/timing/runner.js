import { CONFIG, makeFixture, createSession, advanceSession, buildState, makeRequest, expectedAction, applyDecision, fixtureBetween, drumWindows, drumHitsBetween } from "./session.js";

export async function requestDecision(state, signal) {
  const response = await fetch("/api/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }), signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload.code;
    const retry = response.headers.get("Retry-After");
    error.retryMs = retry ? Math.max(0, Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
    throw error;
  }
  return payload;
}

export function createRun({ mode, audio, recording: source, durationMs = 60000, requestDecision: decide = requestDecision, onUpdate = () => {}, onFinish = () => {}, autoTimers = true }) {
  const session = createSession(crypto.randomUUID(), source?.fixture ?? makeFixture());
  const recording = mode === "replay" ? source : {
    version: 1, mode, created_at: new Date().toISOString(), duration_ms: 0, config: CONFIG, fixture: session.fixture,
    environment: typeof navigator === "undefined" ? "Node test" : navigator.userAgent,
    requests: [], actions: [], skipped_ticks: 0, backoff_ticks: 0, scheduler_late_hits: 0, scheduler_max_late_ms: 0,
  };
  const duration = mode === "replay" ? recording.duration_ms : Math.min(durationMs, CONFIG.max_duration_ms);
  const replayWindows = mode === "replay" ? drumWindows(recording.actions, duration) : null;
  let active = false, cursor = 0, nextId = 0, busy = false, controller = null, currentRequest = null;
  let schedulerTimer, pollTimer, timeoutTimer, retryAt = 0, failures = 0;
  const clock = () => Math.min(duration, Math.max(0, audio.nowMs()));

  function tick() {
    if (!active) return;
    if (!audio.isRunning()) { stop("Audio paused; run ended."); return; }
    const now = clock();
    advanceSession(session, now);
    const end = Math.min(duration, now + CONFIG.lookahead_ms);
    const windows = replayWindows ?? drumWindows(recording.actions, duration);
    for (const event of fixtureBetween(session.fixture, cursor, end)) {
      if (event.type === "note_on" && event.velocity > 0) noteLateness(event.time_ms, now);
      audio.schedulePiano(event);
    }
    for (const hit of drumHitsBetween(cursor, end, windows)) {
      noteLateness(hit.time_ms, now);
      audio.scheduleDrum(hit);
    }
    cursor = end;
    if (mode !== "replay") recording.duration_ms = now;
    onUpdate({ now, session, recording, active, mode });
    if (now >= duration) stop("Run complete.");
  }

  function noteLateness(time, now) {
    if (mode !== "replay" && time < now - 1) {
      recording.scheduler_late_hits++;
      recording.scheduler_max_late_ms = Math.max(recording.scheduler_max_late_ms, now - time);
    }
  }

  async function poll() {
    if (!active || mode === "replay") return;
    if (busy) { recording.skipped_ticks++; return; }
    const now = clock();
    if (now < retryAt) { recording.backoff_ticks++; return; }
    advanceSession(session, now);
    const state = buildState(session, now);
    const row = { ...makeRequest(session, now, ++nextId), state, expected: expectedAction(state), sent_at_ms: now, request_bytes: new TextEncoder().encode(JSON.stringify({ state })).length };
    const sent = performance.now();
    busy = true;
    currentRequest = row;
    controller = new AbortController();
    try {
      let response;
      if (mode === "mock") response = { answer: { type: "choice", choice: row.expected, confidence: 1, probabilities: { [row.expected]: 1 } }, model: "deterministic-fixture-rule" };
      else {
        const timeout = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => { controller?.abort(); reject(new Error("Request timed out after 2 seconds.")); }, 2000);
        });
        response = await Promise.race([decide(state, controller.signal), timeout]);
      }
      if (!active || currentRequest !== row) return;
      const received = clock();
      advanceSession(session, received);
      row.received_ms = received;
      row.round_trip_ms = performance.now() - sent;
      row.response = response.answer;
      row.model = response.model;
      row.usage = response.usage;
      row.outcome = applyDecision(session, row.response.choice, row, received);
      if (row.outcome.accepted) {
        recording.actions.push(row.outcome);
        if (row.outcome.action === "stop") audio.stopDrums();
      }
      recording.requests.push(row);
      failures = 0;
      retryAt = 0;
    } catch (error) {
      if (!active || currentRequest !== row) return;
      row.received_ms = clock();
      row.round_trip_ms = performance.now() - sent;
      row.error = error.message;
      recording.requests.push(row);
      failures++;
      retryAt = clock() + Math.max(Math.min(8000, 1000 * 2 ** (failures - 1)), error.retryMs || 0);
      if ([401, 403].includes(error.status) || error.code === "missing_api_key") stop(`Live run ended: ${error.message}`);
    } finally {
      clearTimeout(timeoutTimer);
      busy = false;
      controller = null;
      currentRequest = null;
    }
  }

  function stop(reason = "Stopped.") {
    if (!active) return;
    active = false;
    session.active = false;
    clearInterval(schedulerTimer);
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    controller?.abort();
    if (mode !== "replay") {
      recording.duration_ms = clock();
      recording.end_reason = reason;
      // Pending calls are aborted, not fabricated as completed latency samples.
      recording.aborted_requests = currentRequest && !recording.requests.includes(currentRequest) ? 1 : 0;
    }
    audio.stopAll();
    onUpdate({ now: clock(), session, recording, active, mode });
    onFinish(recording, reason, mode);
  }

  return {
    recording, session, get active() { return active; }, tick, poll, stop,
    async start() {
      await audio.start();
      active = true;
      if (autoTimers) {
        schedulerTimer = setInterval(tick, 25);
        pollTimer = setInterval(poll, CONFIG.poll_ms);
      }
      tick();
    },
  };
}
