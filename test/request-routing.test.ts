import test from "node:test";
import assert from "node:assert/strict";
import { REQUEST_CATEGORIES, resolveRoot, unsupportedMessage } from "../src/core/pattern/request-tree.js";
import { ROOT_QUESTIONS } from "../src/ai/request-tree-questions.js";

test("root categories have stable IDs and explicit next nodes", () => {
  assert.deepEqual(Object.keys(REQUEST_CATEGORIES).sort(), ["recorded_rhythm", "fill_rhythm", "edit_pattern", "change_kit", "change_swing", "change_tempo", "add_compression", "polish_mix", "undo", "load_preset", "clear_pattern", "shuffle_preset", "unsupported"].sort());
  assert.equal(resolveRoot("clear_pattern").next_node, "pattern_clear");
  assert.equal(resolveRoot("shuffle_preset").next_node, "preset_shuffle");
  assert.equal(resolveRoot("edit_pattern").next_node, "edit_plan");
  assert.equal(resolveRoot("load_preset").next_node, "preset_search");
  assert.equal(resolveRoot("unsupported").next_node, null);
  assert.throws(() => resolveRoot("other"), /invalid request category/i);
});

test("unsupported guidance is generated from actionable categories", () => {
  for (const [id, category] of Object.entries(REQUEST_CATEGORIES)) if (id !== "unsupported") assert.ok(unsupportedMessage().includes(category.description));
});

test("the root sends one bounded choice without pattern state", () => {
  assert.deepEqual(Object.keys(ROOT_QUESTIONS), ["request_category"]);
  assert.equal(ROOT_QUESTIONS.request_category.type, "choice");
  assert.deepEqual(Object.keys(ROOT_QUESTIONS.request_category.criteria).sort(), Object.keys(REQUEST_CATEGORIES).sort());
  assert.deepEqual(ROOT_QUESTIONS.request_category.instructions.inspect, ["request"]);
});
