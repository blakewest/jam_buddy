import { appendHistory, createPatternState, INSTRUMENTS } from "./state.js";

export function applyVelocityEdit(inputState, intent, request) {
  const state = createPatternState(inputState);
  const { instruments, bars, beats, subdivision, delta } = intent;
  if (![16, 32, -16, -32].includes(delta) || !Array.isArray(instruments) || !instruments.length || instruments.some(i => !INSTRUMENTS.includes(i))
    || !Array.isArray(bars) || !bars.length || bars.some(b => !Number.isInteger(b) || b < 1 || b > state.pattern.bars)
    || !Array.isArray(beats) || !beats.length || beats.some(b => !Number.isInteger(b) || b < 1 || b > state.pattern.meter.numerator)
    || !["onbeats", "offbeats", "all"].includes(subdivision)) throw new Error("Invalid velocity edit targets.");
  const beatTicks = 960 * 4 / state.pattern.meter.denominator;
  // Small tolerance preserves human timing around nominal positions.
  const tolerance = 60;
  const applied = [];
  const notes = state.pattern.notes.map(note => {
    if (!instruments.includes(note.instrument) || !bars.includes(note.bar)) return note;
    const targets = beats.flatMap(beat => subdivision === "onbeats" ? [(beat - 1) * beatTicks] : subdivision === "offbeats" ? [(beat - 0.5) * beatTicks] : []);
    const matches = subdivision === "all" ? beats.includes(Math.floor(note.tick / beatTicks) + 1) : targets.some(tick => Math.abs(note.tick - tick) <= tolerance);
    if (!matches) return note;
    const velocity = Math.max(1, Math.min(127, note.velocity + delta));
    if (velocity === note.velocity) return note;
    const after = { ...note, velocity };
    applied.push({ kind: "modify", note_id: note.id, before: note, after });
    return after;
  });
  const history = { request, applied_changes: [`Adjusted velocity on ${applied.length} notes by ${delta}.`, ...applied.slice(0, 7).map(c => `Changed ${c.before.instrument} in bar ${c.before.bar} at tick ${c.before.tick}, velocity ${c.before.velocity} to ${c.after.velocity}`)], rejected_changes: [] };
  return { state: appendHistory({ ...state, pattern: { ...state.pattern, notes } }, history), result: { applied_changes: applied, rejected_changes: [], history_entry: history, message: applied.length ? `Changed velocity on ${applied.length} notes.` : "No matching notes could change; they may already be at the velocity limit." } };
}
