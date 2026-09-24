import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState } from "../src/core/pattern/state.js";
import { runPatternCommand } from "../src/core/pattern/request-tree.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";
import { REQUEST_QUESTIONS, validRequestState } from "../src/ai/request-questions.js";

const initial = () => createPatternState({ tempo_bpm: 120, notes: [{ id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 96 }] });
const choice = (value: string) => ({ answers: { selection: { type: "choice" as const, choice: value } } });

async function tempo(state: ReturnType<typeof initial>, request: string, action: string) {
  return runPatternCommand({ initialState: state, request, decideNode: async (node, sentState) => {
    if (node === "change_tempo") assert.deepEqual(sentState, { request });
    return choice(node === "root" ? "change_tempo" : action);
  }, editPattern: async () => { throw new Error("Tempo must not edit notes"); } });
}

test("spoken slower, faster and explicit BPM requests change only tempo", async () => {
  const before = initial();
  const slower = await tempo(before, "slow this whole thing down", "decrease");
  assert.equal(slower.state.tempo_bpm, 110);
  assert.deepEqual(slower.state.pattern, before.pattern);
  assert.deepEqual(slower.routing?.map(item => item.node_id), ["root", "change_tempo"]);
  const faster = await tempo(slower.state, "let's make the beat faster", "increase");
  assert.equal(faster.state.tempo_bpm, 120);
  const exact = await tempo(faster.state, "speed it up to like 130 bpm", "set_exact");
  assert.equal(exact.state.tempo_bpm, 130);
  assert.deepEqual(exact.result.applied_changes, [{ kind: "tempo", before_bpm: 120, after_bpm: 130 }]);
});

test("tempo limits, malformed targets and repeats do not add undo steps", async () => {
  const high = createPatternState({ ...initial(), tempo_bpm: 235 });
  const capped = await tempo(high, "faster", "increase");
  assert.equal(capped.state.tempo_bpm, 240);
  assert.equal((await tempo(capped.state, "faster", "increase")).result.applied_changes.length, 0);
  const low = createPatternState({ ...initial(), tempo_bpm: 45 });
  assert.equal((await tempo(low, "slower", "decrease")).state.tempo_bpm, 40);
  assert.equal((await tempo(createPatternState({ ...initial(), tempo_bpm: 30 }), "slower", "decrease")).state.tempo_bpm, 30);
  assert.equal((await tempo(createPatternState({ ...initial(), tempo_bpm: 250 }), "faster", "increase")).state.tempo_bpm, 250);
  for (const request of ["make it 300 bpm", "set tempo", "set 100 or 120 bpm"]) {
    const unchanged = await tempo(initial(), request, "set_exact");
    assert.equal(unchanged.state.tempo_bpm, 120);
    assert.equal(unchanged.result.applied_changes.length, 0);
  }
  const unchanged = await tempo(initial(), "keep tempo", "unsupported");
  assert.equal(unchanged.result.applied_changes.length, 0);
});

test("tempo requests survive reload and one undo restores the prior tempo", async () => {
  const before = initial();
  const completed = await tempo(before, "130 bpm", "set_exact");
  const saved = recordUndoUnit(before, completed, "130 bpm").state;
  const reloaded = createPatternState(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.tempo_bpm, 130);
  assert.equal(undoLastChange(reloaded).state.tempo_bpm, 120);
});

test("tempo branch has a small typed decision and request-only state", () => {
  assert.deepEqual(Object.keys(REQUEST_QUESTIONS.change_tempo.buildQuestions().selection.criteria), ["increase", "decrease", "set_exact", "unsupported"]);
  assert.equal(validRequestState({ request: "slower" }, "change_tempo"), true);
  assert.equal(validRequestState({ request: "slower", tempo_bpm: 120 }, "change_tempo"), false);
});
