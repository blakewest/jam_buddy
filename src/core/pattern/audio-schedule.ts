import type { Pattern, PatternNote } from "./state.js";
const BAR_SECONDS = 2;
const SLOT_SECONDS = BAR_SECONDS / 16;
export type ScheduledPatternHit = PatternNote & { time: number; kit_id: string };

export function eventsForWindow(pattern: Pattern, fromTime: number, toTime: number, originTime = 0): ScheduledPatternHit[] {
  if (toTime <= fromTime) return [];
  const events: ScheduledPatternHit[] = [];
  const phraseSeconds = pattern.bars * BAR_SECONDS;
  const firstPhrase = Math.floor((fromTime - originTime) / phraseSeconds);
  const lastPhrase = Math.floor((toTime - originTime) / phraseSeconds);
  for (let phrase = firstPhrase; phrase <= lastPhrase; phrase++) {
    const phraseTime = originTime + phrase * phraseSeconds;
    for (const note of pattern.notes) {
      const time = phraseTime + (note.bar - 1) * BAR_SECONDS + (note.slot - 1) * SLOT_SECONDS;
      if (time >= fromTime && time < toTime) events.push({ ...note, time, kit_id: pattern.kit_id ?? "acoustic" });
    }
  }
  return events.sort((left, right) => left.time - right.time || left.bar - right.bar || left.slot - right.slot);
}

export function splitPatternWindow({ activePattern, pendingPattern, fromTime, toTime, originTime, boundaryTime }: { activePattern: Pattern; pendingPattern: Pattern | null; fromTime: number; toTime: number; originTime: number; boundaryTime: number }) {
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
