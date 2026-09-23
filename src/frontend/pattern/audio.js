import { splitPatternWindow } from "/core/pattern/audio-schedule.js";
import { getKit, sampleForHit } from "/core/pattern/kits.js";

const BAR_SECONDS = 2;
const LOOKAHEAD_SECONDS = 0.1;
const POLL_MS = 25;
const instruments = ["kick", "snare", "closed_hat", "open_hat"];

const clone = value => JSON.parse(JSON.stringify(value));

export function createPatternPlayer({ onError = () => {}, onSwap = () => {} } = {}) {
  let context;
  let output;
  let timer;
  let generation = 0;
  const kitLoads = new Map();
  let playing = false;
  let activePattern = { bars: 1, slots_per_bar: 16, notes: [] };
  let pendingPattern = null;
  let originTime = 0;
  let scheduledThrough = 0;
  const buffers = new Map();
  const sources = new Set();
  const openHatSources = new Set();

  function ensureContext() {
    if (context) return;
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio is not supported in this browser.");
    context = new AudioContext();
    output = context.createGain();
    output.gain.value = 0.8;
    output.connect(context.destination);
  }

  async function load(kitId = "acoustic") {
    getKit(kitId);
    ensureContext();
    if (!kitLoads.has(kitId)) {
      const urls = [...new Set(instruments.flatMap(instrument => Array.from({ length: 5 }, (_, index) => sampleForHit(kitId, instrument, index + 1).url)))];
      const loading = Promise.all(urls.map(async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load ${getKit(kitId).name} samples.`);
        return [url, await context.decodeAudioData(await response.arrayBuffer())];
      })).then(entries => {
        for (const [url, buffer] of entries) buffers.set(url, buffer);
      }).catch(error => {
        kitLoads.delete(kitId);
        throw error;
      });
      kitLoads.set(kitId, loading);
    }
    return kitLoads.get(kitId);
  }

  function scheduleHit(hit) {
    const sample = sampleForHit(hit.kit_id ?? "acoustic", hit.instrument, hit.velocity_layer);
    const buffer = buffers.get(sample.url);
    if (!buffer) {
      onError(`Missing sample for ${hit.instrument}, layer ${hit.velocity_layer}.`);
      return;
    }
    if (hit.instrument === "closed_hat") {
      for (const source of openHatSources) {
        try { source.stop(hit.time + 0.01); } catch {}
      }
      openHatSources.clear();
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = sample.gain;
    source.connect(gain);
    gain.connect(output);
    sources.add(source);
    if (hit.instrument === "open_hat") openHatSources.add(source);
    source.onended = () => {
      sources.delete(source);
      openHatSources.delete(source);
      source.disconnect?.();
      gain.disconnect();
    };
    source.start(Math.max(context.currentTime, hit.time));
  }

  function tick() {
    if (!playing) return;
    const horizon = context.currentTime + LOOKAHEAD_SECONDS;
    const phraseSeconds = activePattern.bars * BAR_SECONDS;
    const completedPhrases = Math.floor(Math.max(0, scheduledThrough - originTime) / phraseSeconds);
    const boundaryTime = originTime + (completedPhrases + 1) * phraseSeconds;
    const window = splitPatternWindow({ activePattern, pendingPattern, fromTime: scheduledThrough, toTime: horizon, originTime, boundaryTime });
    window.events.forEach(scheduleHit);
    activePattern = window.activePattern;
    pendingPattern = window.pendingPattern;
    if (window.didSwap) {
      originTime = boundaryTime;
      onSwap(clone(activePattern));
    }
    scheduledThrough = Math.max(scheduledThrough, horizon);
  }

  async function start(pattern) {
    stop();
    const startedGeneration = generation;
    await load(pattern.kit_id ?? "acoustic");
    if (startedGeneration !== generation) return false;
    await context.resume();
    if (startedGeneration !== generation) return false;
    activePattern = clone(pattern);
    pendingPattern = null;
    playing = true;
    originTime = context.currentTime + 0.05;
    scheduledThrough = originTime;
    tick();
    timer = window.setInterval(tick, POLL_MS);
    return true;
  }

  async function unlock() {
    ensureContext();
    await context.resume();
  }

  function stop() {
    generation++;
    pendingPattern = null;
    playing = false;
    if (timer) window.clearInterval(timer);
    timer = null;
    for (const source of sources) {
      try { source.stop(); } catch {}
    }
    sources.clear();
    openHatSources.clear();
  }

  function stage(pattern) {
    if (playing) pendingPattern = clone(pattern);
    else activePattern = clone(pattern);
  }

  function setVolume(value) {
    ensureContext();
    output.gain.value = Math.min(1, Math.max(0, value));
  }

  return {
    load,
    unlock,
    start,
    stop,
    stage,
    setVolume,
    isPlaying: () => playing,
    hasPendingPattern: () => pendingPattern !== null,
  };
}
