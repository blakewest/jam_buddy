import { createDemoStudio } from "./demo.js";
import { bytesToBase64 } from "../../core/demo/recording.js";
import type { DemoView, DemoTake } from "../../core/demo/recording.js";
import { validSelection } from "../../core/pattern/selection.js";
import type { BeatSelection } from "../../core/pattern/selection.js";
import { createGridSelection } from "./selection.js";
import { createRecorder } from "./capture.js";
import { analyzeTake } from "../../core/recording/analysis.js";
import { encodeWav } from "../../core/recording/capture.js";
import type { RecordedTake } from "../../core/recording/capture.js";
import { prepareEvidence, validateRecordingDecision } from "../../core/recording/decision.js";
import type { RecordingEvidence, RecordingDecision } from "../../core/recording/decision.js";
import { mapRecording, applyRecording, recordingDelta, assertRecordingCurrent } from "../../core/recording/rhythm.js";
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
import { runPatternTree } from "../../core/pattern/request-runner.js";
import { swungTick } from "../../core/pattern/swing.js";
import { ticksPerBar } from "../../core/pattern/musical-time.js";

type RequestLog = Partial<CommandResult> & { request: string; local?: boolean; beat_ticks?: number; demo_activity?: DemoView["activity"][number] };
interface SavedSession { state: PatternState; logs: RequestLog[]; tempo_bpm?: number }
type Decide = <T>(url: string, payload: unknown) => Promise<T>;

interface Elements {
  "demo-studio": HTMLElement;
  "demo-record": HTMLButtonElement;
  "demo-play": HTMLButtonElement;
  "demo-download": HTMLButtonElement;
  "demo-load": HTMLButtonElement;
  "demo-file": HTMLInputElement;
  "demo-status": HTMLElement;
  "demo-time": HTMLElement;
  "selection-summary": HTMLElement;
  "clear-selection": HTMLButtonElement;
  "tempo": HTMLInputElement;
  "record": HTMLButtonElement;
  "microphone": HTMLSelectElement;
  "microphone-enable": HTMLButtonElement;
  "record-cancel": HTMLButtonElement;
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
  "jev": HTMLElement;
  "jev-caption": HTMLElement;
  "prompt-heading": HTMLElement;
  "pending": HTMLElement;
  "request-form": HTMLFormElement;
  "request": HTMLTextAreaElement;
  "send": HTMLButtonElement;
  "request-status": HTMLElement;
  "request-meta": HTMLElement;
  "history-heading": HTMLElement;
  "undo": HTMLButtonElement;
  "clear": HTMLButtonElement;
  "new-session": HTMLButtonElement;
  "history-list": HTMLElement;
}

function $<K extends keyof Elements>(id: K): Elements[K] {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as Elements[K];
}
function setRequestStatus(message: string, hint = false) {
  $("request-status").textContent = message;
  $("request-status").classList.toggle("is-hint", hint);
}

const labels: Record<string, string> = { kick: "Kick", snare: "Snare", closed_hat: "Closed hat", open_hat: "Open hat", ride: "Ride", crash: "Crash", high_tom: "High tom", mid_tom: "Mid tom", floor_tom: "Floor tom" };
let demo: ReturnType<typeof createDemoStudio> | undefined;
let replayView: DemoView | null = null;
let replayRestore: { request: string; selection: BeatSelection | null; volume: string } | null = null;
let demoTypingFrame = 0;
let demoTypingText = "";
const defaultRequestPlaceholder = $("request").placeholder;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function typeDemoText(text: string, target: "value" | "placeholder" = "value") {
  if (`${target}:${text}` === demoTypingText) return;
  cancelAnimationFrame(demoTypingFrame);
  demoTypingText = `${target}:${text}`;
  const startedAt = performance.now();
  const letters = Array.from(text);
  const durationMs = Math.min(900, letters.length * 18);
  const tick = () => {
    const progress = reducedMotion.matches || !durationMs ? 1 : Math.min(1, (performance.now() - startedAt) / durationMs);
    $("request")[target] = letters.slice(0, Math.ceil(letters.length * progress)).join("");
    $("request").scrollTop = $("request").scrollHeight;
    if (progress < 1) demoTypingFrame = requestAnimationFrame(tick);
  };
  tick();
}
let state = createPatternState();
let pendingState: PatternState | null = null;
let pendingBoundary: "beat" | "phrase" = "beat";
let logs: RequestLog[] = [];
let busy = false;
let microphoneSetup = false;
let microphoneId = "";
let microphoneLabel = "Selected microphone";
try {
  const saved = JSON.parse(localStorage.getItem("jam-microphone") ?? "null");
  if (typeof saved?.id === "string") microphoneId = saved.id;
  if (typeof saved?.label === "string") microphoneLabel = saved.label;
} catch { /* Device preference is optional when browser storage is unavailable. */ }
let microphoneRefresh = 0;
async function refreshMicrophones() {
  const version = ++microphoneRefresh;
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId);
    if (version !== microphoneRefresh) return;
    const select = $("microphone");
    select.replaceChildren(new Option("System default", ""));
    for (const [index, device] of devices.entries()) {
      if (device.deviceId !== "default") select.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId));
    }
    if (microphoneId && !devices.some(device => device.deviceId === microphoneId)) select.add(new Option(`${microphoneLabel} (unavailable)`, microphoneId));
    select.value = microphoneId;
    select.title = select.selectedOptions[0]?.textContent ?? "Microphone input";
    $("microphone-enable").hidden = devices.some(device => !!device.label);
  } catch { setRequestStatus("Could not list microphones. Check browser microphone permissions."); }
}
$("microphone").addEventListener("change", () => {
  microphoneId = $("microphone").value;
  microphoneLabel = $("microphone").selectedOptions[0]?.textContent ?? "Selected microphone";
  $("microphone").title = microphoneLabel;
  try { localStorage.setItem("jam-microphone", JSON.stringify({ id: microphoneId, label: microphoneLabel })); } catch { /* Recording still works without saved preferences. */ }
});
$("microphone-enable").addEventListener("click", async () => {
  microphoneSetup = true;
  updateControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    await refreshMicrophones();
    setRequestStatus("");
  } catch { setRequestStatus("Allow microphone access in your browser to choose an input."); }
  finally { microphoneSetup = false; updateControls(); }
});
navigator.mediaDevices?.addEventListener("devicechange", () => { void refreshMicrophones(); });
let captureStatus: "idle" | "initializing" | "recording" = "idle";
let recordProcessing = false;
let takeMemory: { take: RecordedTake; before: PatternState; evidence?: RecordingEvidence; decision?: RecordingDecision; transcript?: Transcript; demoTake?: DemoTake } | null = null;
const hitTimers = new Map<string, number>();
let startingPlayback = false;
let operationVersion = 0;
let requestAbort: AbortController | null = null;
const gridSelection = createGridSelection($("pattern-grid"), $("selection-summary"), $("clear-selection"), () => displayedState().pattern, () => busy || !!pendingState || startingPlayback || captureStatus !== "idle" || recordProcessing || !!demo?.isReplaying() || !!demo?.isBusy(), () => demo?.recordView());
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
  for (const timer of hitTimers.values()) window.clearTimeout(timer);
  hitTimers.clear();
  $("jev").className = "jev-kit";
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
  if (demo?.isReplaying()) return;
  try { await storage({ state: pendingState ?? state, logs: logs.slice(-50) }); } catch { setRequestStatus("Browser storage is unavailable; this session will not survive a reload."); }
}

function animateHit(instrument: string) {
    const jev = $("jev");
    const part = instrument === "kick" ? "kick" : instrument.includes("hat") ? "hat" : instrument === "crash" || instrument === "ride" ? "crash" : instrument === "snare" ? "snare" : "tom";
    const side = part === "kick" ? null : part === "hat" || part === "snare" ? "left" : "right";
    for (const name of [`hit-${part}`, ...(side ? [`hit-${side}`] : [])]) {
      window.clearTimeout(hitTimers.get(name));
      jev.classList.remove(name);
      void jev.offsetWidth;
      jev.classList.add(name);
      hitTimers.set(name, window.setTimeout(() => { jev.classList.remove(name); hitTimers.delete(name); }, 320));
    }
}

const player = createPatternPlayer({
  onError: message => { $("playback-status").textContent = message; },
  onHit: instrument => {
    animateHit(instrument);
    demo?.recordHit(instrument as import("../../core/pattern/state.js").Instrument);
  },
  onSwap: () => {
    if (!pendingState) return;
    state = pendingState;
    pendingState = null;
    setRequestStatus("Changes are now playing.");
    render();
    focusRequest();
    persist();
  },
});

function displayedState() {
  return replayView ? replayView.pending_state ?? replayView.state : pendingState ?? state;
}

function renderGrid() {
  const pattern = displayedState().pattern;
  const container = $("pattern-grid");
  container.replaceChildren();
  const barTicks = ticksPerBar(pattern.meter);
  container.style.width = `${70 + pattern.bars * 120}px`;
  container.style.setProperty("--bars", String(pattern.bars));
  const ruler = document.createElement("div"); ruler.className = "bar-ruler";
  ruler.append(document.createElement("span"));
  for (let bar = 1; bar <= pattern.bars; bar++) {
    const label = document.createElement("span"); label.textContent = `BAR ${bar}`; ruler.append(label);
  }
  container.append(ruler);
  for (const instrument of INSTRUMENTS) {
    const row = document.createElement("div"); row.className = `pattern-lane lane-${instrument}`;
    const label = document.createElement("div"); label.className = "grid-label"; label.textContent = labels[instrument];
    const track = document.createElement("div"); track.className = "lane-track";
    for (let beat = 0; beat <= pattern.bars * pattern.meter.numerator; beat++) {
      const line = document.createElement("i"); line.className = beat % pattern.meter.numerator === 0 ? "beat-line bar-line" : "beat-line";
      line.style.left = `${beat / (pattern.bars * pattern.meter.numerator) * 100}%`;
      track.append(line);
    }
    for (const note of pattern.notes.filter(item => item.instrument === instrument)) {
      const marker = document.createElement("span"); marker.className = "note-dot";
      marker.style.left = `${((note.bar - 1) + swungTick(note.tick, pattern.swing_percent ?? 50) / barTicks) / pattern.bars * 100}%`;
      marker.style.setProperty("--velocity", String(note.velocity / 127));
      marker.title = `${labels[instrument]}, bar ${note.bar}, tick ${note.tick}, velocity ${note.velocity}`;
      track.append(marker);
    }
    row.append(label, track); container.append(row);
  }
  $("note-count").textContent = `${pattern.notes.length} note${pattern.notes.length === 1 ? "" : "s"}`;
  $("phrase-bars").textContent = `${pattern.bars} ${pattern.bars === 1 ? "bar" : "bars"}`;
  $("phrase-steps").textContent = `${pattern.meter.numerator}/${pattern.meter.denominator}`;
  $("tempo").value = String(displayedState().tempo_bpm);
  gridSelection.refresh();
}

function activitySteps(log: RequestLog): string[] {
  const names: Record<string, string> = { edit_pattern: "Edit pattern", fill_rhythm: "Fill rhythm", change_kit: "Change kit", another_kit: "Shuffle kit", keep_current: "Keep current kit", load_preset: "Load beat", shuffle_preset: "Shuffle beat", clear_pattern: "Clear beat", clear_selection: "Clear selection", duplicate: "Duplicate", whole_pattern: "Whole groove", selected: "Highlighted selection", undo: "Undo", unsupported: "Unsupported request", recorded_rhythm: "Recorded rhythm", change_tempo: "Change tempo", change_swing: "Change swing", edit_plan: "Plan edits", preset_search: "Find a beat", preset_select: "Choose a beat", rhythm_fill: "Build rhythm", rhythm_interpret: "Choose rhythm", edit_interpret: "Interpret edit", velocity_apply: "Adjust velocity", preset_shuffle: "Pick another beat", preset_load: "Load beat", pattern_clear: "Clear beat", edit_intent: "Interpret edit", velocity_edit: "Adjust velocity" };
  const readable = (value: string) => names[value] ?? value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
  const steps = (log.routing ?? []).flatMap(route => "next_node" in route.outcome ? [readable(route.outcome.next_node)] : [readable(route.outcome.selection)]);
  for (const visit of log.visits ?? []) {
    if (visit.node === "root") continue;
    const label = readable(visit.node);
    if (!steps.includes(label)) steps.push(label);
  }
  return steps.length ? steps : [log.local ? "Direct control" : "Decision not recorded"];
}

function activityActions(log: RequestLog): string[] {
  const changes = log.result?.applied_changes ?? [];
  if (!changes.length) return [log.message ?? "No changes needed."];
  const groups = new Map<string, { count: number; verb: string; suffix: string; instrument: string; place: string }>();
  const actions: string[] = [];
  for (const change of changes) {
    if (!["add", "remove", "modify"].includes(change.kind)) { actions.push(describeChange(change)); continue; }
    const note = change.after ?? change.proposed ?? change.before;
    if (!note) { actions.push(describeChange(change)); continue; }
    const descriptions: { verb: string; suffix: string }[] = [];
    if (change.kind === "modify" && change.before) {
      const before = change.before;
      if (note.velocity !== before.velocity) descriptions.push({ verb: note.velocity > before.velocity ? "Increased volume on" : "Decreased volume on", suffix: "" });
      if (note.bar !== before.bar || note.tick !== before.tick) {
        const earlier = note.bar < before.bar || (note.bar === before.bar && note.tick < before.tick);
        // Small within-bar changes get a gentler label; no timing precision is implied.
        const nudge = note.bar === before.bar && Math.abs(note.tick - before.tick) <= 60;
        descriptions.push({ verb: nudge ? "Nudged" : "Moved", suffix: earlier ? " earlier" : " later" });
      }
      if (note.instrument !== before.instrument) descriptions.push({ verb: "Changed", suffix: ` from ${(labels[before.instrument] ?? before.instrument).toLowerCase()}` });
      else if (note.midi_pitch !== before.midi_pitch) descriptions.push({ verb: "Changed the sound of", suffix: "" });
    }
    if (!descriptions.length) descriptions.push({ verb: change.kind === "add" ? "Added" : change.kind === "remove" ? "Removed" : "Updated", suffix: "" });
    const instrument = (labels[note.instrument] ?? note.instrument).toLowerCase();
    const beat = log.beat_ticks ? Math.floor(note.tick / log.beat_ticks) + 1 : null;
    const place = `bar ${note.bar}${beat ? `, beat ${beat}` : ""}`;
    for (const { verb, suffix } of descriptions) {
      const key = `${verb}:${suffix}:${instrument}:${place}`;
      const group = groups.get(key) ?? { count: 0, verb, suffix, instrument, place };
      group.count++;
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) actions.push(`${group.verb} ${group.count} ${group.instrument} hit${group.count === 1 ? "" : "s"}${group.suffix} · ${group.place}`);
  return actions;
}

function sizeHistory() {
  const list = $("history-list");
  const cards = list.querySelectorAll<HTMLElement>(".activity-card");
  const height = cards.length > 5 ? cards[4].getBoundingClientRect().bottom - cards[0].getBoundingClientRect().top : 0;
  list.style.maxHeight = height > 0 ? `${height}px` : "none";
}

new ResizeObserver(sizeHistory).observe($("history-list"));

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  requestAnimationFrame(sizeHistory);
  const activity = replayView?.activity ?? activitySnapshot();
  if (!activity.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Every groove starts somewhere. Your first move will appear here.";
    list.append(empty);
    return;
  }
  for (const row of [...activity].reverse()) {
    const item = document.createElement("article");
    item.className = "activity-card";
    const body = document.createElement("div");
    body.className = "activity-columns";
    for (const [label, values] of [["Input", [row.request]], ["Jev decisions", row.steps], ["Actions", row.actions]] as const) {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = label;
      section.append(heading);
      const content = document.createElement(label === "Input" ? "p" : "ul");
      content.className = label === "Jev decisions" ? "decision-path" : label === "Actions" ? "activity-actions" : "activity-input";
      if (label === "Input") content.textContent = values[0];
      else for (const value of values) {
        const line = document.createElement("li");
        line.textContent = value;
        content.append(line);
      }
      section.append(content);
      body.append(section);
    }
    item.append(body);
    list.append(item);
  }
}

function describeChange(change: CommandResult["result"]["applied_changes"][number]) {
  if (change.kind === "tempo") return `Tempo: ${change.before_bpm} → ${change.after_bpm} BPM`;
  if (change.kind === "undo") return `Undid: ${change.request}`;
  if (change.kind === "swing") return `Swing: ${change.before_swing}% → ${change.after_swing}%`;
  if (change.kind === "kit") return `Changed kit: ${getKit(change.before_kit!).name} → ${getKit(change.after_kit!).name}`;
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
  if (change.kind === "preset" || change.kind === "load_preset") return `Loaded ${change.preset_name ?? "a new beat"}`;
  return change.source ?? "Updated the groove";
}

function activitySnapshot() {
  return logs.map(log => log.demo_activity ?? ({ request: log.request, steps: activitySteps(log), actions: activityActions(log), details: log }));
}

function demoSnapshot(): DemoView {
  const selection = gridSelection.snapshot();
  return { state, pending_state: pendingState, selection: selection && validSelection(selection, displayedState().pattern) ? selection : null, activity: activitySnapshot(),
    request: $("request").value, request_status: $("request-status").textContent ?? "", playback_status: $("playback-status").textContent ?? "",
    playing: player.isPlaying(), volume: Number($("volume").value), capturing: captureStatus === "recording" };
}

function updateDemoControls() {
  if (!demo) return;
  const liveBusy = busy || !!pendingState || startingPlayback || captureStatus !== "idle" || recordProcessing || microphoneSetup;
  const recording = demo.isRecording();
  const replaying = demo.isReplaying();
  $("demo-record").textContent = recording ? "■ Finish recording" : "● Record demo";
  $("demo-record").classList.toggle("is-recording", recording);
  $("demo-record").disabled = liveBusy || replaying || demo.isBusy();
  $("demo-play").textContent = replaying ? "■ Stop demo" : "▶ Play demo";
  $("demo-play").classList.toggle("is-playing", replaying);
  $("demo-play").disabled = !replaying && (liveBusy || recording || demo.isBusy() || !demo.hasSaved());
  $("demo-download").disabled = recording || replaying || demo.isBusy() || !demo.hasSaved();
  $("demo-load").disabled = liveBusy || recording || replaying || demo.isBusy();
  $("demo-status").textContent = demo.message();
  $("demo-play").title = demo.message();
  const seconds = Math.floor((recording || replaying ? demo.elapsed() : demo.duration()) / 1000);
  $("demo-time").textContent = recording || replaying || demo.hasSaved() ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
  if (replaying && demo.caption()) typeDemoText(demo.caption());
}

function updateControls() {
  const demoLocked = !!demo?.isReplaying() || !!demo?.isBusy();
  const currentState = replayView?.state ?? state;
  const currentPending = replayView ? replayView.pending_state : pendingState;
  const playing = replayView?.playing ?? player.isPlaying();
  const pending = currentPending !== null;
  const recording = captureStatus !== "idle";
  const locked = busy || pending || startingPlayback || recording || microphoneSetup || demoLocked;
  $("microphone").disabled = locked;
  $("microphone-enable").disabled = locked;
  $("new-session").disabled = locked;
  $("clear-selection").disabled = locked;
  $("record").disabled = busy || pending || startingPlayback || microphoneSetup || demoLocked;
  $("record").textContent = captureStatus === "recording" ? "Recording… release to finish" : captureStatus === "initializing" ? "Preparing microphone…" : "Hold to speak";
  $("record").setAttribute("aria-pressed", String(captureStatus === "recording"));
  $("record-cancel").hidden = !recording && !recordProcessing;
  $("tempo").disabled = locked;
  $("undo").disabled = locked || state.undo_history.length === 0;
  $("kit").disabled = locked;
  document.querySelectorAll<HTMLButtonElement>(".examples button").forEach(button => { button.disabled = locked; });
  $("kit").value = displayedState().pattern.kit_id;
  const currentSwing = currentState.pattern.swing_percent ?? 50;
  const nextSwing = displayedState().pattern.swing_percent ?? 50;
  $("swing-status").textContent = currentSwing !== nextSwing ? `Swing ${currentSwing}% → ${nextSwing}% next beat` : nextSwing === 50 ? "Swing off" : `Swing ${nextSwing}%`;
  $("swing-status").classList.toggle("is-active", currentSwing !== nextSwing || nextSwing !== 50);
  const currentKit = getKit(currentState.pattern.kit_id).name;
  $("kit-status").textContent = currentPending && currentPending.pattern.kit_id !== currentState.pattern.kit_id ? `${currentKit} → ${getKit(currentPending.pattern.kit_id).name} next beat` : currentKit;
  $("kit-status").classList.toggle("is-active", !!currentPending && currentPending.pattern.kit_id !== currentState.pattern.kit_id);
  $("send").disabled = locked;
  $("request").disabled = locked && !demo?.isReplaying();
  $("request").readOnly = !!demo?.isReplaying();
  $("clear").disabled = locked || displayedState().pattern.notes.length === 0;
  $("pending").hidden = !pending;
  $("pending").textContent = `Applies next ${pendingBoundary}`;
  $("play").disabled = playing || locked;
  $("stop").disabled = demoLocked || recording || recordProcessing || (!player.isPlaying() && !busy && !startingPlayback);
  $("volume").disabled = demoLocked;
  $("jev-caption").textContent = playing ? "JEV IS PLAYING" : "JEV IS READY";
  updateDemoControls();
  demo?.recordView();
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

async function commitOrStage(nextState: PatternState, autoPlay = true, boundary: "beat" | "phrase" = "beat") {
  if (player.isPlaying()) {
    pendingState = nextState;
    updateControls();
    pendingBoundary = await player.stage(nextState.pattern, nextState.tempo_bpm, boundary) ?? "beat";
    setRequestStatus(`Accepted changes are waiting for the next ${pendingBoundary}.`);
  } else {
    state = nextState;
    setRequestStatus("Changes applied.");
  }
  gridSelection.clear();
  render();
  persist();
  if (autoPlay && !player.isPlaying()) void startPlayback(state.pattern);
}

async function performRequest(request: string, run: (decide: Decide) => Promise<CommandResult>, local = false) {
  if (busy || pendingState || startingPlayback || captureStatus !== "idle" || demo?.isReplaying() || demo?.isBusy()) return;
  busy = true;
  const version = ++operationVersion;
  requestAbort = new AbortController();
  const signal = requestAbort.signal;
  const selection = gridSelection.snapshot();
  updateControls();
  setRequestStatus(local ? "Applying change…" : "Jev is choosing the kind of change…");
  const decide: Decide = async <T>(url: string, payload: unknown): Promise<T> => {
    signal.throwIfAborted();
    const started = performance.now();
    const response = await fetch(url, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(payload as object), ...(selection ? { selection } : {}) }) });
    const data = await response.json();
    demo?.recordCall({ at_ms: demo.elapsed(), path: url, status: response.status, request: { ...(payload as object), ...(selection ? { selection } : {}) }, response: data });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(data.error ?? `Request failed with HTTP ${response.status}.`);
    return { ...data, latency_ms: performance.now() - started };
  };
  try {
    let completed = await run(decide);
    if (version !== operationVersion) return;
    if (completed.result.applied_changes.length) {
      setRequestStatus("Preparing sounds…");
      await player.load(completed.state.pattern);
      if (version !== operationVersion) return;
    }
    const savedRequest = recordProcessing && takeMemory?.transcript ? takeMemory.transcript.text.trim().slice(0, 500) || request : request;
    completed = recordUndoUnit(state, completed, savedRequest);
    const log = { request: savedRequest, local, beat_ticks: state.pattern.ticks_per_quarter * 4 / state.pattern.meter.denominator, message: completed.message, routing: completed.routing, visits: completed.visits, plan: completed.plan, passes: completed.passes, result: completed.result, latency_ms: completed.latency_ms ?? 0, model: completed.model, usage: completed.usage, question_count: completed.question_count };
    logs = [...logs, log].slice(-50);

    const tokens = Number(completed.usage?.input_tokens ?? 0) + Number(completed.usage?.output_tokens ?? 0);
    $("request-meta").textContent = local ? "Local change · No API call" : `${Math.round(completed.latency_ms)} ms · ${completed.question_count} questions · ${completed.passes.length} edit passes · ${completed.model}${tokens ? ` · ${tokens} tokens` : ""}`;
    if (!local) $("request").value = "";
    if (completed.result.applied_changes.length) {
      await commitOrStage(completed.state, completed.result.applied_changes.some(change => !["kit", "undo", "swing", "tempo"].includes(change.kind)));
    }
    else {
      state = completed.state;
      setRequestStatus(local ? completed.message ?? "No changes needed." : "Hey, I didn’t quite get that. Try another command?", !local);
      render();
      persist();
    }
  } catch (error) {
    if (version === operationVersion) {
      const message = error instanceof Error ? error.message : String(error);
      setRequestStatus(message);
      if (recordProcessing && takeMemory) {
        const log = { request: "Recorded rhythm failed", message, local: false };
        logs = [...logs, log].slice(-50);
        renderHistory();
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
      setRequestStatus(`Jev is considering edit ${pass} of ${plannedOperationCount}…`);
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
    selection: gridSelection.snapshot() ?? undefined,
    initialState: state,
    request,
    grooveRequest: grooveHandler(request, decide),
    decideNode: (nodeId, sentState) => {
      setRequestStatus(nodeId === "root" ? "Jev is choosing the kind of change…" : nodeId === "change_swing" ? "Jev is adjusting swing…" : nodeId === "change_tempo" ? "Jev is setting tempo…" : "Jev is selecting a kit…");
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
  deviceId: () => microphoneId,
  recordingDestination: () => demo?.microphoneDestination(),
  context: () => player.captureContext(),
  snapshot: () => player.snapshot(state.pattern, 0, state.tempo_bpm),
  onStatus: status => {
    captureStatus = status;
    if (status === "recording") void refreshMicrophones();
    if (status !== "idle") setRequestStatus(status === "initializing" ? "Preparing microphone — keep holding." : "Recording now. Release when you’re done.");
    updateControls();
  },
  onError: message => { setRequestStatus(message); },
  onTake: take => {
    takeMemory = { take, before: createPatternState(state) };
    if (demo?.isRecording()) {
      const durationMs = take.samples.length / take.sample_rate * 1000;
      takeMemory.demoTake = { id: take.id, at_ms: Math.max(0, demo.elapsed() - (performance.now() - take.release_performance_ms) - durationMs), duration_ms: durationMs,
        audio: { mime_type: "audio/wav", base64: bytesToBase64(new Uint8Array(encodeWav(take.samples, take.sample_rate))) },
        metadata: { sample_rate: take.sample_rate, start_context_seconds: take.start_context_seconds, release_performance_ms: take.release_performance_ms, transport: take.transport } };
      demo.recordTake(takeMemory.demoTake);
    }
    void processTake();
  },
});
function cancelRecording() {
  recorder.cancel();
  if (recordProcessing) { operationVersion++; requestAbort?.abort(); requestAbort = null; busy = false; recordProcessing = false; }
  takeMemory = null;
  setRequestStatus("Recording canceled.");
  updateControls();
}
function mappedTake(memory: NonNullable<typeof takeMemory>): CommandResult {
  const { take, evidence, decision } = memory;
  if (!evidence || !decision || decision.mode === "edit") throw new Error("No recorded rhythm to apply.");
  assertRecordingCurrent(state, memory.before);
  if (decision.span === "unresolved") throw new Error("Could not place that rhythm. Try another recording.");
  const span = evidence.spans.find(item => item.id === decision.span) ?? evidence.spans[0];
  const timingIndex = Number(decision.timing.replace("timing_", ""));
  const tempo = (span.tempos[timingIndex] ?? span.tempos[0]).tempo_bpm;
  const mapped = mapRecording({ hits: evidence.hits, start_context_seconds: take.start_context_seconds, transport: take.transport,
    mode: decision.mode, instrument: decision.instrument, start_seconds: span.start_seconds, tempo_bpm: tempo, rotation_slots: 0 });
  const result = applyRecording(memory.before, mapped, take.id, memory.transcript?.text.trim().slice(0, 500) || "Recorded rhythm");
  result.result.applied_changes = recordingDelta(state.pattern, result.state.pattern, state.tempo_bpm, result.state.tempo_bpm);
  result.state.next_note_id = Math.max(result.state.next_note_id, state.next_note_id);
  result.state.undo_history = state.undo_history;
  result.state.recent_history = [...state.recent_history, result.result.history_entry].slice(-8);
  if (span.tempos[0].uncertain) setRequestStatus("Tempo may need adjusting after this take.");
  return result;
}
async function processTake() {
  const memory = takeMemory;
  if (!memory) return;
  const blocked = busy || pendingState || startingPlayback || captureStatus !== "idle";
  if (blocked) {
    setRequestStatus("Jev is busy. Try recording again in a moment.");
    takeMemory = null;
    updateControls();
    return;
  }
  recordProcessing = true;
  const acceptedBefore = operationVersion;
  await performRequest("Recorded rhythm", async decide => {
    const signal = requestAbort!.signal;
    setRequestStatus("Analyzing and transcribing…");
    const hits = analyzeTake(memory.take.samples, memory.take.sample_rate);
    if (!memory.transcript) {
      const response = await fetch("/api/transcribe", { method: "POST", signal, headers: { "Content-Type": "audio/wav" }, body: encodeWav(memory.take.samples, memory.take.sample_rate) });
      const data = await response.json();
      demo?.recordCall({ at_ms: demo.elapsed(), path: "/api/transcribe", status: response.status, request: { take_id: memory.take.id }, response: data });
      signal.throwIfAborted();
      if (!response.ok) throw new Error(data.error ?? "Transcription failed.");
      memory.transcript = data as Transcript;
      if (memory.demoTake) { memory.demoTake.transcript = memory.transcript; demo?.recordTake(memory.demoTake); }
    }
    memory.evidence = prepareEvidence(memory.transcript, hits, memory.take.transport.tempo_bpm);
    const request = memory.transcript.text.trim().slice(0, 500) || "Recorded beatbox demonstration";
    $("request").value = request;
    demo?.recordView();
    const completed = await runPatternCommand({ initialState: state, request, selection: gridSelection.snapshot() ?? undefined,
      recording: {
        transcript: memory.transcript.text, hit_count: hits.length,
        hit_onsets_seconds: hits.map(hit => Number(hit.onset_seconds.toFixed(3))),
        words: memory.transcript.words.slice(-32),
      },
      grooveRequest: grooveHandler(request, decide),
      decideNode: (nodeId, sentState) => decide("/api/request-decision", { node_id: nodeId, state: sentState }),
      editPattern: () => editRequest(request, decide),
      recordedRhythm: async () => {
        const response = await decide<{ answers: JevAnswers; model: string; usage: Record<string, number>; latency_ms: number; question_count: number }>("/api/recording-decision", { state: { evidence: memory.evidence, pattern_state: stateForJev(state, request), playback: memory.take.transport } });
        memory.decision = validateRecordingDecision(memory.evidence!, response.answers);
        if (memory.decision.mode === "edit") return editRequest(request, decide);
        const result = mappedTake(memory);
        return { ...result, model: response.model, usage: response.usage, latency_ms: response.latency_ms, question_count: response.question_count };
      },
    });
    if (memory.demoTake) {
      memory.demoTake.metadata = { ...(memory.demoTake.metadata as object), evidence: memory.evidence, decision: memory.decision };
      demo?.recordTake(memory.demoTake);
    }
    return completed;
  });
  if (operationVersion === acceptedBefore + 1) {
    recordProcessing = false;
    takeMemory = null;
    updateControls();
  }
}
$("record").addEventListener("pointerdown", event => {
  if (event.button !== 0 || $("record").disabled) return;
  event.preventDefault(); $("record").setPointerCapture(event.pointerId); void recorder.start();
});
$("record").addEventListener("pointerup", () => recorder.release());
$("record").addEventListener("pointercancel", cancelRecording);
$("record").addEventListener("lostpointercapture", () => { if (captureStatus !== "idle") recorder.release(); });
$("record").addEventListener("keydown", event => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); void recorder.start(); }
});
$("record").addEventListener("keyup", event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); recorder.release(); } });
$("record").addEventListener("blur", () => { if (captureStatus !== "idle") cancelRecording(); });
$("record").addEventListener("contextmenu", event => event.preventDefault());
document.addEventListener("keydown", event => { if (event.key === "Escape" && (captureStatus !== "idle" || recordProcessing)) cancelRecording(); });
window.addEventListener("blur", () => { if (captureStatus !== "idle") cancelRecording(); });
$("record-cancel").addEventListener("click", cancelRecording);

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
    // the beat-boundary swap commits the new state.
    void commitOrStage(next, false).catch(error => {
      pendingState = null;
      setRequestStatus(error instanceof Error ? error.message : String(error));
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

$("request").addEventListener("input", () => {
  $("request").classList.remove("demo-invite");
  void player.unlock().catch(() => {});
});

const unlockAudio = () => { void player.unlock().catch(() => {}); };
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("keydown", unlockAudio);

$("play").addEventListener("click", async () => {
  await startPlayback(state.pattern);
});

$("stop").addEventListener("click", () => {
  cancelWork();
  if (pendingState) { state = pendingState; pendingState = null; persist(); }
  $("playback-status").textContent = "Stopped";
  setRequestStatus("Stopped. Ready for your next request.");
  render();
});

$("volume").addEventListener("input", () => { player.setVolume(Number($("volume").value)); demo?.recordView(); });

$("undo").addEventListener("click", () => {
  void performRequest("Undo (manual)", async () => undoLastChange(state, "Undo (manual)"), true);
});

$("clear").addEventListener("click", () => {
  const entry = { request: "Clear pattern (manual)", applied_changes: ["Cleared the whole pattern"], rejected_changes: [] };
  const next = appendHistory({ ...createPatternState(state), pattern: { ...state.pattern, notes: [] } }, entry);
  const result: CommandResult["result"] = { candidates: [], applied_changes: [{ kind: "reset" }], rejected_changes: [], ignored_changes: [], history_entry: entry };
  const log = { request: entry.request, result, local: true };
  logs = [...logs, log].slice(-50);

  commitOrStage(recordUndoUnit(state, { state: next, result }, entry.request).state);
});

$("new-session").addEventListener("click", () => {
  cancelWork();
  state = createPatternState();
  gridSelection.clear();
  takeMemory = null;
  $("request").value = "";
  pendingState = null;
  logs = [];
  $("playback-status").textContent = "Stopped";
  setRequestStatus("New empty session ready.");
  $("request-meta").textContent = "No API call yet";

  render();
  persist();
});

document.querySelector(".examples")?.addEventListener("click", event => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  if (event.target.dataset.branch === "recorded_rhythm") {
    setRequestStatus("Hold ‘Hold to speak’, say which drum to use, then beatbox your rhythm. Release to send it to Jev.");
    $("record").focus();
    return;
  }
  $("request").value = event.target.textContent ?? "";
  $("request").focus();
  void player.unlock().catch(() => {});
});

window.addEventListener("pagehide", cancelWork);

let demoAuthoring = false;
try {
  const response = await fetch("/api/demo-config");
  if (response.ok) demoAuthoring = (await response.json()).authoring === true;
} catch { /* The public demo remains available without authoring configuration. */ }
$("demo-studio").hidden = !demoAuthoring;
for (const id of ["demo-record", "demo-download", "demo-load"] as const) $(id).hidden = !demoAuthoring;
demo = createDemoStudio({
  authoring: demoAuthoring,
  context: () => player.captureContext(),
  connectOutput: destination => player.connectRecording(destination),
  view: demoSnapshot,
  onChange: updateControls,
  onReplayHit: animateHit,
  onReplayView: view => {
    if (view.request && view.request !== replayView?.request) typeDemoText(view.request);
    replayView = view;
    setRequestStatus(view.request_status);
    $("playback-status").textContent = view.playback_status;
    $("volume").value = String(view.volume);
    gridSelection.set(view.selection);
    render();
  },
  onReplayEnd: (completed, finalView) => {
    cancelAnimationFrame(demoTypingFrame);
    demoTypingText = "";
    if (completed && finalView) {
      state = createPatternState(finalView.pending_state ?? finalView.state);
      pendingState = null;
      logs = finalView.activity.slice(-50).map(row => ({ request: row.request, demo_activity: row }));
      $("volume").value = String(finalView.volume);
      player.setVolume(finalView.volume);
      void persist();
    }
    replayView = null;
    for (const timer of hitTimers.values()) window.clearTimeout(timer);
    hitTimers.clear();
    $("jev").className = "jev-kit";
    $("request").value = completed ? "" : replayRestore?.request ?? "";
    $("request").placeholder = defaultRequestPlaceholder;
    if (completed) {
      typeDemoText("and now your turn! Keep building on this beat or start fresh!", "placeholder");
      $("request").classList.add("demo-invite");
    }
    gridSelection.set(completed ? null : replayRestore?.selection ?? null);
    if (!completed && replayRestore) $("volume").value = replayRestore.volume;
    replayRestore = null;
    $("playback-status").textContent = "Stopped";
    setRequestStatus(completed ? "Demo finished. Your turn to build a beat." : "Demo stopped. Your working beat is unchanged.");
    render();
  },
});
$("demo-record").addEventListener("click", () => { if (demo?.isRecording()) void demo.finish(); else void demo?.start(); });
$("demo-play").addEventListener("click", () => {
  $("demo-play").classList.remove("demo-invite");
  $("request").classList.remove("demo-invite");
  cancelAnimationFrame(demoTypingFrame);
  demoTypingText = "";
  if (demo?.isReplaying()) { demo.stopReplay(); return; }
  replayRestore = { request: $("request").value, selection: gridSelection.snapshot(), volume: $("volume").value };
  $("request").value = "";
  $("request").placeholder = "Listen to the demo…";
  cancelWork();
  void demo?.play();
});
$("demo-download").addEventListener("click", () => demo?.download());
$("demo-load").addEventListener("click", () => $("demo-file").click());
$("demo-file").addEventListener("change", () => {
  const file = $("demo-file").files?.[0];
  if (file) void demo?.loadFile(file);
  $("demo-file").value = "";
});
window.addEventListener("pagehide", () => { demo?.stopReplay(); if (demo?.isRecording()) void demo.finish(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) demo?.stopReplay(); });

try {
  const saved = await storage();
  if (saved?.state) state = createPatternState({ ...saved.state, tempo_bpm: saved.state.tempo_bpm ?? saved.tempo_bpm });
  if (Array.isArray(saved?.logs)) logs = saved.logs.slice(-50);
} catch { setRequestStatus("Browser storage is unavailable; the demo still works for this tab."); }
render();

void refreshMicrophones();

void demo.restore().then(() => {
  if (demo?.hasSaved() && !demo.isReplaying()) $("demo-play").classList.add("demo-invite");
});
