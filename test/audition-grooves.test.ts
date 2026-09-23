import test from "node:test";
import assert from "node:assert/strict";
import * as catalog from "../src/core/pattern/audition-grooves.js";

const { AUDITION_GROOVES } = catalog;

test("audition catalog offers 50 bounded source-audio previews across styles", () => {
  assert.equal(AUDITION_GROOVES.length, 50);
  assert.ok(new Set(AUDITION_GROOVES.map(groove => groove.style.split("/")[0])).size >= 15);
  assert.equal(new Set(AUDITION_GROOVES.map(groove => groove.id)).size, 50);
  assert.ok(AUDITION_GROOVES.every(groove => groove.bars >= 1 && groove.bars <= 8));
  assert.ok(AUDITION_GROOVES.every(groove => ["3/4", "4/4", "6/8"].includes(groove.meter)));
});

test("the ten approved audition grooves remain in the curated shortlist", () => {
  const selected = [
    "gmd_drummer8_session1_16",
    "gmd_drummer1_session2_10",
    "gmd_drummer1_session3_6",
    "gmd_drummer1_session1_126",
    "gmd_drummer1_eval_session_2",
    "gmd_drummer8_session1_23",
    "gmd_drummer3_session2_31",
    "gmd_drummer7_session3_11",
    "gmd_drummer1_eval_session_9",
    "gmd_drummer7_session2_54",
  ];
  assert.deepEqual(catalog.CURATED_GROOVE_IDS, selected);
  assert.ok(selected.every(id => AUDITION_GROOVES.some(groove => groove.id === id)));
});
