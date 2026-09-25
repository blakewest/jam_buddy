import { createPatternState, INSTRUMENTS } from "../pattern/state.js";
import type { PatternState, Instrument } from "../pattern/state.js";
import { validSelection } from "../pattern/selection.js";
import type { BeatSelection } from "../pattern/selection.js";
import type { Transcript } from "../../services/transcription.js";

// Engineering limits for a short demo, not media format limits.
export const MAX_DEMO_MS = 10 * 60 * 1000;
export const MAX_DEMO_BYTES = 128 * 1024 * 1024;
export type EmbeddedAudio = { mime_type: string; base64: string };
export type DemoActivity = { request: string; steps: string[]; actions: string[]; details: unknown };
export type DemoView = {
  state: PatternState; pending_state: PatternState | null; selection: BeatSelection | null;
  activity: DemoActivity[]; request: string; request_status: string; playback_status: string;
  playing: boolean; volume: number; capturing: boolean;
};
export type DemoTake = { id: string; at_ms: number; duration_ms: number; audio: EmbeddedAudio; transcript?: Transcript; metadata?: unknown };
export type DemoCall = { at_ms: number; path: string; status: number; request: unknown; response: unknown };
export type DemoRecording = {
  version: 1; created_at: string; duration_ms: number; audio: EmbeddedAudio;
  frames: { at_ms: number; view: DemoView }[];
  hits: { at_ms: number; instrument: Instrument }[];
  takes: DemoTake[]; calls: DemoCall[];
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 32768) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  return btoa(chunks.join(""));
}
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

export class DemoJournal {
  readonly frames: DemoRecording["frames"];
  readonly hits: DemoRecording["hits"] = [];
  readonly takes: DemoTake[] = [];
  readonly calls: DemoCall[] = [];
  readonly createdAt = new Date().toISOString();
  private previousView: string;
  private bytes = 0;
  private reserve(change: number) {
    if (this.bytes + change > MAX_DEMO_BYTES * .75) throw new Error("Demo data limit reached. Finish and download this recording.");
    this.bytes += change;
  }
  constructor(view: DemoView, private readonly startedAt: number) {
    this.previousView = JSON.stringify(view);
    this.frames = [{ at_ms: 0, view: clone(view) }];
    this.reserve(this.previousView.length);
  }
  elapsed(now: number) { return Math.max(0, now - this.startedAt); }
  view(view: DemoView, now: number) {
    const serialized = JSON.stringify(view);
    if (serialized === this.previousView) return;
    if (this.frames.length >= 2000) throw new Error("Demo reached its screen-change limit. Finish this recording.");
    this.reserve(serialized.length);
    this.previousView = serialized;
    this.frames.push({ at_ms: this.elapsed(now), view: JSON.parse(serialized) });
  }
  hit(instrument: Instrument, now: number) {
    if (this.hits.length >= 24000) throw new Error("Demo reached its hit limit. Finish this recording.");
    this.hits.push({ at_ms: this.elapsed(now), instrument });
  }
  take(take: DemoTake) {
    const index = this.takes.findIndex(item => item.id === take.id);
    this.reserve(JSON.stringify(take).length - (index >= 0 ? JSON.stringify(this.takes[index]).length : 0));
    if (index >= 0) this.takes[index] = clone(take);
    else {
      if (this.takes.length >= 100) throw new Error("Demo reached 100 voice takes. Finish this recording.");
      this.takes.push(clone(take));
    }
  }
  call(call: DemoCall) {
    if (this.calls.length >= 1000) throw new Error("Demo reached its response limit. Finish this recording.");
    this.reserve(JSON.stringify(call).length);
    this.calls.push(clone(call));
  }
  finish(audio: EmbeddedAudio, now: number): DemoRecording {
    return clone({ version: 1, created_at: this.createdAt, duration_ms: this.elapsed(now), audio, frames: this.frames, hits: this.hits, takes: this.takes, calls: this.calls });
  }
}

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 10000;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every(text);
function validAudio(value: unknown): value is EmbeddedAudio {
  return record(value) && /^audio\/(webm|ogg|mp4|wav)(;codecs=[a-zA-Z0-9.,-]+)?$/.test(value.mime_type)
    && typeof value.base64 === "string" && value.base64.length > 0 && value.base64.length <= MAX_DEMO_BYTES
    && value.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64);
}
function validState(value: unknown): value is PatternState {
  if (!record(value) || !record(value.pattern) || !Array.isArray(value.pattern.notes) || value.pattern.notes.length > 512 || !bounded(value.tempo_bpm, 30, 360)) return false;
  const restored = createPatternState(value);
  const pattern = value.pattern;
  return ["bars", "swing_percent", "ticks_per_quarter", "kit_id"].every(key => pattern[key] === restored.pattern[key as keyof typeof restored.pattern])
    && pattern.meter?.numerator === restored.pattern.meter.numerator && pattern.meter?.denominator === restored.pattern.meter.denominator
    && pattern.notes.length === restored.pattern.notes.length
    && pattern.notes.every((note: any, index: number) => typeof note.id === "string"
      && (["id", "instrument", "bar", "tick", "velocity", "midi_pitch"] as const).every(key => note[key] === restored.pattern.notes[index][key]))
    && Array.isArray(value.undo_history) && value.undo_history.length <= 20;
}
function validView(value: unknown): value is DemoView {
  return record(value) && validState(value.state) && (value.pending_state === null || validState(value.pending_state))
    && (value.selection === null || validSelection(value.selection, (value.pending_state ?? value.state).pattern))
    && Array.isArray(value.activity) && value.activity.length <= 50
    && value.activity.every((row: unknown) => record(row) && text(row.request) && strings(row.steps) && strings(row.actions))
    && text(value.request) && text(value.request_status) && text(value.playback_status)
    && typeof value.playing === "boolean" && typeof value.capturing === "boolean" && bounded(value.volume, 0, 1);
}

export function parseDemo(serialized: string): DemoRecording {
  try {
    if (serialized.length > MAX_DEMO_BYTES) throw new Error();
    const file = JSON.parse(serialized);
    if (!record(file) || file.version !== 1 || !text(file.created_at) || !bounded(file.duration_ms, 1, MAX_DEMO_MS + 30000) || !validAudio(file.audio)) throw new Error();
    const timed = (items: unknown, maximum: number, validate: (item: any) => boolean) => Array.isArray(items) && items.length <= maximum
      && items.every((item, index) => record(item) && bounded(item.at_ms, 0, file.duration_ms)
        && (index === 0 || item.at_ms >= items[index - 1].at_ms) && validate(item));
    if (!timed(file.frames, 2000, item => validView(item.view)) || !file.frames.length || file.frames[0].at_ms !== 0
      || !timed(file.hits, 24000, item => INSTRUMENTS.includes(item.instrument))
      || !timed(file.takes, 100, item => text(item.id) && validAudio(item.audio) && bounded(item.duration_ms, 0, 30000)
        && item.at_ms + item.duration_ms <= file.duration_ms + 1 && (!item.transcript || (text(item.transcript.text) && Array.isArray(item.transcript.words))))
      || !timed(file.calls, 1000, item => typeof item.path === "string" && item.path.startsWith("/api/") && bounded(item.status, 0, 599))) throw new Error();
    return file as DemoRecording;
  } catch { throw new Error("Invalid or unsupported demo file. Load a demo downloaded from this app (up to 128 MB)."); }
}

export class DemoTimeline {
  private frame = 0;
  private hit = 0;
  private previous = -1;
  constructor(readonly recording: DemoRecording) {}
  advance(elapsedMs: number) {
    if (elapsedMs < this.previous) { this.frame = 0; this.hit = 0; }
    this.previous = elapsedMs;
    const { frames, hits, takes } = this.recording;
    while (this.frame + 1 < frames.length && frames[this.frame + 1].at_ms <= elapsedMs) this.frame++;
    const due: Instrument[] = [];
    while (this.hit < hits.length && hits[this.hit].at_ms <= elapsedMs) due.push(hits[this.hit++].instrument);
    const take = takes.find(item => item.at_ms <= elapsedMs && elapsedMs < item.at_ms + item.duration_ms + 700);
    return { view: frames[this.frame].view, hits: due, caption: take?.transcript?.text ?? "" };
  }
}
