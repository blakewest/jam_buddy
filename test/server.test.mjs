import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";

const state = { piano: { recent_events: [], silent_for_ms: 1000 }, drums: { status: "stopped", scheduled_start: false } };
async function withServer(run, options = {}) {
  const server = createServer({ apiKey: "test-only-secret", ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (url, payload = { state }, extra = {}) => fetch(`${url}/api/decision`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url, ...extra }, body: JSON.stringify(payload) });

test("proxy sends only minimal state and fixed question; returns structured answer", async () => {
  await withServer(async url => {
    const response = await post(url);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).answer.choice, "keep_current");
  }, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.state, state);
    assert.equal(payload.model, "jev-latest");
    assert.deepEqual(Object.keys(payload.questions.action.criteria), ["start_next_bar", "stop", "keep_current"]);
    return Response.json({ model: "test-model", answers: { action: { type: "choice", choice: "keep_current", probabilities: { keep_current: 1 }, confidence: 1 } }, usage: { input_tokens: 100, output_tokens: 10 } });
  } });
});

test("dotfiles, foreign origins, invalid state and large bodies never call upstream", async () => {
  await withServer(async url => {
    assert.equal((await fetch(`${url}/.env`)).status, 404);
    assert.equal((await fetch(`${url}/server.mjs`)).status, 404);
    assert.equal((await post(url, { state }, { Origin: "https://example.com" })).status, 403);
    assert.equal((await post(url, { state: { ...state, secret: "bad" } })).status, 400);
    assert.equal((await post(url, { text: "x".repeat(200000) })).status, 413);
  }, { fetchImpl: () => { throw new Error("Upstream must not be called"); } });
});

test("upstream errors are sanitized and retry-after is retained", async () => {
  await withServer(async url => {
    const response = await post(url);
    assert.equal(response.status, 429);
    const body = await response.text();
    assert.ok(!body.includes("test-only-secret"));
    assert.equal(response.headers.get("Retry-After"), "3");
  }, { fetchImpl: async () => new Response("test-only-secret", { status: 429, headers: { "Retry-After": "3" } }) });
});

test("invalid answer cannot reach the client as an action", async () => {
  await withServer(async url => {
    assert.equal((await post(url)).status, 502);
  }, { fetchImpl: async () => Response.json({ answers: { action: { choice: "unknown" } } }) });
});
