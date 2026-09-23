import { REQUEST_CATEGORIES } from "../core/pattern/request-tree.js";

export const ROOT_QUESTIONS = Object.freeze({
  request_category: {
    type: "choice",
    instructions: {
      question: "Which supported category best describes what the user wants?",
      inspect: ["request"],
      focus: "Choose clear_pattern to remove the entire beat or start empty ('fully remove this beat', 'clear it'). Choose shuffle_preset for another/different beat, 'no, something else', 'try again', or 'shuffle funk'. Choose load_preset to request a complete genre, meter, or style beat. Choose fill_rhythm for regular quarter/eighth/sixteenth notes on one drum, including 16ths on hi-hats. Choose edit_pattern for other individual note or instrument edits. Choose change_swing to add, increase, decrease, or remove swing on the current groove, including 'no, swing it harder'. Choose unsupported only when none of these applies.",
    },
    criteria: Object.fromEntries(Object.entries(REQUEST_CATEGORIES).map(([id, category]) => [id, { meaning: category.description }])),
  },
});
