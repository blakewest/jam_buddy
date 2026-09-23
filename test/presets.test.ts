import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, filterPresets, loadPreset, presetById, validatePreset } from "../src/core/pattern/presets.js";
import { createPatternState } from "../src/core/pattern/state.js";
import { AUDITION_GROOVES, CURATED_GROOVE_IDS } from "../src/core/pattern/audition-grooves.js";

test("simple backbeat has only kick on 1/3, snare on 2/4, and eighth-note hats", () => {
  const beat = presetById("simple_backbeat")!;
  assert.equal(beat.bars, 1);
  assert.equal(beat.tempo_bpm, 100);
  assert.equal(beat.notes.length, 12);
  assert.deepEqual(beat.notes.filter(n => n.instrument === "kick").map(n => n.tick), [0, 1920]);
  assert.deepEqual(beat.notes.filter(n => n.instrument === "snare").map(n => n.tick), [960, 2880]);
  assert.deepEqual(beat.notes.filter(n => n.instrument === "closed_hat").map(n => n.tick), [0, 480, 960, 1440, 1920, 2400, 2880, 3360]);
  assert.deepEqual(filterPresets({ feels: ["simple", "straight"] }).map(p => p.id), ["simple_backbeat"]);
});

test("the active catalog is exactly the ten curated grooves plus Simple Backbeat", () => {
  assert.equal(PRESETS.length, 11);
  const approved = CURATED_GROOVE_IDS.map(id => AUDITION_GROOVES.find(g => g.id === id)!.source_id).sort();
  assert.deepEqual(PRESETS.filter(p => p.id !== "simple_backbeat").map(p => p.source.id).sort(), approved);
  for (const id of ["rock_straight", "rock_waltz", "electronic_house", "disco_floor", "punk_fast", "jazz_brush"]) assert.equal(presetById(id), null);
  assert.ok(PRESETS.every(validatePreset));
});

test("every preset has a usable playback tempo, with recorded grooves at their source BPM", () => {
  assert.ok(PRESETS.every(item => Number.isInteger(item.tempo_bpm) && item.tempo_bpm >= 40 && item.tempo_bpm <= 240));
  assert.ok(PRESETS.filter(item => item.source.kind === "gmd").every(item => item.tempo_bpm === item.source.bpm));
  assert.equal(presetById("simple_backbeat")!.tempo_bpm, 100);
});

test("every kept audition groove is an active, tagged MIDI preset", () => {
  for (const id of CURATED_GROOVE_IDS) {
    const groove = AUDITION_GROOVES.find(item => item.id === id)!;
    const preset = PRESETS.find(item => item.source.id === groove.source_id);
    assert.ok(preset, groove.source_id);
    assert.equal(preset!.bars, groove.bars);
    assert.equal(`${preset.meter.numerator}/${preset.meter.denominator}`, groove.meter);
    assert.ok(preset!.notes.length > 0, groove.source_id);
    assert.ok(preset.genres.includes(groove.style.split("/")[0]), groove.source_id);
    assert.ok(preset.tags.length > 0, groove.source_id);
  }
});

test("human-played presets preserve multi-bar phrases up to eight bars", () => {
  const humanPresets = PRESETS.filter(item => item.source.kind === "gmd");
  assert.ok(humanPresets.length > 0);
  assert.ok(humanPresets.every(item => item.bars >= 1 && item.bars <= 8));
  assert.equal(presetById("funk_pocket")!.bars, 2);
  assert.equal(presetById("hiphop_headnod")!.bars, 5);
  assert.ok(presetById("funk_pocket")!.notes.some(note => note.bar === 1 && note.instrument === "kick" && note.tick <= 60));
  assert.ok(presetById("funk_pocket")!.notes.some(note => note.bar === 2));
  assert.ok(presetById("hiphop_headnod")!.notes.some(note => note.bar === 1 && note.instrument === "closed_hat" && note.tick === 18 && note.velocity === 127));
  assert.ok(humanPresets.every(item => Number.isInteger(item.source.bpm) && item.source.bpm! > 0));
  assert.ok(humanPresets.every(item => Array.isArray(item.source.source_bars) && item.source.source_bars.length === 2));
});

test("funk presets retain their original MIDI drum pitches", () => {
  const pocket = presetById("funk_pocket")!;
  const fast = presetById("gmd_drummer1_session1_126")!;
  assert.equal(pocket.notes.length, 46);
  assert.equal(fast.notes.length, 197);
  for (const pitch of [22, 26, 38, 40, 42, 44]) assert.ok(pocket.notes.some(note => note.midi_pitch === pitch), `Funk Pocket pitch ${pitch}`);
  for (const pitch of [37, 38, 42, 44, 46]) assert.ok(fast.notes.some(note => note.midi_pitch === pitch), `Fast Funk pitch ${pitch}`);
});

test("catalog validation rejects duplicate instrument cells", () => {
  const preset = { ...structuredClone(PRESETS[0]), notes: [...structuredClone(PRESETS[0].notes)] };
  preset!.notes.push({ ...preset!.notes[0] });
  assert.equal(validatePreset(preset), false);
});

test("catalog validation rejects a pitch from the wrong drum lane", () => {
  const item = structuredClone(PRESETS[0]);
  item.notes[0].midi_pitch = 44;
  assert.equal(validatePreset(item), false);
});

test("filtering uses requested genre and meter", () => {
  const matches = filterPresets({ genres: ["rock"], meter: "3/4", feels: [] });
  assert.deepEqual(matches, []);
});

test("a funk request can offer both kept funk performances", () => {
  const matches = filterPresets({ genres: ["funk"] });
  assert.ok(matches.some(preset => preset.source.id === "drummer1/eval_session/2"));
  assert.ok(matches.some(preset => preset.source.id === "drummer1/session1/126"));
  assert.ok(matches.every(preset => preset.genres.includes("funk")));
});

test("loading a preset atomically replaces notes and records one history item", () => {
  const initial = createPatternState({ notes: [{ id: "note_9", instrument: "kick", bar: 1, tick: 0, velocity: 100 }] });
  const preset = presetById("funk_pocket")!;
  const loaded = loadPreset(initial, preset, "give me a funk beat");
  assert.equal(loaded.pattern.meter.numerator, 4);
  assert.equal(loaded.pattern.bars, preset!.bars);
  assert.equal(loaded.pattern.notes.length, preset!.notes.length);
  assert.equal(loaded.pattern.notes[0].id, "note_10");
  assert.deepEqual(loaded.pattern.notes.at(-1), { id: `note_${preset!.notes.length + 9}`, ...preset!.notes.at(-1) });
  assert.equal(loaded.recent_history.at(-1)!.request, "give me a funk beat");
  assert.match(loaded.recent_history.at(-1)!.applied_changes[0], /Loaded Funk Pocket/);
});
