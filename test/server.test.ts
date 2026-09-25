import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.js";

const state = { piano: { recent_events: [], silent_for_ms: 1000 }, drums: { status: "stopped", scheduled_start: false } };
async function withServer(run: (url: string) => Promise<void>, options: Parameters<typeof createServer>[0] = {}) {
  const server = createServer({ apiKey: "test-only-secret", ...options });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (url: string, payload: unknown = { state }, extra = {}) => fetch(`${url}/api/decision`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url, ...extra }, body: JSON.stringify(payload) });

test("proxy sends only minimal state and fixed question; returns structured answer", async () => {
  await withServer(async (url: string) => {
    const response = await post(url);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).answer.choice, "keep_current");
  }, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const payload = JSON.parse(String(options?.body));
    assert.deepEqual(payload.state, state);
    assert.equal(payload.model, "jev-latest");
    assert.deepEqual(Object.keys(payload.questions.action.criteria), ["start_next_bar", "stop", "keep_current"]);
    return Response.json({ model: "test-model", answers: { action: { type: "choice", choice: "keep_current", probabilities: { keep_current: 1 }, confidence: 1 } }, usage: { input_tokens: 100, output_tokens: 10 } });
  } });
});

test("preset audition page and source clips are served", async () => {
  await withServer(async (url: string) => {
    for (const path of ["/presets.html", "/presets.css", "/presets-app.js", "/core/pattern/audition-grooves.js", "/assets/gmd/funk_pocket.wav", "/assets/gmd/gmd_drummer5_session1_17.wav"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 200, path);
    }
  });
});

test("groove audio supports byte ranges for browser playback", async () => {
  await withServer(async (url: string) => {
    const path = `${url}/assets/gmd/funk_pocket.wav`;
    const first = await fetch(path, { headers: { Range: "bytes=0-1023" } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get("Accept-Ranges"), "bytes");
    assert.match(first.headers.get("Content-Range")!, /^bytes 0-1023\/\d+$/);
    assert.equal((await first.arrayBuffer()).byteLength, 1024);

    const suffix = await fetch(path, { headers: { Range: "bytes=-128" } });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 128);

    const invalid = await fetch(path, { headers: { Range: "bytes=999999999-" } });
    assert.equal(invalid.status, 416);
    assert.match(invalid.headers.get("Content-Range")!, /^bytes \*\/\d+$/);
  });
});

test("dotfiles, foreign origins, invalid state and large bodies never call upstream", async () => {
  await withServer(async (url: string) => {
    assert.equal((await fetch(`${url}/.env`)).status, 404);
    assert.equal((await fetch(`${url}/server.mjs`)).status, 404);
    assert.equal((await post(url, { state }, { Origin: "https://example.com" })).status, 403);
    assert.equal((await post(url, { state: { ...state, secret: "bad" } })).status, 400);
    assert.equal((await post(url, { text: "x".repeat(200000) })).status, 413);
  }, { fetchImpl: () => { throw new Error("Upstream must not be called"); } });
});

test("upstream errors are sanitized and retry-after is retained", async () => {
  await withServer(async (url: string) => {
    const response = await post(url);
    assert.equal(response.status, 429);
    const body = await response.text();
    assert.ok(!body.includes("test-only-secret"));
    assert.equal(response.headers.get("Retry-After"), "3");
  }, { fetchImpl: async () => new Response("test-only-secret", { status: 429, headers: { "Retry-After": "3" } }) });
});

test("invalid answer cannot reach the client as an action", async () => {
  await withServer(async (url: string) => {
    assert.equal((await post(url)).status, 502);
  }, { fetchImpl: async () => Response.json({ answers: { action: { choice: "unknown" } } }) });
});

test("pattern builder is home and timing lab has its own URL", async () => {
  await withServer(async url => {
    const home = await fetch(url).then(response => response.text());
    const pattern = await fetch(`${url}/pattern.html`).then(response => response.text());
    const timing = await fetch(`${url}/timing.html`).then(response => response.text());
    assert.equal(home, pattern);
    assert.match(home, /href="\/timing.html"/);
    assert.match(timing, /Can the drummer keep up\?/);
    assert.match(timing, /href="\/">Pattern builder/);
  });
});
