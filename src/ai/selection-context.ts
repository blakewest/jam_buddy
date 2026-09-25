import { selectionRegions, selectionContains } from "../core/pattern/selection.js";
import type { PatternJevState } from "../core/pattern/state.js";
import type { BeatSelection } from "../core/pattern/selection.js";
import type { Questions } from "./question-types.js";

export function selectionContext(selection: BeatSelection, pattern?: PatternJevState["pattern"]) {
  return { instruments: selection.instruments, regions: selectionRegions(selection), ...(pattern ? { note_ids: selection.instruments.flatMap(instrument => pattern.parts[instrument].filter(note => selectionContains(selection, note.bar, note.tick / (960 * 4 / pattern.meter.denominator) + 1)).map(note => note.id)) } : {}) };
}
export function withSelectionQuestions(questions: Questions): Questions {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { ...q, instructions: {
    question: q.instructions,
    selected_area: id === "selection_scope" ? "Decide time scope only. An explicitly named drum or note value NEVER overrides the selected time range. For example, give me triplet snares right here uses selected, even if several lanes are highlighted. Only explicit beat/bar destinations or a whole-pattern request use explicit." : id === "subdivision" ? "Selection limits the time window but does not imply on-beat-only notes. Infer a subdivision restriction only from explicit words in request; otherwise select all." : "The user highlighted `selection` in the beat grid. 'This', 'these', 'those', 'here', 'right here', or 'this section' refer to that area, ahead of older history. Use its instruments and bar/beat regions for omitted targets in a local note edit. Explicit targets or a whole-pattern request override the highlight. Beat numbers in selection identify full beat windows, including every subdivision. When selection.note_ids is present, those are exactly the existing selected notes; use those IDs for removing or modifying 'this section', and count them when planning a removal. Do not use their nearest named musical position to decide selection membership. To remove every hit in the highlighted area choose clear_selection; other targeted note removals use edit_pattern, never clear_pattern (which deletes the whole beat). Selection is context, not an instruction to edit or clear by itself.",
  } }]));
}
export const selectionScopeQuestion = {
  type: "choice",
  instructions: "Should this note edit use the highlighted selection's time range? Choose selected for 'this', 'here', 'right here', 'these', 'those' and omitted beat/bar targets. Choose explicit when the current request explicitly targets a different time range or the whole pattern. An explicitly named instrument can still use the selected time range.",
  criteria: { selected: "Use the highlighted beat windows", explicit: "The request itself names a different beat/bar range or the whole pattern; drum names and spacing do not count" },
};
