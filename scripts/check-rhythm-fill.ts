// Live regression check: build, start QA, then run with QA_URL=http://127.0.0.1:3210.
import assert from "node:assert/strict";
import { createPatternState, stateForJev } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { applyRhythmFill } from "../src/core/pattern/rhythm-fill.js";
import type { RhythmIntent } from "../src/core/pattern/rhythm-fill.js";

const url = process.env.QA_URL;
if (!url) throw new Error("Set QA_URL to a running QA server. This check makes live TypeSafe calls.");
const before = loadPreset(createPatternState(), presetById("simple_kick_snare"), "give me a simple kick and snare");
const cases = [
  { request: "give me hats on the 16ths", instrument: "closed_hat", note_value: "sixteenths", beats: [1, 2, 3, 4], count: 16 },
  { request: "give me hats on the sixteenths", instrument: "closed_hat", note_value: "sixteenths", beats: [1, 2, 3, 4], count: 16 },
  { request: "give me hats on the 8ths", instrument: "closed_hat", note_value: "eighths", beats: [1, 2, 3, 4], count: 8 },
  { request: "give me open hats on the 16ths", instrument: "open_hat", note_value: "sixteenths", beats: [1, 2, 3, 4], count: 16 },
  { request: "give me hats on the 16ths on beat 2", instrument: "closed_hat", note_value: "sixteenths", beats: [2], count: 4 },
];

async function post(path: string, payload: unknown) {
  const response = await fetch(`${url}/api/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
}

for (const expected of cases) {
  const { request } = expected;
  const routed = await post("request-decision", { node_id: "root", state: { request, kit_id: before.pattern.kit_id, recent_history: before.recent_history } });
  assert.equal(routed.outcome.next_node, "fill_rhythm", request);
  const response = await post("rhythm-fill", { state: stateForJev(before, request) });
  const intent = response.intent as RhythmIntent | null;
  assert.ok(intent, `${request}: ${JSON.stringify(response.answers)}`);
  assert.equal(intent.instrument, expected.instrument, request);
  assert.equal(intent.note_value, expected.note_value, request);
  assert.deepEqual(intent.beats, expected.beats, request);
  assert.deepEqual(intent.bars, [1], request);
  const after = applyRhythmFill(before, intent, request).state;
  assert.equal(after.pattern.notes.filter(note => note.instrument === expected.instrument).length, expected.count, request);
  for (const note of before.pattern.notes) assert.deepEqual(after.pattern.notes.find(added => added.id === note.id), note);
  console.log(`PASS: ${request} → ${expected.count} ${expected.instrument} hits`);
}

const previous = applyRhythmFill(before, { instrument: "closed_hat", note_value: "eighths", beats: [1, 2, 3, 4], bars: [1], velocity: 64 }, "All right nice now add hats on the eighths").state;
previous.recent_history.unshift(
  { request: "All right, can you give me a funk beat?", applied_changes: ["Loaded Funk Pocket preset"], rejected_changes: [] },
  { request: "Alright, that's cool, but it's actually a little too busy. Just clear that.", applied_changes: ["Cleared the whole pattern"], rejected_changes: [] },
);
for (const request of ["Nice, nice. Actually, let's do the 16th. Add them on the 16th.", "actually add 'em on the 16ths", "add those on sixteenths"]) {
  const response = await post("rhythm-fill", { state: stateForJev(previous, request) });
  assert.deepEqual(response.intent, { instrument: "closed_hat", note_value: "sixteenths", beats: [1, 2, 3, 4], bars: [1], velocity: 64 }, `${request}: ${JSON.stringify(response.answers)}`);
  const result = applyRhythmFill(previous, response.intent, request);
  assert.equal(result.result.applied_changes.length, 8);
  assert.equal(result.state.pattern.notes.filter(note => note.instrument === "closed_hat").length, 16);
  for (const note of previous.pattern.notes) assert.deepEqual(result.state.pattern.notes.find(added => added.id === note.id), note);
  console.log(`PASS: ${request} → retained hats, added 8 missing sixteenths`);
}

const latest = applyRhythmFill(previous, { instrument: "snare", note_value: "eighths", beats: [1, 2, 3, 4], bars: [1], velocity: 64 }, "add snares on eighths").state;
latest.recent_history.push({ request: "that didn't work", applied_changes: [], rejected_changes: [] });
for (const [request, instrument] of [["actually add those on the 16ths", "snare"], ["actually add hats on the 16ths", "closed_hat"]]) {
  const response = await post("rhythm-fill", { state: stateForJev(latest, request) });
  assert.equal(response.intent?.instrument, instrument, `${request}: ${JSON.stringify(response.answers)}`);
  assert.equal(response.intent?.note_value, "sixteenths", request);
  console.log(`PASS: ${request} → ${instrument} after recent snares and a failed request`);
}
