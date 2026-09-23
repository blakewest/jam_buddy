import { appendHistory, createPatternState, INSTRUMENTS, stateForJev } from "/core/pattern/state.js";
import { createPatternPlayer } from "/frontend/pattern/audio.js";
import { runPatternRequest } from "/core/pattern/runner.js";
import { runPatternTree } from "/core/pattern/request-runner.js";
import { ticksPerBar } from "/core/pattern/musical-time.js";
import { createIdleSubmit } from "/frontend/shared/idle-submit.js";

const $ = id => document.getElementById(id);
const labels = { kick: "Kick", snare: "Snare", closed_hat: "Closed hat", open_hat: "Open hat", ride: "Ride", crash: "Crash", high_tom: "High tom", mid_tom: "Mid tom", floor_tom: "Floor tom" };
let state = createPatternState();
let tempoBpm = 120;
let pendingState = null;
let logs = [];
let busy = false;
let startingPlayback = false;

function focusRequest() {
  if (!$("request").disabled) $("request").focus();
}

async function storage(value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("jam-partner-pattern", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("session");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("session", value === undefined ? "readonly" : "readwrite");
      const request = value === undefined ? tx.objectStore("session").get("current") : tx.objectStore("session").put(value, "current");
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function persist() {
  try { await storage({ state: pendingState ?? state, tempo_bpm: tempoBpm, logs: logs.slice(-50) }); } catch { $("request-status").textContent = "Browser storage is unavailable; this session will not survive a reload."; }
}

const player = createPatternPlayer({
  onError: message => { $("playback-status").textContent = message; },
  onSwap: () => {
    if (!pendingState) return;
    state = pendingState;
    pendingState = null;
    $("request-status").textContent = "Changes are now playing.";
    render();
    focusRequest();
    persist();
  },
});

const idleSubmit = createIdleSubmit({
  delayMs: 300,
  onSubmit: () => $("request-form").requestSubmit(),
});

function displayedState() {
  return pendingState ?? state;
}

function renderGrid() {
  const pattern = displayedState().pattern;
  const container = $("pattern-grid");
  container.replaceChildren();
  const barTicks = ticksPerBar(pattern.meter);
  for (let bar = 1; bar <= pattern.bars; bar++) {
    const section = document.createElement("section");
    section.className = "pattern-bar";
    const heading = document.createElement("h3");
    heading.textContent = `Bar ${bar}`;
    const grid = document.createElement("div"); grid.className = "pattern-grid";
    for (const instrument of INSTRUMENTS) {
      const row = document.createElement("div"); row.className = "pattern-lane";
      const label = document.createElement("div"); label.className = "grid-label"; label.textContent = labels[instrument];
      const track = document.createElement("div"); track.className = "lane-track";
      for (let beat = 0; beat <= pattern.meter.numerator; beat++) {
        const line = document.createElement("i"); line.className = "beat-line"; line.style.left = `${beat / pattern.meter.numerator * 100}%`; track.append(line);
      }
      for (const note of pattern.notes.filter(item => item.instrument === instrument && item.bar === bar)) {
        const marker = document.createElement("span"); marker.className = `note-dot ${instrument}`;
        marker.style.left = `${note.tick / barTicks * 100}%`; marker.style.opacity = `${0.45 + note.velocity / 230}`; marker.style.transform = `translate(-50%, -50%) scale(${0.75 + note.velocity / 300})`;
        marker.title = `${labels[instrument]}, bar ${bar}, tick ${note.tick}, velocity ${note.velocity}`; track.append(marker);
      }
      row.append(label, track); grid.append(row);
    }
    section.append(heading, grid);
    container.append(section);
  }
  $("note-count").textContent = `${pattern.notes.length} note${pattern.notes.length === 1 ? "" : "s"}`;
  $("pattern-heading").textContent = `${pendingState ? "Next-phrase" : pattern.bars === 1 ? "One-bar" : `${pattern.bars}-bar`} pattern`;
  $("phrase-bars").textContent = `${pattern.bars} ${pattern.bars === 1 ? "bar" : "bars"}`;
  $("phrase-steps").textContent = `${pattern.meter.numerator}/${pattern.meter.denominator}`;
  $("tempo").value = String(tempoBpm);
}

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Your first change will appear here.";
    list.append(empty);
    return;
  }
  for (let index = logs.length - 1; index >= 0; index--) {
    const log = logs[index];
    const item = document.createElement("div");
    item.className = "history-item";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = index;
    const title = document.createElement("strong");
    title.textContent = log.request;
    const detail = document.createElement("span");
    const applied = log.result?.applied_changes?.length ?? 0;
    const rejected = log.result?.rejected_changes?.length ?? 0;
    detail.textContent = `${log.local ? "Local" : `${Math.round(log.latency_ms)} ms`} · ${applied} applied${rejected ? ` · ${rejected} rejected` : ""}`;
    button.append(title, detail);
    item.append(button);
    list.append(item);
  }
}

function describeChange(change) {
  if (change.kind === "reset") return "Cleared the entire pattern";
  if (change.kind === "resize") return `Changed phrase from ${change.before_bars} to ${change.after_bars} bars`;
  if (change.kind === "load_preset") return `Loaded ${change.preset_name}`;
  if (change.kind === "remove") return `Removed ${labels[change.before?.instrument] ?? change.note_id}`;
  if (change.kind === "add") {
    const note = change.after ?? change.proposed;
    return `Added ${labels[note?.instrument] ?? "note"} in bar ${note?.bar ?? 1} at tick ${note?.tick ?? "?"}, velocity ${note?.velocity ?? "?"}`;
  }
  if (change.kind === "modify") {
    const before = change.before ?? { instrument: change.note_id, tick: "?" };
    const after = change.after ?? change.proposed;
    return `Changed ${labels[before.instrument] ?? before.instrument} in bar ${before.bar ?? 1} at tick ${before.tick}, velocity ${before.velocity ?? "?"} → ${labels[after?.instrument] ?? after?.instrument} in bar ${after?.bar ?? 1} at tick ${after?.tick ?? "?"}, velocity ${after?.velocity ?? "?"}`;
  }
  return change.source ?? "Change";
}

function renderInspector(log) {
  const summary = $("decision-summary");
  summary.replaceChildren();
  if (!log) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Raw Jev answers and local application rules will appear here."; summary.append(empty);
    $("raw").textContent = "No response yet.";
    $("reset-score").textContent = "Reset —";
    return;
  }
  const result = log.result;
  $("reset-score").textContent = Number.isFinite(result?.reset_probability) ? `Reset ${(result.reset_probability * 100).toFixed(1)}%` : "Local change";
  const rows = [
    ...(result?.applied_changes ?? []).map(change => ({ status: "applied", change })),
    ...(result?.rejected_changes ?? []).map(change => ({ status: "rejected", change })),
    ...(result?.ignored_changes ?? []).map(change => ({ status: "ignored", change })),
  ];
  if (!rows.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Jev selected no pattern changes."; summary.append(empty);
  }
  for (const row of rows) {
    const element = document.createElement("div");
    element.className = `decision-row ${row.status}`;
    const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = row.status;
    const description = document.createElement("span"); description.className = "description"; description.textContent = row.status === "rejected" ? `${describeChange(row.change)} · ${row.change.reason}` : describeChange(row.change);
    const confidence = document.createElement("span"); confidence.className = "confidence"; confidence.textContent = Number.isFinite(row.change.score) ? `${(row.change.score * 100).toFixed(1)}%` : "";
    element.append(kind, description, confidence);
    summary.append(element);
  }
  $("raw").textContent = JSON.stringify(log, null, 2);
}

function updateControls() {
  const pending = pendingState !== null;
  $("send").disabled = busy || pending || startingPlayback;
  $("request").disabled = busy || pending || startingPlayback;
  $("clear").disabled = busy || pending || startingPlayback || displayedState().pattern.notes.length === 0;
  $("tempo").disabled = busy || startingPlayback;
  $("new-session").disabled = busy || startingPlayback;
  $("pending").hidden = !pending;
  $("play").disabled = player.isPlaying() || startingPlayback || busy;
  $("stop").disabled = !player.isPlaying() && !startingPlayback;
}

function render() {
  renderGrid();
  renderHistory();
  updateControls();
}

async function startPlayback(pattern) {
  if (player.isPlaying() || startingPlayback || pattern.notes.length === 0) return;
  startingPlayback = true;
  $("playback-status").textContent = "Loading drum kit…";
  updateControls();
  try {
    await player.start(pattern, tempoBpm);
    $("playback-status").textContent = player.isPlaying() ? "Playing" : "Stopped";
  } catch (error) {
    $("playback-status").textContent = error.message;
  } finally {
    startingPlayback = false;
    updateControls();
  }
}

async function commitOrStage(nextState, nextTempoBpm = tempoBpm) {
  const wasPlaying = player.isPlaying();
  if (wasPlaying) {
    await player.stage(nextState.pattern, nextTempoBpm);
    if (player.isPlaying()) {
      pendingState = nextState;
      $("request-status").textContent = "Accepted changes are waiting for the next phrase.";
    } else {
      state = nextState;
      $("request-status").textContent = "Changes applied.";
    }
  } else {
    state = nextState;
    $("request-status").textContent = "Changes applied.";
  }
  tempoBpm = nextTempoBpm;
  render();
  persist();
  if (!wasPlaying) void startPlayback(state.pattern);
}

$("request-form").addEventListener("submit", async event => {
  event.preventDefault();
  idleSubmit.cancel();
  const request = $("request").value.trim();
  if (!request || busy || pendingState) return;
  busy = true;
  updateControls();
  $("request-status").textContent = "Jev is routing your request…";
  try {
    let plannedOperationCount = 0;
    const post = async (path, body) => {
      const started = performance.now();
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}.`);
      return { ...data, latency_ms: performance.now() - started };
    };
    const completed = await runPatternTree({
      state,
      request,
      route: value => post("/api/pattern-route", { request: value }),
      searchPresets: value => post("/api/preset-search", { request: value }),
      selectPreset: (value, candidateIds) => post("/api/preset-select", { request: value, candidate_ids: candidateIds }),
      interpretEdit: () => post("/api/pattern-edit-intent", { state: stateForJev(state, request) }),
      runEdit: () => runPatternRequest({
        initialState: state, request, maxPasses: 8,
        estimateOperations: async sentState => {
          $("request-status").textContent = "Jev is planning the edit branch…";
          const data = await post("/api/pattern-plan", { state: sentState });
          plannedOperationCount = data.operation_count;
          return data;
        },
        decide: async (sentState, pass, plan) => {
          $("request-status").textContent = `Jev is considering edit ${pass} of ${plannedOperationCount}…`;
          return post("/api/pattern-decision", { state: sentState, instruments: plan.relevant_instruments });
        },
      }),
    });
    const log = { request, route: completed.route, visits: completed.visits, plan: completed.plan, passes: completed.passes, result: completed.result, latency_ms: completed.latency_ms, model: completed.model, usage: completed.usage, question_count: completed.question_count };
    logs.push(log);
    logs = logs.slice(-50);
    renderInspector(log);
    const tokens = Number(completed.usage?.input_tokens ?? 0) + Number(completed.usage?.output_tokens ?? 0);
    $("request-meta").textContent = `${completed.route.category.replaceAll("_", " ")} · ${Math.round(completed.latency_ms)} ms · ${completed.question_count} questions${completed.model ? ` · ${completed.model}` : ""}${tokens ? ` · ${tokens} tokens` : ""}`;
    $("request").value = "";
    if (completed.state === state) {
      $("request-status").textContent = completed.result.message;
      renderInspector(log); renderHistory();
    } else {
      if (completed.route.category === "clear_pattern") {
        player.stop();
        $("playback-status").textContent = "Stopped";
      }
      await commitOrStage(completed.state, completed.result.tempo_bpm ?? tempoBpm);
    }
  } catch (error) {
    $("request-status").textContent = error.message;
  } finally {
    busy = false;
    updateControls();
    focusRequest();
  }
});

$("request").addEventListener("keydown", event => {
  if (event.metaKey && event.key === "Enter") {
    event.preventDefault();
    $("request-form").requestSubmit();
  }
});

$("request").addEventListener("input", event => {
  void player.unlock().catch(() => {});
  idleSubmit.schedule(event.currentTarget.value, $("auto-submit").checked);
});

const unlockAudio = () => { void player.unlock().catch(() => {}); };
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("keydown", unlockAudio);

$("auto-submit").addEventListener("change", () => {
  idleSubmit.schedule($("request").value, $("auto-submit").checked);
});

$("play").addEventListener("click", async () => {
  await startPlayback(state.pattern);
});

$("stop").addEventListener("click", () => {
  player.stop();
  if (pendingState) { state = pendingState; pendingState = null; persist(); }
  $("playback-status").textContent = "Stopped";
  render();
});

$("volume").addEventListener("input", event => player.setVolume(Number(event.target.value)));

$("tempo").addEventListener("change", event => {
  const value = Math.round(Number(event.target.value));
  tempoBpm = Math.min(240, Math.max(40, Number.isFinite(value) ? value : 120));
  event.target.value = String(tempoBpm);
  player.setTempo(tempoBpm);
  $("request-status").textContent = player.isPlaying() ? `Tempo ${tempoBpm} BPM applies next phrase.` : `Tempo set to ${tempoBpm} BPM.`;
  persist();
});

$("clear").addEventListener("click", () => {
  const entry = { request: "Clear pattern (manual)", applied_changes: ["Cleared the whole pattern"], rejected_changes: [] };
  const next = appendHistory({ ...createPatternState(state), pattern: { ...state.pattern, notes: [] } }, entry);
  const result = { reset_probability: null, candidates: [], applied_changes: [{ kind: "reset" }], rejected_changes: [], ignored_changes: [], history_entry: entry };
  const log = { request: entry.request, result, local: true };
  logs.push(log);
  renderInspector(log);
  void commitOrStage(next).catch(error => { $("request-status").textContent = error.message; });
});

$("new-session").addEventListener("click", () => {
  idleSubmit.cancel();
  player.stop();
  state = createPatternState();
  tempoBpm = 120;
  pendingState = null;
  logs = [];
  $("playback-status").textContent = "Stopped";
  $("request-status").textContent = "New empty session ready.";
  $("request-meta").textContent = "No API call yet";
  renderInspector(null);
  render();
  persist();
});

$("history-list").addEventListener("click", event => {
  const index = event.target.closest("button")?.dataset.index;
  if (index !== undefined) renderInspector(logs[Number(index)]);
});

document.querySelector(".examples").addEventListener("click", event => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  $("request").value = event.target.textContent;
  $("request").focus();
  void player.unlock().catch(() => {});
  idleSubmit.schedule($("request").value, $("auto-submit").checked);
});

window.addEventListener("pagehide", () => player.stop());

try {
  const saved = await storage();
  if (saved?.state) state = createPatternState(saved.state);
  if (Number.isInteger(saved?.tempo_bpm) && saved.tempo_bpm >= 40 && saved.tempo_bpm <= 240) tempoBpm = saved.tempo_bpm;
  if (Array.isArray(saved?.logs)) logs = saved.logs.slice(-50);
  if (logs.length) renderInspector(logs.at(-1));
} catch { $("request-status").textContent = "Browser storage is unavailable; the demo still works for this tab."; }
render();
