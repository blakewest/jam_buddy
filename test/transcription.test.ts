import test from "node:test";
import assert from "node:assert/strict";
import { transcribe, validateWav } from "../src/services/transcription.js";
import { encodeWav } from "../src/core/recording/capture.js";
const wav = () => Buffer.from(encodeWav(new Float32Array(16000), 16000));

test("OpenRouter receives Whisper WAV with word timestamps and returns validated origin-relative times", async () => {
  const result = await transcribe(wav(), { apiKey: "test-key", signal: new AbortController().signal, fetchImpl: async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "openai/whisper-1");
    assert.equal(body.response_format, "verbose_json");
    assert.deepEqual(body.timestamp_granularities, ["word"]);
    assert.equal(Buffer.from(body.input_audio.data, "base64").length, 32044);
    return Response.json({ text: "boom", words: [{ word: "boom", start: 0.2, end: 0.4 }] });
  } });
  assert.deepEqual(result.words, [{ word: "boom", start: 0.2, end: 0.4 }]);
});
test("invalid PCM, long audio and malformed timestamp responses fail without returning a transcript", async () => {
  assert.throws(() => validateWav(Buffer.from("bad")), /WAV/);
  assert.throws(() => validateWav(Buffer.from(encodeWav(new Float32Array(16000 * 31), 16000))), /30/);
  await assert.rejects(transcribe(wav(), { apiKey: "test", signal: new AbortController().signal, fetchImpl: async () => Response.json({ text: "boom", words: [{ word: "boom", start: -1, end: 4 }] }) }), /timestamp/);
  await assert.rejects(transcribe(wav(), { apiKey: "test", signal: new AbortController().signal, fetchImpl: async () => Response.json({ text: "boom" }) }), /timestamp/);
});
test("upstream failures and cancellation are surfaced", async () => {
  await assert.rejects(transcribe(wav(), { apiKey: "test", signal: new AbortController().signal, fetchImpl: async () => new Response("secret provider detail", { status: 429 }) }), /HTTP 429/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(transcribe(wav(), { apiKey: "test", signal: abort.signal, fetchImpl: async () => { throw new Error("must not call"); } }), { name: "AbortError" });
});
