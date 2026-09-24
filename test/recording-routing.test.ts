import test from "node:test";
import assert from "node:assert/strict";
import { prepareEvidence, recordingQuestions, validateRecordingDecision } from "../src/core/recording/decision.js";
import { runPatternCommand, changeKit } from "../src/core/pattern/request-tree.js";
import { createPatternState } from "../src/core/pattern/state.js";
import { validRequestState } from "../src/ai/request-questions.js";
import { assertRecordingCurrent, recordingStateKey } from "../src/core/recording/rhythm.js";

test("a voice command uses the current beat while stale rhythm application rejects", async () => {
  const before = createPatternState();
  const current = createPatternState({ swing_percent: 65, notes: [{ id: "note_1", instrument: "snare", bar: 1, tick: 960, velocity: 80 }] });
  const original = structuredClone(current);
  const request = "Swing it harder";
  const options = {
    initialState: current, request, recording: { transcript: request, hit_count: 3 },
    recordedRhythm: async () => {
      assertRecordingCurrent(current, before);
      throw new Error("A stale take must never reach rhythm application");
    },
  };
  const completed = await runPatternCommand({ ...options,
    decideNode: async node => ({ answers: { selection: { type: "choice", choice: node === "root" ? "change_swing" : "increase" } } }),
  });
  assert.equal(completed.state.pattern.swing_percent, 75);
  assert.deepEqual(completed.state.pattern.notes, current.pattern.notes);
  await assert.rejects(runPatternCommand({ ...options,
    decideNode: async () => ({ answers: { selection: { type: "choice", choice: "recorded_rhythm" } } }),
  }), /beat changed/i);
  assert.deepEqual(current, original);
});

test("manual rhythm adjustments accept their last applied state but protect later edits", () => {
  const before = createPatternState();
  const applied = createPatternState({ notes: [{ id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 64 }] });
  const key = recordingStateKey(applied);
  assert.doesNotThrow(() => assertRecordingCurrent(applied, before, key));
  applied.pattern.notes[0].velocity = 100;
  assert.throws(() => assertRecordingCurrent(applied, before, key), /beat changed/i);
});

test("root accepts bounded audio timing evidence instead of only a hit count", () => {
  const recording = { transcript: "Make a beat like...", hit_count: 4,
    hit_onsets_seconds: [1.2, 1.8, 2.4, 3],
    words: [{ word: "like", start: 0.8, end: 2.5 }] };
  const state = { request: recording.transcript, kit_id: "acoustic", recent_history: [], recording };
  assert.equal(validRequestState(state), true);
  for (const invalid of [[-1], [31], [NaN], Array(257).fill(1)]) {
    assert.equal(validRequestState({ ...state, recording: { ...recording, hit_onsets_seconds: invalid } }), false);
  }
  assert.equal(validRequestState({ ...state, recording: { ...recording, words: [{ word: "like", start: 2, end: 1 }] } }), false);
});

test("a stretched final cue still offers the entire demonstrated rhythm", () => {
  const hits = [0.865, 0.905, 1.3, 1.5, 1.805, 1.84, 2.05, 3.123, 3.715, 3.85, 4.026, 4.3, 4.895, 5.505, 6.075, 6.365, 6.65, 7.225]
    .map(onset_seconds => ({ onset_seconds, instrument: "kick" }));
  const evidence = prepareEvidence({ text: "Give me a beat like...", words: [
    { word: "beat", start: 1.98, end: 2.08 }, { word: "like", start: 2.18, end: 5.68 },
  ] }, hits, 120);
  assert.ok(evidence.spans.some(span => {
    const retained = hits.filter(hit => hit.onset_seconds >= span.start_seconds);
    return retained.length === 11 && retained[0].onset_seconds === 3.123;
  }), "must offer the first kick, without the spoken introduction");
});

test("word timestamps retain transcribed beatboxing and offer speech boundary candidates", () => {
  const evidence = prepareEvidence({ text: "add kick boom boom", words: [{ word: "add", start: 0, end: 0.2 }, { word: "kick", start: 0.2, end: 0.5 }, { word: "boom", start: 1, end: 1.2 }, { word: "boom", start: 1.5, end: 1.7 }] }, [{ onset_seconds: 1, instrument: "kick" }, { onset_seconds: 1.5, instrument: "kick" }], 120);
  assert.equal(evidence.hits.length, 2);
  assert.ok(evidence.spans.some(span => span.start_seconds <= 1));
  const questions = recordingQuestions(evidence);
  assert.deepEqual(Object.keys(questions).sort(), ["instrument", "mode", "span", "timing"]);
  assert.throws(() => validateRecordingDecision(evidence, { mode: { type: "choice", choice: "destroy" } }), /decision/);
});
test("pure beatboxing goes through the shared root and recorded branch", async () => {
  const state = createPatternState();
  const completed = await runPatternCommand({ initialState: state, request: "Recorded take", recording: { transcript: "", hit_count: 3 }, decideNode: async (id, sent) => {
    assert.equal(id, "root"); assert.equal(sent.recording?.hit_count, 3);
    return { answers: { selection: { type: "choice", choice: "recorded_rhythm" } } };
  }, recordedRhythm: async () => ({ ...changeKit(state, "acoustic", "Recorded take"), message: "recorded" }) });
  assert.equal(completed.message, "recorded");
});

test("mixed speech offers a boundary before the first boom even without a pause", () => {
  const transcript = { text: "Give me a beat like, boom, kuh, boom, kuh.", words: [
    { word: "Give", start: 0, end: 0.2 }, { word: "me", start: 0.2, end: 0.3 },
    { word: "a", start: 0.3, end: 0.4 }, { word: "beat", start: 0.4, end: 0.6 },
    { word: "like,", start: 0.6, end: 0.9 }, { word: "boom,", start: 0.95, end: 1.2 },
    { word: "kuh,", start: 1.45, end: 1.7 }, { word: "boom,", start: 1.95, end: 2.08 },
    { word: "kuh.", start: 2.45, end: 2.7 },
  ] };
  const hits = [0.05, 0.4, 0.65, 0.95, 1.45, 1.95, 2.45].map(onset_seconds => ({ onset_seconds, instrument: "kick" }));
  const evidence = prepareEvidence(transcript, hits, 120);
  const span = evidence.spans.find(item => item.start_seconds === 0.9);
  assert.ok(span, "must offer the complete four-hit demonstration, not just suffixes");
  const criteria = recordingQuestions(evidence).span.criteria as Record<string, any>;
  assert.equal(criteria[span.id].retained_hits, 4);
  assert.match(criteria[span.id].remaining_words, /boom.*kuh.*boom.*kuh/);
});

test("a first kick transcribed as um is retained after the demonstration cue", () => {
  const transcript = { text: "Alright, give me a beat like, um...", words: [
    { word: "Alright", start: 0.56, end: 1.04 }, { word: "give", start: 1.22, end: 1.26 },
    { word: "me", start: 1.26, end: 1.34 }, { word: "a", start: 1.34, end: 1.64 },
    { word: "beat", start: 1.64, end: 1.64 }, { word: "like", start: 1.64, end: 2.72 },
    { word: "um", start: 2.9, end: 3.48 },
  ] };
  const hits = [2.891, 3.483, 3.771, 4.049, 4.641, 5.24, 5.838, 6.11, 6.389, 6.94].map((onset_seconds, i) => ({ onset_seconds, instrument: [1, 4, 6, 9].includes(i) ? "snare" : "kick" }));
  const evidence = prepareEvidence(transcript, hits, 120);
  const start = evidence.spans.find(span => span.start_seconds === 2.72);
  assert.ok(start, "offer the end of the instruction even without a 200 ms word gap");
  assert.equal(hits.filter(hit => hit.onset_seconds >= start.start_seconds).length, 10);
  assert.ok(Math.abs(start.tempos[0].tempo_bpm - 103) <= 1);
});
