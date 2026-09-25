import { selectionContains, validSelection } from "./selection.js";
import type { BeatSelection } from "./selection.js";
import { appendHistory, createPatternState, INSTRUMENTS } from "./state.js";
import type { Instrument, PatternState, PatternChange } from "./state.js";

export const RHYTHM_STEPS = { quarters: 960, eighths: 480, sixteenths: 240, quarter_triplets: 640, eighth_triplets: 320 };
export type RhythmIntent = { instrument: Instrument; note_value: keyof typeof RHYTHM_STEPS; bars: number[]; beats: number[]; velocity: number; selection?: BeatSelection };

export function applyRhythmFill(input: PatternState, intent: RhythmIntent, request: string) {
  const state = createPatternState(input);
  const validRange = (values: number[], maximum: number) => Array.isArray(values) && values.length > 0 && values.length <= maximum && new Set(values).size === values.length && values.every(n => Number.isInteger(n) && n >= 1 && n <= maximum);
  if (!INSTRUMENTS.includes(intent.instrument) || !Object.hasOwn(RHYTHM_STEPS, intent.note_value)
    || !validRange(intent.bars, state.pattern.bars) || !validRange(intent.beats, state.pattern.meter.numerator)
    || !Number.isInteger(intent.velocity) || intent.velocity < 1 || intent.velocity > 127) throw new Error("Invalid rhythm fill targets.");
  if (intent.selection && !validSelection(intent.selection, state.pattern)) throw new Error("Invalid beat selection.");
  const notes = [...state.pattern.notes];
  const changes: PatternChange[] = [];
  const beatTicks = 960 * 4 / state.pattern.meter.denominator;
  const step = RHYTHM_STEPS[intent.note_value];
  const triplet = intent.note_value === "quarter_triplets" || intent.note_value === "eighth_triplets";
  let nextId = state.next_note_id;
  // Engineering tolerance: keep humanized hits within 60 ticks of a target.
  const toleranceTicks = 60;
  const targets = intent.bars.flatMap(bar => intent.beats.flatMap(beat => {
    const start = (beat - 1) * beatTicks;
    if (triplet) {
      if (start + step * 3 > state.pattern.meter.numerator * beatTicks) throw new Error("That triplet group does not fit in the bar. Choose an earlier beat or eighth-note triplets.");
      return [0, 1, 2].map(part => ({ bar, tick: start + part * step }));
    }
    const ticks: { bar: number; tick: number }[] = [];
    for (let tick = Math.ceil(start / step) * step; tick < start + beatTicks; tick += step) ticks.push({ bar, tick });
    return ticks;
  }));
  if (triplet && intent.selection && targets.some(t => !selectionContains(intent.selection!, t.bar, t.tick / beatTicks + 1))) throw new Error("That triplet group does not fit in the selection.");
  const selectedTargets = intent.selection ? targets.filter(t => selectionContains(intent.selection!, t.bar, t.tick / beatTicks + 1)) : targets;
  const covered = (bar: number, tick: number) => notes.some(note => note.instrument === intent.instrument && note.bar === bar && Math.abs(note.tick - tick) <= toleranceTicks);
  for (const { bar, tick } of selectedTargets) {
    if (covered(bar, tick)) continue;
    const note = { id: `note_${nextId++}`, instrument: intent.instrument, bar, tick, velocity: intent.velocity };
    notes.push(note);
    changes.push({ kind: "add", note_id: note.id, after: note });
  }
  if (!selectedTargets.every(({ bar, tick }) => covered(bar, tick))) throw new Error("Rhythm fill is incomplete.");
  const description = `Filled ${intent.instrument} with ${intent.note_value} in bars ${intent.bars.join(", ")}, ${triplet ? "three-hit groups starting on beats" : "beats"} ${intent.beats.join(", ")}; added ${changes.length} notes.`;
  // Keep the resolved target for follow-ups, even when no notes were added.
  // Actual edits (and undo) still use the separate changes array.
  const history = { request, applied_changes: [description], rejected_changes: [] };
  return { state: appendHistory({ ...state, next_note_id: nextId, pattern: { ...state.pattern, notes } }, history), result: { applied_changes: changes, rejected_changes: [], history_entry: history, message: changes.length ? description : "Those rhythm positions are already filled." } };
}
