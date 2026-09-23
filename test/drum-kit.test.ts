import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PRESETS } from "../src/core/pattern/presets.js";
import { pitchForNote, sampleFamily } from "../src/core/pattern/drum-pitches.js";

test("every active preset articulation maps to a named drum sound", () => {
  for (const preset of PRESETS) for (const note of preset.notes) {
    assert.ok(sampleFamily(pitchForNote(note)), `${preset.id}: MIDI ${pitchForNote(note)}`);
  }
  assert.notEqual(sampleFamily(37), sampleFamily(38));
  assert.notEqual(sampleFamily(40), sampleFamily(38));
  assert.notEqual(sampleFamily(44), sampleFamily(42));
  assert.notEqual(sampleFamily(22), sampleFamily(42));
  assert.notEqual(sampleFamily(26), sampleFamily(46));
});

test("the kit manifest points only to real WAV samples", async () => {
  const root = new URL("../src/frontend/assets/virtuosity/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.license, "CC0-1.0");
  for (const paths of Object.values(manifest.families as Record<string, string[]>)) {
    assert.ok(paths.length > 0);
    for (const path of paths) {
      assert.match(path, /^[a-z0-9_-]+\.wav$/);
      const bytes = await readFile(new URL(path, root));
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    }
  }
});
