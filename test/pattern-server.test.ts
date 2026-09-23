import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.js";
import { createPatternState, stateForJev } from "../src/core/pattern/state.js";
import { loadPreset, presetById } from "../src/core/pattern/presets.js";
import { requestBudgetError } from "../src/ai/request-budget.js";

const state = stateForJev(createPatternState(), "Put a strong kick on beat one");

async function withServer(run: (url: string) => Promise<void>, options: Parameters<typeof createServer>[0] = {}) {
  const server = createServer({ apiKey: "pattern-test-secret", ...options });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}

const post = (url: string, payload: unknown = { state, instruments: ["kick"] }, headers = {}) => fetch(`${url}/api/pattern-decision`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: url, ...headers },
  body: JSON.stringify(payload),
});

const postPlan = (url: string, payload = { state }) => fetch(`${url}/api/pattern-plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: url },
  body: JSON.stringify(payload),
});

test("server exposes the articulation kit manifest and only listed samples", async () => {
  await withServer(async (url: string) => {
    const response = await fetch(`${url}/assets/virtuosity/manifest.json`);
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.license, "CC0-1.0");
    const sample = await fetch(`${url}/assets/virtuosity/${manifest.families.snare_side[0]}`);
    assert.equal(sample.status, 200);
    assert.equal(sample.headers.get("content-type"), "audio/wav");
    assert.equal((await fetch(`${url}/assets/virtuosity/not-listed.wav`)).status, 404);
  });
});

function answerQuestions(questions: import("../src/ai/question-types.js").Questions) {
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    if (question.type === "noul") return [key, { type: "noul", noul: 0.1 }];
    const choice = Object.keys(question.criteria ?? {})[0];
    return [key, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
}

test("a large groove narrows to an exact late-bar note before building edit questions", async () => {
  const loaded = loadPreset(createPatternState(), presetById("gmd_drummer1_session1_126"), "funk beat");
  const sent = stateForJev(loaded, "remove the last snare in bar 6");
  const target = sent.pattern.parts.snare.filter(note => note.bar === 6).at(-1)!.id;
  const calls = [];
  await withServer(async (url: string) => {
    const response = await post(url, { state: sent, instruments: ["snare"] });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.answers[`${target}_operation`].choice, "remove");
    assert.equal(result.question_count, 6);
    assert.deepEqual(result.traversal.map((item: any) => item.node), ["edit_scope", "edit_target"]);
  }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(requestBudgetError(body.state, body.questions), null);
    calls.push(Object.keys(body.questions));
    const answers: import("../src/ai/question-types.js").Answers = answerQuestions(body.questions);
    if (answers.edit_scope) answers.edit_scope = { type: "choice", choice: "snare:6", probabilities: { "snare:6": 1 } };
    else if (answers.edit_target) answers.edit_target = { type: "choice", choice: target, probabilities: { [target]: 1 } };
    else assert.deepEqual(Object.keys(body.questions), ["operation", "timing", "velocity", "instrument"].map(suffix => `${target}_${suffix}`));
    return Response.json({ model: "test-jev", answers, usage: { input_tokens: 10 } });
  } });
  assert.equal(calls.length, 3);
});

test("an oversized target list is stopped locally before being sent", async () => {
  const sent = stateForJev(createPatternState({ pattern: { bars: 8, notes: Array.from({ length: 300 }, (_, i) => ({ id: `note_${i + 1}`, instrument: "snare", bar: 1, tick: i, velocity: 80 })) } }), "change the snare");
  let calls = 0;
  await withServer(async (url: string) => {
    const response = await post(url, { state: sent, instruments: ["snare"] });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /narrow the edit/);
  }, { fetchImpl: async () => {
    calls++;
    return Response.json({ model: "test-jev", answers: { edit_scope: { type: "choice", choice: "snare:1", probabilities: { "snare:1": 1 } } } });
  } });
  assert.equal(calls, 1);
});

test("a small pattern exceeding the question budget uses scope narrowing", async () => {
  const instruments = ["kick", "snare", "closed_hat", "ride"];
  const sent = stateForJev(createPatternState({ notes: Array.from({ length: 6 }, (_, i) => ({ id: `note_${i + 1}`, instrument: instruments[i % 4], bar: 1, tick: i * 480, velocity: 80 })) }), "change the beat");
  await withServer(async (url: string) => {
    const response = await post(url, { state: sent, instruments });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).traversal[0].node, "edit_scope");
  }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(requestBudgetError(body.state, body.questions), null);
    assert.ok(body.questions.edit_scope);
    return Response.json({ model: "test-jev", answers: answerQuestions(body.questions) });
  } });
});

test("pattern proxy sends one dynamic structured request and returns every answer", async () => {
  let calls = 0;
  await withServer(async (url: string) => {
    const response = await post(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.question_count, 3);
    assert.equal(Object.keys(body.answers).length, 3);
    assert.equal(body.model, "test-jev");
  }, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer pattern-test-secret");
    const payload = JSON.parse(String(options?.body));
    assert.deepEqual(payload.state, state);
    assert.equal(payload.model, "jev-latest");
    assert.equal(Object.keys(payload.questions).length, 3);
    return Response.json({ model: "test-jev", answers: answerQuestions(payload.questions), usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  assert.equal(calls, 1);
});

test("pattern proxy accepts two hidden articulations at one lane position", async () => {
  const doubled = structuredClone(state);
  doubled.pattern.parts.snare = [
    { id: "note_1", bar: 1, tick: 960, position: "beat_2", velocity: 80 },
    { id: "note_2", bar: 1, tick: 960, position: "beat_2", velocity: 90 },
  ];
  await withServer(async (url: string) => {
    const response = await post(url, { state: doubled, instruments: ["snare"] });
    assert.equal(response.status, 200);
  }, { fetchImpl: async (_url, options) => Response.json({ model: "test-jev", answers: answerQuestions(JSON.parse(String(options?.body)).questions), usage: {} }) });
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
  await withServer(async (url: string) => {
    assert.equal((await post(url, { state: stateWithHistory, instruments: ["kick"] })).status, 200);
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    return Response.json({ model: "test-jev", answers: answerQuestions(payload.questions), usage: {} });
  } });
});

test("planning proxy returns edit count, phrase length, and relevant instruments", async () => {
  await withServer(async (url: string) => {
    const response = await postPlan(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operation_count, 1);
    assert.equal(body.phrase_bars, 4);
    assert.deepEqual(body.relevant_instruments, ["snare"]);
    assert.equal(body.question_count, 11);
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    assert.deepEqual(Object.keys(payload.questions.operation_count.criteria), Array.from({ length: 9 }, (_, count) => `operations_${count}`));
    const answers: import("../src/ai/question-types.js").Answers = answerQuestions(payload.questions);
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
  await withServer(async (url: string) => {
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
  await withServer(async (url: string) => {
    assert.equal((await post(url, { state }, { Origin: "https://example.com" })).status, 403);
    assert.equal((await post(url)).status, 502);
  }, { fetchImpl: async () => Response.json({ model: "test-jev", answers: { reset_pattern: { type: "noul", noul: 2 } } }) });
});

test("pattern proxy sanitizes upstream failures and preserves retry timing", async () => {
  await withServer(async (url: string) => {
    const response = await post(url);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "4");
    assert.ok(!(await response.text()).includes("pattern-test-secret"));
  }, { fetchImpl: async () => new Response("pattern-test-secret", { status: 429, headers: { "Retry-After": "4" } }) });
});

test("request tree routes then searches and selects from bounded presets", async () => {
  await withServer(async (url: string) => {
    const headers = { "Content-Type": "application/json", Origin: url };
    const route = await fetch(`${url}/api/pattern-route`, { method: "POST", headers, body: JSON.stringify({ request: "give me a simple rock beat" }) });
    assert.equal(route.status, 200);
    assert.equal((await route.json()).route.next_node, "preset_search");

    const search = await fetch(`${url}/api/preset-search`, { method: "POST", headers, body: JSON.stringify({ request: "give me a simple rock beat" }) });
    const searchBody = await search.json();
    assert.equal(search.status, 200);
    assert.deepEqual(searchBody.candidate_ids, ["simple_backbeat"]);

    const select = await fetch(`${url}/api/preset-select`, { method: "POST", headers, body: JSON.stringify({ request: "give me a simple rock beat", candidate_ids: searchBody.candidate_ids }) });
    assert.equal(select.status, 200);
    assert.equal((await select.json()).preset_id, "simple_backbeat");
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    const answers: import("../src/ai/question-types.js").Answers = answerQuestions(payload.questions);
    if (answers.request_category) answers.request_category = { type: "choice", choice: "load_preset", probabilities: { load_preset: 1 }, confidence: 1 };
    if (answers.meter) {
      answers.meter = { type: "choice", choice: "4/4", probabilities: { "4/4": 1 }, confidence: 1 };
      answers.genre_rock = { type: "noul", noul: 0.98 };
    }
    return Response.json({ model: "test-jev", answers, usage: {} });
  } });
});

test("preset selection sends Jev descriptive tags for a kept funk groove", async () => {
  await withServer(async (url: string) => {
    const response = await fetch(`${url}/api/preset-select`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ request: "give me a fast funk beat", candidate_ids: ["gmd_drummer1_session1_126"] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).preset_id, "gmd_drummer1_session1_126");
  }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(String(options?.body));
    const candidate = payload.state.candidates[0];
    assert.ok(candidate.tags.includes("funk"));
    assert.ok(candidate.tags.includes("fast"));
    assert.equal(candidate.source_bpm, 125);
    assert.equal(candidate.bars, 8);
    return Response.json({ model: "test-jev", answers: { preset: { type: "choice", choice: candidate.id, probabilities: { [candidate.id]: 1 } } }, usage: {} });
  } });
});

test("a funk request reaches both kept funk grooves before Jev selects", async () => {
  await withServer(async (url: string) => {
    const response = await fetch(`${url}/api/preset-search`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ request: "hey, give me a funk beat" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.candidate_ids.includes("funk_pocket"));
    assert.ok(body.candidate_ids.includes("gmd_drummer1_session1_126"));
    assert.ok(body.candidate_ids.length <= 8);
  }, { fetchImpl: async (_url, options) => {
    const questions = JSON.parse(String(options?.body)).questions;
    const answers = answerQuestions(questions);
    answers.genre_funk = { type: "noul", noul: 0.99 };
    return Response.json({ model: "test-jev", answers, usage: {} });
  } });
});
