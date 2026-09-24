// Only copy mono input here. Analysis and encoding run after release on the main thread.
class TakeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = true;
    this.count = 0;
    this.originTime = null;
    this.port.onmessage = event => {
      if (event.data === "stop") { this.active = false; this.port.postMessage({ done: true }); }
    };
  }
  process(inputs, outputs) {
    if (!this.active) return false;
    const channels = inputs[0] ?? [];
    if (this.originTime === null) {
      if (!channels.length) return true;
      this.originTime = currentFrame / sampleRate;
    }
    const blockLength = channels[0]?.length ?? outputs[0]?.[0]?.length ?? 0;
    const length = Math.min(blockLength, sampleRate * 30 - this.count);
    if (!length) return true;
    const samples = new Float32Array(length);
    for (const channel of channels) for (let i = 0; i < length; i++) samples[i] += channel[i] / channels.length;
    // Anchor once, then use the sample stream as the recording clock. Reading
    // render timestamps per block can expose startup clock discontinuities.
    const time = this.originTime + this.count / sampleRate;
    this.count += length;
    this.port.postMessage({ time, samples }, [samples.buffer]);
    if (this.count >= sampleRate * 30) { this.active = false; this.port.postMessage({ done: true }); }
    return this.active;
  }
}
registerProcessor("take-capture", TakeCapture);
