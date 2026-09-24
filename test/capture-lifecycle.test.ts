import test from "node:test";
import assert from "node:assert/strict";
import { createRecorder } from "../src/frontend/pattern/capture.js";
import type { RecordedTake } from "../src/core/recording/capture.js";

function harness(t: test.TestContext) {
  let resolveMedia!: (stream: MediaStream) => void;
  let rejectMedia!: (error: Error) => void;
  const media = new Promise<MediaStream>((resolve, reject) => { resolveMedia = resolve; rejectMedia = reject; });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => media } } });
  const originalNode = globalThis.AudioWorkletNode;
  const statuses: string[] = [], errors: string[] = [], takes: RecordedTake[] = [];
  let stops = 0;
  const track = Object.assign(new EventTarget(), { stop() { stops++; } });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  class Node {
    port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (_: string) => {}, close() {} };
    onprocessorerror: (() => void) | null = null;
    constructor() { node = this; }
    connect() {} disconnect() {}
  }
  let node: Node;
  globalThis.AudioWorkletNode = Node as unknown as typeof AudioWorkletNode;
  const context = Object.assign(new EventTarget(), { sampleRate: 8000, state: "running", destination: {}, audioWorklet: { addModule: async () => {} }, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }) });
  const recorder = createRecorder({ context: async () => context as unknown as AudioContext, snapshot: () => ({ playing: false, tempo_bpm: 120, bars: 1, origin_context_seconds: 0, captured_context_seconds: 10, output_latency_seconds: 0, output_context_seconds: 10, output_performance_ms: 0, input_correction_ms: 0 }), onStatus: status => statuses.push(status), onTake: take => takes.push(take), onError: message => errors.push(message) });
  t.after(() => { recorder.cancel(); globalThis.AudioWorkletNode = originalNode; if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor); else Reflect.deleteProperty(globalThis, "navigator"); });
  return { oldError: () => node.onprocessorerror, recorder, statuses, errors, takes, context, allow: () => resolveMedia(stream), deny: () => rejectMedia(new Error("Permission denied")), stops: () => stops, emit: (data: unknown) => node.port.onmessage?.({ data }), disconnect: () => track.dispatchEvent(new Event("ended")) };
}
test("release while permission is pending stops late tracks without recording", async t => {
  const h = harness(t);
  const start = h.recorder.start();
  await Promise.resolve();
  h.recorder.release(); h.allow(); await start;
  assert.equal(h.stops(), 1); assert.equal(h.takes.length, 0); assert.equal(h.statuses.at(-1), "idle");
  assert.match(h.errors[0], /before.*ready/i);
});
test("permission denial returns idle with a useful error", async t => {
  const h = harness(t); const start = h.recorder.start(); h.deny(); await start;
  assert.match(h.errors[0], /Permission/); assert.equal(h.statuses.at(-1), "idle");
});
test("release flushes the final samples, stops tracks, and ignores stale samples", async t => {
  const h = harness(t); const start = h.recorder.start(); h.allow(); await start;
  h.emit({ time: 10, samples: new Float32Array(128) });
  h.recorder.release(); h.emit({ time: 10.016, samples: new Float32Array(128) }); h.emit({ done: true });
  assert.equal(h.takes[0].samples.length, 256); assert.equal(h.stops(), 1);
  h.emit({ time: 12, samples: new Float32Array(128) }); assert.equal(h.takes.length, 1);
});
for (const failure of ["cancel", "interruption", "disconnect"] as const) test(`${failure} releases tracks and cannot submit a late take`, async t => {
  const h = harness(t); const start = h.recorder.start(); h.allow(); await start;
  h.emit({ time: 10, samples: new Float32Array(128) });
  if (failure === "cancel") h.recorder.cancel();
  else if (failure === "disconnect") h.disconnect();
  else { h.context.state = "suspended"; h.context.dispatchEvent(new Event("statechange")); }
  h.emit({ done: true }); assert.equal(h.takes.length, 0); assert.equal(h.stops(), 1);
});

test("a stale worklet error cannot cancel a later capture", async t => {
  const h = harness(t); const starting = h.recorder.start(); h.allow(); await starting;
  const oldError = h.oldError(); h.recorder.cancel();
  await h.recorder.start(); oldError?.();
  h.emit({ time: 12, samples: new Float32Array(128) }); h.emit({ done: true });
  assert.equal(h.takes.length, 1); assert.equal(h.errors.length, 0);
});
