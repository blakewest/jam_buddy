import test from "node:test";
import assert from "node:assert/strict";
import { REQUEST_CATEGORIES, resolveRoot, unsupportedMessage } from "../src/core/pattern/request-tree.js";
import { ROOT_QUESTIONS } from "../src/ai/request-tree-questions.mjs";

test("root categories have stable IDs and explicit next nodes", () => {
  assert.deepEqual(Object.keys(REQUEST_CATEGORIES), ["edit_pattern", "load_preset", "unsupported"]);
  assert.equal(resolveRoot("edit_pattern").next_node, "edit_plan");
  assert.equal(resolveRoot("load_preset").next_node, "preset_search");
  assert.equal(resolveRoot("unsupported").next_node, null);
  assert.throws(() => resolveRoot("other"), /invalid request category/i);
});

test("unsupported guidance is generated from actionable categories", () => {
  assert.equal(unsupportedMessage(), "I didn't get that. I can edit the current beat or pick a beat preset.");
});

test("the root sends one bounded choice without pattern state", () => {
  assert.deepEqual(Object.keys(ROOT_QUESTIONS), ["request_category"]);
  assert.equal(ROOT_QUESTIONS.request_category.type, "choice");
  assert.deepEqual(Object.keys(ROOT_QUESTIONS.request_category.criteria), ["edit_pattern", "load_preset", "unsupported"]);
  assert.deepEqual(ROOT_QUESTIONS.request_category.instructions.inspect, ["request"]);
});
