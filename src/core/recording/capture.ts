import type { Meter } from "../pattern/musical-time.js";
// Demo engineering limits, not perceptual constants.
export const MAX_TAKE_SECONDS = 30;
// Engineering tolerance for brief device-startup dropouts, not lost-audio recovery.
const MAX_CAPTURE_GAP_SECONDS = 0.25;
export type TransportSnapshot = {
  playing: boolean;
  meter?: Meter;
  tempo_bpm: number;
  bars: number;
  origin_context_seconds: number;
  captured_context_seconds: number;
  output_latency_seconds: number;
  output_context_seconds: number;
  output_performance_ms: number;
  input_correction_ms: number;
};
export type CapturedAudio = { samples: Float32Array; sample_rate: number; start_context_seconds: number };
export type RecordedTake = CapturedAudio & { id: string; release_performance_ms: number; transport: TransportSnapshot };

export class CaptureBuffer {
  private chunks: Float32Array[] = [];
  private length = 0;
  private start: number | null = null;
  constructor(readonly sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("Unsupported capture sample rate.");
  }
  get full() { return this.length >= this.sampleRate * MAX_TAKE_SECONDS; }
  append(contextSeconds: number, samples: Float32Array) {
    if (this.full) return;
    if (!Number.isFinite(contextSeconds) || samples.some(value => !Number.isFinite(value))) throw new Error("Invalid microphone samples.");
    this.start ??= contextSeconds;
    const gapSamples = Math.round((contextSeconds - this.start) * this.sampleRate) - this.length;
    if (gapSamples < -2) throw new Error(`Microphone capture overlap (${Math.round(-gapSamples / this.sampleRate * 1000)} ms); please retry.`);
    if (gapSamples > this.sampleRate * MAX_CAPTURE_GAP_SECONDS) throw new Error(`Microphone capture gap (${Math.round(gapSamples / this.sampleRate * 1000)} ms); please retry.`);
    if (gapSamples > 0) {
      // Retain real time: concatenating across a dropout would move later hits early.
      const silence = new Float32Array(Math.min(gapSamples, this.sampleRate * MAX_TAKE_SECONDS - this.length));
      this.chunks.push(silence);
      this.length += silence.length;
    }
    const chunk = samples.slice(0, this.sampleRate * MAX_TAKE_SECONDS - this.length);
    this.chunks.push(chunk);
    this.length += chunk.length;
  }
  finish(): CapturedAudio {
    if (!this.length || this.start === null) throw new Error("No audio captured. Hold until the recording indicator appears.");
    const samples = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    this.chunks = [];
    return { samples, sample_rate: this.sampleRate, start_context_seconds: this.start };
  }
}

export function correctedContextTime(startSeconds: number, onsetSeconds: number, outputLatencySeconds: number, inputCorrectionMs: number) {
  return startSeconds + onsetSeconds - outputLatencySeconds - inputCorrectionMs / 1000;
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const word = (offset: number, text: string) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  word(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); word(8, "WAVE");
  word(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767), true));
  return buffer;
}
