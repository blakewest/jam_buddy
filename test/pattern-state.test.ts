import test from "node:test";
import assert from "node:assert/strict";
import { appendHistory, applyPatternAnswers, createPatternState, INSTRUMENTS, MAX_BARS, resizePattern, stateForJev } from "../src/core/pattern/state.js";
import { swungTick } from "../src/core/pattern/swing.js";

const choice = (value: any, probabilities: Record<string, number> = { no_op: 0 }) => ({ type: "choice" as const, choice: value, probabilities, confidence: Math.max(...Object.values(probabilities)) });
const noul = (value: any) => ({ type: "noul" as const, noul: value });
const velocities = [1, 32, 64, 96, 127];
const note = (id: string, instrument: import("../src/core/pattern/state.js").Instrument, slot: number, velocityLayer = 3, bar = 1) => ({ id, instrument, bar, tick: (slot - 1) * 240, velocity: velocities[velocityLayer - 1] });

function noReset(extra = {}) {
  return { reset_pattern: noul(0), ...extra };
}

function modify(id: string, operationProbability: number, timing = "no_change", velocity = "no_change", instrument = "keep_current") {
  return {
    [`${id}_operation`]: choice("modify", { remove: 0, modify: operationProbability, no_op: 1 - operationProbability }),
    [`${id}_timing`]: choice(timing, { [timing]: 1 }),
    [`${id}_velocity`]: choice(velocity, { [velocity]: 1 }),
    [`${id}_instrument`]: choice(instrument, { [instrument]: 1 }),
  };
}

function remove(id: string, probability: number, speculative: { instrument?: string; velocity?: string; timing?: string } = {}) {
  return {
    [`${id}_operation`]: choice("remove", { remove: probability, modify: 0, no_op: 1 - probability }),
    [`${id}_timing`]: choice(speculative.timing ?? "later_sixteenth", { later_sixteenth: 1 }),
    [`${id}_velocity`]: choice(speculative.velocity ?? "increase_2", { increase_2: 1 }),
    [`${id}_instrument`]: choice(speculative.instrument ?? "snare", { snare: 1 }),
  };
}

function addition(_lane: any, confidence: number, instrument: import("../src/core/pattern/state.js").Instrument, slot: number, velocity: number, bar = 1) {
  const positions = ["beat_1", "beat_1_e", "beat_1_and", "beat_1_a", "beat_2", "beat_2_e", "beat_2_and", "beat_2_a", "beat_3", "beat_3_e", "beat_3_and", "beat_3_a", "beat_4", "beat_4_e", "beat_4_and", "beat_4_a"];
  const action = `add_${instrument}_in_bar_${bar}_at_${positions[slot - 1]}`;
  return {
    [`addition_${instrument}_action`]: choice(action, { no_addition: 1 - confidence, [action]: confidence }),
    [`addition_${instrument}_velocity`]: choice(`velocity_${velocity}`, { [`velocity_${velocity}`]: 1 }),
  };
}

test("the pattern supports cymbal and tom voices", () => {
  assert.deepEqual(INSTRUMENTS, ["kick", "snare", "closed_hat", "open_hat", "ride", "crash", "high_tom", "mid_tom", "floor_tom"]);
  const notes = ["ride", "crash", "high_tom", "mid_tom", "floor_tom"].map((instrument, index) => ({ id: `note_${index + 1}`, instrument, bar: 1, tick: index * 240, velocity: 96 }));
  assert.equal(createPatternState({ notes }).pattern.notes.length, 5);
});

test("a new pattern is an empty one-bar phrase", () => {
  const state = createPatternState();
  assert.deepEqual(state.pattern, { bars: 1, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes: [], kit_id: "acoustic", swing_percent: 50 });
  assert.deepEqual(state.recent_history, []);
});

test("patterns retain notes through an eight-bar phrase", () => {
  const state = createPatternState({ bars: 8, notes: [{ id: "note_1", instrument: "crash", bar: 8, tick: 0, velocity: 100 }] });
  assert.equal(MAX_BARS, 8);
  assert.equal(state.pattern.bars, 8);
  assert.equal(state.pattern.notes[0].bar, 8);
});

test("source articulations survive storage and same-lane edits", () => {
  const source = { id: "note_1", instrument: "snare", bar: 1, tick: 960, velocity: 80, midi_pitch: 37 };
  const state = createPatternState({ notes: [source] });
  assert.deepEqual(state.pattern.notes[0], source);
  const edited = applyPatternAnswers(state, noReset(modify("note_1", 0.9, "later_sixteenth")), "move rim hit");
  assert.equal(edited.state.pattern.notes[0].midi_pitch, 37);
  assert.equal(edited.state.pattern.notes[0].tick, 1200);
  assert.deepEqual(Object.keys(stateForJev(state, "edit").pattern.parts.snare[0]), ["id", "bar", "tick", "position", "velocity"]);
});

test("changing lanes resets a source articulation to the new lane's default", () => {
  const state = createPatternState({ notes: [{ id: "note_1", instrument: "snare", bar: 1, tick: 960, velocity: 80, midi_pitch: 37 }] });
  const edited = applyPatternAnswers(state, noReset(modify("note_1", 0.9, "no_change", "no_change", "kick")), "make it a kick");
  assert.equal(edited.state.pattern.notes[0].instrument, "kick");
  assert.equal(edited.state.pattern.notes[0].midi_pitch, 36);
});

test("different snare articulations can share a tick", () => {
  const notes = [37, 38].map((midi_pitch, index) => ({ id: `note_${index + 1}`, instrument: "snare", bar: 1, tick: 960, velocity: 80, midi_pitch }));
  const state = createPatternState({ notes });
  assert.equal(state.pattern.notes.length, 2);
  assert.equal(stateForJev(state, "edit").pattern.parts.snare.length, 2);
});

test("resizing preserves notes when expanding and removes truncated bars when shrinking", () => {
  const state = createPatternState({ bars: 2, notes: [note("note_1", "kick", 1), note("note_2", "snare", 5, 4, 2)] });
  assert.deepEqual(resizePattern(state, 4).pattern, { bars: 4, meter: { numerator: 4, denominator: 4 }, ticks_per_quarter: 960, notes: state.pattern.notes, kit_id: "acoustic", swing_percent: 50 });
  assert.deepEqual(resizePattern(state, 1).pattern.notes, [note("note_1", "kick", 1)]);
});

test("whole-pattern reset requires 0.90 and suppresses note edits", () => {
  const initial = createPatternState({ notes: [note("note_1", "kick", 1)] });
  const below = applyPatternAnswers(initial, noReset({ reset_pattern: noul(0.89) }), "maybe start over");
  assert.equal(below.state.pattern.notes.length, 1);

  const reset = applyPatternAnswers(initial, noReset({ reset_pattern: noul(0.9), ...remove("note_1", 1) }), "wipe everything");
  assert.deepEqual(reset.state.pattern.notes, []);
  assert.equal(reset.result.applied_changes.length, 1);
  assert.equal(reset.result.candidates.length, 0);
});

test("only the four highest-confidence alterations are applied", () => {
  const notes = [1, 2, 3, 4, 5].map(slot => note(`note_${slot}`, "kick", slot));
  const state = createPatternState({ notes });
  const answers = noReset();
  [0.51, 0.92, 0.73, 0.84, 0.65].forEach((probability, index) => Object.assign(answers, remove(`note_${index + 1}`, probability)));
  const applied = applyPatternAnswers(state, answers, "remove most of these");
  assert.deepEqual(applied.state.pattern.notes.map(item => item.id), ["note_1"]);
  assert.deepEqual(applied.result.applied_changes.map(item => item.note_id), ["note_2", "note_4", "note_3", "note_5"]);
  assert.equal(applied.result.ignored_changes.length, 1);
});

test("removal ignores speculative modification answers", () => {
  const state = createPatternState({ notes: [note("note_1", "kick", 1, 1)] });
  const applied = applyPatternAnswers(state, noReset(remove("note_1", 0.8, { timing: "later_eighth", velocity: "increase_2", instrument: "snare" })), "remove it");
  assert.deepEqual(applied.state.pattern.notes, []);
  assert.equal(applied.result.applied_changes[0].kind, "remove");
});

test("modification shifts tick timing and clamps MIDI velocity", () => {
  const state = createPatternState({ bars: 2, notes: [note("note_1", "kick", 15, 5, 2), note("note_2", "snare", 2, 1)] });
  const answers = noReset({
    ...modify("note_1", 0.9, "later_sixteenth", "increase_2", "open_hat"),
    ...modify("note_2", 0.8, "earlier_sixteenth", "decrease_2"),
  });
  const applied = applyPatternAnswers(state, answers, "move them around");
  assert.deepEqual(applied.state.pattern.notes, [
    note("note_1", "open_hat", 16, 5, 2),
    note("note_2", "snare", 1, 1),
  ]);
});

test("micro timing moves selected hits about 10 ms at the current tempo", () => {
  const state = createPatternState({ tempo_bpm: 120, notes: [
    note("snare_1", "snare", 5), note("snare_2", "snare", 13), note("kick_1", "kick", 1),
  ] });
  const answers = noReset({
    ...modify("snare_1", 0.9, "later_10ms"),
    ...modify("snare_2", 0.9, "later_10ms"),
  });
  const result = applyPatternAnswers(state, answers, "make those snares just a hair late");
  assert.deepEqual(result.state.pattern.notes.map(item => item.tick), [979, 2899, 0]);
  assert.deepEqual(result.state.pattern.notes.map(item => item.velocity), state.pattern.notes.map(item => item.velocity));
  assert.equal(result.result.applied_changes.length, 2);
  const repeated = applyPatternAnswers(result.state, answers, "a touch later again");
  assert.deepEqual(repeated.state.pattern.notes.map(item => item.tick), [998, 2918, 0]);
});

test("micro timing uses stored BPM and wraps across the phrase edge", () => {
  const state = createPatternState({ tempo_bpm: 60, notes: [{ id: "snare_1", instrument: "snare", bar: 1, tick: 0, velocity: 80 }] });
  const early = applyPatternAnswers(state, noReset(modify("snare_1", 0.9, "earlier_10ms")), "a touch early");
  assert.equal(early.state.pattern.notes[0].tick, 3830);
  assert.equal(early.state.pattern.notes[0].velocity, 80);
  assert.equal(applyPatternAnswers(state, noReset(modify("snare_1", 0.9, "later_sixteenth")), "a little later").state.pattern.notes[0].tick, 240);
});

test("ordinary earlier language cannot trigger a micro nudge from a Jev choice", () => {
  const state = createPatternState({ tempo_bpm: 120, notes: [note("snare_1", "snare", 5)] });
  const answer = noReset(modify("snare_1", 0.9, "earlier_10ms"));
  const result = applyPatternAnswers(state, answer, "move that snare a little earlier");
  assert.equal(result.state.pattern.notes[0].tick, 720);
});

test("micro timing stays near 10 ms in the audible swung timeline", () => {
  const state = createPatternState({ tempo_bpm: 120, swing_percent: 85, notes: [
    { id: "snare_1", instrument: "snare", bar: 1, tick: 960, velocity: 80 },
    { id: "snare_2", instrument: "snare", bar: 1, tick: 1440, velocity: 80 },
  ] });
  const result = applyPatternAnswers(state, noReset({
    ...modify("snare_1", 0.9, "later_10ms"), ...modify("snare_2", 0.9, "later_10ms"),
  }), "just a hair late");
  for (const [index, before] of state.pattern.notes.entries()) {
    const after = result.state.pattern.notes[index];
    const elapsedMs = (swungTick(after.tick, 85) - swungTick(before.tick, 85)) * 60_000 / (120 * 960);
    assert.ok(Math.abs(elapsedMs - 10) < 1, `${before.tick} shifted ${elapsedMs} ms`);
  }
});

test("a modification cannot collide with an occupied cell", () => {
  const state = createPatternState({ notes: [note("note_1", "kick", 1), note("note_2", "kick", 2)] });
  const answers = noReset({
    ...modify("note_2", 0.9, "earlier_sixteenth"),
  });
  const applied = applyPatternAnswers(state, answers, "move the second kick earlier");
  assert.deepEqual(applied.state.pattern.notes, state.pattern.notes);
  assert.equal(applied.result.rejected_changes.length, 1);
  assert.equal(applied.result.rejected_changes[0].reason, "collision");
});

test("a confident addition choice is applied without a separate Noul gate", () => {
  const answers = noReset(addition(1, 0.88, "kick", 5, 4));
  const applied = applyPatternAnswers(createPatternState({ notes: [note("note_1", "kick", 1, 4)] }), answers, "put kicks on every beat");
  assert.deepEqual(applied.state.pattern.notes, [note("note_1", "kick", 1, 4), note("note_2", "kick", 5, 4)]);
  assert.equal(applied.result.applied_changes[0].score, 0.88);
});

test("a combined addition action maps instrument and position together", () => {
  const answers = noReset({
    addition_closed_hat_action: choice("add_closed_hat_in_bar_2_at_beat_2_and", { no_addition: 0.02, add_closed_hat_in_bar_2_at_beat_2_and: 0.98 }),
    addition_closed_hat_velocity: choice("velocity_3", { velocity_3: 1 }),
  });
  const applied = applyPatternAnswers(createPatternState({ bars: 2 }), answers, "hat in bar two");
  assert.deepEqual(applied.state.pattern.notes, [note("note_1", "closed_hat", 7, 3, 2)]);
});

test("Jev state groups notes by instrument and includes musical references", () => {
  const state = stateForJev(createPatternState({ notes: [
    note("note_1", "kick", 1, 4),
    note("note_2", "closed_hat", 3, 2),
  ] }), "add the rest of the eighths");
  assert.equal(state.pattern.bars, 1);
  assert.deepEqual(state.pattern.parts.kick, [{ id: "note_1", bar: 1, tick: 0, position: "beat_1", velocity: 96 }]);
  assert.deepEqual(state.pattern.parts.closed_hat, [{ id: "note_2", bar: 1, tick: 480, position: "beat_1_and", velocity: 32 }]);
  assert.deepEqual(state.music_reference.all_eighths, ["beat_1", "beat_1_and", "beat_2", "beat_2_and", "beat_3", "beat_3_and", "beat_4", "beat_4_and"]);
  assert.deepEqual(state.music_reference.four_on_the_floor.kick, ["beat_1", "beat_2", "beat_3", "beat_4"]);
  assert.deepEqual(state.music_reference.backbeat.snare, ["beat_2", "beat_4"]);
});

test("a pass can apply one highest-confidence edit without recording history", () => {
  const answers = noReset({
    ...addition(1, 0.7, "kick", 1, 4),
    ...addition(2, 0.95, "snare", 5, 4),
  });
  const applied = applyPatternAnswers(createPatternState(), answers, "make a beat", { maxOperations: 1, recordHistory: false });
  assert.deepEqual(applied.state.pattern.notes, [note("note_1", "snare", 5, 4)]);
  assert.deepEqual(applied.state.recent_history, []);
  assert.equal(applied.result.ignored_changes.length, 1);
});

test("deleted note IDs are not reused", () => {
  const first = applyPatternAnswers(createPatternState(), noReset(addition(1, 1, "kick", 1, 3)), "add");
  const removed = applyPatternAnswers(first.state, noReset(remove("note_1", 1)), "remove");
  const second = applyPatternAnswers(removed.state, noReset(addition(1, 1, "snare", 5, 4)), "add another");
  assert.equal(second.state.pattern.notes[0].id, "note_2");
});

test("history retains only the newest eight entries", () => {
  let state = createPatternState();
  for (let index = 1; index <= 10; index++) state = appendHistory(state, { request: `request ${index}`, applied_changes: [], rejected_changes: [] });
  assert.equal(state.recent_history.length, 8);
  assert.equal(state.recent_history[0].request, "request 3");
  assert.equal(state.recent_history[7].request, "request 10");
});


test("saved recording state migrates tempo and retains bounded take references alongside playback settings", () => {
  const state = createPatternState({
    pattern: { tempo_bpm: 72.5, bars: 1, meter: { numerator: 3, denominator: 4 }, swing_percent: 60, kit_id: "tr_808", notes: [note("note_1", "kick", 1)] },
    recent_take: { id: "take", note_ids: ["note_1", "missing"] },
    undo_history: [{ request: "record", pattern: { tempo_bpm: 97, notes: [note("note_2", "snare", 5)] }, recent_take: { id: "older", note_ids: ["note_2", "missing"] } }],
  });
  assert.equal(state.tempo_bpm, 72.5);
  assert.equal("tempo_bpm" in state.pattern, false);
  assert.deepEqual(state.pattern.meter, { numerator: 3, denominator: 4 });
  assert.equal(state.pattern.swing_percent, 60);
  assert.equal(state.pattern.kit_id, "tr_808");
  assert.deepEqual(state.recent_take, { id: "take", note_ids: ["note_1"] });
  assert.deepEqual(stateForJev(state, "edit the take").recent_take, state.recent_take);
  assert.equal(state.undo_history[0].tempo_bpm, 97);
  assert.deepEqual(state.undo_history[0].recent_take, { id: "older", note_ids: ["note_2"] });
});
