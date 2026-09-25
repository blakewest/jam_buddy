import { PRESETS } from "../core/pattern/presets.js";

export const PRESET_GENRES = Object.freeze([...new Set(PRESETS.flatMap(item => item.genres))].sort());
export const PRESET_FEELS = Object.freeze([...new Set(PRESETS.flatMap(item => item.feel))].sort());

export const PRESET_SEARCH_QUESTIONS = Object.freeze({
  explicit_filters: {
    type: "noul",
    instructions: "Does `request` name a genre, musical style, feel, or time signature? 'Something else', 'another beat', 'shuffle again', and rejecting the current beat alone do not specify musical filters.",
  },
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
    instructions: { question: `Does the user specifically request the ${genre} genre in \`request\`?`, inspect: ["request"], focus: "Select named genres and clear synonyms, not related genres or associations. A request for funk does not also request dance, electronic, or soul. 'Shuffle' as an action means pick another preset, not a musical genre." },
    criteria: { true: { meaning: `${genre} applies` }, false: { meaning: `${genre} does not apply` } },
  }])),
  ...Object.fromEntries(PRESET_FEELS.map(feel => [`feel_${feel}`, {
    type: "noul",
    instructions: { question: `Does the user specifically request a ${feel} feel?`, inspect: ["request"], focus: "Select stated musical qualities, not traits merely associated with the genre. 'Shuffle funk', 'shuffle again', or 'shuffle the beat' means pick another preset; it does not request a shuffle rhythm. 'A shuffle groove' or 'with a shuffle feel' does request that rhythm." },
    criteria: { true: { meaning: `${feel} applies` }, false: { meaning: `${feel} does not apply` } },
  }])),
});

export function attributesFromAnswers(answers: import("./question-types.js").Answers) {
  return {
    meter: answers.meter.choice ?? "unspecified",
    genres: PRESET_GENRES.filter(genre => answers[`genre_${genre}`]!.noul! >= 0.5),
    feels: PRESET_FEELS.filter(feel => answers[`feel_${feel}`]!.noul! >= 0.5),
  };
}

export function buildPresetSelectionQuestions(candidates: import("../core/pattern/presets.js").Preset[]) {
  return {
    preset: {
      type: "choice",
      instructions: { question: "Which candidate beat preset best fulfills the request?", inspect: ["request", "candidates"], focus: "A simple kick-and-snare starter or a backbeat without hats selects Simple Kick & Snare. A generic simple/basic backbeat selects Simple Backbeat, which includes eighth-note hats." },
      criteria: Object.fromEntries(candidates.map(item => [item.id, { name: item.name, genres: item.genres, meter: `${item.meter.numerator}/${item.meter.denominator}`, feel: item.feel, tags: item.tags, bars: item.bars, source_bpm: item.source.bpm ?? null, description: item.description }])),
    },
  };
}
