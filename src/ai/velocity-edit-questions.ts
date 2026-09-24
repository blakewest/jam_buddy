import { INSTRUMENTS } from "../core/pattern/state.js";

import type { PatternJevState } from "../core/pattern/state.js";
import type { Answers } from "./question-types.js";
const choice = (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria });
export function buildVelocityEditQuestions(state: PatternJevState) {
  return {
    operation: choice("Which relative loudness/velocity change does `request` ask for? In this drum editor, quiet down, turn down, lower/reduce/decrease velocity, softer, less loud, and less intense all mean decrease note velocity. No numeric amount is required. 'Nice, but quiet down all the hi-hats' is decrease; polite words and feedback such as nice, okay, or but are not additional edits. Louder, turn up, increase velocity, stronger, and accent mean increase from the values at submission, even if already accented. Use the larger change only for explicit emphasis such as much, a lot, or really. Beat/bar numbers and all-notes scopes select targets, not exact velocity amounts. Choose other for exact velocity values or numeric changes, percentages, doubling/halving, requests combining velocity with another edit, adding/removing/moving notes, or unresolved references.", {
      increase: "Louder, turn up, increase velocity, stronger, accent: increase each selected note once by 16",
      increase_lots: "Much louder, a lot stronger, really loud: increase each selected note once by 32",
      decrease: "Quiet down, turn down, reduce/lower/decrease velocity, softer, quieter, less loud: decrease each selected note once by 16",
      decrease_lots: "Much quieter, a lot softer, really quiet: decrease each selected note once by 32",
      other: "Not a relative note-velocity change, an unsupported numeric amount, a mixed edit, or unresolved references. Ordinary quiet-down/softer requests belong to decrease.",
    }),
    instrument: choice("Which instrument does this velocity request explicitly target? Unqualified hi-hats means both closed and open hats. Choose unknown for unclear references like 'those' without an explicit target.", { ...Object.fromEntries(INSTRUMENTS.map(i => [i, i])), hats: "Hi-hats, open and closed", all: "All drums", unknown: "Unclear or multiple instruments other than hats/all" }),
    beat_scope: choice("Does the request specify numbered beats?", { all: "No numbered restriction, all beats", selected: "Specific numbered beats" }),
    subdivision: choice("Which positions within each beat are requested? 'On beats 3 and 4' means onbeats only; offbeats means the eighth-note 'ands'. Unqualified 'make hats louder' means all notes.", { onbeats: "Numbered beats/on-beats", offbeats: "Off-beats/ands", all: "All subdivisions" }),
    bar_scope: choice("Does the request specify bar numbers? Beat numbers are not bar numbers. Default to all bars.", { all: "All bars", selected: "Specific bars" }),
    ...Object.fromEntries(Array.from({ length: state.pattern.meter.numerator }, (_, i) => [`beat_${i + 1}`, { type: "noul", instructions: `Does the request explicitly include beat ${i + 1} among its target beats? Interpret ranges inclusively.` }])),
    ...Object.fromEntries(Array.from({ length: state.pattern.bars }, (_, i) => [`bar_${i + 1}`, { type: "noul", instructions: `Does the request explicitly include bar ${i + 1} among its target bars? Beat numbers are not bar numbers.` }])),
  };
}

export function velocityIntent(state: PatternJevState, answers: Answers) {
  const deltas: Record<string, number> = { increase: 16, increase_lots: 32, decrease: -16, decrease_lots: -32 };
  const delta = deltas[answers.operation.choice ?? ""];
  const instrument = answers.instrument.choice ?? "unknown";
  if (!delta || instrument === "unknown") return null;
  const instruments = instrument === "hats" ? ["closed_hat", "open_hat"] : instrument === "all" ? [...INSTRUMENTS] : [instrument];
  const beats = Array.from({ length: state.pattern.meter.numerator }, (_, i) => i + 1).filter(i => answers.beat_scope.choice === "all" || (answers[`beat_${i}`].noul ?? 0) >= 0.5);
  const bars = Array.from({ length: state.pattern.bars }, (_, i) => i + 1).filter(i => answers.bar_scope.choice === "all" || (answers[`bar_${i}`].noul ?? 0) >= 0.5);
  return beats.length && bars.length ? { instruments, beats, bars, subdivision: answers.subdivision.choice ?? "all", delta } : null;
}
