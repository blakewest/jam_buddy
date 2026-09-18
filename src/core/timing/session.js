export const CONFIG = Object.freeze({ tempo_bpm: 120, beats_per_bar: 4, cycle_ms: 16000, bar_ms: 2000, lookahead_ms: 100, poll_ms: 100, max_duration_ms: 600000 });
export const ACTIONS = ["start_next_bar", "stop", "keep_current"];

export function makeFixture() {
  const events = [];
  [[60, 64, 67], [60, 65, 69], [59, 62, 67], [60, 64, 67]].forEach((chord, bar) => {
    for (let beat = 0; beat < 4; beat++) {
      const time = 4000 + bar * 2000 + beat * 500;
      for (const note of chord) {
        events.push({ time_ms: time, type: "note_on", note, velocity: 78 });
        events.push({ time_ms: time + 350, type: "note_off", note, velocity: 0 });
      }
    }
  });
  return events.sort((a, b) => a.time_ms - b.time_ms);
}

export function fixtureBetween(fixture, fromMs, toMs) {
  const events = [];
  for (let cycle = Math.max(0, Math.floor(fromMs / CONFIG.cycle_ms)); cycle <= Math.floor(toMs / CONFIG.cycle_ms); cycle++) {
    for (const event of fixture) {
      const time = cycle * CONFIG.cycle_ms + event.time_ms;
      if (time >= fromMs && time < toMs) events.push({ ...event, time_ms: time });
    }
  }
  return events;
}

export function createSession(runId, fixture = makeFixture()) {
  return { runId, fixture, observedThrough: -1, history: [], pressed: new Set(), sustained: new Set(), pedal: false, silentSince: 0, drumStatus: "stopped", scheduledStart: null, lastRequest: -1, active: true };
}

export function ingestEvent(session, event) {
  session.history.push(event);
  const sounding = session.pressed.size + session.sustained.size > 0;
  if (event.type === "sustain") {
    session.pedal = event.value >= 64;
    if (!session.pedal) session.sustained.clear();
  } else if (event.type === "note_on" && event.velocity > 0) {
    session.pressed.add(event.note);
    session.sustained.delete(event.note);
  } else {
    if (session.pedal && session.pressed.has(event.note)) session.sustained.add(event.note);
    session.pressed.delete(event.note);
  }
  const nowSounding = session.pressed.size + session.sustained.size > 0;
  if (sounding && !nowSounding) session.silentSince = event.time_ms;
}

export function advanceSession(session, nowMs) {
  // Inclusive observation at now; the audio scheduler uses a separate, exclusive cursor.
  for (const event of fixtureBetween(session.fixture, Math.max(0, session.observedThrough + 0.0001), nowMs + 0.0001)) ingestEvent(session, event);
  session.observedThrough = nowMs;
  if (session.scheduledStart !== null && nowMs >= session.scheduledStart) {
    session.drumStatus = "playing";
    session.scheduledStart = null;
  }
}

export function buildState(session, nowMs) {
  session.history = session.history.filter(event => event.time_ms >= nowMs - 10000 && event.time_ms <= nowMs).slice(-500);
  return {
    piano: {
      recent_events: session.history.map(event => ({ ...event })),
      silent_for_ms: session.pressed.size + session.sustained.size ? 0 : Math.max(0, Math.floor(nowMs - session.silentSince)),
    },
    drums: { status: session.drumStatus, scheduled_start: session.scheduledStart !== null },
  };
}

export function makeRequest(session, snapshotMs, requestId) {
  return { run_id: session.runId, request_id: requestId, snapshot_ms: snapshotMs, target_bar_ms: (Math.floor(snapshotMs / CONFIG.bar_ms) + 1) * CONFIG.bar_ms };
}

export function expectedAction(state) {
  const active = state.drums.status === "playing" || state.drums.scheduled_start;
  if (state.piano.silent_for_ms >= 1000) return active ? "stop" : "keep_current";
  const hasPlayed = state.piano.recent_events.some(event => event.type === "note_on" && event.velocity > 0);
  return hasPlayed && !active ? "start_next_bar" : "keep_current";
}

export function applyDecision(session, action, request, receivedMs) {
  const reject = reason => ({ accepted: false, reason, action, received_ms: receivedMs });
  if (!session.active || request.run_id !== session.runId) return reject("stale_run");
  if (request.request_id <= session.lastRequest) return reject("stale_response");
  session.lastRequest = request.request_id;
  if (!ACTIONS.includes(action)) return reject("invalid_action");
  if (action === "keep_current") return reject("unchanged");
  if (action === "start_next_bar") {
    if (session.drumStatus === "playing" || session.scheduledStart !== null) return reject("already_active");
    if (request.target_bar_ms - receivedMs < CONFIG.lookahead_ms) return reject("missed_deadline");
    session.scheduledStart = request.target_bar_ms;
  } else {
    if (session.drumStatus === "stopped" && session.scheduledStart === null) return reject("already_stopped");
    session.drumStatus = "stopped";
    session.scheduledStart = null;
  }
  return { accepted: true, action, received_ms: receivedMs, effective_ms: action === "start_next_bar" ? request.target_bar_ms : receivedMs, request_id: request.request_id };
}

export function summarize(requests) {
  const success = requests.filter(row => row.response && !row.error);
  const times = success.map(row => row.round_trip_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const count = times.length;
  return {
    count: requests.length, success: count, errors: requests.filter(row => row.error).length,
    median: count ? (times[Math.floor((count - 1) / 2)] + times[Math.floor(count / 2)]) / 2 : null,
    p95: count ? times[Math.ceil(count * 0.95) - 1] : null,
    worst: count ? times[count - 1] : null,
    agreement: success.length ? 100 * success.filter(row => row.response.choice === row.expected).length / success.length : null,
    missed: requests.filter(row => row.outcome?.reason === "missed_deadline").length,
    starts: requests.filter(row => row.outcome?.accepted && row.outcome.action === "start_next_bar").length,
  };
}

export function drumWindows(actions, durationMs) {
  const windows = [];
  let current = null;
  for (const action of actions) {
    if (action.action === "start_next_bar") {
      if (!current) { current = { start: action.effective_ms, end: durationMs }; windows.push(current); }
    } else if (action.action === "stop" && current) {
      current.end = Math.min(current.end, action.effective_ms);
      current = null;
    }
  }
  return windows.filter(window => window.end > window.start);
}

export function drumHitsBetween(fromMs, toMs, windows) {
  const hits = [];
  for (let time = Math.ceil(fromMs / 250) * 250; time < toMs; time += 250) {
    const window = windows.find(item => time >= item.start && time < item.end);
    if (!window) continue;
    hits.push({ time_ms: time, instrument: "hat", stop_ms: window.end });
    if (time % 1000 === 0) hits.push({ time_ms: time, instrument: "kick", stop_ms: window.end });
    if (time % 1000 === 500) hits.push({ time_ms: time, instrument: "snare", stop_ms: window.end });
  }
  return hits;
}

function validTime(value, max = CONFIG.max_duration_ms) {
  return Number.isFinite(value) && value >= 0 && value <= max;
}

export function validateRecording(text) {
  if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error("Recording exceeds 10 MB.");
  const r = JSON.parse(text);
  if (r.version !== 1 || !["mock", "live"].includes(r.mode) || !validTime(r.duration_ms) || r.config?.tempo_bpm !== 120 || r.config?.beats_per_bar !== 4 || r.config?.cycle_ms !== 16000) throw new Error("Unsupported recording format or timing.");
  if (!Array.isArray(r.fixture) || !r.fixture.length || r.fixture.length > 500 || !Array.isArray(r.actions) || r.actions.length > 6000 || !Array.isArray(r.requests) || r.requests.length > 6000) throw new Error("Invalid recording lists.");
  let previous = -1;
  for (const e of r.fixture) {
    if (!validTime(e.time_ms, 15999) || e.time_ms < previous || !["note_on", "note_off", "sustain"].includes(e.type)) throw new Error("Invalid fixture event.");
    if (e.type === "sustain" ? !Number.isInteger(e.value) || e.value < 0 || e.value > 127 : !Number.isInteger(e.note) || e.note < 0 || e.note > 127 || !Number.isInteger(e.velocity) || e.velocity < 0 || e.velocity > 127) throw new Error("Invalid MIDI value.");
    previous = e.time_ms;
  }
  previous = -1;
  for (const a of r.actions) {
    const received = a.received_ms ?? a.effective_ms;
    if (!["start_next_bar", "stop"].includes(a.action) || !validTime(a.effective_ms, r.duration_ms + CONFIG.bar_ms) || !validTime(received, r.duration_ms) || received < previous || a.effective_ms < received) throw new Error("Invalid recorded action.");
    previous = received;
  }
  previous = -1;
  for (const row of r.requests) {
    if (!validTime(row.snapshot_ms, r.duration_ms) || !validTime(row.received_ms, r.duration_ms) || row.received_ms < row.snapshot_ms || row.received_ms < previous || !validTime(row.round_trip_ms) || (row.response && !ACTIONS.includes(row.response.choice)) || (row.error && typeof row.error !== "string")) throw new Error("Invalid recorded decision.");
    if (Boolean(row.response) === Boolean(row.error) || !validTime(row.sent_at_ms, r.duration_ms) || row.sent_at_ms < row.snapshot_ms) throw new Error("Incomplete recorded decision.");
    if (!row.state?.piano || !Array.isArray(row.state.piano.recent_events) || row.state.piano.recent_events.length > 500 || !Number.isFinite(row.state.piano.silent_for_ms) || row.state.piano.silent_for_ms < 0 || !["playing", "stopped"].includes(row.state.drums?.status) || typeof row.state.drums.scheduled_start !== "boolean") throw new Error("Invalid recorded state.");
    if (row.response && (row.response.type !== "choice" || !ACTIONS.includes(row.expected) || !row.response.probabilities || Object.values(row.response.probabilities).some(value => !Number.isFinite(value) || value < 0 || value > 1))) throw new Error("Invalid recorded answer.");
    if (row.outcome && (typeof row.outcome.accepted !== "boolean" || !ACTIONS.includes(row.outcome.action) || !validTime(row.outcome.received_ms, r.duration_ms) || (row.outcome.accepted && !validTime(row.outcome.effective_ms, r.duration_ms + CONFIG.bar_ms)))) throw new Error("Invalid recorded outcome.");
    previous = row.received_ms;
  }
  return r;
}
