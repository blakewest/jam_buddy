export function createAudio() {
  let context, master, epoch = 0, volume = 0.35, noise;
  let pedal = false;
  const voices = new Set();
  const notes = new Map();
  const released = new Set();

  function timeAt(ms) { return epoch + ms / 1000; }
  function voice(kind, source, gain, start, end = Infinity) {
    const entry = { kind, source, gain, start, end };
    voices.add(entry);
    source.onended = () => { voices.delete(entry); source.disconnect(); gain.disconnect(); };
    return entry;
  }
  function release(entry, at) {
    if (!entry || entry.end <= at) return;
    const time = Math.max(context.currentTime, at);
    entry.gain.gain.cancelAndHoldAtTime(time);
    entry.gain.gain.linearRampToValueAtTime(0, time + 0.012);
    entry.source.stop(time + 0.015);
    entry.end = time + 0.015;
  }
  function stopDrums() {
    for (const entry of voices) {
      if (entry.kind !== "drum") continue;
      if (entry.start > context.currentTime) { entry.source.stop(); entry.end = context.currentTime; }
      else release(entry, context.currentTime);
    }
  }
  function stopAll() {
    if (!context) return;
    for (const entry of voices) { try { entry.source.stop(); } catch {} }
    voices.clear(); notes.clear(); released.clear(); pedal = false;
  }

  return {
    async start() {
      if (!context) {
        context = new AudioContext({ latencyHint: "interactive" });
        master = context.createGain(); master.gain.value = volume; master.connect(context.destination);
        noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
        // Fixed noise seed makes repeated drum synthesis consistent.
        let seed = 17;
        const samples = noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) { seed = (seed * 16807) % 2147483647; samples[i] = seed / 1073741823.5 - 1; }
      }
      stopAll();
      await context.resume();
      epoch = context.currentTime;
    },
    nowMs: () => context ? (context.currentTime - epoch) * 1000 : 0,
    isRunning: () => context?.state === "running",
    setVolume(value) { volume = value; if (master) master.gain.setTargetAtTime(value, context.currentTime, 0.015); },
    getInfo: () => context ? { sample_rate: context.sampleRate, base_latency_ms: context.baseLatency * 1000, output_latency_ms: (context.outputLatency || 0) * 1000 } : {},
    stopDrums, stopAll,
    schedulePiano(event) {
      const at = Math.max(context.currentTime, timeAt(event.time_ms));
      if (event.type === "sustain") {
        pedal = event.value >= 64;
        if (!pedal) { for (const entry of released) release(entry, at); released.clear(); }
        return;
      }
      if (event.type === "note_off" || event.velocity === 0) {
        const entry = notes.get(event.note);
        if (entry) { if (pedal) released.add(entry); else release(entry, at); notes.delete(event.note); }
        return;
      }
      release(notes.get(event.note), at);
      const source = context.createOscillator();
      source.type = "triangle";
      source.frequency.value = 440 * 2 ** ((event.note - 69) / 12);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(event.velocity / 127 * 0.18, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.035, at + 0.3);
      source.connect(gain).connect(master);
      source.start(at);
      notes.set(event.note, voice("piano", source, gain, at));
    },
    scheduleDrum(hit) {
      const at = Math.max(context.currentTime, timeAt(hit.time_ms));
      const duration = hit.instrument === "kick" ? 0.22 : hit.instrument === "snare" ? 0.15 : 0.045;
      const gain = context.createGain();
      let source, filter;
      if (hit.instrument === "kick") {
        source = context.createOscillator();
        source.frequency.setValueAtTime(140, at);
        source.frequency.exponentialRampToValueAtTime(45, at + 0.1);
        source.connect(gain);
      } else {
        source = context.createBufferSource(); source.buffer = noise;
        filter = context.createBiquadFilter(); filter.type = "highpass";
        filter.frequency.value = hit.instrument === "hat" ? 7000 : 1400;
        source.connect(filter).connect(gain);
      }
      gain.connect(master);
      gain.gain.setValueAtTime(hit.instrument === "kick" ? 0.5 : hit.instrument === "snare" ? 0.23 : 0.10, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      source.start(at); source.stop(at + duration + 0.01);
      const entry = voice("drum", source, gain, at, at + duration + 0.01);
      const ended = source.onended;
      source.onended = () => { ended(); filter?.disconnect(); };
      if (Number.isFinite(hit.stop_ms)) release(entry, timeAt(hit.stop_ms));
    },
  };
}
