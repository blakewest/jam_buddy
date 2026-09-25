import type { Instrument } from "./state.js";
const electronicGains = Object.freeze([0.2, 0.35, 0.5, 0.72, 1]);
const instrumentGains = Object.freeze({ kick: 0.8, snare: 0.65, closed_hat: 0.22, open_hat: 0.25 });

export const KITS = Object.freeze(([
  { id: "acoustic", name: "Acoustic", description: "AVL Black Pearl acoustic drums with five recorded velocity layers." },
  { id: "tr_808", name: "808", description: "Electronic, rounded bass drum, crisp hats. Default for a more modern/electronic sound from Acoustic." },
  { id: "tr_505", name: "TR-505", description: "Compact, punchy digital drum-machine sound; a different electronic alternative to the 808." },
] as const).map(kit => Object.freeze(kit)));
export type KitId = typeof KITS[number]["id"];

export function getKit(id: string) {
  const kit = KITS.find(item => item.id === id);
  if (!kit) throw new Error("Unknown drum kit.");
  return kit;
}

export function sampleForHit(kitId: string, instrument: Instrument, layer: number) {
  getKit(kitId);
  if (!Object.hasOwn(instrumentGains, instrument) || !Number.isInteger(layer) || layer < 1 || layer > 5) throw new Error("Invalid drum hit.");
  return kitId === "acoustic"
    ? { url: `/assets/osdk/${instrument}/layer-${layer}.wav`, gain: 1 }
    : { url: `/assets/${kitId}/${instrument}.wav`, gain: instrumentGains[instrument as keyof typeof instrumentGains] * electronicGains[layer - 1] };
}
