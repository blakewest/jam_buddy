import test from "node:test";
import assert from "node:assert/strict";
import { requestBudgetError } from "../src/ai/request-budget.js";

test("request budgets cover question count, combined bytes, individual context, and choice count", () => {
  const question = { type: "noul", instructions: "Is a kick requested?" };
  assert.equal(requestBudgetError({}, { kick: question }), null);
  assert.match(requestBudgetError({}, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i, question])))!, /Too many questions/);
  assert.match(requestBudgetError({}, { big: { ...question, instructions: "x".repeat(29000) } })!, /context/);
  assert.match(requestBudgetError({}, Object.fromEntries(Array.from({ length: 3 }, (_, i) => [i, { ...question, instructions: "x".repeat(20000) }])))!, /combined/);
  assert.match(requestBudgetError({}, { pick: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, "x"])) } })!, /choices/);
});
