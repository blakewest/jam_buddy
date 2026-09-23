import type { Instrument } from "./state.js";
const PITCHES = Object.freeze({
  kick: [35, 36],
  snare: [37, 38, 39, 40],
  closed_hat: [22, 42, 44],
  open_hat: [26, 46],
  ride: [51, 53, 59],
  crash: [49, 52, 55, 57],
  high_tom: [48, 50],
  mid_tom: [45, 47],
  floor_tom: [41, 43, 58],
});

export const DEFAULT_PITCH = Object.freeze({ kick: 36, snare: 38, closed_hat: 42, open_hat: 46, ride: 51, crash: 49, high_tom: 50, mid_tom: 47, floor_tom: 43 });
export const defaultPitch = (instrument: string) => DEFAULT_PITCH[instrument as Instrument];
export const pitchForNote = (note: { midi_pitch?: number; instrument: string }) => note.midi_pitch ?? defaultPitch(note.instrument);
export const instrumentForPitch = (pitch: number) => (Object.keys(PITCHES) as Instrument[]).find(instrument => PITCHES[instrument].includes(pitch)) ?? null;
export const validPitchForInstrument = (pitch: number, instrument: string) => Number.isInteger(pitch) && PITCHES[instrument as Instrument]?.includes(pitch) === true;

const SAMPLE_FAMILY = Object.freeze({
  22: "hat_half", 26: "hat_three_quarter", 35: "kick", 36: "kick", 37: "snare_side", 38: "snare_center", 39: "snare_center", 40: "snare_rim",
  41: "tom_low", 42: "hat_closed", 43: "tom_low", 44: "hat_pedal", 45: "tom_mid", 46: "hat_open", 47: "tom_mid", 48: "tom_high", 49: "crash", 50: "tom_high", 51: "ride_bow", 52: "crash", 53: "ride_bell", 55: "crash", 57: "crash", 58: "tom_low", 59: "ride_bow",
});

export const sampleFamily = (pitch: number) => (SAMPLE_FAMILY as Record<number, string>)[pitch] ?? null;
