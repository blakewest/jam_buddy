import { INSTRUMENTS } from "./state.js";
import type { Instrument, Pattern } from "./state.js";

// Beat offsets span the whole phrase; end_beat is exclusive.
export type BeatSelection = { instruments: Instrument[]; start_beat: number; end_beat: number; beats_per_bar: number };
export function validSelection(value: unknown, pattern?: Pick<Pattern, "bars" | "meter">): value is BeatSelection {
  const s = value as BeatSelection;
  return !!s && Object.keys(s).sort().join(",") === "beats_per_bar,end_beat,instruments,start_beat"
    && Array.isArray(s.instruments) && s.instruments.length > 0 && s.instruments.length <= INSTRUMENTS.length
    && new Set(s.instruments).size === s.instruments.length && s.instruments.every(i => INSTRUMENTS.includes(i))
    && Number.isInteger(s.beats_per_bar) && s.beats_per_bar >= 1 && s.beats_per_bar <= 12
    && Number.isInteger(s.start_beat) && Number.isInteger(s.end_beat) && s.start_beat >= 0 && s.end_beat > s.start_beat
    && s.end_beat <= (pattern?.bars ?? 8) * s.beats_per_bar && (!pattern || s.beats_per_bar === pattern.meter.numerator);
}
export function selectionContains(s: BeatSelection, bar: number, beat: number) {
  const offset = (bar - 1) * s.beats_per_bar + beat - 1;
  return offset >= s.start_beat && offset < s.end_beat;
}
export function selectionRegions(s: BeatSelection) {
  const regions: { bar: number; beats: number[] }[] = [];
  for (let offset = s.start_beat; offset < s.end_beat; offset++) {
    const bar = Math.floor(offset / s.beats_per_bar) + 1;
    if (regions.at(-1)?.bar !== bar) regions.push({ bar, beats: [] });
    regions.at(-1)!.beats.push(offset % s.beats_per_bar + 1);
  }
  return regions;
}
export function selectionFromCells(a: { lane: number; beat: number }, b: { lane: number; beat: number }, beatsPerBar: number): BeatSelection {
  return { instruments: INSTRUMENTS.slice(Math.min(a.lane, b.lane), Math.max(a.lane, b.lane) + 1), start_beat: Math.min(a.beat, b.beat), end_beat: Math.max(a.beat, b.beat) + 1, beats_per_bar: beatsPerBar };
}
