import type { PlaybackPattern } from "../../core/pattern/audio-schedule.js";
import type { PatternNote } from "../../core/pattern/state.js";
import { sampleForHit } from "../../core/pattern/kits.js";
import { patternDurationSeconds, splitPatternWindow } from "../../core/pattern/audio-schedule.js";
import { pitchForNote, sampleFamily } from "../../core/pattern/drum-pitches.js";

const LOOKAHEAD_SECONDS = 0.1;
const POLL_MS = 25;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sampleIndex = (velocity: number, count: number) => Math.min(count - 1, Math.floor((velocity - 1) * count / 127));

export function createPatternPlayer({ onError = () => {}, onSwap = () => {}, onHit }: { onError?: (message: string) => void; onSwap?: (pattern: PlaybackPattern) => void; onHit?: (instrument: string) => void } = {}) {
  let context: AudioContext;
  let output: GainNode;
  let timer: number | null;
  let manifest: { families: Record<string, string[]> };
  let manifestRequest: Promise<typeof manifest> | null;
  let playing = false;
  let activePattern: PlaybackPattern = { bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes: [] };
  let pendingPattern: PlaybackPattern | null = null;
  let audibleSwap: { pattern: PlaybackPattern; time: number } | null = null;
  let activeBpm = 120;
  let pendingBpm: number | null = null;
  let pendingBoundaryTime: number | null = null;
  let pendingBoundary: "beat" | "phrase" = "phrase";
  let originTime = 0;
  let scheduledThrough = 0;
  let startVersion = 0;
  let loadingUpdate: { bpm: number } | null = null;
  const buffers = new Map<string, AudioBuffer>();
  const sources = new Set<AudioBufferSourceNode>();
  const openHatSources = new Set<AudioBufferSourceNode>();
  const visualTimers = new Set<number>();

  async function kitManifest() {
    if (manifest) return manifest;
    if (!manifestRequest) manifestRequest = fetch("/assets/virtuosity/manifest.json")
      .then(response => { if (!response.ok) throw new Error("Could not load the drum kit manifest."); return response.json(); })
      .then(data => { manifest = data; return data; })
      .catch(error => { manifestRequest = null; throw error; });
    return manifestRequest;
  }

  function sampleFor(family: string, velocity: number) {
    const files = manifest.families[family];
    if (!files?.length) throw new Error(`Missing drum sound: ${family}.`);
    return files[sampleIndex(velocity, files.length)];
  }

  function playbackSample(note: PatternNote, kitId = "acoustic") {
    if (kitId !== "acoustic" && ["kick", "snare", "closed_hat", "open_hat"].includes(note.instrument)) {
      const layer = Math.min(5, Math.floor((note.velocity - 1) * 5 / 127) + 1);
      const sample = sampleForHit(kitId, note.instrument, layer);
      return { ...sample, gain: sample.gain * note.velocity / Math.ceil(layer * 127 / 5) };
    }
    // Electronic packs contain four voices; keep the acoustic articulations for other lanes.
    const family = sampleFamily(pitchForNote(note));
    const count = manifest.families[family].length;
    const ceiling = Math.ceil((sampleIndex(note.velocity, count) + 1) * 127 / count);
    return { url: `/assets/virtuosity/${sampleFor(family, note.velocity)}`, gain: note.velocity / ceiling };
  }

  async function prepare(pattern: PlaybackPattern) {
    ensureContext();
    await kitManifest();
    const paths = new Set(pattern.notes.map(note => playbackSample(note, pattern.kit_id).url));
    await Promise.all([...paths].filter(path => !buffers.has(path)).map(async path => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Could not load drum sound ${path}.`);
      buffers.set(path, await context.decodeAudioData(await response.arrayBuffer()));
    }));
  }

  function ensureContext() {
    if (context) return;
    const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error("Web Audio is not supported in this browser.");
    context = new Context();
    output = context.createGain();
    output.gain.value = 0.8;
    output.connect(context.destination);
  }

  async function load(pattern = activePattern) {
    try {
      await prepare(pattern);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  function scheduleHit(hit: PatternNote & { time: number; sample_family: string; kit_id: string }) {
    const sample = playbackSample(hit, hit.kit_id);
    const path = sample.url;
    const buffer = buffers.get(path);
    if (!buffer) {
      onError(`Missing drum sound ${path}.`);
      return;
    }
    if (["hat_closed", "hat_half", "hat_pedal"].includes(hit.sample_family)) {
      for (const source of openHatSources) {
        try { source.stop(hit.time + 0.01); } catch {}
      }
      openHatSources.clear();
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const hitGain = context.createGain();
    hitGain.gain.value = sample.gain;
    source.connect(hitGain);
    hitGain.connect(output);
    sources.add(source);
    if (["hat_open", "hat_three_quarter"].includes(hit.sample_family)) openHatSources.add(source);
    source.onended = () => {
      hitGain.disconnect();
      sources.delete(source);
      openHatSources.delete(source);
    };
    source.start(Math.max(context.currentTime, hit.time));
    if (onHit) {
      const visualDelayMs = Math.max(0, (hit.time - context.currentTime + (context.outputLatency ?? 0)) * 1000);
      const visualTimer = window.setTimeout(() => {
        visualTimers.delete(visualTimer);
        if (playing) onHit(hit.instrument);
      }, visualDelayMs);
      visualTimers.add(visualTimer);
    }
  }

  function tick() {
    if (!playing) return;
    if (audibleSwap && context.currentTime >= audibleSwap.time) {
      const accepted = audibleSwap.pattern;
      audibleSwap = null;
      onSwap(clone(accepted));
    }
    const horizon = context.currentTime + LOOKAHEAD_SECONDS;
    const phraseSeconds = patternDurationSeconds(activePattern, activeBpm);
    const completedPhrases = Math.floor(Math.max(0, scheduledThrough - originTime) / phraseSeconds);
    const boundaryTime = pendingBoundaryTime ?? originTime + (completedPhrases + 1) * phraseSeconds;
    const window = splitPatternWindow({ activePattern, activeBpm, pendingPattern, pendingBpm, fromTime: scheduledThrough, toTime: horizon, originTime, boundaryTime, preservePhase: pendingBoundary === "beat" });
    window.events.forEach(scheduleHit);
    activePattern = window.activePattern;
    activeBpm = window.activeBpm;
    pendingPattern = window.pendingPattern;
    pendingBpm = window.pendingBpm;
    if (window.didSwap) {
      if (pendingBoundary === "phrase") originTime = boundaryTime;
      pendingBoundaryTime = null;
      audibleSwap = { pattern: clone(activePattern), time: boundaryTime + (context.outputLatency ?? 0) + (context.baseLatency ?? 0) };
    }
    scheduledThrough = Math.max(scheduledThrough, horizon);
  }

  async function start(pattern: PlaybackPattern, bpm = 120) {
    stop();
    const version = startVersion;
    const update = { bpm };
    loadingUpdate = update;
    try {
      await load(pattern);
      await context.resume();
      if (version !== startVersion) return false;
      activePattern = clone(pattern);
      activeBpm = update.bpm;
      pendingPattern = null;
      pendingBpm = null;
      playing = true;
      originTime = context.currentTime + 0.05;
      scheduledThrough = originTime;
      tick();
      timer = window.setInterval(tick, POLL_MS);
      return true;
    } finally {
      if (loadingUpdate === update) loadingUpdate = null;
    }
  }

  async function unlock() {
    ensureContext();
    await context.resume();
  }

  function stop() {
    startVersion++;
    pendingPattern = null;
    pendingBpm = null;
    pendingBoundaryTime = null;
    pendingBoundary = "phrase";
    audibleSwap = null;
    playing = false;
    if (timer) window.clearInterval(timer);
    timer = null;
    for (const visualTimer of visualTimers) window.clearTimeout(visualTimer);
    visualTimers.clear();
    for (const source of sources) {
      try { source.stop(); } catch {}
    }
    sources.clear();
    openHatSources.clear();
  }

  function nextBoundaryTime(boundary: "beat" | "phrase") {
    const interval = boundary === "beat" ? 60 / activeBpm * 4 / activePattern.meter.denominator : patternDurationSeconds(activePattern, activeBpm);
    return originTime + (Math.floor(Math.max(0, Math.max(context.currentTime, scheduledThrough) - originTime) / interval) + 1) * interval;
  }

  async function stage(pattern: PlaybackPattern, bpm = activeBpm, boundary: "beat" | "phrase" = "phrase") {
    const update = { bpm };
    loadingUpdate = update;
    try {
      if (playing) await load(pattern);
      if (loadingUpdate !== update) return;
      if (playing) {
        // Mid-phrase edits must retain the existing timeline and sounds.
        pendingBoundary = boundary === "beat" && update.bpm === activeBpm
          && pattern.bars === activePattern.bars && pattern.meter.numerator === activePattern.meter.numerator
          && pattern.meter.denominator === activePattern.meter.denominator
          && pattern.kit_id === activePattern.kit_id && pattern.swing_percent === activePattern.swing_percent ? "beat" : "phrase";
        pendingBoundaryTime = nextBoundaryTime(pendingBoundary);
        pendingPattern = clone(pattern);
        pendingBpm = update.bpm;
      } else {
        activePattern = clone(pattern);
        activeBpm = update.bpm;
      }
      return pendingBoundary;
    } finally {
      if (loadingUpdate === update) loadingUpdate = null;
    }
  }

  function setTempo(bpm: number) {
    if (loadingUpdate) loadingUpdate.bpm = bpm;
    if (playing) {
      pendingPattern ??= clone(activePattern);
      pendingBpm = bpm;
      pendingBoundary = "phrase";
      pendingBoundaryTime = nextBoundaryTime("phrase");
    } else activeBpm = bpm;
  }

  function setVolume(value: number) {
    ensureContext();
    output.gain.value = Math.min(1, Math.max(0, value));
  }

  return {
    async captureContext() { await unlock(); return context; },
    snapshot(pattern: PlaybackPattern, inputCorrectionMs: number, bpm = activeBpm) {
      ensureContext();
      const clock = context.getOutputTimestamp?.();
      const outputLatency = clock?.performanceTime && typeof clock.contextTime === "number" && clock.contextTime > 0
        ? Math.max(0, context.currentTime - (clock.contextTime + (performance.now() - clock.performanceTime) / 1000))
        : (context.outputLatency ?? 0) + (context.baseLatency ?? 0);
      return { playing, tempo_bpm: bpm, bars: pattern.bars, meter: { ...pattern.meter }, origin_context_seconds: originTime,
        captured_context_seconds: context.currentTime, output_latency_seconds: outputLatency,
        output_context_seconds: clock?.contextTime ?? context.currentTime - outputLatency,
        output_performance_ms: clock?.performanceTime ?? performance.now(), input_correction_ms: inputCorrectionMs };
    },
    load,
    unlock,
    start,
    stop,
    stage,
    setTempo,
    setVolume,
    isPlaying: () => playing,
    hasPendingPattern: () => pendingPattern !== null || audibleSwap !== null,
  };
}
