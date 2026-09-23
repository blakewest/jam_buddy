import type { PatternNote } from "../src/core/pattern/state.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createPatternState, resizePattern, applyPatternAnswers } from "../src/core/pattern/state.js";

const notes: PatternNote[] = [{ id: "note_1", instrument: "kick", bar: 1, tick: 0, velocity: 96 }];

test("kit selection survives saved-state migration, resize and note edits", () => {
  const state = createPatternState({ pattern: { bars: 1, notes, kit_id: "tr_808" } });
  assert.equal(state.pattern.kit_id, "tr_808");
  assert.equal(createPatternState(JSON.parse(JSON.stringify(state))).pattern.kit_id, "tr_808");
  assert.equal(resizePattern(state, 2).pattern.kit_id, "tr_808");
  const edited = applyPatternAnswers(state, { reset_pattern: { type: "noul", noul: 1 } });
  assert.equal(edited.state.pattern.kit_id, "tr_808");
  assert.deepEqual(edited.state.pattern.notes, []);
});

test("missing or retired saved kits migrate to Acoustic", () => {
  assert.equal(createPatternState().pattern.kit_id, "acoustic");
  assert.equal(createPatternState({ kit_id: "linn" }).pattern.kit_id, "acoustic");
});

test("kit catalog maps every instrument and velocity to bundled samples", async () => {
  const { KITS, sampleForHit } = await import("../src/core/pattern/kits.js");
  const { access } = await import("node:fs/promises");
  assert.deepEqual(KITS.map(kit => kit.id), ["acoustic", "tr_808", "tr_505"]);
  for (const kit of KITS) {
    for (const instrument of ["kick", "snare", "closed_hat", "open_hat"] as const) {
      let previous = 0;
      for (let layer = 1; layer <= 5; layer++) {
        const sample = sampleForHit(kit.id, instrument, layer);
        await access(new URL(`../src/frontend${sample.url}`, import.meta.url));
        assert.ok(sample.gain > 0);
        if (kit.id !== "acoustic") assert.ok(sample.gain > previous);
        previous = sample.gain;
      }
    }
  }
  assert.throws(() => sampleForHit("invalid", "kick", 1));
  assert.throws(() => sampleForHit("tr_808", "kick", 6));
});
