export type Meter = { numerator: number; denominator: number };
export const TICKS_PER_QUARTER = 960;
export const SUPPORTED_METERS = Object.freeze([
  Object.freeze({ numerator: 3, denominator: 4 }),
  Object.freeze({ numerator: 4, denominator: 4 }),
  Object.freeze({ numerator: 6, denominator: 8 }),
]);

export function validMeter(meter: unknown): meter is Meter {
  const value = meter as Meter | undefined;
  return SUPPORTED_METERS.some(item => item.numerator === value?.numerator && item.denominator === value?.denominator);
}

export function ticksPerBar(meter: Meter) {
  if (!validMeter(meter)) throw new Error("Unsupported meter.");
  return meter.numerator * TICKS_PER_QUARTER * 4 / meter.denominator;
}

function beatTicks(meter: Meter) {
  return TICKS_PER_QUARTER * 4 / meter.denominator;
}

function positionMap(meter: Meter) {
  if (!validMeter(meter)) return new Map<string, number>();
  const result = new Map<string, number>();
  const size = beatTicks(meter);
  for (let beat = 1; beat <= meter.numerator; beat++) {
    const start = (beat - 1) * size;
    result.set(`beat_${beat}`, start);
    result.set(`beat_${beat}_e`, start + size / 4);
    result.set(`beat_${beat}_and`, start + size / 2);
    result.set(`beat_${beat}_a`, start + size * 3 / 4);
    result.set(`beat_${beat}_triplet_2`, start + size / 3);
    result.set(`beat_${beat}_triplet_3`, start + size * 2 / 3);
    for (let part = 2; part <= 6; part++) result.set(`beat_${beat}_sixteenth_triplet_${part}`, start + size * (part - 1) / 6);
  }
  return result;
}

export function tickForPosition(position: string, meter: Meter) {
  const tick = positionMap(meter).get(position);
  return Number.isInteger(tick) ? tick! : Number.NaN;
}

export function editPositions(meter: Meter) {
  const seen = new Set();
  return [...positionMap(meter)].filter(([, tick]) => {
    if (!Number.isInteger(tick) || seen.has(tick)) return false;
    seen.add(tick);
    return true;
  }).map(([id, tick]) => ({ id, tick }));
}

export function describeTick(tick: number, meter: Meter) {
  for (const [position, candidate] of positionMap(meter)) if (candidate === tick) return position;
  return `tick_${tick}`;
}

export const velocityForLayer = (layer: number) => [1, 32, 64, 96, 127][layer - 1];
