import test from "node:test";
import assert from "node:assert/strict";
import { runPatternTree as runTree } from "../src/core/pattern/request-runner.js";
// Deliberately partial API fixtures exercise only the selected branch.
const runPatternTree = (options: unknown) => runTree(options as Parameters<typeof runTree>[0]);
import { createPatternState } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";

test("clearing a loaded groove bypasses every edit and preset API", async () => {
  const initial = loadPreset(createPatternState(), presetById("gmd_drummer1_session1_126"), "funk beat");
  assert.equal(initial.pattern.notes.length, 197);
  const forbidden = async () => { throw new Error("Only the root should be called"); };
  const result = await runPatternTree({ state: initial, request: "Fully remove this beat", route: async () => ({ route: { category: "clear_pattern" } }), runEdit: forbidden, searchPresets: forbidden, selectPreset: forbidden });
  assert.equal(result.state.pattern.notes.length, 0);
  assert.equal(initial.pattern.notes.length, 197);
  assert.deepEqual(result.result.applied_changes, [{ kind: "reset" }]);
});

test("tempo route uses its child decision without entering the note editor", async () => {
  const initial = createPatternState({ tempo_bpm: 120 });
  const forbidden = async () => { throw new Error("Unexpected API call"); };
  const result = await runPatternTree({ state: initial, request: "slow this whole thing down", route: async () => ({ route: { category: "change_tempo" } }), interpretTempo: async () => ({ action: "decrease" }), runEdit: forbidden, searchPresets: forbidden, selectPreset: forbidden } as unknown as Parameters<typeof runPatternTree>[0]);
  assert.equal(result.state.tempo_bpm, 110);
  assert.deepEqual(result.visits.map(visit => visit.node), ["root", "change_tempo"]);
});

test("shuffle remembers filters after reload and never selects the current groove", async () => {
  const loaded = await runPatternTree({ state: createPatternState(), request: "funk beat", route: async () => ({ route: { category: "load_preset" } }), searchPresets: async () => ({ attributes: { genres: ["funk"], meter: "unspecified", feels: [] }, candidate_ids: ["funk_pocket"] }), selectPreset: async () => ({ preset_id: "funk_pocket" }) });
  const restored = createPatternState(JSON.parse(JSON.stringify(loaded.state)));
  const result = await runPatternTree({ state: restored, request: "no something else", route: async () => ({ route: { category: "shuffle_preset" } }), searchPresets: async () => ({ has_explicit_filters: false, attributes: { genres: [], meter: "unspecified", feels: ["heavy"] } }), selectPreset: async () => { throw new Error("Shuffle must use code"); }, random: () => 0 });
  assert.notEqual(result.result.preset_id, "funk_pocket");
  assert.ok(presetById(result.result.preset_id!)!.genres.includes("funk"));
  assert.equal(result.result.tempo_bpm, presetById(result.result.preset_id!)!.tempo_bpm);
});

test("shuffle with no alternative preserves state and explains why", async () => {
  const initial = loadPreset(createPatternState(), presetById("gmd_drummer1_session2_10"), "country beat");
  const result = await runPatternTree({ state: initial, request: "another", route: async () => ({ route: { category: "shuffle_preset" } }), searchPresets: async () => ({ has_explicit_filters: false }) });
  assert.equal(result.state, initial);
  assert.match(result.result.message!, /isn't another/);
});

test("edit routes only to the existing edit runner", async () => {
  const calls: any[] = [];
  const initial = createPatternState();
  const result = await runPatternTree({
    state: initial, request: "add a kick",
    route: async () => ({ route: { category: "edit_pattern", next_node: "edit_plan" }, latency_ms: 2, usage: { input_tokens: 2 } }),
    runEdit: async () => { calls.push("edit"); return { state: initial, result: { applied_changes: [] }, latency_ms: 3, usage: { input_tokens: 5 } }; },
    searchPresets: async () => calls.push("search"), selectPreset: async () => calls.push("select"),
  });
  assert.deepEqual(calls, ["edit"]);
  assert.deepEqual(result.visits.map(item => item.node), ["root", "edit_plan"]);
  assert.equal(result.latency_ms, 5);
  assert.deepEqual(result.usage, { input_tokens: 7 });
});

test("preset routes through search and selection then loads atomically", async () => {
  const initial = createPatternState();
  const result = await runPatternTree({
    state: initial, request: "simple backbeat",
    route: async () => ({ route: { category: "load_preset", next_node: "preset_search" } }),
    searchPresets: async () => ({ candidate_ids: ["simple_backbeat"] }),
    selectPreset: async () => ({ preset_id: "simple_backbeat" }),
    runEdit: async () => { throw new Error("edit should not run"); },
  });
  assert.equal(result.state.pattern.meter.numerator, 4);
  assert.equal(result.result.tempo_bpm, 100);
  assert.deepEqual(result.visits.map(item => item.node), ["root", "preset_search", "preset_select", "preset_load"]);
});

test("unsupported and empty searches preserve state", async () => {
  const initial = createPatternState();
  const unsupported = await runPatternTree({ state: initial, request: "write a bass line", route: async () => ({ route: { category: "unsupported", message: "Nope" } }) });
  assert.deepEqual(unsupported.state, initial);
  assert.equal(unsupported.result.message, "Nope");

  const empty = await runPatternTree({ state: initial, request: "metal in 5/4", route: async () => ({ route: { category: "load_preset" } }), searchPresets: async () => ({ candidate_ids: [], alternatives: { meters: ["4/4"] } }) });
  assert.deepEqual(empty.state, initial);
  assert.match(empty.result.message!, /No matching preset/);
});
