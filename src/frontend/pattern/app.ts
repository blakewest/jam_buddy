import type { Pattern, PatternState } from "../../core/pattern/state.js";
import type { PatternPlan } from "../../core/pattern/runner.js";
import type { CommandResult } from "../../core/pattern/request-tree.js";

import { appendHistory, createPatternState, INSTRUMENTS } from "../../core/pattern/state.js";
import { createPatternPlayer } from "./audio.js";
import { runPatternRequest } from "../../core/pattern/runner.js";
import { KITS, getKit } from "../../core/pattern/kits.js";
import { recordUndoUnit, undoLastChange } from "../../core/pattern/undo.js";
import { runPatternCommand, changeKit } from "../../core/pattern/request-tree.js";
import { createIdleSubmit } from "../shared/idle-submit.js";

type RequestLog = Partial<CommandResult> & { request: string; local?: boolean };
interface SavedSession { state: PatternState; logs: RequestLog[] }
type Decide = <T>(url: string, payload: unknown) => Promise<T>;

interface Elements {
  "play": HTMLButtonElement;
  "stop": HTMLButtonElement;
  "phrase-bars": HTMLElement;
  "phrase-steps": HTMLElement;
  "kit": HTMLSelectElement;
  "kit-status": HTMLElement;
  "volume": HTMLInputElement;
  "playback-status": HTMLElement;
  "pattern-heading": HTMLElement;
  "note-count": HTMLElement;
  "pattern-grid": HTMLElement;
  "prompt-heading": HTMLElement;
  "pending": HTMLElement;
  "request-form": HTMLFormElement;
  "request": HTMLTextAreaElement;
  "send": HTMLButtonElement;
  "auto-submit": HTMLInputElement;
  "request-status": HTMLElement;
  "request-meta": HTMLElement;
  "history-heading": HTMLElement;
  "undo": HTMLButtonElement;
  "clear": HTMLButtonElement;
  "new-session": HTMLButtonElement;
  "history-list": HTMLElement;
  "inspector-heading": HTMLElement;
  "reset-score": HTMLElement;
  "decision-summary": HTMLElement;
  "raw": HTMLElement;
}

function $<K extends keyof Elements>(id: K): Elements[K] {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as Elements[K];
}
const labels: Record<string, string> = { kick: "Kick", snare: "Snare", closed_hat: "Closed hat", open_hat: "Open hat" };
let state = createPatternState();
let pendingState: PatternState | null = null;
let logs: RequestLog[] = [];
let busy = false;
let startingPlayback = false;
let operationVersion = 0;
let requestAbort: AbortController | null = null;
for (const kit of KITS) {
  const option = document.createElement("option");
  option.value = kit.id;
  option.textContent = kit.name;
  $("kit").append(option);
}

function cancelWork() {
  operationVersion++;
  requestAbort?.abort();
  requestAbort = null;
  busy = false;
  startingPlayback = false;
  idleSubmit.cancel();
  player.stop();
}

function focusRequest() {
  if (!$("request").disabled) $("request").focus();
}

async function storage(value?: SavedSession): Promise<SavedSession | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("jam-partner-pattern", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("session");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<SavedSession | undefined>((resolve, reject) => {
      const tx = db.transaction("session", value === undefined ? "readonly" : "readwrite");
      const request = value === undefined ? tx.objectStore("session").get("current") : tx.objectStore("session").put(value, "current");
      tx.oncomplete = () => resolve(value === undefined ? request.result : undefined);
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
    button.dataset.index = String(index);
    const title = document.createElement("strong");
    title.textContent = log.request;
    const detail = document.createElement("span");
    const applied = log.result?.applied_changes?.length ?? 0;
    const rejected = log.result?.rejected_changes?.length ?? 0;
    detail.textContent = `${log.local ? "Local" : `${Math.round(log.latency_ms ?? 0)} ms`} · ${applied} applied${rejected ? ` · ${rejected} rejected` : ""}`;
    button.append(title, detail);
    item.append(button);
    list.append(item);
  }
}

function describeChange(change: CommandResult["result"]["applied_changes"][number]) {
  if (change.kind === "undo") return `Undid: ${change.request}`;
  if (change.kind === "kit") return `Changed kit: ${getKit(change.before_kit).name} → ${getKit(change.after_kit).name}`;
  if (change.kind === "reset") return "Cleared the entire pattern";
  if (change.kind === "resize") return `Changed phrase from ${change.before_bars} to ${change.after_bars} bars`;
  if (change.kind === "remove") return `Removed ${labels[change.before?.instrument ?? ""] ?? change.note_id}`;
  if (change.kind === "add") {
    const note = change.after ?? change.proposed;
    return `Added ${labels[note?.instrument ?? ""] ?? "note"} in bar ${note?.bar ?? 1} at slot ${note?.slot ?? "?"}, layer ${note?.velocity_layer ?? "?"}`;
  }
  if (change.kind === "modify") {
    const before = change.before;
    const after = change.after ?? change.proposed;
    return `Changed ${labels[before?.instrument ?? ""] ?? before?.instrument ?? change.note_id} in bar ${before?.bar ?? 1} at slot ${before?.slot ?? "?"}, layer ${before?.velocity_layer ?? "?"} → ${labels[after?.instrument ?? ""] ?? after?.instrument} in bar ${after?.bar ?? 1} at slot ${after?.slot ?? "?"}, layer ${after?.velocity_layer ?? "?"}`;
  }
  return change.source ?? "Change";
}

function renderInspector(log: RequestLog | null | undefined) {
  const summary = $("decision-summary");
  summary.replaceChildren();
  if (!log) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Raw Jev answers and local application rules will appear here."; summary.append(empty);
    $("raw").textContent = "No response yet.";
    $("reset-score").textContent = "Reset —";
    return;
  }
  const result = log.result;
  $("reset-score").textContent = typeof result?.reset_probability === "number" ? `Reset ${(result.reset_probability * 100).toFixed(1)}%` : log.local ? "Local change" : "Request decision";
  const rows = [
    ...(result?.applied_changes ?? []).map(change => ({ status: "applied", change })),
    ...(result?.rejected_changes ?? []).map(change => ({ status: "rejected", change })),
    ...(result?.ignored_changes ?? []).map(change => ({ status: "ignored", change })),
  ];
  if (!rows.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = log.message ?? "No changes needed."; summary.append(empty);
  }
  for (const row of rows) {
    const element = document.createElement("div");
    element.className = `decision-row ${row.status}`;
    const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = row.status;
    const description = document.createElement("span"); description.className = "description"; description.textContent = row.status === "rejected" ? `${describeChange(row.change)} · ${"reason" in row.change ? row.change.reason : ""}` : describeChange(row.change);
    const confidence = document.createElement("span"); confidence.className = "confidence"; confidence.textContent = "score" in row.change && typeof row.change.score === "number" ? `${(row.change.score * 100).toFixed(1)}%` : "";
    element.append(kind, description, confidence);
    summary.append(element);
  }
  $("raw").textContent = JSON.stringify(log, null, 2);
}

function updateControls() {
  const pending = pendingState !== null;
  const locked = busy || pending || startingPlayback;
  $("undo").disabled = locked || state.undo_history.length === 0;
  $("kit").disabled = locked;
  document.querySelectorAll<HTMLButtonElement>(".examples button").forEach(button => { button.disabled = locked; });
  $("kit").value = displayedState().pattern.kit_id;
  const currentKit = getKit(state.pattern.kit_id).name;
  $("kit-status").textContent = pendingState && pendingState.pattern.kit_id !== state.pattern.kit_id ? `${currentKit} → ${getKit(pendingState.pattern.kit_id).name} next phrase` : currentKit;
  $("send").disabled = locked;
  $("request").disabled = locked;
  $("clear").disabled = locked || displayedState().pattern.notes.length === 0;
  $("pending").hidden = !pending;
  $("play").disabled = player.isPlaying() || locked;
  $("stop").disabled = !player.isPlaying() && !busy && !startingPlayback;
}

function render() {
  renderGrid();
  renderHistory();
  updateControls();
}

async function startPlayback(pattern: Pattern) {
  if (player.isPlaying() || startingPlayback || pattern.notes.length === 0) return;
  const version = operationVersion;
  startingPlayback = true;
  $("playback-status").textContent = "Loading drum kit…";
  updateControls();
  try {
    const started = await player.start(pattern);
    if (started && version === operationVersion) $("playback-status").textContent = "Playing";
  } catch (error) {
    if (version === operationVersion) $("playback-status").textContent = (error instanceof Error ? error.message : String(error));
  } finally {
    if (version !== operationVersion) return;
    startingPlayback = false;
    updateControls();
  }
}

function commitOrStage(nextState: PatternState, autoPlay = true) {
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
  if (autoPlay && !player.isPlaying()) void startPlayback(state.pattern);
}

async function performRequest(request: string, run: (decide: Decide) => Promise<CommandResult>, local = false) {
  if (busy || pendingState || startingPlayback) return;
  idleSubmit.cancel();
  busy = true;
  const version = ++operationVersion;
  requestAbort = new AbortController();
  const signal = requestAbort.signal;
  updateControls();
  $("request-status").textContent = local ? "Applying change…" : "Jev is choosing the kind of change…";
  const decide: Decide = async <T>(url: string, payload: unknown): Promise<T> => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await fetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    signal.throwIfAborted();
    if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}.`);
    return { ...data, latency_ms: performance.now() - started };
  };
  try {
    let completed = await run(decide);
    if (version !== operationVersion) return;
    if (completed.result.applied_changes.length) {
      $("request-status").textContent = "Preparing sounds…";
      await player.load(completed.state.pattern.kit_id);
      if (version !== operationVersion) return;
    }
    completed = recordUndoUnit(state, completed, request);
    const log = { request, local, message: completed.message, routing: completed.routing, plan: completed.plan, passes: completed.passes, result: completed.result, latency_ms: completed.latency_ms ?? 0, model: completed.model, usage: completed.usage, question_count: completed.question_count };
    logs = [...logs, log].slice(-50);
    renderInspector(log);
    const tokens = Number(completed.usage?.input_tokens ?? 0) + Number(completed.usage?.output_tokens ?? 0);
    $("request-meta").textContent = local ? "Local change · No API call" : `${Math.round(completed.latency_ms)} ms · ${completed.question_count} questions · ${completed.passes.length} edit passes · ${completed.model}${tokens ? ` · ${tokens} tokens` : ""}`;
    if (!local) $("request").value = "";
    if (completed.result.applied_changes.length) commitOrStage(completed.state, completed.result.applied_changes.some(change => change.kind !== "kit" && change.kind !== "undo"));
    else {
      state = completed.state;
      $("request-status").textContent = completed.message ?? "No changes needed.";
      render();
      persist();
    }
  } catch (error) {
    if (version === operationVersion) $("request-status").textContent = (error instanceof Error ? error.message : String(error));
  } finally {
    if (version === operationVersion) {
      busy = false;
      requestAbort = null;
      updateControls();
      focusRequest();
    }
  }
}

$("request-form").addEventListener("submit", event => {
  event.preventDefault();
  const request = $("request").value.trim();
  if (!request) return;
  void performRequest(request, decide => runPatternCommand({
    initialState: state,
    request,
    decideNode: (nodeId, sentState) => {
      $("request-status").textContent = nodeId === "root" ? "Jev is choosing the kind of change…" : "Jev is selecting a kit…";
      return decide("/api/request-decision", { node_id: nodeId, state: sentState });
    },
    editPattern: () => {
      let plannedOperationCount = 0;
      return runPatternRequest({
        initialState: state,
        request,
        maxPasses: 8,
        estimateOperations: async sentState => {
          const data = await decide<PatternPlan>("/api/pattern-plan", { state: sentState });
          plannedOperationCount = data.operation_count;
          return data;
        },
        decide: (sentState, pass, plan) => {
          $("request-status").textContent = `Jev is considering edit ${pass} of ${plannedOperationCount}…`;
          return decide("/api/pattern-decision", { state: sentState, instruments: plan.relevant_instruments });
        },
      });
    },
  }));
});

$("kit").addEventListener("change", event => {
  const kitId = $("kit").value;
  const request = `Use ${getKit(kitId).name} (manual)`;
  void performRequest(request, async () => changeKit(state, kitId, request), true);
});

$("request").addEventListener("keydown", event => {
  if (event.metaKey && event.key === "Enter") {
    event.preventDefault();
    $("request-form").requestSubmit();
  }
});

$("request").addEventListener("input", event => {
  void player.unlock().catch(() => {});
  idleSubmit.schedule($("request").value, $("auto-submit").checked);
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
  cancelWork();
  if (pendingState) { state = pendingState; pendingState = null; persist(); }
  $("playback-status").textContent = "Stopped";
  $("request-status").textContent = "Stopped. Ready for your next request.";
  render();
});

$("volume").addEventListener("input", event => player.setVolume(Number($("volume").value)));

$("undo").addEventListener("click", () => {
  void performRequest("Undo (manual)", async () => undoLastChange(state, "Undo (manual)"), true);
});

$("clear").addEventListener("click", () => {
  const entry = { request: "Clear pattern (manual)", applied_changes: ["Cleared the whole pattern"], rejected_changes: [] };
  const next = appendHistory({ ...createPatternState(state), pattern: { ...state.pattern, notes: [] } }, entry);
  const result: CommandResult["result"] = { candidates: [], applied_changes: [{ kind: "reset" }], rejected_changes: [], ignored_changes: [], history_entry: entry };
  const log = { request: entry.request, result, local: true };
  logs = [...logs, log].slice(-50);
  renderInspector(log);
  commitOrStage(recordUndoUnit(state, { state: next, result }, entry.request).state);
});

$("new-session").addEventListener("click", () => {
  cancelWork();
  state = createPatternState();
  $("request").value = "";
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
  const index = event.target instanceof Element ? event.target.closest("button")?.dataset.index : undefined;
  if (index !== undefined) renderInspector(logs[Number(index)]);
});

document.querySelector(".examples")?.addEventListener("click", event => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  $("request").value = event.target.textContent ?? "";
  $("request").focus();
  void player.unlock().catch(() => {});
  idleSubmit.schedule($("request").value, $("auto-submit").checked);
});

window.addEventListener("pagehide", cancelWork);

try {
  const saved = await storage();
  if (saved?.state) state = createPatternState(saved.state);
  if (Array.isArray(saved?.logs)) logs = saved.logs.slice(-50);
  if (logs.length) renderInspector(logs.at(-1));
} catch { $("request-status").textContent = "Browser storage is unavailable; the demo still works for this tab."; }
render();
