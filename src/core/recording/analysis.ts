export type DrumGuess = "kick" | "snare" | "closed_hat";
export type DetectedHit = {
  onset_seconds: number;
  instrument: DrumGuess;
  scores: Record<DrumGuess, number>;
  features: { peak_rms: number; attack_low: number; attack_mid: number; attack_high: number; body_low: number; body_mid: number; body_high: number; energy_median_seconds: number };
};
// Engineering choices for this demo; validate against real takes before tuning.
export const ANALYSIS_SETTINGS = Object.freeze({
  hop_seconds: 0.005, support_seconds: 0.01, release_seconds: 0.01,
  retrigger_rise: 0.5, retrigger_decay: 0.5, minimum_separation_seconds: 0.03,
  voiced_tail_seconds: 0.25, voiced_tail_body_low: 0.95, voiced_tail_attack_ratio: 0.25,
  minimum_rms: 0.008, background_multiplier: 3, relative_rise: 0.12,
  attack_seconds: 0.025, body_seconds: 0.1, low_hz: 350, high_hz: 3000, max_hits: 256,
});

// Ported from Frederic's causal RMS, Hann-window band power, normalized spectral
// balance and cumulative-energy shape calculations. Attack groups use the first
// rising edge, not the weighted median: this is timing extraction, not perception.
function bands(samples: Float32Array, sampleRate: number, start: number, seconds: number, end = samples.length): number[] {
  const count = Math.max(0, Math.min(Math.round(seconds * sampleRate), end - start));
  const size = 2 ** Math.ceil(Math.log2(Math.max(2, count)));
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let i = 0; i < count; i++) real[i] = samples[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, count - 1)));
  // Radix-2 FFT keeps analysis bounded even at the maximum take length.
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let length = 2; length <= size; length *= 2) {
    for (let base = 0; base < size; base += length) {
      for (let i = 0; i < length / 2; i++) {
        const angle = -2 * Math.PI * i / length;
        const left = base + i, right = left + length / 2;
        const r = real[right] * Math.cos(angle) - imaginary[right] * Math.sin(angle);
        const im = real[right] * Math.sin(angle) + imaginary[right] * Math.cos(angle);
        real[right] = real[left] - r; imaginary[right] = imaginary[left] - im;
        real[left] += r; imaginary[left] += im;
      }
    }
  }
  const power = [0, 0, 0];
  for (let i = 1; i <= size / 2; i++) {
    const frequency = i * sampleRate / size;
    const band = frequency < ANALYSIS_SETTINGS.low_hz ? 0 : frequency < ANALYSIS_SETTINGS.high_hz ? 1 : 2;
    power[band] += real[i] ** 2 + imaginary[i] ** 2;
  }
  const sum = power.reduce((a, b) => a + b, 0) || 1;
  return power.map(value => value / sum);
}

export function analyzeTake(samples: Float32Array, sampleRate: number): DetectedHit[] {
  if (sampleRate < 8000 || sampleRate > 192000 || samples.length > sampleRate * 30 || samples.some(value => !Number.isFinite(value))) throw new Error("Invalid take audio.");
  const settings = ANALYSIS_SETTINGS;
  const hop = Math.round(sampleRate * settings.hop_seconds);
  const support = Math.round(sampleRate * settings.support_seconds);
  const envelope: number[] = [];
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] ** 2;
    if (i >= support) sum -= samples[i - support] ** 2;
    if (i % hop === 0) envelope.push(Math.sqrt(Math.max(0, sum) / support));
  }
  const sorted = [...envelope].sort((a, b) => a - b);
  const background = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
  const peak = sorted.at(-1) ?? 0;
  const threshold = Math.max(settings.minimum_rms, background * settings.background_multiplier);
  if (peak < threshold) return [];
  const starts: number[] = [];
  let activePeak = 0;
  let quietFrames = 0;
  const releaseFrames = Math.ceil(settings.release_seconds * sampleRate / hop);
  for (let i = 1; i < envelope.length; i++) {
    const level = envelope[i];
    const previousLevel = envelope[Math.max(0, i - 2)];
    const rise = level - previousLevel;
    if (activePeak > 0) {
      // Rearm only after the previous event has decayed. A vowel swelling
      // again is not a new attack; this is not a fixed minimum hit spacing.
      // A loud hit's tail can remain well above the onset threshold after
      // falling below 20% of its peak. Rearming there counts small tail
      // fluctuations as new hits. Require quiet, or the abrupt attack below.
      quietFrames = level < threshold ? quietFrames + 1 : 0;
      // A genuinely abrupt new attack may interrupt a decaying tail.
      const newAttack = previousLevel < activePeak * settings.retrigger_decay
        && rise >= level * settings.retrigger_rise
        && (i - starts[starts.length - 1]) * hop / sampleRate >= settings.minimum_separation_seconds;
      // Compare against the previous peak, not this frame: a growing first
      // attack must not manufacture the apparent decay needed to retrigger.
      activePeak = Math.max(activePeak, level);
      if (quietFrames < releaseFrames && !newAttack) continue;
      activePeak = 0;
    }
    // Local contrast: a loud instruction must not raise the onset threshold
    // for every later hit in the recording.
    if (level < threshold || rise < Math.max(threshold * 0.3, level * settings.relative_rise)) continue;
    starts.push(i);
    activePeak = level;
    quietFrames = 0;
  }
  if (starts.length > settings.max_hits) throw new Error("Too many attacks. Record a shorter demonstration.");
  const onsets: { onset: number; frame: number }[] = [];
  for (const frame of starts) {
    let onset = Math.max(0, frame * hop - support);
    const end = Math.min(samples.length, (frame + 1) * hop);
    while (onset < end && Math.abs(samples[onset]) < Math.max(background * 2, threshold * 0.25)) onset++;
    // Enforce spacing on refined sample positions, including after quiet gaps.
    // Envelope frame rounding must not turn one consonant into two hits.
    const previous = onsets.at(-1);
    if (!previous || onset - previous.onset >= Math.round(settings.minimum_separation_seconds * sampleRate)) onsets.push({ onset, frame });
  }
  const candidates: DetectedHit[] = onsets.map(({ onset, frame }, index) => {
    // Classify only this event: the next attack must not enter its FFT window.
    const end = onsets[index + 1]?.onset ?? samples.length;
    const attack = bands(samples, sampleRate, onset, settings.attack_seconds, end);
    const bodyStart = Math.min(end, onset + Math.round(settings.attack_seconds * sampleRate));
    const measuredBody = bands(samples, sampleRate, bodyStart, settings.body_seconds - settings.attack_seconds, end);
    const body = measuredBody.some(power => power > 0) ? measuredBody : attack;
    const bodyEnd = Math.min(end, onset + Math.round(settings.body_seconds * sampleRate));
    let energy = 0;
    for (let i = onset; i < bodyEnd; i++) energy += samples[i] ** 2;
    let cumulative = 0, median = onset;
    for (; median < bodyEnd; median++) { cumulative += samples[median] ** 2; if (cumulative >= energy * 0.5) break; }
    const scores = { kick: body[0] * 0.75 + attack[0] * 0.25, snare: body[1] * 0.7 + (1 - Math.max(...attack)) * 0.3, closed_hat: attack[2] * 0.65 + body[2] * 0.35 - body[0] * 0.2 };
    const instrument = (Object.keys(scores) as DrumGuess[]).reduce((best, key) => scores[key] > scores[best] ? key : best, "kick");
    return { onset_seconds: onset / sampleRate, instrument, scores, features: { peak_rms: envelope[frame], attack_low: attack[0], attack_mid: attack[1], attack_high: attack[2], body_low: body[0], body_mid: body[1], body_high: body[2], energy_median_seconds: (median - onset) / sampleRate } };
  });
  const hasQuietGap = (startSeconds: number, endSeconds: number) => {
    let quiet = 0;
    const floor = Math.max(background * 2, settings.minimum_rms * 0.1);
    for (let i = Math.ceil((startSeconds + settings.attack_seconds) * sampleRate / hop); i < endSeconds * sampleRate / hop; i++) {
      quiet = envelope[i] < floor ? quiet + 1 : 0;
      if (quiet >= releaseFrames) return true;
    }
    return false;
  };
  const hits: DetectedHit[] = [];
  for (const hit of candidates) {
    const previous = hits.at(-1);
    // A voiced kick can have a second volume rise in its low tonal tail.
    // Reject that continuation only when its broader attack energy has
    // collapsed relative to the preceding kick. Pure-tone and fast double
    // kicks with comparable attack spectra remain separate events.
    const voicedTail = previous?.instrument === "kick" && hit.instrument === "kick"
      && hit.onset_seconds - previous.onset_seconds <= settings.voiced_tail_seconds
      && hit.features.body_low >= settings.voiced_tail_body_low
      && hit.features.attack_mid + hit.features.attack_high
        < (previous.features.attack_mid + previous.features.attack_high) * settings.voiced_tail_attack_ratio;
    if (!voicedTail || hasQuietGap(previous!.onset_seconds, hit.onset_seconds)) hits.push(hit);
  }
  return hits;
}
