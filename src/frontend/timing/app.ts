import type { Recording, TimingRequestRow } from "../../core/timing/session.js";
import type { RunSnapshot } from "../../core/timing/runner.js";
import { CONFIG, makeFixture, summarize, drumWindows, drumHitsBetween, validateRecording } from "../../core/timing/session.js";
import { createAudio } from "./audio.js";
import { createRun } from "../../core/timing/runner.js";

interface Elements {
  "mode": HTMLSelectElement;
  "play": HTMLButtonElement;
  "stop": HTMLButtonElement;
  "volume": HTMLInputElement;
  "status": HTMLElement;
  "phase": HTMLElement;
  "clock": HTMLElement;
  "bar": HTMLElement;
  "piano-track": HTMLElement;
  "piano-status": HTMLElement;
  "drum-track": HTMLElement;
  "drum-status": HTMLElement;
  "median": HTMLElement;
  "p95": HTMLElement;
  "deadlines": HTMLElement;
  "agreement": HTMLElement;
  "details": HTMLElement;
  "download": HTMLButtonElement;
  "import": HTMLInputElement;
  "log": HTMLTableSectionElement;
  "inspector": HTMLDetailsElement;
  "payload": HTMLElement;
  "recording-status": HTMLElement;
}

function $<K extends keyof Elements>(id: K): Elements[K] {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as Elements[K];
}
const audio = createAudio();
let run: ReturnType<typeof createRun> | null = null;
let saved: Recording | null = null;
let rows: TimingRequestRow[] = [];
let lastRender = -1, lastCount = -1;
const ms = (value: number | null | undefined) => value == null ? "—" : `${Math.round(value)} ms`;
const seconds = (value: number) => `${(value / 1000).toFixed(2)} s`;

async function storage(value?: Recording): Promise<Recording | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("jam-partner", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<Recording | undefined>((resolve, reject) => {
      const tx = db.transaction("recordings", value ? "readwrite" : "readonly");
      const request = value ? tx.objectStore("recordings").put(value, "last") : tx.objectStore("recordings").get("last");
      tx.oncomplete = () => resolve(value === undefined ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

function position(element: HTMLElement, left: number, width?: number) {
  element.style.left = `${left}%`;
  if (width !== undefined) element.style.width = `${width}%`;
}

function timeline(recording: Pick<Recording, "fixture" | "actions" | "duration_ms">, now: number) {
  const cycleStart = Math.floor(now / CONFIG.cycle_ms) * CONFIG.cycle_ms;
  const piano = $("piano-track");
  piano.replaceChildren();
  for (const event of recording.fixture) {
    if (event.type !== "note_on" || !event.velocity) continue;
    const note = document.createElement("span"); note.className = "note";
    position(note, event.time_ms / 160, 350 / 160);
    note.style.top = `${8 + event.note % 3 * 10}px`;
    piano.append(note);
  }
  const drums = $("drum-track"); drums.replaceChildren();
  const visibleActions = recording.actions.filter(action => (action.received_ms ?? action.effective_ms ?? Infinity) <= now);
  const windows = drumWindows(visibleActions, run?.active ? 600000 : recording.duration_ms);
  for (const window of windows) {
    const start = Math.max(cycleStart, window.start), end = Math.min(cycleStart + 16000, window.end);
    if (end <= start) continue;
    const region = document.createElement("span"); region.className = "drum-region";
    position(region, (start - cycleStart) / 160, (end - start) / 160); drums.append(region);
  }
  for (const hit of drumHitsBetween(cycleStart, cycleStart + 16000, windows)) {
    if (hit.instrument === "hat") continue;
    const marker = document.createElement("span"); marker.className = "drum-hit";
    position(marker, (hit.time_ms - cycleStart) / 160); drums.append(marker);
  }
  for (const target of [piano, drums]) {
    const head = document.createElement("span"); head.className = "playhead";
    position(head, (now - cycleStart) / 160); target.append(head);
  }
}

function render({ now, session, recording, active, mode }: RunSnapshot) {
  if (active && now - lastRender < 100) return;
  lastRender = now;
  $("clock").textContent = `${String(Math.floor(now / 60000)).padStart(2, "0")}:${(now / 1000 % 60).toFixed(1).padStart(4, "0")}`;
  $("bar").textContent = `Bar ${Math.floor(now / 2000) + 1} · beat ${Math.floor(now % 2000 / 500) + 1}`;
  const playing = now % 16000 >= 4000 && now % 16000 < 11850;
  $("phase").textContent = playing ? "Piano is playing" : "Piano is resting";
  $("piano-status").textContent = session.pressed.size + session.sustained.size ? "Playing" : "Silent";
  const visibleActions = recording.actions.filter(action => (action.received_ms ?? action.effective_ms ?? Infinity) <= now);
  const windows = drumWindows(visibleActions, active ? 600000 : recording.duration_ms);
  const drumPlaying = windows.some(w => now >= w.start && now < w.end);
  $("drum-status").textContent = drumPlaying ? "Playing" : mode !== "replay" && session.scheduledStart !== null ? `At ${seconds(session.scheduledStart)}` : "Stopped";
  rows = mode === "replay" ? recording.requests.filter(row => (row.received_ms ?? Infinity) <= now) : recording.requests;
  const metrics = summarize(rows);
  $("median").textContent = ms(metrics.median);
  $("p95").textContent = ms(metrics.p95);
  $("deadlines").textContent = `${metrics.starts} / ${metrics.missed}`;
  $("agreement").textContent = metrics.agreement === null ? "—" : `${metrics.agreement.toFixed(1)}%`;
  const latest = rows.at(-1);
  const latestAction = [...rows].reverse().find(row => row.outcome?.accepted);
  $("details").textContent = `${metrics.count} completed requests · ${metrics.errors} errors · ${recording.skipped_ticks ?? 0} busy ticks skipped · ${recording.backoff_ticks ?? 0} backoff ticks · worst ${ms(metrics.worst)} · first call ${rows[0]?.error ? "error" : ms(rows[0]?.round_trip_ms)} · latest snapshot age ${latest ? ms((latest.received_ms ?? now) - latest.snapshot_ms) : "—"} · last action delay ${latestAction ? ms((latestAction.outcome?.effective_ms ?? now) - latestAction.snapshot_ms) : "—"} · ${recording.scheduler_late_hits ?? 0} late audio hits (max ${ms(recording.scheduler_max_late_ms ?? 0)}) · ${latest?.model ?? mode}${mode === "replay" ? " · recorded metrics; no API calls" : ""}`;
  if (rows.length !== lastCount) {
    lastCount = rows.length;
    const body = $("log"); body.replaceChildren();
    for (let index = rows.length - 1; index >= Math.max(0, rows.length - 80); index--) {
      const row = rows[index], tr = document.createElement("tr"); tr.dataset.index = String(index); tr.tabIndex = 0;
      const outcome = row.error ?? (row.outcome?.accepted ? `${row.outcome.action === "start_next_bar" ? "Scheduled" : "Stopped"} at ${seconds(row.outcome.effective_ms ?? now)}` : row.outcome?.reason?.replaceAll("_", " ") ?? "Recorded");
      const values = [seconds(row.received_ms ?? now), row.response?.choice?.replaceAll("_", " ") ?? "Error", ms(row.round_trip_ms), outcome];
      values.forEach((value, i) => { const td = document.createElement("td"); td.textContent = value; if (i === 1) td.className = row.error ? "error" : row.response?.choice === "start_next_bar" ? "start" : row.response?.choice === "stop" ? "stop" : ""; tr.append(td); });
      body.append(tr);
    }
    if (!rows.length) { const tr = body.insertRow(); const td = tr.insertCell(); td.colSpan = 4; td.className = "empty"; td.textContent = "Your first decision will appear here."; }
  }
  timeline(recording, now);
}

function inspect(event: Event) {
  if (event instanceof KeyboardEvent && event.key !== "Enter") return;
  const index = event.target instanceof Element ? event.target.closest("tr")?.dataset.index : undefined;
  if (index === undefined) return;
  $("payload").textContent = JSON.stringify(rows[Number(index)], null, 2);
  $("inspector").open = true;
}
$("log").addEventListener("click", inspect);
$("log").addEventListener("keydown", inspect);

$("play").addEventListener("click", async () => {
  const mode = $("mode").value;
  if (mode !== "live" && mode !== "mock" && mode !== "replay") return;
  if (mode === "replay" && !saved) { $("status").textContent = "Run a test or import a recording first."; return; }
  $("play").disabled = true; $("mode").disabled = true;
  lastCount = -1; lastRender = -1;
  run = createRun({ mode, audio, recording: mode === "replay" ? saved ?? undefined : undefined, onUpdate: render, onFinish: async (recording, reason, finishedMode) => {
    $("play").disabled = false; $("stop").disabled = true; $("mode").disabled = false; $("status").textContent = reason;
    if (finishedMode !== "replay") {
      recording.audio = audio.getInfo();
      saved = recording; $("download").disabled = false;
      try { await storage(recording); $("recording-status").textContent = `${finishedMode === "live" ? "Live" : "Mock"} recording saved in this browser. Replay or download it.`; }
      catch { $("recording-status").textContent = "Browser storage unavailable. Download this recording to keep it."; }
    }
  } });
  try {
    await run.start();
    $("stop").disabled = false;
    $("status").textContent = mode === "live" ? "Live · sending fixture snapshots to TypeSafe." : mode === "replay" ? "Replaying recorded actions · no API calls." : "Mock · deterministic decisions, no API calls.";
  } catch (error) { $("status").textContent = (error instanceof Error ? error.message : String(error)); $("play").disabled = false; $("mode").disabled = false; }
});
$("stop").addEventListener("click", () => run?.stop());
$("mode").addEventListener("change", () => { $("play").textContent = $("mode").value === "replay" ? "▶ Replay saved run" : "▶ Play 60-second test"; });
$("volume").addEventListener("input", event => audio.setVolume(Number($("volume").value)));
document.addEventListener("visibilitychange", () => { if (document.hidden) run?.stop("Tab hidden; run ended to keep timing measurements valid."); });
window.addEventListener("pagehide", () => run?.stop("Page closed."));
$("download").addEventListener("click", () => {
  if (!saved) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(saved)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `jam-partner-${saved.mode}-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import").addEventListener("change", async event => {
  const file = $("import").files?.[0]; if (!file) return;
  if (run?.active) { $("status").textContent = "Stop the current run before importing."; $("import").value = ""; return; }
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Recording exceeds 10 MB.");
    saved = validateRecording(await file.text());
    await storage(saved);
    $("mode").value = "replay"; $("mode").dispatchEvent(new Event("change"));
    $("download").disabled = false; $("status").textContent = "Recording loaded. Press Replay.";
  } catch (error) { $("status").textContent = `Import failed: ${(error instanceof Error ? error.message : String(error))}`; }
  $("import").value = "";
});
try { const stored = await storage() ?? await fetch("/recorded-run.json").then(response => response.ok ? response.json() : null); if (stored) { saved = validateRecording(JSON.stringify(stored)); $("download").disabled = false; $("recording-status").textContent = `Previous ${saved.mode} recording available in Replay.`; } } catch { /* A fresh run is still available if storage is disabled or outdated. */ }
timeline({ fixture: makeFixture(), actions: [], duration_ms: 0 }, 0);
