import { REQUEST_CATEGORIES } from "../core/pattern/request-tree.js";

export const ROOT_QUESTIONS = Object.freeze({
  request_category: {
    type: "choice",
    instructions: {
      question: "Which supported category best describes what the user wants?",
      inspect: ["request"],
      focus: "Choose edit_pattern for changes to the current beat. Choose load_preset for a request to replace it with a complete genre, meter, or style beat. Choose unsupported only when neither capability applies.",
    },
    criteria: Object.fromEntries(Object.entries(REQUEST_CATEGORIES).map(([id, category]) => [id, { meaning: category.description }])),
  },
});
