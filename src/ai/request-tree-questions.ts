import { REQUEST_CATEGORIES } from "../core/pattern/request-tree.js";

export const ROOT_QUESTIONS = Object.freeze({
  request_category: {
    type: "choice",
    instructions: {
      question: "Which supported category best describes what the user wants?",
      inspect: ["request"],
      focus: "Choose clear_pattern to remove the entire beat or start empty ('fully remove this beat', 'clear it'). Choose shuffle_preset for another/different beat, 'no, something else', 'try again', or 'shuffle funk'. Choose load_preset to request a complete genre, meter, or style beat. Choose fill_rhythm for regular quarter/eighth/sixteenth notes on one drum, including 16ths on hi-hats. Choose edit_pattern for individual note or instrument edits, including a hit nudged 'just a hair', 'a touch', or 'just slightly' early or late. Choose add_compression for 'make the drums punchier', 'add some compression', or 'make this hit harder'. Choose polish_mix for 'polish it up' or mastering. Choose change_swing to add, increase, decrease, or remove swing on the current groove, including 'no, swing it harder'. Choose change_tempo for slowing or speeding the whole beat or setting a target BPM, such as 'speed it up to 130 bpm'. Choose unsupported only when none of these applies.",
    },
    criteria: Object.fromEntries(Object.entries(REQUEST_CATEGORIES).map(([id, category]) => [id, { meaning: category.description }])),
  },
});
