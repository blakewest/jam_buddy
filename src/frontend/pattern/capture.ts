import { CaptureBuffer } from "../../core/recording/capture.js";
import type { RecordedTake, TransportSnapshot } from "../../core/recording/capture.js";

export function createRecorder(options: {
  context: () => Promise<AudioContext>;
  snapshot: () => TransportSnapshot;
  onStatus: (status: "idle" | "initializing" | "recording") => void;
  onTake: (take: RecordedTake) => void;
  onError: (message: string) => void;
}) {
  let version = 0;
  let held = false;
  let releasedAt: number | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let muted: GainNode | undefined;
  let context: AudioContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let buffer: CaptureBuffer | undefined;
  let transport: TransportSnapshot | undefined;
  let stateListener: (() => void) | undefined;
  const loaded = new WeakSet<AudioContext>();

  function cleanup() {
    clearTimeout(timer);
    if (context && stateListener) context.removeEventListener("statechange", stateListener);
    if (node) { node.onprocessorerror = null; node.port.onmessage = null; node.port.close(); node.disconnect(); }
    source?.disconnect(); muted?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    node = undefined; source = undefined; muted = undefined; stream = undefined;
    held = false;
    options.onStatus("idle");
  }
  function cancel() { version++; cleanup(); buffer = undefined; }
  function fail(error: unknown) { cancel(); options.onError(error instanceof Error ? error.message : String(error)); }
  function finish() {
    try {
      if (!buffer || !transport) return;
      const audio = buffer.finish();
      buffer = undefined;
      version++;
      cleanup();
      options.onTake({ ...audio, id: crypto.randomUUID(), release_performance_ms: releasedAt ?? performance.now(), transport });
    } catch (error) { fail(error); }
  }
  async function start() {
    if (held || node) return;
    held = true;
    releasedAt = undefined;
    const current = ++version;
    options.onStatus("initializing");
    try {
      context = await options.context();
      if (current !== version) return;
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (current !== version) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      if (!loaded.has(context)) { await context.audioWorklet.addModule("/frontend/pattern/capture-worklet.js"); loaded.add(context); }
      if (current !== version) return;
      if (context.state !== "running") throw new Error("Audio context interrupted. Try recording again.");
      buffer = new CaptureBuffer(context.sampleRate);
      transport = options.snapshot();
      node = new AudioWorkletNode(context, "take-capture");
      source = context.createMediaStreamSource(stream);
      muted = context.createGain(); muted.gain.value = 0;
      source.connect(node); node.connect(muted); muted.connect(context.destination);
      node.port.onmessage = event => {
        if (current !== version) return;
        try {
          if (event.data.done) { finish(); return; }
          buffer?.append(event.data.time, event.data.samples);
        } catch (error) { fail(error); }
      };
      node.onprocessorerror = () => { if (current === version) fail(new Error("Microphone processing stopped. Try again.")); };
      stream.getTracks().forEach(track => track.addEventListener("ended", () => { if (current === version) fail(new Error("Microphone disconnected.")); }));
      stateListener = () => { if (context?.state !== "running") fail(new Error("Audio context interrupted. Take canceled.")); };
      context.addEventListener("statechange", stateListener);
      options.onStatus("recording");
      timer = setTimeout(release, 30000);
    } catch (error) { if (current === version) fail(error); }
  }
  function release() {
    if (!held && !node) return;
    releasedAt ??= performance.now();
    held = false;
    if (!node) {
      cancel();
      options.onError("Released before the microphone was ready. Hold until Recording… appears, then demonstrate the beat.");
      return;
    }
    clearTimeout(timer);
    node.port.postMessage("stop");
    timer = setTimeout(() => fail(new Error("Microphone did not stop cleanly. Try again.")), 1500);
  }
  return { start, release, cancel };
}
