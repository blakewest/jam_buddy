import { PRESETS } from "../core/pattern/presets.js";

export const PRESET_GENRES = Object.freeze([...new Set(PRESETS.flatMap(item => item.genres))].sort());
export const PRESET_FEELS = Object.freeze([...new Set(PRESETS.flatMap(item => item.feel))].sort());

export const PRESET_SEARCH_QUESTIONS = Object.freeze({
  meter: {
    type: "choice",
    instructions: { question: "Which time signature does the user request?", inspect: ["request"], focus: "Choose unspecified when no meter is stated." },
    criteria: {
      unspecified: { meaning: "No time signature requested" },
      "3/4": { meaning: "Three quarter-note beats per bar" },
      "4/4": { meaning: "Four quarter-note beats per bar" },
      "6/8": { meaning: "Six eighth-note beats per bar" },
    },
  },
  ...Object.fromEntries(PRESET_GENRES.map(genre => [`genre_${genre}`, {
    type: "noul",
    instructions: { question: `Does the request ask for or strongly imply the ${genre} genre?`, inspect: ["request"] },
    criteria: { true: { meaning: `${genre} applies` }, false: { meaning: `${genre} does not apply` } },
  }])),
  ...Object.fromEntries(PRESET_FEELS.map(feel => [`feel_${feel}`, {
    type: "noul",
    instructions: { question: `Does the request ask for or strongly imply a ${feel} feel?`, inspect: ["request"] },
    criteria: { true: { meaning: `${feel} applies` }, false: { meaning: `${feel} does not apply` } },
  }])),
});

export function attributesFromAnswers(answers) {
  return {
    meter: answers.meter.choice,
    genres: PRESET_GENRES.filter(genre => answers[`genre_${genre}`].noul >= 0.5),
    feels: PRESET_FEELS.filter(feel => answers[`feel_${feel}`].noul >= 0.5),
  };
}

export function buildPresetSelectionQuestions(candidates) {
  return {
    preset: {
      type: "choice",
      instructions: { question: "Which candidate beat preset best fulfills the request?", inspect: ["request", "candidates"] },
      criteria: Object.fromEntries(candidates.map(item => [item.id, { name: item.name, genres: item.genres, meter: `${item.meter.numerator}/${item.meter.denominator}`, feel: item.feel, description: item.description }])),
    },
  };
}
