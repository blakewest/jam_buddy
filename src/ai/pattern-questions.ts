import type { PatternJevState, Instrument } from "../core/pattern/state.js";
import type { Questions } from "./question-types.js";
import { INSTRUMENTS } from "../core/pattern/state.js";
import { editPositions } from "../core/pattern/musical-time.js";

const inspect = ["request", "pattern.bars", "pattern.parts", "music_reference", "recent_history", "recent_take"];
const context = "Make the next single-note edit that moves `pattern` closer to the current `request`. If the pattern already fulfills the request, choose no edits. The application will send another pass with the updated pattern when more work remains. When present, `recent_take.note_ids` identifies the most recently inserted demonstration; use it for 'those' or 'that take'. Relabeling those hits preserves their timing unless timing is explicitly requested. The current request is authoritative; use `recent_history` only to resolve references such as 'that' or 'again'.";
const operationCountQuestion = {
  type: "choice",
  instructions: {
    question: "How many atomic note operations are required to make the current `pattern` fulfill `request`?",
    inspect,
    atomic_operation: "Adding, removing, or changing one existing note is one operation. Changing several fields or moving the same note several grid steps is still one operation. A whole-pattern reset is one operation.",
    focus: "Count only distinct notes that must change. Phrase-length changes are handled separately and do not count. Choose zero when no note edits are needed.",
  },
  criteria: Object.fromEntries(Array.from({ length: 9 }, (_, count) => [`operations_${count}`, count === 1 ? {
    meaning: "Exactly one atomic note operation",
    examples: ["move the first snare a little earlier", "remove the snare from beat 4", "add one kick on beat 1"],
  } : {
    meaning: count === 8 ? "Eight or more atomic note operations" : `Exactly ${count} atomic note operations`,
  }])),
};
const instrumentCriteria = {
  kick: { sound: "Bass drum", role: "Low pulse, downbeats, and rhythmic foundation" },
  snare: { sound: "Snare drum", role: "Backbeats, accents, and sharp responses" },
  closed_hat: { sound: "Closed hi-hat", role: "Short subdivision pulse and timekeeping" },
  open_hat: { sound: "Open hi-hat", role: "Longer bright accent or lift" },
  ride: { sound: "Ride cymbal", role: "Sustained cymbal pulse and timekeeping" },
  crash: { sound: "Crash cymbal", role: "Strong phrase-opening accent" },
  high_tom: { sound: "High tom", role: "High-pitched fill and melodic movement" },
  mid_tom: { sound: "Mid tom", role: "Mid-range fill and melodic movement" },
  floor_tom: { sound: "Floor tom", role: "Low fill, weight, and rolling movement" },
};

export const PLANNING_QUESTIONS = {
  operation_count: operationCountQuestion,
  phrase_length: {
    type: "choice",
    instructions: {
      question: "Does `request` explicitly ask for a particular phrase length in bars?",
      inspect,
      focus: "Choose keep_current unless the request asks to resize the whole repeating phrase. This is independent of note edits.",
    },
    criteria: {
      keep_current: { meaning: "Keep the current number of bars" },
      ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`bars_${index + 1}`, { meaning: `Resize the phrase to exactly ${index + 1} ${index ? "bars" : "bar"}` }])),
    },
  },
  ...Object.fromEntries(INSTRUMENTS.map(instrument => [`involves_${instrument}`, {
    type: "noul",
    instructions: {
      question: `Does fulfilling \`request\` involve ${instrumentCriteria[instrument].sound} notes as an existing source, a new target, or both?`,
      inspect,
      focus: "Include an instrument when its notes may need adding, removing, or changing. Broad requests about the whole groove involve every current instrument.",
    },
    criteria: {
      true: { meaning: `${instrumentCriteria[instrument].sound} notes are involved in the requested change` },
      false: { meaning: `${instrumentCriteria[instrument].sound} notes are unrelated to the requested change` },
    },
  }])),
};
const velocityCriteria = {
  velocity_1: { strength: "Very soft", midi_velocity: 16 },
  velocity_2: { strength: "Soft", midi_velocity: 40 },
  velocity_3: { strength: "Medium", midi_velocity: 64 },
  velocity_4: { strength: "Strong", midi_velocity: 96 },
  velocity_5: { strength: "Very strong", midi_velocity: 120 },
};
const timingCriteria = {
  earlier_eighth: { direction: "earlier", interval: "one straight eighth note" },
  earlier_sixteenth: { direction: "earlier", interval: "one straight sixteenth note" },
  earlier_eighth_triplet: { direction: "earlier", interval: "one eighth-note triplet step" },
  earlier_sixteenth_triplet: { direction: "earlier", interval: "one sixteenth-note triplet step" },
  earlier_10ms: { direction: "earlier", interval: "about 10 milliseconds", use_only_for: "Small nudge earlier: 'nudge it earlier', 'nudge it a little earlier', 'just a hair early', 'a touch early', or 'just slightly earlier'. An explicitly requested note subdivision instead uses that grid interval." },
  no_change: { direction: "unchanged", sixteenth_note_steps: 0 },
  later_10ms: { direction: "later", interval: "about 10 milliseconds", use_only_for: "Small nudge later: 'nudge it later', 'nudge it a little later', 'just a hair late', 'a touch late', or 'just slightly later'. An explicitly requested note subdivision instead uses that grid interval." },
  later_sixteenth_triplet: { direction: "later", interval: "one sixteenth-note triplet step" },
  later_eighth_triplet: { direction: "later", interval: "one eighth-note triplet step" },
  later_sixteenth: { direction: "later", interval: "one straight sixteenth note" },
  later_eighth: { direction: "later", interval: "one straight eighth note" },
};
const velocityChangeCriteria = {
  decrease_2: { midi_velocity_delta: -32 },
  decrease_1: { midi_velocity_delta: -16 },
  no_change: { midi_velocity_delta: 0 },
  increase_1: { midi_velocity_delta: 16 },
  increase_2: { midi_velocity_delta: 32 },
};

function notesFromParts(state: PatternJevState) {
  return INSTRUMENTS.flatMap(instrument => state.pattern.parts[instrument].map(note => ({ ...note, instrument })));
}

function additionCriteria(state: PatternJevState, instrument: Instrument, selectedBar: number | null = null) {
  const occupied = new Set(notesFromParts(state).map(note => `${note.instrument}:${note.bar}:${note.tick}`));
  const criteria: Record<string, unknown> = { no_addition: { meaning: "The current pattern already satisfies the request, or the next edit should remove or modify an existing note." } };
  for (let bar = 1; bar <= state.pattern.bars; bar++) {
    if (selectedBar !== null && bar !== selectedBar) continue;
    for (const position of editPositions(state.pattern.meter)) {
      if (occupied.has(`${instrument}:${bar}:${position.tick}`)) continue;
      criteria[`add_${instrument}_in_bar_${bar}_at_${position.id}`] = {
        action: `Add one ${instrumentCriteria[instrument].sound} note`,
        bar,
        position: position.id,
        tick: position.tick,
      };
    }
  }
  return criteria;
}

function additionQuestions(state: PatternJevState, instrument: Instrument, bar: number | null = null) {
  return {
    [`addition_${instrument}_action`]: {
      type: "choice",
      instructions: {
        question: "Which single legal note addition best moves the current pattern closer to `request`, or is no addition needed?",
        inspect,
        context,
        focus: `Choose the most important missing ${instrumentCriteria[instrument].sound} position. Occupied positions are deliberately absent from the choices.`,
      },
      criteria: additionCriteria(state, instrument, bar),
    },
    [`addition_${instrument}_velocity`]: {
      type: "choice",
      instructions: { premise: "Assume the chosen addition action will be applied.", question: "Which velocity layer should the new note use?", inspect, context },
      criteria: velocityCriteria,
    },
  };
}

function noteQuestions(note: PatternJevState["pattern"]["parts"][Instrument][number] & { instrument: Instrument }) {
  const instructions = (extra: Record<string, unknown>) => ({ note: { ...note }, context, ...extra });
  return {
    [`${note.id}_operation`]: {
      type: "choice",
      instructions: instructions({ question: "Given `request`, what should happen to this exact note?", focus: "Judge this note independently. Other questions describe possible changes." }),
      criteria: {
        remove: { meaning: "Delete this note from the pattern" },
        modify: { meaning: "Keep this note but change one or more fields" },
        no_op: { meaning: "Leave this note exactly as it is" },
      },
    },
    [`${note.id}_timing`]: {
      type: "choice",
      instructions: instructions({ premise: "Assume this exact note will be modified rather than removed.", question: "How should its timing change to satisfy `request`?", grid: "'Nudge' earlier or later means one about-10ms micro timing adjustment, including 'nudge it a little earlier/later'. 'Just a hair', 'a touch', and 'just slightly' also mean micro timing. An explicit note interval takes priority: 'nudge it a sixteenth earlier' uses earlier_sixteenth. Without nudge or other micro wording, 'move it a little earlier' or 'a little later' uses a grid move. Movement wraps around the complete phrase." }),
      criteria: timingCriteria,
    },
    [`${note.id}_velocity`]: {
      type: "choice",
      instructions: instructions({ premise: "Assume this exact note will be modified rather than removed.", question: "How should its velocity layer change to satisfy `request`?" }),
      criteria: velocityChangeCriteria,
    },
    [`${note.id}_instrument`]: {
      type: "choice",
      instructions: instructions({ premise: "Assume this exact note will be modified rather than removed.", question: "Which instrument should it use to satisfy `request`?" }),
      criteria: {
        keep_current: { meaning: `Keep the current ${note.instrument} instrument` },
        kick: { meaning: "Use a kick" },
        snare: { meaning: "Use a snare" },
        closed_hat: { meaning: "Use a closed hi-hat" },
        open_hat: { meaning: "Use an open hi-hat" },
        ride: { meaning: "Use a ride cymbal" },
        crash: { meaning: "Use a crash cymbal" },
        high_tom: { meaning: "Use a high tom" },
        mid_tom: { meaning: "Use a mid tom" },
        floor_tom: { meaning: "Use a floor tom" },
      },
    },
  };
}

export function buildPatternQuestions(state: PatternJevState, relevantInstruments: readonly Instrument[] = INSTRUMENTS): Questions {
  const selected = INSTRUMENTS.filter(instrument => relevantInstruments.includes(instrument));
  const questions: Questions = {
    reset_pattern: {
      type: "noul",
      instructions: {
        question: "Does `request` clearly ask to discard every note in the current `pattern` and start again with an empty phrase?",
        inspect,
        context,
        focus: "This is a destructive whole-pattern reset. Simplifying, removing one instrument, undoing one idea, or changing the groove are not resets.",
      },
      criteria: {
        true: { meaning: "The user clearly wants every note removed and a completely empty starting point." },
        false: { meaning: "The user wants to preserve the pattern as continuing work." },
      },
    },
  };
  for (const instrument of selected) Object.assign(questions, additionQuestions(state, instrument));
  for (const note of notesFromParts(state).filter(note => selected.includes(note.instrument))) Object.assign(questions, noteQuestions(note));
  return questions;
}

export function patternSummary(state: PatternJevState) {
  return { ...state, pattern: { ...state.pattern, hit_fields: ["tick", "velocity"], parts: Object.fromEntries(INSTRUMENTS.map(instrument => [instrument,
    Array.from({ length: state.pattern.bars }, (_, i) => {
      const notes = state.pattern.parts[instrument].filter(note => note.bar === i + 1);
      return { bar: i + 1, notes: notes.length, hits: notes.map(note => [note.tick, note.velocity]) };
    }),
  ])) } };
}

export function buildScopeQuestion(state: PatternJevState, instruments: Instrument[]): Questions {
  return { edit_scope: { type: "choice", instructions: "Choose the instrument and bar for the next single-note edit requested in `request`. For edits across several bars, choose the next bar that still needs a change. Choose none if already satisfied.", criteria: {
    none: "No further edit needed",
    ...Object.fromEntries(instruments.flatMap(instrument => Array.from({ length: state.pattern.bars }, (_, i) => [`${instrument}:${i + 1}`, `Edit ${instrument} in bar ${i + 1}`]))),
  } } };
}

export function buildTargetQuestion(state: PatternJevState, instrument: Instrument, bar: number): Questions {
  return { edit_target: { type: "choice", instructions: "Choose the one existing note to remove or modify next to fulfill `request`, or add a missing note in the selected instrument and bar. Choose none if this scope already satisfies the request.", criteria: {
    none: "No further edit needed in this scope", add: `Add a ${instrument} note in bar ${bar}`,
    ...Object.fromEntries(state.pattern.parts[instrument].filter(note => note.bar === bar).map(note => [note.id, note])),
  } } };
}

export function buildTargetDetails(state: PatternJevState, instrument: Instrument, bar: number, target: string): Questions {
  if (target === "add") return additionQuestions(state, instrument, bar);
  const note = state.pattern.parts[instrument].find(note => note.id === target && note.bar === bar);
  if (!note) throw new Error("Invalid edit target.");
  return noteQuestions({ ...note, instrument });
}

export function buildPlanningQuestions(state: PatternJevState) {
  if (!state.recent_take?.note_ids.length) return PLANNING_QUESTIONS;
  return { ...PLANNING_QUESTIONS, recorded_take_instrument: {
    type: "choice" as const,
    instructions: "Does `request` ONLY ask to relabel all notes identified by `recent_take.note_ids` as one instrument (for example 'those should be hi-hats')? Select that instrument only for an explicit whole-take label correction. Otherwise use ordinary_edit, including changes to timing, velocity, phrase length, a subset of hits, or multiple kinds of edits.",
    criteria: { ordinary_edit: "Use the normal atomic note edit loop.", kick: "All notes of the last take should be kicks.", snare: "All notes of the last take should be snares.", closed_hat: "All notes of the last take should be closed hi-hats.", open_hat: "All notes of the last take should be open hi-hats." },
  } };
}
