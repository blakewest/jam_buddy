import { appendHistory, createPatternState, INSTRUMENTS } from "./pattern-state.js";
import { createPatternPlayer } from "./pattern-audio.js";
import { runPatternRequest } from "./pattern-runner.js";
import { createIdleSubmit } from "./idle-submit.js";

const $ = id => document.getElementById(id);
const labels = { kick: "Kick", snare: "Snare", closed_hat: "Closed hat", open_hat: "Open hat" };
let state = createPatternState();
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
  try { await storage({ state: pendingState ?? state, logs: logs.slice(-50) }); } catch { $("request-status").textContent = "Browser storage is unavailable; this session will not survive a reload."; }
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
  const stepNames = ["1", "e", "&", "a", "2", "e", "&", "a", "3", "e", "&", "a", "4", "e", "&", "a"];
  for (let bar = 1; bar <= pattern.bars; bar++) {
    const section = document.createElement("section");
    section.className = "pattern-bar";
    const heading = document.createElement("h3");
    heading.textContent = `Bar ${bar}`;
    const grid = document.createElement("div");
    grid.className = "pattern-grid";
    const corner = document.createElement("div");
    corner.className = "grid-cell grid-label step-label";
    corner.textContent = "Instrument";
    grid.append(corner);
    stepNames.forEach((name, index) => {
      const cell = document.createElement("div");
      cell.className = `grid-cell step-label${index % 4 === 0 ? " downbeat" : ""}`;
      cell.textContent = name;
      grid.append(cell);
    });
    for (const instrument of INSTRUMENTS) {
      const label = document.createElement("div");
      label.className = "grid-cell grid-label";
      label.textContent = labels[instrument];
      grid.append(label);
      for (let slot = 1; slot <= 16; slot++) {
        const cell = document.createElement("div");
        cell.className = `grid-cell${(slot - 1) % 4 === 0 ? " beat" : ""}`;
        const note = pattern.notes.find(item => item.instrument === instrument && item.bar === bar && item.slot === slot);
        if (note) {
          const marker = document.createElement("span");
          marker.className = `note-dot ${instrument} velocity-${note.velocity_layer}`;
          marker.title = `${labels[instrument]}, bar ${bar}, slot ${slot}, velocity layer ${note.velocity_layer}`;
          cell.append(marker);
        }
        grid.append(cell);
      }
    }
    section.append(heading, grid);
    container.append(section);
  }
  $("note-count").textContent = `${pattern.notes.length} note${pattern.notes.length === 1 ? "" : "s"}`;
  $("pattern-heading").textContent = `${pendingState ? "Next-phrase" : pattern.bars === 1 ? "One-bar" : `${pattern.bars}-bar`} pattern`;
  $("phrase-bars").textContent = `${pattern.bars} ${pattern.bars === 1 ? "bar" : "bars"}`;
  $("phrase-steps").textContent = `${pattern.bars * 16} steps`;
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
  if (change.kind === "remove") return `Removed ${labels[change.before?.instrument] ?? change.note_id}`;
  if (change.kind === "add") {
    const note = change.after ?? change.proposed;
    return `Added ${labels[note?.instrument] ?? "note"} in bar ${note?.bar ?? 1} at slot ${note?.slot ?? "?"}, layer ${note?.velocity_layer ?? "?"}`;
  }
  if (change.kind === "modify") {
    const before = change.before ?? { instrument: change.note_id, slot: "?" };
    const after = change.after ?? change.proposed;
    return `Changed ${labels[before.instrument] ?? before.instrument} in bar ${before.bar ?? 1} at slot ${before.slot}, layer ${before.velocity_layer ?? "?"} → ${labels[after?.instrument] ?? after?.instrument} in bar ${after?.bar ?? 1} at slot ${after?.slot ?? "?"}, layer ${after?.velocity_layer ?? "?"}`;
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
  $("send").disabled = busy || pending;
  $("request").disabled = busy || pending;
  $("clear").disabled = busy || pending || displayedState().pattern.notes.length === 0;
  $("pending").hidden = !pending;
  $("play").disabled = player.isPlaying();
  $("stop").disabled = !player.isPlaying();
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
    await player.start(pattern);
    $("playback-status").textContent = "Playing";
  } catch (error) {
    $("playback-status").textContent = error.message;
  } finally {
    startingPlayback = false;
    updateControls();
  }
}

function commitOrStage(nextState) {
  if (player.isPlaying()) {
    pendingState = nextState;
    player.stage(nextState.pattern);
    $("request-status").textContent = "Accepted changes are waiting for the next phrase.";
  } else {
    state = nextState;
    $("request-status").textContent = "Changes applied.";
  }
  render();
  persist();
  if (!player.isPlaying()) void startPlayback(state.pattern);
}

$("request-form").addEventListener("submit", async event => {
  event.preventDefault();
  idleSubmit.cancel();
  const request = $("request").value.trim();
  if (!request || busy || pendingState) return;
  busy = true;
  updateControls();
  $("request-status").textContent = "Jev is estimating the number of edits…";
  try {
    let plannedOperationCount = 0;
    const completed = await runPatternRequest({
      initialState: state,
      request,
      maxPasses: 8,
      estimateOperations: async sentState => {
        const started = performance.now();
        const response = await fetch("/api/pattern-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: sentState }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}.`);
        plannedOperationCount = data.operation_count;
        $("request-status").textContent = plannedOperationCount === 0 ? `Jev planned a ${data.phrase_bars}-bar phrase with no note edits.` : `Jev planned ${plannedOperationCount} edit${plannedOperationCount === 1 ? "" : "s"} across ${data.phrase_bars} bar${data.phrase_bars === 1 ? "" : "s"}…`;
        return { ...data, latency_ms: performance.now() - started };
      },
      decide: async (sentState, pass, plan) => {
        $("request-status").textContent = `Jev is considering edit ${pass} of ${plannedOperationCount}…`;
        const started = performance.now();
        const response = await fetch("/api/pattern-decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: sentState, instruments: plan.relevant_instruments }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}.`);
        return { ...data, latency_ms: performance.now() - started };
      },
    });
    const log = { request, plan: completed.plan, passes: completed.passes, result: completed.result, latency_ms: completed.latency_ms, model: completed.model, usage: completed.usage, question_count: completed.question_count };
    logs.push(log);
    logs = logs.slice(-50);
    renderInspector(log);
    const tokens = Number(completed.usage?.input_tokens ?? 0) + Number(completed.usage?.output_tokens ?? 0);
    $("request-meta").textContent = `${completed.state.pattern.bars} bars · ${completed.result.planned_operations} planned · ${completed.passes.length} edit pass${completed.passes.length === 1 ? "" : "es"} · ${Math.round(completed.latency_ms)} ms · ${completed.question_count} questions · ${completed.model}${tokens ? ` · ${tokens} tokens` : ""}`;
    $("request").value = "";
    commitOrStage(completed.state);
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

$("clear").addEventListener("click", () => {
  const entry = { request: "Clear pattern (manual)", applied_changes: ["Cleared the whole pattern"], rejected_changes: [] };
  const next = appendHistory({ ...createPatternState(state), pattern: { ...state.pattern, notes: [] } }, entry);
  const result = { reset_probability: null, candidates: [], applied_changes: [{ kind: "reset" }], rejected_changes: [], ignored_changes: [], history_entry: entry };
  const log = { request: entry.request, result, local: true };
  logs.push(log);
  renderInspector(log);
  commitOrStage(next);
});

$("new-session").addEventListener("click", () => {
  idleSubmit.cancel();
  player.stop();
  state = createPatternState();
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
  if (Array.isArray(saved?.logs)) logs = saved.logs.slice(-50);
  if (logs.length) renderInspector(logs.at(-1));
} catch { $("request-status").textContent = "Browser storage is unavailable; the demo still works for this tab."; }
render();
