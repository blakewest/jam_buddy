import { TICKS_PER_QUARTER } from "./musical-time.js";

// Product defaults: 50 is straight, 55 is light, relative changes use 10 points.
export const SWING_CHOICES = {
  light: "Set light eighth-note swing to 55%; also the default for 'add swing'.",
  moderate: "An absolute request explicitly asks for medium swing or 65%. Never select for a comparative request like harder or more.",
  strong: "An absolute request explicitly asks for strong swing or 75%. Never select for a comparative request like harder or more.",
  maximum: "Set maximum eighth-note swing to 85%.",
  increase: "A relative adjustment upward, regardless of the current amount: 'more swing', 'swing it harder', 'even stronger'.",
  decrease: "Decrease the CURRENT swing: 'less swing', 'ease off', 'a little straighter'.",
  remove: "Remove added swing: 'no swing', 'remove swing', 'straighten it out'.",
  unsupported: "Sixteenth-note swing, swing on only one instrument, or an unsupported swing amount/action.",
};
export type SwingAction = keyof typeof SWING_CHOICES;

export function normalizedSwing(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 50 && value <= 85 ? value : 50;
}

export function nextSwingPercent(current: number, action: SwingAction): number {
  switch (action) {
    case "light": return 55;
    case "moderate": return 65;
    case "strong": return 75;
    case "maximum": return 85;
    case "increase": return current === 50 ? 55 : Math.min(85, current + 10);
    case "decrease": return Math.max(50, current - 10);
    case "remove": return 50;
    case "unsupported": return current;
  }
}

// Continuous time warp: stretch the first eighth, compress the second.
// Original ticks stay untouched; off-grid timing is never quantized.
export function swungTick(tick: number, swingPercent: number): number {
  if (swingPercent === 50) return tick;
  const pairStart = Math.floor(tick / TICKS_PER_QUARTER) * TICKS_PER_QUARTER;
  const withinPair = tick - pairStart;
  const half = TICKS_PER_QUARTER / 2;
  const ratio = swingPercent / 100;
  return pairStart + (withinPair <= half
    ? withinPair * 2 * ratio
    : TICKS_PER_QUARTER * ratio + (withinPair - half) * 2 * (1 - ratio));
}
