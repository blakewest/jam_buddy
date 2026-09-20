import test from "node:test";
import assert from "node:assert/strict";
import { runPatternTree } from "../src/core/pattern/request-runner.js";
import { createPatternState } from "../src/core/pattern/state.js";

test("edit routes only to the existing edit runner", async () => {
  const calls = [];
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
    state: initial, request: "rock in 3/4",
    route: async () => ({ route: { category: "load_preset", next_node: "preset_search" } }),
    searchPresets: async () => ({ candidate_ids: ["rock_waltz"] }),
    selectPreset: async () => ({ preset_id: "rock_waltz" }),
    runEdit: async () => { throw new Error("edit should not run"); },
  });
  assert.equal(result.state.pattern.meter.numerator, 3);
  assert.deepEqual(result.visits.map(item => item.node), ["root", "preset_search", "preset_select", "preset_load"]);
});

test("unsupported and empty searches preserve state", async () => {
  const initial = createPatternState();
  const unsupported = await runPatternTree({ state: initial, request: "write a bass line", route: async () => ({ route: { category: "unsupported", message: "Nope" } }) });
  assert.deepEqual(unsupported.state, initial);
  assert.equal(unsupported.result.message, "Nope");

  const empty = await runPatternTree({ state: initial, request: "metal in 5/4", route: async () => ({ route: { category: "load_preset" } }), searchPresets: async () => ({ candidate_ids: [], alternatives: { meters: ["4/4"] } }) });
  assert.deepEqual(empty.state, initial);
  assert.match(empty.result.message, /No matching preset/);
});
