import { INSTRUMENTS } from "../core/pattern/state.js";

const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export function buildVelocityEditQuestions(state) {
  return {
    operation: choice("Does `request` ask ONLY for a relative loudness/velocity increase or decrease of specified drum notes? Choose other for exact numbers, percentages, doubling/halving, mixed edits, adding notes, or unclear references. Louder means increase from the values at submission, even if already accented.", {
      increase: "Louder, increase velocity: +16", increase_lots: "Much louder, a lot stronger: +32", decrease: "Quieter, decrease velocity: -16", decrease_lots: "Much quieter: -32", other: "Another edit, an unsupported amount, or ambiguous targets",
    }),
    instrument: choice("Which instrument does this velocity request explicitly target? Unqualified hi-hats means both closed and open hats. Choose unknown for unclear references like 'those' without an explicit target.", { ...Object.fromEntries(INSTRUMENTS.map(i => [i, i])), hats: "Hi-hats, open and closed", all: "All drums", unknown: "Unclear or multiple instruments other than hats/all" }),
    beat_scope: choice("Does the request specify numbered beats?", { all: "No numbered restriction, all beats", selected: "Specific numbered beats" }),
    subdivision: choice("Which positions within each beat are requested? 'On beats 3 and 4' means onbeats only; offbeats means the eighth-note 'ands'. Unqualified 'make hats louder' means all notes.", { onbeats: "Numbered beats/on-beats", offbeats: "Off-beats/ands", all: "All subdivisions" }),
    bar_scope: choice("Does the request specify bar numbers? Beat numbers are not bar numbers. Default to all bars.", { all: "All bars", selected: "Specific bars" }),
    ...Object.fromEntries(Array.from({ length: state.pattern.meter.numerator }, (_, i) => [`beat_${i + 1}`, { type: "noul", instructions: `Does the request explicitly include beat ${i + 1} among its target beats? Interpret ranges inclusively.` }])),
    ...Object.fromEntries(Array.from({ length: state.pattern.bars }, (_, i) => [`bar_${i + 1}`, { type: "noul", instructions: `Does the request explicitly include bar ${i + 1} among its target bars? Beat numbers are not bar numbers.` }])),
  };
}

export function velocityIntent(state, answers) {
  const deltas = { increase: 16, increase_lots: 32, decrease: -16, decrease_lots: -32 };
  const delta = deltas[answers.operation.choice];
  const instrument = answers.instrument.choice;
  if (!delta || instrument === "unknown") return null;
  const instruments = instrument === "hats" ? ["closed_hat", "open_hat"] : instrument === "all" ? [...INSTRUMENTS] : [instrument];
  const beats = Array.from({ length: state.pattern.meter.numerator }, (_, i) => i + 1).filter(i => answers.beat_scope.choice === "all" || answers[`beat_${i}`].noul >= 0.5);
  const bars = Array.from({ length: state.pattern.bars }, (_, i) => i + 1).filter(i => answers.bar_scope.choice === "all" || answers[`bar_${i}`].noul >= 0.5);
  return beats.length && bars.length ? { instruments, beats, bars, subdivision: answers.subdivision.choice, delta } : null;
}
