import { patternDurationSeconds, splitPatternWindow } from "/core/pattern/audio-schedule.js";

const LOOKAHEAD_SECONDS = 0.1;
const POLL_MS = 25;
const instruments = ["kick", "snare", "closed_hat", "open_hat", "crash", "high_tom", "mid_tom", "floor_tom"];

const clone = value => JSON.parse(JSON.stringify(value));

export function createPatternPlayer({ onError = () => {}, onSwap = () => {} } = {}) {
  let context;
  let output;
  let timer;
  let loaded = false;
  let playing = false;
  let activePattern = { bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes: [] };
  let pendingPattern = null;
  let activeBpm = 120;
  let pendingBpm = null;
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

  async function load() {
    if (loaded) return;
    ensureContext();
    try {
      await Promise.all(instruments.flatMap(instrument => Array.from({ length: 5 }, async (_, index) => {
        const key = `${instrument}:${index + 1}`;
        const response = await fetch(`/assets/osdk/${instrument}/layer-${index + 1}.wav`);
        if (!response.ok) throw new Error(`Could not load ${instrument} layer ${index + 1}.`);
        buffers.set(key, await context.decodeAudioData(await response.arrayBuffer()));
      })));
      loaded = true;
    } catch (error) {
      onError(error.message);
      throw error;
    }
  }

  function scheduleHit(hit) {
    const layer = hit.velocity <= 25 ? 1 : hit.velocity <= 50 ? 2 : hit.velocity <= 76 ? 3 : hit.velocity <= 101 ? 4 : 5;
    const buffer = buffers.get(`${hit.instrument}:${layer}`);
    if (!buffer) {
      onError(`Missing sample for ${hit.instrument}, layer ${layer}.`);
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
    source.connect(output);
    sources.add(source);
    if (hit.instrument === "open_hat") openHatSources.add(source);
    source.onended = () => {
      sources.delete(source);
      openHatSources.delete(source);
    };
    source.start(Math.max(context.currentTime, hit.time));
  }

  function tick() {
    if (!playing) return;
    const horizon = context.currentTime + LOOKAHEAD_SECONDS;
    const phraseSeconds = patternDurationSeconds(activePattern, activeBpm);
    const completedPhrases = Math.floor(Math.max(0, scheduledThrough - originTime) / phraseSeconds);
    const boundaryTime = originTime + (completedPhrases + 1) * phraseSeconds;
    const window = splitPatternWindow({ activePattern, activeBpm, pendingPattern, pendingBpm, fromTime: scheduledThrough, toTime: horizon, originTime, boundaryTime });
    window.events.forEach(scheduleHit);
    activePattern = window.activePattern;
    activeBpm = window.activeBpm;
    pendingPattern = window.pendingPattern;
    pendingBpm = window.pendingBpm;
    if (window.didSwap) {
      originTime = boundaryTime;
      onSwap(clone(activePattern));
    }
    scheduledThrough = Math.max(scheduledThrough, horizon);
  }

  async function start(pattern, bpm = 120) {
    await load();
    await context.resume();
    stop();
    activePattern = clone(pattern);
    activeBpm = bpm;
    pendingPattern = null;
    pendingBpm = null;
    playing = true;
    originTime = context.currentTime + 0.05;
    scheduledThrough = originTime;
    tick();
    timer = window.setInterval(tick, POLL_MS);
  }

  async function unlock() {
    ensureContext();
    await context.resume();
  }

  function stop() {
    playing = false;
    if (timer) window.clearInterval(timer);
    timer = null;
    for (const source of sources) {
      try { source.stop(); } catch {}
    }
    sources.clear();
    openHatSources.clear();
  }

  function stage(pattern, bpm = activeBpm) {
    if (playing) {
      pendingPattern = clone(pattern);
      pendingBpm = bpm;
    } else {
      activePattern = clone(pattern);
      activeBpm = bpm;
    }
  }

  function setTempo(bpm) {
    stage(pendingPattern ?? activePattern, bpm);
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
    setTempo,
    setVolume,
    isPlaying: () => playing,
    hasPendingPattern: () => pendingPattern !== null,
  };
}
