import { patternDurationSeconds, splitPatternWindow } from "../../core/pattern/audio-schedule.js";
import { pitchForNote, sampleFamily } from "../../core/pattern/drum-pitches.js";

const LOOKAHEAD_SECONDS = 0.1;
const POLL_MS = 25;
const clone = value => JSON.parse(JSON.stringify(value));
const sampleIndex = (velocity, count) => Math.min(count - 1, Math.floor((velocity - 1) * count / 127));

export function createPatternPlayer({ onError = () => {}, onSwap = () => {} } = {}) {
  let context;
  let output;
  let timer;
  let manifest;
  let manifestRequest;
  let playing = false;
  let activePattern = { bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes: [] };
  let pendingPattern = null;
  let activeBpm = 120;
  let pendingBpm = null;
  let originTime = 0;
  let scheduledThrough = 0;
  let startVersion = 0;
  let loadingUpdate = null;
  const buffers = new Map();
  const sources = new Set();
  const openHatSources = new Set();

  async function kitManifest() {
    if (manifest) return manifest;
    if (!manifestRequest) manifestRequest = fetch("/assets/virtuosity/manifest.json")
      .then(response => { if (!response.ok) throw new Error("Could not load the drum kit manifest."); return response.json(); })
      .then(data => { manifest = data; return data; })
      .catch(error => { manifestRequest = null; throw error; });
    return manifestRequest;
  }

  function sampleFor(family, velocity) {
    const files = manifest.families[family];
    if (!files?.length) throw new Error(`Missing drum sound: ${family}.`);
    return files[sampleIndex(velocity, files.length)];
  }

  async function prepare(pattern) {
    ensureContext();
    await kitManifest();
    const paths = new Set(pattern.notes.map(note => {
      const family = sampleFamily(pitchForNote(note));
      return sampleFor(family, note.velocity);
    }));
    await Promise.all([...paths].filter(path => !buffers.has(path)).map(async path => {
      const response = await fetch(`/assets/virtuosity/${path}`);
      if (!response.ok) throw new Error(`Could not load drum sound ${path}.`);
      buffers.set(path, await context.decodeAudioData(await response.arrayBuffer()));
    }));
  }

  function ensureContext() {
    if (context) return;
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio is not supported in this browser.");
    context = new AudioContext();
    output = context.createGain();
    output.gain.value = 0.8;
    output.connect(context.destination);
  }

  async function load(pattern = activePattern) {
    try {
      await prepare(pattern);
    } catch (error) {
      onError(error.message);
      throw error;
    }
  }

  function scheduleHit(hit) {
    const path = sampleFor(hit.sample_family, hit.velocity);
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
    const count = manifest.families[hit.sample_family].length;
    const ceiling = Math.ceil((sampleIndex(hit.velocity, count) + 1) * 127 / count);
    hitGain.gain.value = hit.velocity / ceiling;
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
    stop();
    const version = startVersion;
    const update = { bpm };
    loadingUpdate = update;
    try {
      await load(pattern);
      await context.resume();
      if (version !== startVersion) return;
      activePattern = clone(pattern);
      activeBpm = update.bpm;
      pendingPattern = null;
      pendingBpm = null;
      playing = true;
      originTime = context.currentTime + 0.05;
      scheduledThrough = originTime;
      tick();
      timer = window.setInterval(tick, POLL_MS);
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
    playing = false;
    if (timer) window.clearInterval(timer);
    timer = null;
    for (const source of sources) {
      try { source.stop(); } catch {}
    }
    sources.clear();
    openHatSources.clear();
  }

  async function stage(pattern, bpm = activeBpm) {
    const update = { bpm };
    loadingUpdate = update;
    try {
      if (playing) await load(pattern);
      if (loadingUpdate !== update) return;
      if (playing) {
        pendingPattern = clone(pattern);
        pendingBpm = update.bpm;
      } else {
        activePattern = clone(pattern);
        activeBpm = update.bpm;
      }
    } finally {
      if (loadingUpdate === update) loadingUpdate = null;
    }
  }

  function setTempo(bpm) {
    if (loadingUpdate) loadingUpdate.bpm = bpm;
    if (playing) {
      pendingPattern ??= clone(activePattern);
      pendingBpm = bpm;
    } else activeBpm = bpm;
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
