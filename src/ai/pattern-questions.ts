import { INSTRUMENTS, POSITIONS, type Instrument, type PatternJevState, type Position } from "../core/pattern/state.js";
type PartNote = PatternJevState["pattern"]["parts"][Instrument][number] & { instrument: Instrument };
type Question = { type: "choice" | "noul"; instructions: unknown; criteria: Record<string, unknown> };

const inspect = ["request", "pattern.bars", "pattern.parts", "music_reference", "recent_history"];
const context = "Make the next single-note edit that moves `pattern` closer to the current `request`. If the pattern already fulfills the request, choose no edits. The application will send another pass with the updated pattern when more work remains. The current request is authoritative; use `recent_history` only to resolve references such as 'that' or 'again'.";
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
      bars_1: { meaning: "Resize the phrase to exactly one bar" },
      bars_2: { meaning: "Resize the phrase to exactly two bars" },
      bars_3: { meaning: "Resize the phrase to exactly three bars" },
      bars_4: { meaning: "Resize the phrase to exactly four bars" },
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
  }])) as unknown as Record<`involves_${Instrument}`, Question>,
};
const velocityCriteria = {
  layer_1: { strength: "Very soft", midi_range: "1-25" },
  layer_2: { strength: "Soft", midi_range: "26-50" },
  layer_3: { strength: "Medium", midi_range: "51-76" },
  layer_4: { strength: "Strong", midi_range: "77-101" },
  layer_5: { strength: "Very strong", midi_range: "102-127" },
};
const positionDetails = [
  ["beat_1", "Beat 1", "eighth-note grid"],
  ["beat_1_e", "Beat 1 e", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_1_and", "Beat 1-and", "eighth-note grid"],
  ["beat_1_a", "Beat 1 a", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_2", "Beat 2", "eighth-note grid"],
  ["beat_2_e", "Beat 2 e", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_2_and", "Beat 2-and", "eighth-note grid"],
  ["beat_2_a", "Beat 2 a", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_3", "Beat 3", "eighth-note grid"],
  ["beat_3_e", "Beat 3 e", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_3_and", "Beat 3-and", "eighth-note grid"],
  ["beat_3_a", "Beat 3 a", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_4", "Beat 4", "eighth-note grid"],
  ["beat_4_e", "Beat 4 e", "sixteenth-note-only; not on the eighth-note grid"],
  ["beat_4_and", "Beat 4-and", "eighth-note grid"],
  ["beat_4_a", "Beat 4 a", "sixteenth-note-only; not on the eighth-note grid"],
];
const positionCriteria = Object.fromEntries(positionDetails.map(([key, position, grid]) => [key, { position, grid }]));
const timingCriteria = {
  earlier_4: { direction: "earlier", sixteenth_note_steps: 4 },
  earlier_3: { direction: "earlier", sixteenth_note_steps: 3 },
  earlier_2: { direction: "earlier", sixteenth_note_steps: 2 },
  earlier_1: { direction: "earlier", sixteenth_note_steps: 1 },
  no_change: { direction: "unchanged", sixteenth_note_steps: 0 },
  later_1: { direction: "later", sixteenth_note_steps: 1 },
  later_2: { direction: "later", sixteenth_note_steps: 2 },
  later_3: { direction: "later", sixteenth_note_steps: 3 },
  later_4: { direction: "later", sixteenth_note_steps: 4 },
};
const velocityChangeCriteria = {
  decrease_2: { velocity_layer_delta: -2 },
  decrease_1: { velocity_layer_delta: -1 },
  no_change: { velocity_layer_delta: 0 },
  increase_1: { velocity_layer_delta: 1 },
  increase_2: { velocity_layer_delta: 2 },
};

function notesFromParts(state: PatternJevState): PartNote[] {
  return INSTRUMENTS.flatMap(instrument => state.pattern.parts[instrument].map(note => ({ ...note, instrument })));
}

function additionCriteria(state: PatternJevState, instrument: Instrument) {
  const occupied = new Set(notesFromParts(state).map(note => `${note.instrument}:${note.bar}:${note.position}`));
  const criteria: Record<string, unknown> = { no_addition: { meaning: "The current pattern already satisfies the request, or the next edit should remove or modify an existing note." } };
  for (let bar = 1; bar <= state.pattern.bars; bar++) {
    for (const position of POSITIONS) {
      if (occupied.has(`${instrument}:${bar}:${position}`)) continue;
      criteria[`add_${instrument}_in_bar_${bar}_at_${position}`] = {
        action: `Add one ${instrumentCriteria[instrument].sound} note`,
        bar,
        ...positionCriteria[position],
      };
    }
  }
  return criteria;
}

function additionQuestions(state: PatternJevState, instrument: Instrument) {
  return {
    [`addition_${instrument}_action`]: {
      type: "choice",
      instructions: {
        question: "Which single legal note addition best moves the current pattern closer to `request`, or is no addition needed?",
        inspect,
        context,
        focus: `Choose the most important missing ${instrumentCriteria[instrument].sound} position. Occupied positions are deliberately absent from the choices.`,
      },
      criteria: additionCriteria(state, instrument),
    },
    [`addition_${instrument}_velocity`]: {
      type: "choice",
      instructions: { premise: "Assume the chosen addition action will be applied.", question: "Which velocity layer should the new note use?", inspect, context },
      criteria: velocityCriteria,
    },
  };
}

function noteQuestions(note: PartNote) {
  const instructions = (extra: Record<string, string>) => ({ note: { ...note }, context, ...extra });
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
      instructions: instructions({ premise: "Assume this exact note will be modified rather than removed.", question: "How should its timing change to satisfy `request`?", grid: "Each step is one sixteenth note; movement can cross bar lines and wraps around the complete phrase." }),
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
      },
    },
  };
}

export function buildPatternQuestions(state: PatternJevState, relevantInstruments: readonly Instrument[] = INSTRUMENTS): Record<string, { type: "choice" | "noul"; instructions: unknown; criteria: Record<string, unknown> }> {
  const selected = INSTRUMENTS.filter(instrument => relevantInstruments.includes(instrument));
  const questions: Record<string, { type: "choice" | "noul"; instructions: unknown; criteria: Record<string, unknown> }> = {
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
