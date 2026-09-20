import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, filterPresets, loadPreset, presetById, validatePreset } from "../src/core/pattern/presets.js";
import { createPatternState } from "../src/core/pattern/state.js";

test("the catalog covers the promised genres and meters", () => {
  assert.ok(PRESETS.length >= 12 && PRESETS.length <= 16);
  for (const genre of ["rock", "pop", "funk", "jazz", "blues", "disco", "hiphop", "electronic", "reggae", "latin"]) {
    assert.ok(PRESETS.some(preset => preset.genres.includes(genre)), genre);
  }
  for (const meter of ["3/4", "4/4", "6/8"]) assert.ok(PRESETS.some(preset => `${preset.meter.numerator}/${preset.meter.denominator}` === meter));
  assert.ok(PRESETS.every(validatePreset));
});

test("catalog validation rejects duplicate instrument cells", () => {
  const preset = structuredClone(PRESETS[0]);
  preset.notes.push({ ...preset.notes[0] });
  assert.equal(validatePreset(preset), false);
});

test("filtering uses requested genre and meter", () => {
  const matches = filterPresets({ genres: ["rock"], meter: "3/4", feels: [] });
  assert.ok(matches.length > 0);
  assert.ok(matches.every(preset => preset.genres.includes("rock") && preset.meter.numerator === 3));
});

test("loading a preset atomically replaces notes and records one history item", () => {
  const initial = createPatternState({ notes: [{ id: "note_9", instrument: "kick", bar: 1, tick: 0, velocity: 100 }] });
  const preset = presetById("rock_waltz");
  const loaded = loadPreset(initial, preset, "give me a rock beat in 3/4");
  assert.equal(loaded.pattern.meter.numerator, 3);
  assert.equal(loaded.pattern.notes.length, preset.notes.length);
  assert.equal(loaded.pattern.notes[0].id, "note_10");
  assert.equal(loaded.recent_history.at(-1).request, "give me a rock beat in 3/4");
  assert.match(loaded.recent_history.at(-1).applied_changes[0], /Loaded Rock Waltz/);
});
