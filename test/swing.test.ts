import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState, INSTRUMENTS } from "../src/core/pattern/state.js";
import type { PatternState } from "../src/core/pattern/state.js";
import { runPatternCommand } from "../src/core/pattern/request-tree.js";
import { recordUndoUnit, undoLastChange } from "../src/core/pattern/undo.js";
import { eventsForWindow, patternDurationSeconds, splitPatternWindow } from "../src/core/pattern/audio-schedule.js";

const swing = (state: PatternState) => (state.pattern as PatternState["pattern"] & { swing_percent?: number }).swing_percent;
const seed = () => createPatternState({ notes: INSTRUMENTS.map((instrument, i) => ({ id: `note_${i + 1}`, instrument, bar: 1, tick: 480, velocity: 80 })) });
async function requestSwing(state: PatternState, action: string) {
  const result = await runPatternCommand({ initialState: state, request: action, decideNode: async node => ({ answers: { selection: { type: "choice", choice: node === "root" ? "change_swing" : action } } }), editPattern: () => { throw new Error("Swing must not edit notes"); } });
  return recordUndoUnit(state, result, action);
}

test("swing requests start light, increase to 85, decrease and remove without editing notes", async () => {
  let state = seed();
  const notes = structuredClone(state.pattern.notes);
  for (const [action, expected] of [["light", 55], ["increase", 65], ["increase", 75], ["increase", 85], ["increase", 85], ["decrease", 75], ["remove", 50], ["increase", 55], ["decrease", 50]] as const) {
    state = (await requestSwing(state, action)).state;
    assert.equal(swing(state), expected);
    assert.deepEqual(state.pattern.notes, notes);
  }
});

test("swing survives saving and undo; a capped request does not bury the previous change", async () => {
  const original = seed();
  const light = (await requestSwing(original, "light")).state;
  const maximum = (await requestSwing(light, "maximum")).state;
  const capped = await requestSwing(maximum, "increase");
  assert.equal(capped.result.applied_changes.length, 0);
  const restored = createPatternState(JSON.parse(JSON.stringify(capped.state)));
  assert.equal(swing(restored), 85);
  const undone = undoLastChange(restored).state;
  assert.equal(swing(undone), 55);
  assert.deepEqual(undoLastChange(undone).state.pattern, original.pattern);
});

test("old sessions default to straight timing and invalid swing settings cannot corrupt playback", () => {
  assert.equal(swing(seed()), 50);
  for (const value of [null, "65", -1, 90, NaN]) assert.equal(swing(createPatternState({ swing_percent: value })), 50);
  assert.equal(swing(createPatternState({ swing_percent: 65 })), 65);
});

test("eighth swing shifts every lane, keeps beats and loop length fixed, and leaves original notes intact", () => {
  const straight = seed();
  const swung = createPatternState({ ...straight, pattern: { ...straight.pattern, swing_percent: 85, notes: [...straight.pattern.notes, { id: "onbeat", instrument: "kick", bar: 1, tick: 960, velocity: 40 }] } });
  const hits = eventsForWindow(swung.pattern, 120, 0, 2);
  assert.equal(hits.length, 10);
  for (const hit of hits.filter(hit => hit.id !== "onbeat")) assert.ok(Math.abs(hit.time - 0.425) < 1e-10);
  assert.equal(hits.find(hit => hit.id === "onbeat")!.time, 0.5);
  assert.equal(patternDurationSeconds(swung.pattern, 120), 2);
  assert.equal(swung.pattern.notes[0].tick, 480);
  assert.equal(swung.pattern.notes[0].velocity, 80);
});

test("swing warps intervening notes continuously, preserving order and human timing without quantization", () => {
  const state = createPatternState({ swing_percent: 75, notes: [0, 240, 480, 487, 720, 959].map((tick, i) => ({ id: `note_${i + 1}`, instrument: "closed_hat", bar: 1, tick, velocity: 90 })) });
  const ticks = eventsForWindow(state.pattern, 60, 0, 1).map(hit => Math.round(hit.time * 960 * 10) / 10);
  assert.deepEqual(ticks, [0, 360, 720, 723.5, 840, 959.5]);
});

test("scheduler windows emit delayed hits exactly once across a swing change at the loop boundary", () => {
  const activePattern = createPatternState({ ...seed().pattern, swing_percent: 55 }).pattern;
  const pendingPattern = createPatternState({ ...seed().pattern, swing_percent: 85 }).pattern;
  const args = { activePattern, activeBpm: 120, pendingPattern, pendingBpm: 120, originTime: 0, boundaryTime: 2 };
  const all = splitPatternWindow({ ...args, fromTime: 0, toTime: 4 });
  assert.deepEqual([...new Set(all.events.map(hit => Number(hit.time.toFixed(3))))], [0.275, 2.425]);
  const windows = [[0, 0.27], [0.27, 0.3], [0.3, 1.99], [1.99, 2.1], [2.1, 2.42], [2.42, 4]];
  const partitioned = windows.flatMap(([fromTime, toTime]) => splitPatternWindow({ ...args, fromTime, toTime }).events);
  assert.deepEqual(partitioned, all.events);
});

test("swing preserves phrase duration and final hits in both 3/4 and 6/8", () => {
  for (const meter of [{ numerator: 3, denominator: 4 }, { numerator: 6, denominator: 8 }]) {
    const state = createPatternState({ meter, swing_percent: 85, notes: [{ id: "note_1", instrument: "kick", bar: 1, tick: 2879, velocity: 80 }] });
    assert.equal(patternDurationSeconds(state.pattern, 60), 3);
    const hits = eventsForWindow(state.pattern, 60, 0, 6);
    assert.equal(hits.length, 2);
    assert.ok(hits[0].time < 3);
    assert.ok(hits[1].time < 6);
  }
});

test("invalid swing decisions reject atomically", async () => {
  const state = seed();
  await assert.rejects(requestSwing(state, "invented"), /invalid/i);
  assert.equal(swing(state), 50);
  assert.deepEqual((await requestSwing(state, "unsupported")).state.pattern, state.pattern);
});

test("spoken swing commands follow the swing branch despite detected speech transients", async () => {
  const state = seed();
  const request = "Can you swing it?";
  const recording = { transcript: request, hit_count: 3 };
  const completed = await runPatternCommand({
    initialState: state, request, recording,
    decideNode: async (node, context) => {
      if (node === "root") assert.deepEqual(context.recording, recording);
      else assert.deepEqual(context, { request });
      return { answers: { selection: { type: "choice", choice: node === "root" ? "change_swing" : "light" } } };
    },
    recordedRhythm: async () => { throw new Error("Speech must not insert drum hits"); },
    editPattern: async () => { throw new Error("Swing must not edit notes"); },
  });
  assert.equal(swing(completed.state), 55);
  assert.deepEqual(completed.state.pattern.notes, state.pattern.notes);
  assert.deepEqual(completed.routing?.map(route => route.node_id), ["root", "change_swing"]);
});
