import { INSTRUMENTS } from "../core/pattern/state.js";
import { RHYTHM_STEPS } from "../core/pattern/rhythm-fill.js";
import type { PatternJevState, Instrument } from "../core/pattern/state.js";
import type { RhythmIntent } from "../core/pattern/rhythm-fill.js";
import type { Answers, Questions } from "./question-types.js";

export function rhythmFillContext(state: PatternJevState) {
  return { request: state.request, bars: state.pattern.bars, meter: state.pattern.meter,
    previous_change: state.recent_history.at(-1) ?? null };
}

export function buildRhythmFillQuestions(state: PatternJevState): Questions {
  const context = "The current request is authoritative. Use previous_change only to resolve omitted details in references like 'do it as well'. Never copy its instrument when the current request names a different one.";
  const choice = (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions: `${instructions} ${context}`, criteria });
  return {
    operation: choice("Does the user want to fill regular quarter, eighth or sixteenth notes for ONE drum? Filling adds missing hits and preserves existing hits. Choose unsupported for removing, replacing, moving, triplets, multiple instruments, mixed actions or unresolved references.", { fill: "Fill regular hits for one drum", unsupported: "Not a supported rhythm fill" }),
    instrument: choice("Which drum should receive the regular rhythm? Unqualified hats/hi-hats means closed_hat. In a follow-up, inherit the instrument from the most recent change only.", { ...Object.fromEntries(INSTRUMENTS.map(i => [i, i])), unknown: "No identifiable single drum" }),
    note_value: choice("What note spacing is requested? '16ths' means sixteenths; '8ths' means eighths. For 'do it' follow-ups, inherit the previous change's spacing.", { quarters: "Quarter notes", eighths: "Eighth notes", sixteenths: "Sixteenth notes", unknown: "Unspecified and cannot resolve, or unsupported spacing" }),
    beat_scope: choice("Does the current request restrict numbered beats? 'On beat 2' fills subdivisions throughout beat 2. 'Rest of the bar' means fill all missing positions, so choose all. Without a restriction choose all; do not inherit old beat restrictions.", { all: "All beats / rest of bar", selected: "Explicitly numbered beat(s) or range" }),
    bar_scope: choice("Does the current request restrict numbered bars? Default all. Beat numbers are not bar numbers.", { all: "All existing bars", selected: "Explicit bar numbers" }),
    velocity: choice("How loud should newly added notes be? Default medium. Existing notes keep their velocities.", { soft: "Quiet/soft", medium: "Normal/default", strong: "Loud/strong" }),
    ...Object.fromEntries(Array.from({ length: state.pattern.meter.numerator }, (_, i) => [`beat_${i + 1}`, { type: "noul", instructions: `Does the current request include beat ${i + 1} in its explicit numbered beat range/list? Read ranges inclusively. Beat numbers are not subdivisions.` }])),
    ...Object.fromEntries(Array.from({ length: state.pattern.bars }, (_, i) => [`bar_${i + 1}`, { type: "noul", instructions: `Does the current request include bar ${i + 1} in its explicit bar range/list? Read ranges inclusively. Beat numbers are not bar numbers.` }])),
  };
}

export function rhythmFillIntent(state: PatternJevState, answers: Answers): RhythmIntent | null {
  const instrument = answers.instrument.choice;
  const noteValue = answers.note_value.choice;
  if (answers.operation.choice !== "fill" || !INSTRUMENTS.includes(instrument as Instrument) || !noteValue || !Object.hasOwn(RHYTHM_STEPS, noteValue)) return null;
  const beats = Array.from({ length: state.pattern.meter.numerator }, (_, i) => i + 1).filter(i => answers.beat_scope.choice === "all" || (answers[`beat_${i}`].noul ?? 0) >= 0.5);
  const bars = Array.from({ length: state.pattern.bars }, (_, i) => i + 1).filter(i => answers.bar_scope.choice === "all" || (answers[`bar_${i}`].noul ?? 0) >= 0.5);
  const velocity = { soft: 32, medium: 64, strong: 96 }[answers.velocity.choice ?? ""];
  return beats.length && bars.length && velocity ? { instrument: instrument as Instrument, note_value: noteValue as RhythmIntent["note_value"], beats, bars, velocity } : null;
}
