import { createRecorder } from "./capture.js";
import { analyzeTake } from "../../core/recording/analysis.js";
import { encodeWav } from "../../core/recording/capture.js";
import type { RecordedTake } from "../../core/recording/capture.js";
import { prepareEvidence, validateRecordingDecision } from "../../core/recording/decision.js";
import type { RecordingEvidence, RecordingDecision } from "../../core/recording/decision.js";
import { mapRecording, applyRecording, recordingDelta, recordingStateKey, assertRecordingCurrent } from "../../core/recording/rhythm.js";
import type { Transcript } from "../../services/transcription.js";
import type { JevAnswers } from "../../core/pattern/state.js";
import type { Pattern, PatternState } from "../../core/pattern/state.js";
import type { PatternPlan } from "../../core/pattern/runner.js";
import type { CommandResult } from "../../core/pattern/request-tree.js";

import { appendHistory, createPatternState, stateForJev, INSTRUMENTS } from "../../core/pattern/state.js";
import { createPatternPlayer } from "./audio.js";
import { runPatternRequest } from "../../core/pattern/runner.js";
import { KITS, getKit } from "../../core/pattern/kits.js";
import { recordUndoUnit, undoLastChange } from "../../core/pattern/undo.js";
import { runPatternCommand, changeKit } from "../../core/pattern/request-tree.js";
import { createIdleSubmit } from "../shared/idle-submit.js";
import { runPatternTree } from "../../core/pattern/request-runner.js";
import { swungTick } from "../../core/pattern/swing.js";
import { ticksPerBar } from "../../core/pattern/musical-time.js";

type RequestLog = Partial<CommandResult> & { request: string; local?: boolean };
interface SavedSession { state: PatternState; logs: RequestLog[]; tempo_bpm?: number }
type Decide = <T>(url: string, payload: unknown) => Promise<T>;

interface Elements {
  "tempo": HTMLInputElement;
  "record": HTMLButtonElement;
  "record-cancel": HTMLButtonElement;
  "record-status": HTMLElement;
  "input-offset": HTMLInputElement;
  "take-controls": HTMLElement;
  "take-diagnostic": HTMLElement;
  "take-start": HTMLInputElement;
  "take-tempo": HTMLInputElement;
  "take-rotation": HTMLInputElement;
  "take-half": HTMLButtonElement;
  "take-double": HTMLButtonElement;
  "take-apply": HTMLButtonElement;
  "take-retry": HTMLButtonElement;
  "take-export": HTMLButtonElement;
  "play": HTMLButtonElement;
  "stop": HTMLButtonElement;
  "phrase-bars": HTMLElement;
  "phrase-steps": HTMLElement;
  "kit": HTMLSelectElement;
  "kit-status": HTMLElement;
  "swing-status": HTMLElement;
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
const labels: Record<string, string> = { kick: "Kick", snare: "Snare", closed_hat: "Closed hat", open_hat: "Open hat", ride: "Ride", crash: "Crash", high_tom: "High tom", mid_tom: "Mid tom", floor_tom: "Floor tom" };
let state = createPatternState();
let pendingState: PatternState | null = null;
let pendingBoundary: "beat" | "phrase" = "phrase";
let logs: RequestLog[] = [];
let busy = false;
let captureStatus: "idle" | "initializing" | "recording" = "idle";
let recordProcessing = false;
let takeMemory: { take: RecordedTake; before: PatternState; evidence?: RecordingEvidence; decision?: RecordingDecision; transcript?: Transcript; appliedPattern?: string; diagnostic?: unknown; error?: string; routing?: unknown[]; release_ms: number } | null = null;
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
  recorder.cancel();
  recordProcessing = false;
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
        marker.style.left = `${swungTick(note.tick, pattern.swing_percent ?? 50) / barTicks * 100}%`; marker.style.opacity = `${0.45 + note.velocity / 230}`; marker.style.transform = `translate(-50%, -50%) scale(${0.75 + note.velocity / 300})`;
        marker.title = `${labels[instrument]}, bar ${bar}, tick ${note.tick}, velocity ${note.velocity}`; track.append(marker);
      }
      row.append(label, track); grid.append(row);
    }
    section.append(heading, grid);
    container.append(section);
  }
  $("note-count").textContent = `${pattern.notes.length} note${pattern.notes.length === 1 ? "" : "s"}`;
  $("pattern-heading").textContent = `${pendingState ? `Next-${pendingBoundary}` : pattern.bars === 1 ? "One-bar" : `${pattern.bars}-bar`} pattern`;
  $("phrase-bars").textContent = `${pattern.bars} ${pattern.bars === 1 ? "bar" : "bars"}`;
  $("phrase-steps").textContent = `${pattern.meter.numerator}/${pattern.meter.denominator}`;
  $("tempo").value = String(displayedState().tempo_bpm);
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
  if (change.kind === "tempo") return `Tempo: ${change.before_bpm} → ${change.after_bpm} BPM`;
  if (change.kind === "undo") return `Undid: ${change.request}`;
  if (change.kind === "swing") return `Swing: ${change.before_swing}% → ${change.after_swing}%`;
  if (change.kind === "kit") return `Changed kit: ${getKit(change.before_kit!).name} → ${getKit(change.after_kit!).name}`;
  if (change.kind === "effect") return change.effect === "compression" ? "Added glue compression" : "Added light EQ and mastering compression";
  if (change.kind === "reset") return "Cleared the entire pattern";
  if (change.kind === "resize") return `Changed phrase from ${change.before_bars} to ${change.after_bars} bars`;
  if (change.kind === "remove") return `Removed ${labels[change.before?.instrument ?? ""] ?? change.note_id}`;
  if (change.kind === "add") {
    const note = change.after ?? change.proposed;
    return `Added ${labels[note?.instrument ?? ""] ?? "note"} in bar ${note?.bar ?? 1} at tick ${note?.tick ?? "?"}, velocity ${note?.velocity ?? "?"}`;
  }
  if (change.kind === "modify") {
    const before = change.before;
    const after = change.after ?? change.proposed;
    return `Changed ${labels[before?.instrument ?? ""] ?? before?.instrument ?? change.note_id} in bar ${before?.bar ?? 1} at tick ${before?.tick ?? "?"}, velocity ${before?.velocity ?? "?"} → ${labels[after?.instrument ?? ""] ?? after?.instrument} in bar ${after?.bar ?? 1} at tick ${after?.tick ?? "?"}, velocity ${after?.velocity ?? "?"}`;
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
  const recording = captureStatus !== "idle";
  const locked = busy || pending || startingPlayback || recording;
  $("new-session").disabled = locked;
  $("record").disabled = busy || pending || startingPlayback;
  $("record").textContent = captureStatus === "recording" ? "Recording… release to finish" : captureStatus === "initializing" ? "Preparing microphone…" : "Hold to record";
  $("record").setAttribute("aria-pressed", String(captureStatus === "recording"));
  $("record-cancel").hidden = !recording && !recordProcessing;
  $("input-offset").disabled = locked;
  $("take-controls").hidden = !takeMemory;
  const canUseTake = takeMemory && recordingStateKey(state) === (takeMemory.appliedPattern ?? recordingStateKey(takeMemory.before));
  for (const id of ["take-start", "take-tempo", "take-rotation", "take-half", "take-double", "take-apply"] as const) $(id).disabled = locked || !canUseTake;
  $("take-export").disabled = !takeMemory || recording;
  $("take-apply").disabled ||= !takeMemory?.decision || takeMemory.decision.mode === "edit";
  $("take-retry").disabled = locked || !takeMemory || !!takeMemory.appliedPattern;
  const fixedTempo = takeMemory?.take.transport.playing || takeMemory?.decision?.mode === "add";
  if (fixedTempo) for (const id of ["take-tempo", "take-half", "take-double"] as const) $(id).disabled = true;
  $("tempo").disabled = locked;
  $("undo").disabled = locked || state.undo_history.length === 0;
  $("kit").disabled = locked;
  document.querySelectorAll<HTMLButtonElement>(".examples button").forEach(button => { button.disabled = locked; });
  $("kit").value = displayedState().pattern.kit_id;
  const currentSwing = state.pattern.swing_percent ?? 50;
  const nextSwing = displayedState().pattern.swing_percent ?? 50;
  $("swing-status").textContent = currentSwing !== nextSwing ? `Swing ${currentSwing}% → ${nextSwing}% next phrase` : nextSwing === 50 ? "Swing off" : `Swing ${nextSwing}%`;
  const currentKit = getKit(state.pattern.kit_id).name;
  $("kit-status").textContent = pendingState && pendingState.pattern.kit_id !== state.pattern.kit_id ? `${currentKit} → ${getKit(pendingState.pattern.kit_id).name} next phrase` : currentKit;
  $("send").disabled = locked;
  $("request").disabled = locked;
  $("clear").disabled = locked || displayedState().pattern.notes.length === 0;
  $("pending").hidden = !pending;
  $("pending").textContent = `Applies next ${pendingBoundary}`;
  $("play").disabled = player.isPlaying() || locked;
  $("stop").disabled = recording || recordProcessing || (!player.isPlaying() && !busy && !startingPlayback);
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
    const started = await player.start(pattern, state.tempo_bpm);
    if (started && version === operationVersion) $("playback-status").textContent = "Playing";
  } catch (error) {
    if (version === operationVersion) $("playback-status").textContent = (error instanceof Error ? error.message : String(error));
  } finally {
    if (version !== operationVersion) return;
    startingPlayback = false;
    updateControls();
  }
}

async function commitOrStage(nextState: PatternState, autoPlay = true, boundary: "beat" | "phrase" = "phrase") {
  if (player.isPlaying()) {
    pendingState = nextState;
    updateControls();
    pendingBoundary = await player.stage(nextState.pattern, nextState.tempo_bpm, boundary) ?? "phrase";
    $("request-status").textContent = `Accepted changes are waiting for the next ${pendingBoundary}.`;
  } else {
    state = nextState;
    $("request-status").textContent = "Changes applied.";
  }
  render();
  persist();
  if (autoPlay && !player.isPlaying()) void startPlayback(state.pattern);
}

async function performRequest(request: string, run: (decide: Decide) => Promise<CommandResult>, local = false) {
  if (busy || pendingState || startingPlayback || captureStatus !== "idle") return;
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
      await player.load(completed.state.pattern);
      if (version !== operationVersion) return;
    }
    completed = recordUndoUnit(state, completed, request);
    const log = { request, local, message: completed.message, routing: completed.routing, visits: completed.visits, plan: completed.plan, passes: completed.passes, result: completed.result, latency_ms: completed.latency_ms ?? 0, model: completed.model, usage: completed.usage, question_count: completed.question_count };
    logs = [...logs, log].slice(-50);
    renderInspector(log);
    const tokens = Number(completed.usage?.input_tokens ?? 0) + Number(completed.usage?.output_tokens ?? 0);
    $("request-meta").textContent = local ? "Local change · No API call" : `${Math.round(completed.latency_ms)} ms · ${completed.question_count} questions · ${completed.passes.length} edit passes · ${completed.model}${tokens ? ` · ${tokens} tokens` : ""}`;
    if (!local) $("request").value = "";
    if (completed.result.applied_changes.length) {
      if (completed.result.applied_changes.some(change => change.kind === "reset")) {
        player.stop();
        $("playback-status").textContent = "Stopped";
      }
      await commitOrStage(completed.state, completed.result.applied_changes.some(change => !["kit", "undo", "swing", "tempo"].includes(change.kind)), !(recordProcessing && takeMemory?.decision?.mode === "replace") && completed.result.applied_changes.every(change => ["add", "modify", "remove"].includes(change.kind)) ? "beat" : "phrase");
    }
    else {
      state = completed.state;
      $("request-status").textContent = completed.message ?? "No changes needed.";
      render();
      persist();
    }
  } catch (error) {
    if (version === operationVersion) {
      const message = error instanceof Error ? error.message : String(error);
      $("request-status").textContent = message;
      if (recordProcessing && takeMemory) {
        takeMemory.error = message;
        const log = { request: "Recorded rhythm failed", message, local: false };
        logs = [...logs, log].slice(-50);
        renderInspector(log); renderHistory(); renderTakeDiagnostics();
      }
    }
  } finally {
    if (version === operationVersion) {
      busy = false;
      requestAbort = null;
      updateControls();
      focusRequest();
    }
  }
}

function editRequest(request: string, decide: Decide) {
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
}

function grooveHandler(request: string, decide: Decide) {
  return (route: Parameters<NonNullable<Parameters<typeof runPatternCommand>[0]["grooveRequest"]>>[0]) => runPatternTree({
      state, request, route: async () => ({ route }),
      searchPresets: request => decide("/api/preset-search", { request }),
      selectPreset: (request, candidate_ids) => decide("/api/preset-select", { request, candidate_ids }),
      interpretRhythm: () => decide("/api/rhythm-fill", { state: stateForJev(state, request) }),
      interpretEdit: () => decide("/api/pattern-edit-intent", { state: stateForJev(state, request) }),
      runEdit: () => runPatternRequest({
        initialState: state, request,
        estimateOperations: sentState => decide("/api/pattern-plan", { state: sentState }),
        decide: (sentState, _pass, plan) => decide("/api/pattern-decision", { state: sentState, instruments: plan.relevant_instruments }),
      }),
    });
}

function commandForRequest(request: string, decide: Decide) {
  return runPatternCommand({
    initialState: state,
    request,
    grooveRequest: grooveHandler(request, decide),
    decideNode: (nodeId, sentState) => {
      $("request-status").textContent = nodeId === "root" ? "Jev is choosing the kind of change…" : nodeId === "change_swing" ? "Jev is adjusting swing…" : nodeId === "change_tempo" ? "Jev is setting tempo…" : "Jev is selecting a kit…";
      return decide("/api/request-decision", { node_id: nodeId, state: sentState });
    },
    editPattern: () => editRequest(request, decide),
  });
}

$("request-form").addEventListener("submit", event => {
  event.preventDefault();
  const request = $("request").value.trim();
  if (request) void performRequest(request, decide => commandForRequest(request, decide));
});

const recorder = createRecorder({
  context: () => player.captureContext(),
  snapshot: () => player.snapshot(state.pattern, Number($("input-offset").value) || 0, state.tempo_bpm),
  onStatus: status => {
    captureStatus = status;
    if (status !== "idle") $("record-status").textContent = status === "initializing" ? "Preparing microphone — keep holding, wait to start." : "Recording now. Demonstrate your beat, then release.";
    updateControls();
  },
  onError: message => { $("record-status").textContent = message; },
  onTake: take => {
    takeMemory = { take, before: createPatternState(state), release_ms: take.release_performance_ms };
    $("take-start").value = "0"; $("take-tempo").value = String(state.tempo_bpm); $("take-rotation").value = "0";
    renderTakeDiagnostics();
    void processTake();
  },
});
function renderTakeDiagnostics() {
  if (!takeMemory) { $("take-diagnostic").textContent = "No retained take."; return; }
  const { take, before, appliedPattern, release_ms, ...details } = takeMemory;
  $("take-diagnostic").textContent = JSON.stringify({
    take_id: take.id, duration_seconds: take.samples.length / take.sample_rate,
    sample_rate: take.sample_rate, transport: take.transport, ...details,
  }, null, 2);
}
function cancelRecording() {
  recorder.cancel();
  if (recordProcessing) { operationVersion++; requestAbort?.abort(); requestAbort = null; busy = false; recordProcessing = false; }
  $("record-status").textContent = "Recording request canceled.";
  updateControls();
}
function mappedTake(memory: NonNullable<typeof takeMemory>, manual: boolean): CommandResult {
  const { take, evidence, decision } = memory;
  if (!evidence || !decision || decision.mode === "edit") throw new Error("No recorded rhythm to apply.");
  assertRecordingCurrent(state, memory.before, memory.appliedPattern);
  if (!manual && decision.span === "unresolved") throw new Error("Choose the demonstration start below, then apply the take.");
  const span = evidence.spans.find(item => item.id === decision.span) ?? evidence.spans[0];
  const timingIndex = Number(decision.timing.replace("timing_", ""));
  const tempo = (span.tempos[timingIndex] ?? span.tempos[0]).tempo_bpm;
  if (!manual) { $("take-start").value = String(span.start_seconds); $("take-tempo").value = String(tempo); }
  const mapped = mapRecording({ hits: evidence.hits, start_context_seconds: take.start_context_seconds, transport: take.transport,
    mode: decision.mode, instrument: decision.instrument, start_seconds: Number($("take-start").value), tempo_bpm: Number($("take-tempo").value), rotation_slots: Number($("take-rotation").value) });
  const result = applyRecording(memory.before, mapped, take.id, memory.transcript?.text.trim().slice(0, 500) || "Recorded rhythm");
  // Manual adjustments replace this take against its original base, while preserving session history and undo ownership.
  result.result.applied_changes = recordingDelta(state.pattern, result.state.pattern, state.tempo_bpm, result.state.tempo_bpm);
  result.state.next_note_id = Math.max(result.state.next_note_id, state.next_note_id);
  result.state.undo_history = state.undo_history;
  result.state.recent_history = [...state.recent_history, result.result.history_entry].slice(-8);
  memory.diagnostic = { evidence, decision, mapped };
  $("record-status").textContent = span.tempos[0].uncertain ? "Tempo is uncertain. Check playback and adjust tempo if needed." : "Take mapped. Adjust tempo, start, or rotation below.";
  return result;
}
async function processTake(manual = false) {
  const memory = takeMemory;
  if (!memory) return;
  const blocked = busy || pendingState || startingPlayback || captureStatus !== "idle";
  if (blocked) {
    memory.error = "Recording saved. Wait for the current action to finish, then click Retry take.";
    $("record-status").textContent = memory.error;
    renderTakeDiagnostics();
    updateControls();
    return;
  }
  recordProcessing = true;
  memory.error = undefined;
  memory.routing = [];
  if (!manual) memory.decision = undefined;
  const acceptedBefore = operationVersion;
  let completedPattern: string | undefined;
  await performRequest("Recorded rhythm", async decide => {
    const signal = requestAbort!.signal;
    if (manual) {
      const result = mappedTake(memory, true); completedPattern = recordingStateKey(result.state); return result;
    }
    $("record-status").textContent = "Analyzing and transcribing…";
    const hits = analyzeTake(memory.take.samples, memory.take.sample_rate);
    memory.diagnostic = { detected_hits: hits };
    renderTakeDiagnostics();
    if (!memory.transcript) {
      const response = await fetch("/api/transcribe", { method: "POST", signal, headers: { "Content-Type": "audio/wav" }, body: encodeWav(memory.take.samples, memory.take.sample_rate) });
      const data = await response.json();
      signal.throwIfAborted();
      if (!response.ok) throw new Error(data.error ?? "Transcription failed.");
      memory.transcript = data as Transcript;
    }
    memory.evidence = prepareEvidence(memory.transcript, hits, memory.take.transport.tempo_bpm);
    renderTakeDiagnostics();
    const request = memory.transcript.text.trim().slice(0, 500) || "Recorded beatbox demonstration";
    const completed = await runPatternCommand({ initialState: state, request,
      recording: {
        transcript: memory.transcript.text, hit_count: hits.length,
        hit_onsets_seconds: hits.map(hit => Number(hit.onset_seconds.toFixed(3))),
        words: memory.transcript.words.slice(-32),
      },
      grooveRequest: grooveHandler(request, decide),
      decideNode: async (nodeId, sentState) => {
        const decision = await decide<import("../../core/pattern/request-tree.js").NodeDecision>("/api/request-decision", { node_id: nodeId, state: sentState });
        memory.routing?.push({ node_id: nodeId, sent_state: sentState, ...decision });
        renderTakeDiagnostics();
        return decision;
      },
      editPattern: () => editRequest(request, decide),
      recordedRhythm: async () => {
        const response = await decide<{ answers: JevAnswers; model: string; usage: Record<string, number>; latency_ms: number; question_count: number }>("/api/recording-decision", { state: { evidence: memory.evidence, pattern_state: stateForJev(state, request), playback: memory.take.transport } });
        memory.decision = validateRecordingDecision(memory.evidence!, response.answers);
        renderTakeDiagnostics();
        if (memory.decision.mode === "edit") return editRequest(request, decide);
        const result = mappedTake(memory, false);
        return { ...result, model: response.model, usage: response.usage, latency_ms: response.latency_ms, question_count: response.question_count };
      },
    });
    if (memory.decision && memory.decision.mode !== "edit") completedPattern = recordingStateKey(completed.state);
    return completed;
  }, manual);
  if (operationVersion === acceptedBefore + 1) {
    if (completedPattern && recordingStateKey(displayedState()) === completedPattern) {
      memory.appliedPattern = completedPattern;
      $("record-status").textContent += ` Release to result: ${Math.round(performance.now() - memory.release_ms)} ms.`;
    } else $("record-status").textContent = $("request-status").textContent;
    recordProcessing = false;
    renderTakeDiagnostics();
    updateControls();
  }
}
$("record").addEventListener("pointerdown", event => {
  if (event.button !== 0 || $("record").disabled) return;
  event.preventDefault(); idleSubmit.cancel(); $("record").setPointerCapture(event.pointerId); void recorder.start();
});
$("record").addEventListener("pointerup", () => recorder.release());
$("record").addEventListener("pointercancel", cancelRecording);
$("record").addEventListener("lostpointercapture", () => { if (captureStatus !== "idle") recorder.release(); });
$("record").addEventListener("keydown", event => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); idleSubmit.cancel(); void recorder.start(); }
});
$("record").addEventListener("keyup", event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); recorder.release(); } });
$("record").addEventListener("blur", () => { if (captureStatus !== "idle") cancelRecording(); });
$("record").addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("keydown", event => { if (event.key === "Escape" && (captureStatus !== "idle" || recordProcessing)) cancelRecording(); });
window.addEventListener("blur", () => { if (captureStatus !== "idle") cancelRecording(); });
$("record-cancel").addEventListener("click", cancelRecording);
$("take-retry").addEventListener("click", () => { if (takeMemory) takeMemory.release_ms = performance.now(); void processTake(); });
$("take-apply").addEventListener("click", () => { if (takeMemory) takeMemory.release_ms = performance.now(); void processTake(true); });
$("take-half").addEventListener("click", () => { $("take-tempo").value = String(Math.max(30, Number($("take-tempo").value) / 2)); });
$("take-double").addEventListener("click", () => { $("take-tempo").value = String(Math.min(360, Number($("take-tempo").value) * 2)); });
$("take-export").addEventListener("click", () => {
  if (!takeMemory) return;
  const { take, ...diagnostic } = takeMemory;
  const files: [string, Blob][] = [["take.wav", new Blob([encodeWav(take.samples, take.sample_rate)], { type: "audio/wav" })], ["take.json", new Blob([JSON.stringify({ ...diagnostic, take: { ...take, samples: undefined } }, null, 2)], { type: "application/json" })]];
  for (const [name, blob] of files) { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
});

$("kit").addEventListener("change", event => {
  const kitId = $("kit").value;
  const request = `Use ${getKit(kitId).name} (manual)`;
  void performRequest(request, async () => changeKit(state, kitId, request), true);
});

$("tempo").addEventListener("change", () => {
  const value = Math.round(Number($("tempo").value));
  const next = { ...state, tempo_bpm: Math.min(240, Math.max(40, Number.isFinite(value) ? value : 120)) };
  if (player.isPlaying()) {
    // Keep the recording snapshot on the audible tempo and lock capture until
    // the phrase-boundary swap commits the new state.
    void commitOrStage(next, false).catch(error => {
      pendingState = null;
      $("request-status").textContent = error instanceof Error ? error.message : String(error);
      render();
    });
    return;
  }
  state = next;
  player.setTempo(state.tempo_bpm);
  render();
  persist();
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
  takeMemory = null;
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
  if (saved?.state) state = createPatternState({ ...saved.state, tempo_bpm: saved.state.tempo_bpm ?? saved.tempo_bpm });
  if (Array.isArray(saved?.logs)) logs = saved.logs.slice(-50);
  if (logs.length) renderInspector(logs.at(-1));
} catch { $("request-status").textContent = "Browser storage is unavailable; the demo still works for this tab."; }
render();
