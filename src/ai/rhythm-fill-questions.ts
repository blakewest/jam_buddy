import { TOM_DEFAULT } from "./instrument-rules.js";
import { selectionRegions, selectionContains } from "../core/pattern/selection.js";
import type { BeatSelection } from "../core/pattern/selection.js";
import { INSTRUMENTS } from "../core/pattern/state.js";
import { RHYTHM_STEPS } from "../core/pattern/rhythm-fill.js";
import type { PatternJevState, Instrument } from "../core/pattern/state.js";
import type { RhythmIntent } from "../core/pattern/rhythm-fill.js";
import type { Answers, Questions } from "./question-types.js";

export function rhythmFillContext(state: PatternJevState) {
  return { request: state.request, bars: state.pattern.bars, meter: state.pattern.meter,
    recent_history: state.recent_history.slice(-8) };
}

export function buildRhythmFillQuestions(state: PatternJevState): Questions {
  const context = "The current request is authoritative. Use recent_history (oldest to newest) only to resolve omitted details such as 'them', 'those', or 'do it as well'. A failed or unrelated request does not erase the last relevant drum or rhythm. Look back to the latest relevant request and its applied changes. Current explicit details always override history; never copy an old instrument or spacing when the current request names another.";
  const choice = (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions: `${instructions} ${context}`, criteria });
  return {
    operation: choice("Does the user want to add regular quarter, eighth or sixteenth notes, or a three-hit quarter/eighth triplet group for ONE drum? Filling adds missing hits and preserves existing hits. Choose unsupported for removing, replacing, moving, other tuplets, multiple instruments, mixed actions or unresolved references.", { fill: "Add regular hits or a triplet group for one drum", unsupported: "Not a supported rhythm fill" }),
    instrument: { type: "choice", instructions: {
      question: "Which single drum does `request` ask to add notes to?",
      history: "For 'them', 'those', 'these', 'em', or an omitted drum, read `recent_history` from newest to oldest. Resolve the drum from the most recent relevant successful request AND its applied_changes. For example, after adding hats on eighths, 'actually add them on the 16ths' still targets closed_hat. Skip failed requests and unrelated kit/tempo changes. Do not choose unknown just because the current request uses a pronoun. If history has no single relevant drum, choose unknown.",
      tom_default: TOM_DEFAULT,
      rules: "An explicitly named drum always wins. Kick, kicks, bass drum mean kick. Snare or snares mean snare. Hats or hi-hats without open/closed means closed_hat. If the drum is omitted and selection is present, choose selected for the highlighted lane. Otherwise use the latest relevant successful rhythm in recent_history. Note spacing and bar numbers do not change the drum.",
    }, criteria: { selected: "The highlighted drum lane, if selection identifies one drum", kick: "Kick / bass drum", snare: "Snare drum", closed_hat: "Closed hi-hat / unqualified hats", open_hat: "Open hi-hat", ride: "Ride cymbal", crash: "Crash cymbal", high_tom: "High tom", mid_tom: "Middle tom", floor_tom: "Floor / low tom", unknown: "No single drum is named or resolvable" } },
    note_value: choice("What note spacing is requested? Unqualified 'triplets' selects triplets (automatic spacing), even if history used another spacing. Choose quarter_triplets only when quarter-note triplets are explicitly requested. Code chooses quarter-note triplets by default, or eighth-note triplets for a selection too short for quarters. 'Triplet eighths', 'eighth-note triplets', '8th triplets' means eighth_triplets. Straight '16ths', '16th', 'sixteenth' or 'sixteenths' means sixteenths; straight '8ths', '8th' or 'eighths' means eighths. Speech transcripts may omit the plural: after eighth-note hats, 'actually do the 16th, add them on the 16th' requests sixteenth-note spacing for the same drum. For 'do it' follow-ups with no explicit spacing, use the latest relevant rhythm in recent_history. Current explicit spacing overrides history.", { quarters: "Straight quarter notes", eighths: "Straight eighth notes", sixteenths: "Straight sixteenth notes", triplets: "Triplets without an explicit note value; fit the selection", quarter_triplets: "Explicit quarter-note triplets: three hits over two quarter-note beats", eighth_triplets: "Three eighth-note triplet hits over one quarter-note beat", unknown: "Unspecified and cannot resolve, or unsupported spacing" }),
    beat_scope: choice("Does `request` name particular beat positions within a bar? Note values describe spacing, NOT beat positions: 'on the 16ths', 'on the 16th', 'sixteenths', 'on the 8ths', 'on the 8th', 'quarter notes' and 'triplets' all choose all unless a separate beat position is named. 'Hats on the 16ths' means all beats. '16th hats on beat 2' means selected, filling subdivisions throughout beat 2. 'Rest of the bar' means all. Without explicit beat positions choose all; do not inherit old beat restrictions.", { all: "No particular beat positions named; all beats, including requests that only name note spacing", selected: "Particular beat positions explicitly named, e.g. beat 2, beats 2 through 4, or the last beat" }),
    bar_scope: choice("Does `request` name particular bars of the pattern? Note spacing ('16ths', '16th', '8ths', '8th', quarter notes, triplets) and beat positions are NOT bar numbers. Speech transcripts may use singular note values: 'actually do the 16th, add them on the 16th' means all bars, not bar 16. Only choose selected when a bar or measure position is named. 'Hats on the 16ths' means all existing bars. '16th hats in bar 2' means selected. Without an explicit bar restriction choose all; do not inherit old bar restrictions.", { all: "No particular bars named; all existing bars", selected: "Particular bars explicitly named, e.g. bar 2, the fourth bar, or the last bar" }),
    velocity: choice("How loud should newly added notes be? Default medium. Existing notes keep their velocities.", { soft: "Quiet/soft", medium: "Normal/default", strong: "Loud/strong" }),
    ...Object.fromEntries(Array.from({ length: state.pattern.meter.numerator }, (_, i) => [`beat_${i + 1}`, { type: "noul", instructions: `Does the current request include beat ${i + 1} in its explicit numbered beat range/list? Read ranges inclusively. Beat numbers are not subdivisions.` }])),
    ...Object.fromEntries(Array.from({ length: state.pattern.bars }, (_, i) => [`bar_${i + 1}`, { type: "noul", instructions: `Does the current request include bar ${i + 1} in its explicit bar range/list? Read ranges inclusively. Beat numbers are not bar numbers.` }])),
  };
}

export function rhythmFillIntent(state: PatternJevState, answers: Answers, selection?: BeatSelection): RhythmIntent | null {
  const instrument = answers.instrument.choice === "selected" && selection?.instruments.length === 1 ? selection.instruments[0] : answers.instrument.choice;
  const useSelection = selection && answers.selection_scope?.choice === "selected";
  const regions = useSelection ? selectionRegions(selection) : [];
  const selectedQuarterTicks = regions.map(region => region.beats.length * 960 * 4 / state.pattern.meter.denominator);
  const noteValue = answers.note_value.choice === "triplets"
    ? (useSelection && selectedQuarterTicks.some(ticks => ticks < 1920) ? "eighth_triplets" : "quarter_triplets")
    : answers.note_value.choice;
  if (answers.operation.choice !== "fill" || !INSTRUMENTS.includes(instrument as Instrument) || !noteValue || !Object.hasOwn(RHYTHM_STEPS, noteValue)) return null;
  const triplet = noteValue === "quarter_triplets" || noteValue === "eighth_triplets";
  const start = Number(answers.triplet_start?.choice?.replace("beat_", ""));
  const beats = triplet
    ? (Number.isInteger(start) && start >= 1 && start <= state.pattern.meter.numerator ? [start] : [])
    : useSelection ? [...new Set(regions.flatMap(r => r.beats))] : Array.from({ length: state.pattern.meter.numerator }, (_, i) => i + 1).filter(i => answers.beat_scope.choice === "all" || (answers[`beat_${i}`].noul ?? 0) >= 0.5);
  const bars = useSelection ? regions.map(r => r.bar) : Array.from({ length: state.pattern.bars }, (_, i) => i + 1).filter(i => answers.bar_scope.choice === "all" || (answers[`bar_${i}`].noul ?? 0) >= 0.5);
  const velocity = { soft: 32, medium: 64, strong: 96 }[answers.velocity.choice ?? ""];
  return beats.length && bars.length && velocity ? { instrument: instrument as Instrument, note_value: noteValue as RhythmIntent["note_value"], beats, bars, velocity, ...(useSelection ? { selection } : {}) } : null;
}


export function buildTripletPlacementQuestions(state: PatternJevState, answers: Answers, selection?: BeatSelection): Questions | null {
  const intent = rhythmFillIntent(state, { ...answers, triplet_start: { type: "choice", choice: "beat_1" } }, selection);
  if (!intent || !["quarter_triplets", "eighth_triplets"].includes(intent.note_value)) return null;
  const step = RHYTHM_STEPS[intent.note_value];
  const beatTicks = 960 * 4 / state.pattern.meter.denominator;
  const lastStart = Math.floor((state.pattern.meter.numerator * beatTicks - step * 3) / beatTicks) + 1;
  const criteria = Object.fromEntries(Array.from({ length: Math.max(0, lastStart) }, (_, i) => {
    const start = i * beatTicks;
    const ticks = [start, start + step, start + step * 2];
    const existing = state.pattern.parts[intent.instrument].filter(note => intent.bars.includes(note.bar) && ticks.some(tick => Math.abs(note.tick - tick) <= 60)).length;
    return [`beat_${i + 1}`, { starting_beat: i + 1, hit_ticks: ticks, existing_hits_at_these_positions: existing, position: i + 1 === lastStart ? "End-of-bar fill" : i === 0 ? "Beginning of bar" : "Middle of bar" }];
  }).filter(([, candidate]) => !intent.selection || intent.bars.every(bar => (candidate as {hit_ticks:number[]}).hit_ticks.every(tick => selectionContains(intent.selection!, bar, tick / beatTicks + 1)))));
  if (!Object.keys(criteria).length) throw Object.assign(new Error(`Those ${intent.note_value === "quarter_triplets" ? "quarter" : "eighth"}-note triplets do not fit in the ${intent.selection ? "selection" : "bar"}. Select ${intent.note_value === "quarter_triplets" ? "two quarter-note beats, or ask for eighth-note triplets" : "at least one quarter-note beat"}.`), { status: 422 });
  return { triplet_start: { type: "choice", instructions: {
    question: `Where should the three-hit ${intent.note_value} group for ${intent.instrument} in bars ${intent.bars.join(", ")} start?`,
    rules: "Choose one offered beat. Honor an explicit start or end position in the request. A bar number is NOT a starting beat: 'in the 4th bar' does not mean beat 4. If no start is specified, infer a musical placement from the request and groove, prefer space with fewer existing hits, and use an end-of-bar fill when equally suitable. Never choose unknown merely because a start was omitted. Choose unknown only if an explicitly requested starting position is unavailable or conflicting.",
  }, criteria: { ...criteria, unknown: "The explicitly requested placement cannot be satisfied" } } };
}

export function tripletPlacementContext(state: PatternJevState) {
  return { ...rhythmFillContext(state), ticks_per_quarter: state.pattern.ticks_per_quarter,
    groove: Object.fromEntries(INSTRUMENTS.map(instrument => [instrument, state.pattern.parts[instrument].map(note => [note.bar, note.tick])])) };
}
