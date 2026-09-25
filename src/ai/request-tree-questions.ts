import { REQUEST_CATEGORIES } from "../core/pattern/request-tree.js";

export const ROOT_QUESTIONS = Object.freeze({
  request_category: {
    type: "choice",
    instructions: {
      question: "Which supported category best describes what the user wants?",
      inspect: ["request"],
      focus: "Copy/duplicate this bar, beat, or selection selects duplicate: insert one exact copy of the highlighted area after itself, or double the groove if nothing is selected or the request explicitly says the whole thing/entire pattern. Copying to a specific destination, multiple copies, or only part of the highlighted area is unsupported. Choose clear_pattern to remove the entire beat or start empty ('fully remove this beat', 'clear it'). Choose shuffle_preset for another/different beat, 'no, something else', 'try again', or 'shuffle funk'. Choose load_preset to request a complete genre, meter, or style beat, a simple backbeat, or a simple kick-and-snare starter ('give me a simple kick and snare'). Choose fill_rhythm for regular quarter/eighth/sixteenth notes or quarter/eighth triplet groups on one drum, including 16ths on hi-hats and 'add triplet snares in the 4th bar'. Choose edit_pattern for individual note or instrument edits, including a hit nudged 'just a hair', 'a touch', or 'just slightly' early or late. Choose change_swing to add, increase, decrease, or remove swing on the current groove, including 'no, swing it harder'. Choose change_tempo for slowing or speeding the whole beat or setting a target BPM, such as 'speed it up to 130 bpm'. Choose unsupported for effects or when none of these applies.",
    },
    criteria: Object.fromEntries(Object.entries(REQUEST_CATEGORIES).map(([id, category]) => [id, { meaning: category.description }])),
  },
});
