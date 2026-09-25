import { swungTick } from "./swing.js";
import { ticksPerBar } from "./musical-time.js";
import { pitchForNote, sampleFamily } from "./drum-pitches.js";

import type { Pattern, PatternNote } from "./state.js";
export type ScheduledPatternHit = PatternNote & { time: number; kit_id: string; sample_family: string; layer: number; gain: number };
export type PlaybackPattern = Omit<Pattern, "kit_id"> & { kit_id?: string };
export const secondsPerTick = (bpm: number) => 60 / bpm / 960;

function samplePlayback(velocity: number) {
  const ceiling = velocity <= 25 ? 25 : velocity <= 50 ? 50 : velocity <= 76 ? 76 : velocity <= 101 ? 101 : 127;
  const layer = ceiling === 25 ? 1 : ceiling === 50 ? 2 : ceiling === 76 ? 3 : ceiling === 101 ? 4 : 5;
  return { layer, gain: velocity / ceiling };
}

export function patternDurationSeconds(pattern: PlaybackPattern, bpm: number) {
  return pattern.bars * ticksPerBar(pattern.meter) * secondsPerTick(bpm);
}

export function eventsForWindow(pattern: PlaybackPattern, bpm: number, fromTime: number, toTime: number, originTime = 0) {
  if (toTime <= fromTime) return [];
  const events: ScheduledPatternHit[] = [];
  const barTicks = ticksPerBar(pattern.meter);
  const tickSeconds = secondsPerTick(bpm);
  const phraseSeconds = patternDurationSeconds(pattern, bpm);
  const firstPhrase = Math.floor((fromTime - originTime) / phraseSeconds);
  const lastPhrase = Math.floor((toTime - originTime) / phraseSeconds);
  for (let phrase = firstPhrase; phrase <= lastPhrase; phrase++) {
    const phraseTime = originTime + phrase * phraseSeconds;
    for (const note of pattern.notes) {
      const time = phraseTime + ((note.bar - 1) * barTicks + swungTick(note.tick, pattern.swing_percent ?? 50)) * tickSeconds;
      if (time >= fromTime && time < toTime) events.push({ ...note, ...samplePlayback(note.velocity), sample_family: sampleFamily(pitchForNote(note)), kit_id: pattern.kit_id ?? "acoustic", time });
    }
  }
  return events.sort((left, right) => left.time - right.time || left.bar - right.bar || left.tick - right.tick);
}

export function splitPatternWindow({ activePattern, activeBpm, pendingPattern, pendingBpm, fromTime, toTime, originTime, boundaryTime, preservePhase = false }: { activePattern: PlaybackPattern; activeBpm: number; pendingPattern: PlaybackPattern | null; pendingBpm: number | null; fromTime: number; toTime: number; originTime: number; boundaryTime: number; preservePhase?: boolean }) {
  if (!pendingPattern || boundaryTime >= toTime) {
    return { events: eventsForWindow(activePattern, activeBpm, fromTime, toTime, originTime), activePattern, activeBpm, pendingPattern, pendingBpm, originTime, didSwap: false };
  }
  const boundary = Math.max(fromTime, boundaryTime);
  const sameMeter = activePattern.meter.numerator === pendingPattern.meter.numerator && activePattern.meter.denominator === pendingPattern.meter.denominator;
  const oldPhraseTicks = activePattern.bars * ticksPerBar(activePattern.meter);
  const newPhraseTicks = pendingPattern.bars * ticksPerBar(pendingPattern.meter);
  const elapsedTicks = (boundaryTime - originTime) / secondsPerTick(activeBpm);
  // Boundaries are whole beats; rounding removes floating-point drift at the seam.
  const phaseTicks = preservePhase && sameMeter ? Math.round(elapsedTicks) % oldPhraseTicks % newPhraseTicks : 0;
  const nextOriginTime = preservePhase && sameMeter && activePattern.bars === pendingPattern.bars && (pendingBpm ?? activeBpm) === activeBpm
    ? originTime : boundaryTime - phaseTicks * secondsPerTick(pendingBpm ?? activeBpm);
  return {
    events: [
      ...eventsForWindow(activePattern, activeBpm, fromTime, boundary, originTime),
      ...eventsForWindow(pendingPattern, pendingBpm ?? activeBpm, boundary, toTime, nextOriginTime),
    ],
    activePattern: pendingPattern,
    activeBpm: pendingBpm ?? activeBpm,
    pendingPattern: null,
    pendingBpm: null,
    originTime: nextOriginTime,
    didSwap: true,
  };
}
