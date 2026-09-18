const BAR_SECONDS = 2;
const SLOT_SECONDS = BAR_SECONDS / 16;

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
