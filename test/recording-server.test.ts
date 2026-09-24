import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../server.js";
import { encodeWav } from "../src/core/recording/capture.js";
import { prepareEvidence } from "../src/core/recording/decision.js";
import { createPatternState, stateForJev } from "../src/core/pattern/state.js";

async function withServer(t: test.TestContext, fetchImpl: typeof fetch) {
  const server = createServer({ apiKey: "jev-test", openRouterKey: "router-test", fetchImpl });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
test("WAV route rejects malformed and foreign uploads and returns a bounded transcript", async t => {
  let calls = 0;
  const base = await withServer(t, async () => { calls++; return Response.json({ text: "boom", words: [{ word: "boom", start: 0.1, end: 0.4 }] }); });
  const wav = encodeWav(new Float32Array(16000), 16000);
  const post = (body: ArrayBuffer | string, origin = base) => fetch(`${base}/api/transcribe`, { method: "POST", headers: { "Content-Type": "audio/wav", Origin: origin }, body });
  assert.equal((await post(wav, "https://other.test")).status, 403);
  assert.equal((await post("bad")).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post(wav)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post(encodeWav(new Float32Array(16000 * 31), 16000))).status, 400);
});
test("recorded decision batches four questions and validates responses and correction context", async t => {
  let payload: Record<string, any> = {};
  const base = await withServer(t, async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.entries(payload.questions).map(([id, q]) => {
      const choice = Object.keys((q as { criteria: object }).criteria)[0];
      return [id, { type: "choice", choice, probabilities: { [choice]: 1 } }];
    }));
    return Response.json({ model: "test", answers, usage: {} });
  });
  const pattern = createPatternState({ notes: [{ id: "note_1", bar: 1, slot: 1, instrument: "kick", velocity_layer: 3 }], recent_take: { id: "take", note_ids: ["note_1"] } });
  const evidence = prepareEvidence({ text: "boom", words: [{ word: "boom", start: 0, end: 0.2 }] }, [{ onset_seconds: 0, instrument: "kick" }], 120);
  const response = await fetch(`${base}/api/recording-decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: { evidence, pattern_state: stateForJev(pattern, "boom"), playback: { playing: false } } }) });
  assert.equal(response.status, 200);
  assert.equal(Object.keys(payload.questions).length, 4);
  assert.equal((await response.json()).decision.mode, "add");
  for (const path of ["/frontend/pattern/capture.js", "/frontend/pattern/capture-worklet.js", "/core/recording/capture.js", "/core/recording/analysis.js", "/core/recording/decision.js", "/core/recording/rhythm.js"]) assert.equal((await fetch(base + path)).status, 200);
});
