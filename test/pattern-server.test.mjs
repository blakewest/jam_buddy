import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
import { createPatternState, stateForJev } from "../src/core/pattern/state.js";

const state = stateForJev(createPatternState(), "Put a strong kick on beat one");

async function withServer(run, options = {}) {
  const server = createServer({ apiKey: "pattern-test-secret", ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}

const post = (url, payload = { state, instruments: ["kick"] }, headers = {}) => fetch(`${url}/api/pattern-decision`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: url, ...headers },
  body: JSON.stringify(payload),
});

const postPlan = (url, payload = { state }) => fetch(`${url}/api/pattern-plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: url },
  body: JSON.stringify(payload),
});

function answerQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    if (question.type === "noul") return [key, { type: "noul", noul: 0.1 }];
    const choice = Object.keys(question.criteria)[0];
    return [key, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
}

test("pattern proxy sends one dynamic structured request and returns every answer", async () => {
  let calls = 0;
  await withServer(async url => {
    const response = await post(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.question_count, 3);
    assert.equal(Object.keys(body.answers).length, 3);
    assert.equal(body.model, "test-jev");
  }, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(options.headers.Authorization, "Bearer pattern-test-secret");
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.state, state);
    assert.equal(payload.model, "jev-latest");
    assert.equal(Object.keys(payload.questions).length, 3);
    return Response.json({ model: "test-jev", answers: answerQuestions(payload.questions), usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  assert.equal(calls, 1);
});

test("pattern proxy accepts one eight-change history entry", async () => {
  const stateWithHistory = {
    ...state,
    recent_history: [{
      request: "hats on all eighths",
      applied_changes: Array.from({ length: 8 }, (_, index) => `Added hat ${index + 1}`),
      rejected_changes: [],
    }],
  };
  await withServer(async url => {
    assert.equal((await post(url, { state: stateWithHistory, instruments: ["kick"] })).status, 200);
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return Response.json({ model: "test-jev", answers: answerQuestions(payload.questions), usage: {} });
  } });
});

test("planning proxy returns edit count, phrase length, and relevant instruments", async () => {
  await withServer(async url => {
    const response = await postPlan(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operation_count, 1);
    assert.equal(body.phrase_bars, 4);
    assert.deepEqual(body.relevant_instruments, ["snare"]);
    assert.equal(body.question_count, 10);
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload.questions.operation_count.criteria), Array.from({ length: 9 }, (_, count) => `operations_${count}`));
    const answers = answerQuestions(payload.questions);
    answers.operation_count = { type: "choice", choice: "operations_1", probabilities: { operations_1: 1 }, confidence: 1 };
    answers.phrase_length = { type: "choice", choice: "bars_4", probabilities: { bars_4: 1 }, confidence: 1 };
    answers.involves_snare = { type: "noul", noul: 0.91 };
    return Response.json({
      model: "test-jev",
      answers,
      usage: { input_tokens: 4, output_tokens: 1 },
    });
  } });
});

test("invalid pattern state and excess history never call TypeSafe", async () => {
  await withServer(async url => {
    assert.equal((await post(url, { state: { ...state, pattern: { ...state.pattern, slots_per_bar: 12 } } })).status, 400);
    const recent_history = Array.from({ length: 9 }, (_, index) => ({ request: `r${index}`, applied_changes: [], rejected_changes: [] }));
    assert.equal((await post(url, { state: { ...state, recent_history } })).status, 400);
    const duplicate = { ...state, pattern: { bars: 1, slots_per_bar: 16, parts: { ...state.pattern.parts, kick: [
      { id: "note_1", bar: 1, position: "beat_1", velocity_layer: 3 },
      { id: "note_2", bar: 1, position: "beat_1", velocity_layer: 4 },
    ] } } };
    assert.equal((await post(url, { state: duplicate, instruments: ["kick"] })).status, 400);
    assert.equal((await post(url, { state, instruments: ["cowbell"] })).status, 400);
  }, { fetchImpl: () => { throw new Error("upstream should not run"); } });
});

test("pattern proxy rejects foreign origins and invalid dynamic answers", async () => {
  await withServer(async url => {
    assert.equal((await post(url, { state }, { Origin: "https://example.com" })).status, 403);
    assert.equal((await post(url)).status, 502);
  }, { fetchImpl: async () => Response.json({ model: "test-jev", answers: { reset_pattern: { type: "noul", noul: 2 } } }) });
});

test("pattern proxy sanitizes upstream failures and preserves retry timing", async () => {
  await withServer(async url => {
    const response = await post(url);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "4");
    assert.ok(!(await response.text()).includes("pattern-test-secret"));
  }, { fetchImpl: async () => new Response("pattern-test-secret", { status: 429, headers: { "Retry-After": "4" } }) });
});

test("request tree routes then searches and selects from bounded presets", async () => {
  await withServer(async url => {
    const headers = { "Content-Type": "application/json", Origin: url };
    const route = await fetch(`${url}/api/pattern-route`, { method: "POST", headers, body: JSON.stringify({ request: "give me a rock beat in 3/4" }) });
    assert.equal(route.status, 200);
    assert.equal((await route.json()).route.next_node, "preset_search");

    const search = await fetch(`${url}/api/preset-search`, { method: "POST", headers, body: JSON.stringify({ request: "give me a rock beat in 3/4" }) });
    const searchBody = await search.json();
    assert.equal(search.status, 200);
    assert.deepEqual(searchBody.candidate_ids, ["rock_waltz"]);

    const select = await fetch(`${url}/api/preset-select`, { method: "POST", headers, body: JSON.stringify({ request: "give me a rock beat in 3/4", candidate_ids: searchBody.candidate_ids }) });
    assert.equal(select.status, 200);
    assert.equal((await select.json()).preset_id, "rock_waltz");
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    const answers = answerQuestions(payload.questions);
    if (answers.request_category) answers.request_category = { type: "choice", choice: "load_preset", probabilities: { load_preset: 1 }, confidence: 1 };
    if (answers.meter) {
      answers.meter = { type: "choice", choice: "3/4", probabilities: { "3/4": 1 }, confidence: 1 };
      answers.genre_rock = { type: "noul", noul: 0.98 };
    }
    return Response.json({ model: "test-jev", answers, usage: {} });
  } });
});
