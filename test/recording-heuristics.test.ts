import test from "node:test";
import assert from "node:assert/strict";
import { scoreInterpretation } from "../src/core/recording/rhythm.js";
const groove = [0, 4, 6, 8, 12, 16, 20, 22, 24, 28].map((slot, i) => ({ onset_seconds: slot * 15 / 97, instrument: [1, 4, 6, 9].includes(i) ? "snare" : "kick" }));
test("musical priors favor the repeating two-bar interpretation", () => {
  const expected = scoreInterpretation(groove, 97, 0.009);
  const alternative = scoreInterpretation(groove, 145, 0.004);
  assert.equal(expected.repeated_bars, 1);
  assert.equal(expected.kick_on_one, 1);
  assert.equal(expected.loop_gap_fit, 1);
  assert.ok(expected.score > alternative.score);
});
test("musical priors cannot rescue a substantially worse timing fit", () => {
  assert.ok(scoreInterpretation(groove, 97, 0.08).score < scoreInterpretation(groove, 145, 0.005).score);
});
test("a one-bar fragment does not earn a repetition bonus", () => {
  assert.equal(scoreInterpretation(groove.slice(0, 3), 97, 0).repeated_bars, 0);
});
test("scoring neither adds nor removes unconventional hits", () => {
  const unusual = [{ onset_seconds: 0, instrument: "snare" }, { onset_seconds: 0.33, instrument: "kick" }];
  const before = JSON.stringify(unusual);
  assert.equal(scoreInterpretation(unusual, 120, 0).kick_on_one, 0);
  assert.equal(JSON.stringify(unusual), before);
});
