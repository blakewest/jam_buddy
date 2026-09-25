import test from "node:test";
import { rhythmFillContext } from "../src/ai/rhythm-fill-questions.js";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { runPatternTree } from "../src/core/pattern/request-runner.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";

const initial = () => loadPreset(createPatternState(), presetById("simple_backbeat"), "backbeat");
const intent = { instrument: "closed_hat", note_value: "sixteenths", bars: [1], beats: [1, 2, 3, 4], velocity: 64 };
async function fill(state: ReturnType<typeof initial>, targets: unknown = intent) {
  const forbidden = async () => { throw new Error("Rhythm fill must not use the note editor or presets"); };
  const options = { state, request: "Can I get 16ths on the hi-hats?", route: async () => ({ route: { category: "fill_rhythm", next_node: "rhythm_fill", message: null } }), interpretRhythm: async () => ({ intent: targets }), runEdit: forbidden, searchPresets: forbidden, selectPreset: forbidden };
  return runPatternTree(options as unknown as Parameters<typeof runPatternTree>[0]);
}

test("sixteenth hats fill all four beats in one operation and repeat requests add nothing", async () => {
  const before = initial();
  const result = await fill(before);
  assert.equal(result.result.applied_changes.length, 8);
  assert.deepEqual(result.state.pattern.notes.filter(n => n.instrument === "closed_hat").map(n => n.tick).sort((a,b) => a-b), [0,240,480,720,960,1200,1440,1680,1920,2160,2400,2640,2880,3120,3360,3600]);
  for (const note of before.pattern.notes) assert.deepEqual(result.state.pattern.notes.find(n => n.id === note.id), note);
  assert.equal((await fill(result.state)).result.applied_changes.length, 0);
  const accepted = recordUndoUnit(before, result, "16th hats");
  assert.deepEqual(undoLastChange(accepted.state).state.pattern, before.pattern);
});

test("beat-two fills only its missing hats; subsequent rest-of-bar fill covers remaining beats", async () => {
  const before = initial();
  const result = await fill(before, { ...intent, beats: [2] });
  assert.deepEqual(result.result.applied_changes.map(c => c.after?.tick), [1200,1680]);
  const rest = await fill(result.state);
  assert.equal(rest.result.applied_changes.length, 6);
  assert.deepEqual(rest.state.pattern.notes.filter(n => n.instrument === "kick"), before.pattern.notes.filter(n => n.instrument === "kick"));
});

test("fill respects selected bars and preserves human timing, velocity, kit and swing", async () => {
  const before = createPatternState({ tempo_bpm: 110, bars: 2, kit_id: "tr_505", swing_percent: 65, notes: [{ id: "note_1", instrument: "closed_hat", bar: 2, tick: 10, velocity: 20 }] });
  const result = await fill(before, { ...intent, bars: [2], beats: [1] });
  assert.equal(result.result.applied_changes.length, 3);
  assert.deepEqual(result.state.pattern.notes[0], before.pattern.notes[0]);
  assert.ok(result.state.pattern.notes.every(n => n.bar === 2));
  assert.equal(result.state.pattern.kit_id, "tr_505");
  assert.equal(result.state.pattern.swing_percent, 65);
  assert.equal(result.state.tempo_bpm, 110);
});

test("invalid fill targets reject atomically and uncertain interpretations make no changes", async () => {
  const before = initial();
  for (const invalid of [{...intent,beats:[5]}, {...intent,bars:[0]}, {...intent,instrument:"unknown"}, {...intent,note_value:"other"}, {...intent,velocity:NaN}]) await assert.rejects(fill(before, invalid), /invalid/i);
  const result = await fill(before, null);
  assert.deepEqual(result.state.pattern, before.pattern);
  assert.equal(result.result.applied_changes.length, 0);
  assert.ok(result.result.message);
});

test("an already-filled request remains the reference for the next fill, without an undo entry", async () => {
  const { rhythmFillContext } = await import("../src/ai/rhythm-fill-questions.js");
  const { stateForJev, appendHistory } = await import("../src/core/pattern/state.js");
  const full = (await fill(initial())).state;
  const before = appendHistory(full, { request: "add a kick", applied_changes: ["Added kick"], rejected_changes: [] });
  const completed = await fill(before);
  const accepted = recordUndoUnit(before, completed, "Can I get 16ths on the hi-hats?");
  assert.deepEqual(accepted.state.undo_history, before.undo_history);
  const context = rhythmFillContext(stateForJev(accepted.state, "Do it on beats 2, 3 and 4 as well"));
  assert.equal(context.recent_history.at(-1)?.request, "Can I get 16ths on the hi-hats?");
});

test("chained implicit no-op fills retain drum and spacing after save/reload without adding undo steps", async () => {
  const { applyRhythmFill } = await import("../src/core/pattern/rhythm-fill.js");
  const { rhythmFillContext } = await import("../src/ai/rhythm-fill-questions.js");
  const { stateForJev } = await import("../src/core/pattern/state.js");
  for (const instrument of ["closed_hat", "snare"] as const) {
    const before = createPatternState();
    const target = { instrument, note_value: "sixteenths" as const, bars: [1], beats: [1], velocity: 64 };
    const first = recordUndoUnit(before, applyRhythmFill(before, target, `16ths on ${instrument} on beat 1`), "Fill beat 1");
    let state = first.state;
    // Evict the original explicit request so only resolved no-op history remains.
    for (let repeat = 0; repeat < 9; repeat++) {
      const completed = applyRhythmFill(state, target, "Do it on beat 1 again");
      assert.equal(completed.result.applied_changes.length, 0);
      state = recordUndoUnit(state, completed, "Do it on beat 1 again").state;
    }
    state = createPatternState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(state.undo_history, first.state.undo_history);
    assert.deepEqual(state.pattern, first.state.pattern);
    const context = rhythmFillContext(stateForJev(state, "Do it on beats 2, 3 and 4 as well"));
    const descriptions = context.recent_history.at(-1)?.applied_changes.join(" ") ?? "";
    assert.ok(descriptions.includes(instrument));
    assert.match(descriptions, /sixteenths/);
    assert.match(descriptions, /added 0 notes/);
    assert.deepEqual(undoLastChange(state).state.pattern, before.pattern);
  }
});

test("failed voice attempts do not hide the preceding hi-hat fill from follow-ups", async () => {
  const { stateForJev } = await import("../src/core/pattern/state.js");
  const history = [
    { request: "Add hi-hats on eighths", applied_changes: ["Filled closed_hat with eighths in bars 1, beats 1, 2, 3, 4; added 8 notes."], rejected_changes: [] },
    { request: "Actually make it 16 pounds", applied_changes: [], rejected_changes: [] },
  ];
  const context = rhythmFillContext(stateForJev(createPatternState({ recent_history: history }), "Actually add them on the 16th notes"));
  assert.deepEqual(context.recent_history, history);
});

test("quarter-note triplets add one three-hit group in the chosen bar and undo together", async () => {
  const before = createPatternState({ bars: 4, notes: [{ id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 96 }] });
  const target = { ...intent, instrument: "snare", note_value: "quarter_triplets", bars: [4], beats: [3] };
  const result = await fill(before, target);
  assert.deepEqual(result.result.applied_changes.map(c => [c.after?.bar, c.after?.tick]), [[4,1920],[4,2560],[4,3200]]);
  assert.deepEqual(result.state.pattern.notes[0], before.pattern.notes[0]);
  assert.equal((await fill(result.state, target)).result.applied_changes.length, 0);
  assert.deepEqual(undoLastChange(recordUndoUnit(before, result, "triplet snares").state).state.pattern, before.pattern);
});

test("eighth-note triplets fit three kicks on beat four without spilling into another bar", async () => {
  const result = await fill(createPatternState({ bars: 4 }), { ...intent, instrument: "kick", note_value: "eighth_triplets", bars: [4], beats: [4] });
  assert.deepEqual(result.result.applied_changes.map(c => c.after?.tick), [2880,3200,3520]);
  assert.ok(result.state.pattern.notes.every(n => n.bar === 4));
});

test("quarter triplets anchor to the requested beat and reject groups that cannot fit", async () => {
  const before = createPatternState({ bars: 4 });
  const target = { ...intent, instrument: "snare", note_value: "quarter_triplets", bars: [4], beats: [2] };
  assert.deepEqual((await fill(before, target)).result.applied_changes.map(c => c.after?.tick), [960,1600,2240]);
  await assert.rejects(fill(before, { ...target, beats: [4] }), /triplet.*fit/i);
  assert.equal(before.pattern.notes.length, 0);
});

test("triplet interpretation uses contextual placement and supplies compact groove context", async () => {
  const { rhythmFillIntent, buildRhythmFillQuestions, tripletPlacementContext } = await import("../src/ai/rhythm-fill-questions.js");
  const { stateForJev } = await import("../src/core/pattern/state.js");
  const state = stateForJev(createPatternState({ bars: 4, notes: [{ id: "note_1", instrument: "snare", bar: 4, tick: 960, velocity: 64 }] }), "add triplet snares in the 4th bar");
  const choices = { operation: "fill", instrument: "snare", note_value: "quarter_triplets", triplet_start: "beat_3", beat_scope: "all", bar_scope: "selected", velocity: "medium" };
  const answers = Object.fromEntries(Object.entries(buildRhythmFillQuestions(state)).map(([id, q]) => [id, q.type === "choice" ? { type: "choice", choice: choices[id as keyof typeof choices] } : { type: "noul", noul: id === "bar_4" ? 1 : 0 }]));
  answers.triplet_start = { type: "choice", choice: "beat_3" };
  assert.deepEqual(rhythmFillIntent(state, answers), { instrument: "snare", note_value: "quarter_triplets", bars: [4], beats: [3], velocity: 64 });
  const context = tripletPlacementContext(state) as unknown as { groove: { snare: number[][] } };
  assert.deepEqual(context.groove.snare, [[4,960]]);
});

test("triplet placement candidates contain only groups that fit the meter", async () => {
  const { buildTripletPlacementQuestions } = await import("../src/ai/rhythm-fill-questions.js");
  const { stateForJev } = await import("../src/core/pattern/state.js");
  const state = stateForJev(createPatternState({ meter: { numerator: 6, denominator: 8 } }), "add snare triplets");
  const answers = Object.fromEntries(Object.entries({ operation: "fill", instrument: "snare", note_value: "quarter_triplets", bar_scope: "all", velocity: "medium" }).map(([id, choice]) => [id, { type: "choice", choice }]));
  assert.deepEqual(Object.keys(buildTripletPlacementQuestions(state, answers)!.triplet_start.criteria!), ["beat_1", "beat_2", "beat_3", "unknown"]);
  answers.note_value.choice = "eighth_triplets";
  assert.deepEqual(Object.keys(buildTripletPlacementQuestions(state, answers)!.triplet_start.criteria!), ["beat_1", "beat_2", "beat_3", "beat_4", "beat_5", "unknown"]);
});
