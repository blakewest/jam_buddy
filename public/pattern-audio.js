const BAR_SECONDS = 2;
const SLOT_SECONDS = BAR_SECONDS / 16;
const LOOKAHEAD_SECONDS = 0.1;
const POLL_MS = 25;
const instruments = ["kick", "snare", "closed_hat", "open_hat"];

const clone = value => JSON.parse(JSON.stringify(value));

export function eventsForWindow(pattern, fromTime, toTime, originTime = 0) {
  if (toTime <= fromTime) return [];
  const events = [];
  const phraseSeconds = pattern.bars * BAR_SECONDS;
  const firstPhrase = Math.floor((fromTime - originTime) / phraseSeconds);
  const lastPhrase = Math.floor((toTime - originTime) / phraseSeconds);
  for (let phrase = firstPhrase; phrase <= lastPhrase; phrase++) {
    const phraseTime = originTime + phrase * phraseSeconds;
    for (const note of pattern.notes) {
      const time = phraseTime + (note.bar - 1) * BAR_SECONDS + (note.slot - 1) * SLOT_SECONDS;
      if (time >= fromTime && time < toTime) events.push({ ...note, time });
    }
  }
  return events.sort((left, right) => left.time - right.time || left.bar - right.bar || left.slot - right.slot);
}

export function splitPatternWindow({ activePattern, pendingPattern, fromTime, toTime, originTime, boundaryTime }) {
  if (!pendingPattern || boundaryTime >= toTime) {
    return { events: eventsForWindow(activePattern, fromTime, toTime, originTime), activePattern, pendingPattern, didSwap: false };
  }
  const boundary = Math.max(fromTime, boundaryTime);
  return {
    events: [
      ...eventsForWindow(activePattern, fromTime, boundary, originTime),
      ...eventsForWindow(pendingPattern, boundary, toTime, boundaryTime),
    ],
    activePattern: pendingPattern,
    pendingPattern: null,
    didSwap: true,
  };
}

export function createPatternPlayer({ onError = () => {}, onSwap = () => {} } = {}) {
  let context;
  let output;
  let timer;
  let loaded = false;
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
    const buffer = buffers.get(`${hit.instrument}:${hit.velocity_layer}`);
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
    await load();
    await context.resume();
    stop();
    activePattern = clone(pattern);
    pendingPattern = null;
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
