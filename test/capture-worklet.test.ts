import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { CaptureBuffer } from "../src/core/recording/capture.js";

test("worklet timestamps follow captured samples despite repeated or jumping render timestamps", () => {
  const messages: { time?: number; samples?: Float32Array; done?: boolean }[] = [];
  let Processor: any;
  const scope = {
    sampleRate: 48000, currentFrame: 48000,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: any) => messages.push(message) }; },
    registerProcessor: (_name: string, processor: unknown) => { Processor = processor; },
  };
  runInNewContext(readFileSync("src/frontend/pattern/capture-worklet.js", "utf8"), scope);
  const processor = new Processor();
  const capture = new CaptureBuffer(48000);
  for (const [frame, level] of [[48000, 0.25], [48000, 0.5], [48512, 0.75]]) {
    scope.currentFrame = frame;
    processor.process([[new Float32Array(128).fill(level)]], [[new Float32Array(128)]]);
  }
  for (const message of messages) capture.append(message.time!, message.samples!);
  const take = capture.finish();
  assert.equal(take.start_context_seconds, 1);
  assert.equal(take.samples.length, 384);
  assert.deepEqual([take.samples[0], take.samples[128], take.samples[256]], [0.25, 0.5, 0.75]);
});

test("worklet waits for first input, then preserves empty input blocks as silence", () => {
  const messages: any[] = [];
  let Processor: any;
  const scope = {
    sampleRate: 48000, currentFrame: 48000,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: any) => messages.push(message) }; },
    registerProcessor: (_name: string, processor: unknown) => { Processor = processor; },
  };
  runInNewContext(readFileSync("src/frontend/pattern/capture-worklet.js", "utf8"), scope);
  const processor = new Processor();
  const output = [[new Float32Array(128)]];
  processor.process([[]], output);
  assert.equal(messages.length, 0);
  processor.process([[new Float32Array(128).fill(0.5)]], output);
  processor.process([[]], output);
  processor.process([[new Float32Array(128).fill(0.75)]], output);
  assert.equal(messages.length, 3);
  assert.ok(messages[1].samples.every((sample: number) => sample === 0));
  assert.equal(messages[2].time, 1 + 256 / 48000);
});
