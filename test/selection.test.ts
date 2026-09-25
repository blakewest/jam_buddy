import test from "node:test";
import assert from "node:assert/strict";
import { selectionFromCells, selectionRegions, selectionContains, validSelection } from "../src/core/pattern/selection.js";

test("reverse drags select the same lanes and beat windows across bar boundaries", () => {
  const selection = selectionFromCells({lane: 2, beat: 5}, {lane: 0, beat: 2}, 4);
  assert.deepEqual(selection.instruments, ["kick", "snare", "closed_hat"]);
  assert.deepEqual(selectionRegions(selection), [{bar: 1, beats: [3,4]}, {bar: 2, beats: [1,2]}]);
  assert.equal(selectionContains(selection, 1, 1), false);
  assert.equal(selectionContains(selection, 2, 2), true);
  assert.equal(selectionContains(selection, 2, 3), false);
  assert.equal(validSelection(selection, {bars: 2, meter: {numerator: 4, denominator: 4}}), true);
  assert.equal(validSelection(selection, {bars: 1, meter: {numerator: 4, denominator: 4}}), false);
});

test("selected velocity edits do not leak into unselected beats across a bar line", async () => {
  const { applyVelocityEdit } = await import("../src/core/pattern/velocity-edit.js");
  const { createPatternState } = await import("../src/core/pattern/state.js");
  const selection = selectionFromCells({lane: 1, beat: 3}, {lane: 1, beat: 4}, 4);
  const before = createPatternState({bars: 2, notes: [
    {id:"note_1", instrument:"snare", bar:1, tick:0, velocity:64},
    {id:"note_2", instrument:"snare", bar:1, tick:3000, velocity:64},
    {id:"note_3", instrument:"snare", bar:2, tick:320, velocity:64},
    {id:"note_4", instrument:"snare", bar:2, tick:2880, velocity:64},
  ]});
  const result = applyVelocityEdit(before, {instruments:["snare"],bars:[1,2],beats:[1,4],subdivision:"all",delta:-16,selection}, "make this softer");
  assert.deepEqual(result.state.pattern.notes.map(n=>n.velocity), [64,48,48,64]);
});

test("selected rhythm fills add only inside the selected time windows", async () => {
  const { applyRhythmFill } = await import("../src/core/pattern/rhythm-fill.js");
  const { createPatternState } = await import("../src/core/pattern/state.js");
  const selection = selectionFromCells({lane:1,beat:3},{lane:1,beat:4},4);
  const result=applyRhythmFill(createPatternState({bars:2}),{instrument:"snare",note_value:"eighths",bars:[1,2],beats:[1,4],velocity:64,selection},"add eighths here");
  assert.deepEqual(result.state.pattern.notes.map(n=>[n.bar,n.tick]),[[1,2880],[1,3360],[2,0],[2,480]]);
});

test("clearing a selection removes off-grid hits only in selected lanes and supports undo", async () => {
  const { runPatternCommand } = await import("../src/core/pattern/request-tree.js");
  const { createPatternState } = await import("../src/core/pattern/state.js");
  const { recordUndoUnit, undoLastChange } = await import("../src/core/pattern/undo.js");
  const selection = selectionFromCells({ lane: 1, beat: 3 }, { lane: 1, beat: 4 }, 4);
  const before = createPatternState({ bars: 2, notes: [
    { id: "note_1", instrument: "snare", bar: 1, tick: 0, velocity: 64 },
    { id: "note_2", instrument: "snare", bar: 1, tick: 3000, velocity: 64 },
    { id: "note_3", instrument: "snare", bar: 2, tick: 320, velocity: 64 },
    { id: "note_4", instrument: "kick", bar: 2, tick: 0, velocity: 96 },
  ] });
  const decideNode = async () => ({ answers: { selection: { type: "choice" as const, choice: "clear_selection" } } });
  const completed = await runPatternCommand({ initialState: before, request: "remove this section", selection, decideNode });
  assert.deepEqual(completed.state.pattern.notes.map(note => note.id), ["note_1", "note_4"]);
  assert.deepEqual(undoLastChange(recordUndoUnit(before, completed, "remove this section").state).state.pattern, before.pattern);
  await assert.rejects(runPatternCommand({ initialState: before, request: "remove this section", decideNode }), /Select an area/);
});

test("unqualified triplets fit the final selected beat while explicit quarters explain the conflict", async () => {
  const { buildTripletPlacementQuestions, rhythmFillIntent } = await import("../src/ai/rhythm-fill-questions.js");
  const { createPatternState, stateForJev } = await import("../src/core/pattern/state.js");
  const { applyRhythmFill } = await import("../src/core/pattern/rhythm-fill.js");
  const before = createPatternState({ bars: 4 });
  const state = stateForJev(before, "give me triplet snares right here");
  const selection = selectionFromCells({ lane: 1, beat: 15 }, { lane: 1, beat: 15 }, 4);
  const answers = Object.fromEntries(Object.entries({ operation: "fill", instrument: "snare", note_value: "triplets", selection_scope: "selected", velocity: "medium", triplet_start: "beat_4" }).map(([id, choice]) => [id, { type: "choice", choice }]));
  assert.deepEqual(Object.keys(buildTripletPlacementQuestions(state, answers, selection)!.triplet_start.criteria!), ["beat_4", "unknown"]);
  const intent = rhythmFillIntent(state, answers, selection)!;
  assert.equal(intent.note_value, "eighth_triplets");
  assert.deepEqual(applyRhythmFill(before, intent, state.request).state.pattern.notes.map(n => [n.instrument, n.bar, n.tick]), [["snare", 4, 2880], ["snare", 4, 3200], ["snare", 4, 3520]]);
  answers.note_value.choice = "quarter_triplets";
  assert.throws(() => buildTripletPlacementQuestions(state, answers, selection), /do not fit.*selection/i);
});
