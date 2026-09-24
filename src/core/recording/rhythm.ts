import { ticksPerBar } from "../pattern/musical-time.js";
import type { Meter } from "../pattern/musical-time.js";
import { appendHistory, createPatternState } from "../pattern/state.js";
import type { Instrument, Pattern, PatternState, PatternNote, PatternChange } from "../pattern/state.js";
import type { CommandResult } from "../pattern/request-tree.js";
import { correctedContextTime } from "./capture.js";
import type { TransportSnapshot } from "./capture.js";
export type TimingCandidate = { tempo_bpm: number; grid_error: number; uncertain: boolean; musical?: ReturnType<typeof scoreInterpretation> };
export type RhythmHit = { onset_seconds: number; instrument: string };
export type MappingOptions = { hits: RhythmHit[]; start_context_seconds: number; transport: TransportSnapshot; mode: "add" | "replace"; tempo_bpm: number; start_seconds: number; rotation_slots: number; instrument: "automatic" | Instrument };
export type MappedRecording = { notes: Omit<PatternNote, "id">[]; bars: number; tempo_bpm: number; mode: "add" | "replace"; meter?: Meter };
const wrap = (value: number, length: number) => ((value % length) + length) % length;

// Compare musical values, independent of object-property insertion order.
export function recordingStateKey(state: PatternState): string {
  const pattern = state.pattern;
  return JSON.stringify([
    state.tempo_bpm, pattern.bars, pattern.meter.numerator, pattern.meter.denominator,
    pattern.ticks_per_quarter, pattern.kit_id, pattern.swing_percent ?? 50,
    pattern.notes.map(note => [note.id, note.instrument, note.bar, note.tick, note.velocity, note.midi_pitch]),
  ]);
}

export function assertRecordingCurrent(current: PatternState, before: PatternState, appliedStateKey?: string): void {
  if (recordingStateKey(current) !== (appliedStateKey ?? recordingStateKey(before))) {
    throw new Error("The beat changed after this take. Record the rhythm again against the current beat; your newer edits were kept.");
  }
}
// Soft engineering priors, not rules of music. Timing fit dominates their
// combined maximum bonus; these never create, delete, or move observed hits.
export function scoreInterpretation(hits: RhythmHit[], tempo: number, gridError: number) {
  const positions = hits.map(hit => Math.round((hit.onset_seconds - hits[0].onset_seconds) * tempo / 15));
  const bars = positions.length ? Math.floor(Math.max(...positions) / 16) + 1 : 0;
  const cells = Array.from({ length: bars }, () => new Set<string>());
  hits.forEach((hit, i) => cells[Math.floor(positions[i] / 16)].add(`${hit.instrument}:${positions[i] % 16}`));
  let repeated = 0;
  for (let i = 1; i < cells.length; i++) {
    const union = new Set([...cells[i - 1], ...cells[i]]);
    repeated += [...cells[i]].filter(cell => cells[i - 1].has(cell)).length / Math.max(1, union.size);
  }
  const repeated_bars = bars > 1 ? repeated / (bars - 1) : 0;
  const kick_on_one = bars ? cells.filter(bar => bar.has("kick:0")).length / bars : 0;
  const gaps = positions.slice(1).map((position, i) => position - positions[i]).filter(gap => gap > 0);
  const seam = bars * 16 - (positions.at(-1) ?? 0);
  // A clean seam resembles an interval already played, rather than inventing
  // a long empty tail just to fill the last bar. Silence may still be intended.
  const loop_gap_fit = gaps.length ? Math.max(0, 1 - Math.min(...gaps.map(gap => Math.abs(seam - gap) / Math.max(seam, gap)))) : 0;
  const score = -gridError + 0.012 * repeated_bars + 0.004 * kick_on_one + 0.006 * loop_gap_fit;
  return { score, bars, repeated_bars, kick_on_one, loop_gap_fit };
}
export function tempoCandidates(onsets: number[], currentTempo: number): TimingCandidate[] {
  if (onsets.length < 3) return [{ tempo_bpm: currentTempo, grid_error: 0, uncertain: true }];
  // Demo engineering choices: tolerate up to 20% suspect attacks and give
  // eighth-note interpretations a small preference over unnecessary sixteenths.
  // This is a prior, not proof of the performer's intended beat.
  const evaluate = (bpm: number) => {
    const errors = onsets.map(time => {
      const position = (time - onsets[0]) * bpm / 15;
      const nearest = Math.round(position);
      return { error: (position - nearest) ** 2, cost: (position - nearest) ** 2 + (Math.abs(nearest) % 2) * 0.04 };
    }).sort((a, b) => a.cost - b.cost);
    const retained = errors.slice(0, Math.ceil(errors.length * 0.8));
    return { tempo_bpm: bpm, grid_error: retained.reduce((sum, item) => sum + item.error, 0) / retained.length,
      cost: retained.reduce((sum, item) => sum + item.cost, 0) / retained.length, uncertain: false };
  };
  const candidates = Array.from({ length: 121 }, (_, index) => evaluate(index + 60));
  const compare = (a: ReturnType<typeof evaluate>, b: ReturnType<typeof evaluate>) => Math.abs(a.cost - b.cost) > 1e-6
    ? a.cost - b.cost : Math.abs(a.tempo_bpm - currentTempo) - Math.abs(b.tempo_bpm - currentTempo);
  const ranked = [...candidates].sort(compare);
  const best = ranked[0];
  // Keep a distinct local minimum, not just half/double of the winner.
  const alternative = candidates.filter((candidate, index) =>
    Math.abs(candidate.tempo_bpm / best.tempo_bpm - 1) > 0.08
    && candidate.cost <= (candidates[index - 1]?.cost ?? Infinity)
    && candidate.cost <= (candidates[index + 1]?.cost ?? Infinity)).sort(compare)[0];
  const wanted = [best.tempo_bpm, alternative?.tempo_bpm, currentTempo, best.tempo_bpm / 2, best.tempo_bpm * 2];
  const ambiguous = !!alternative && alternative.cost - best.cost < 0.02;
  return [...new Set(wanted)].filter((bpm): bpm is number => bpm !== undefined && bpm >= 60 && bpm <= 180).slice(0, 4).map(bpm => {
    const { cost, ...candidate } = evaluate(bpm);
    return { ...candidate, uncertain: ambiguous };
  });
}
export function mapRecording(options: MappingOptions): MappedRecording {
  const { transport, mode, start_context_seconds, start_seconds, instrument } = options;
  const hits = options.hits.filter(hit => hit.onset_seconds >= start_seconds);
  if (!hits.length) throw new Error("No demonstrated hits after the selected start.");
  const tempo = transport.playing || mode === "add" ? transport.tempo_bpm : options.tempo_bpm;
  if (!Number.isFinite(tempo) || tempo < 30 || tempo > 360 || !Number.isFinite(start_seconds) || !Number.isInteger(options.rotation_slots)) throw new Error("Invalid rhythm controls.");
  const meter = transport.playing || mode === "add" ? transport.meter ?? { numerator: 4, denominator: 4 } : { numerator: 4, denominator: 4 };
  const slotsPerBar = ticksPerBar(meter) / 240;
  const positions = hits.map(hit => Math.round((transport.playing
    ? correctedContextTime(start_context_seconds, hit.onset_seconds, transport.output_latency_seconds, transport.input_correction_ms) - transport.origin_context_seconds
    : hit.onset_seconds - hits[0].onset_seconds) * tempo / 15));
  const bars = transport.playing || mode === "add" ? transport.bars : Math.floor(Math.max(...positions) / slotsPerBar) + 1;
  if (!transport.playing && mode === "replace" && bars > 4) throw new Error("Demonstration exceeds four bars. Choose a later start or record a shorter take.");
  const cells = new Set<string>();
  const notes: MappedRecording["notes"] = [];
  hits.forEach((hit, index) => {
    const position = wrap(positions[index] + options.rotation_slots, bars * slotsPerBar);
    const kind = instrument === "automatic" ? hit.instrument : instrument;
    if (!["kick", "snare", "closed_hat", "open_hat"].includes(kind)) throw new Error("Invalid hit instrument.");
    const key = `${kind}:${position}`;
    if (cells.has(key)) return;
    cells.add(key);
    notes.push({ instrument: kind as Instrument, bar: Math.floor(position / slotsPerBar) + 1, tick: (position % slotsPerBar) * 240, velocity: 64 });
  });
  return { notes, bars, tempo_bpm: tempo, mode, meter };
}
export function applyRecording(before: PatternState, mapped: MappedRecording, takeId: string, request: string): CommandResult {
  const state = createPatternState(before);
  const changes: PatternChange[] = [];
  const notes = mapped.mode === "replace" ? [] : [...state.pattern.notes];
  if (mapped.mode === "replace") changes.push({ kind: "reset" });
  const ids: string[] = [];
  for (const note of mapped.notes) {
    const existing = notes.find(item => item.instrument === note.instrument && item.bar === note.bar && item.tick === note.tick);
    if (existing) continue;
    const after = { ...note, id: `note_${state.next_note_id++}` };
    notes.push(after); ids.push(after.id); changes.push({ kind: "add", after, note_id: after.id });
  }
  const history = { request: request.slice(0, 500), applied_changes: [`${mapped.mode === "replace" ? "Replaced pattern with" : "Added"} recorded take: ${mapped.notes.length} cells, ${mapped.tempo_bpm} BPM.`], rejected_changes: [] };
  state.pattern = { ...state.pattern, notes, bars: mapped.bars, meter: mapped.meter ?? state.pattern.meter };
  state.tempo_bpm = mapped.tempo_bpm;
  state.recent_take = { id: takeId, note_ids: ids.slice(0, 256) };
  return { state: appendHistory(state, history), result: { applied_changes: changes, rejected_changes: [], ignored_changes: [], candidates: [], history_entry: history }, plan: null, passes: [], model: null, usage: {}, latency_ms: 0, question_count: 0 };
}

export function recordingDelta(before: Pattern, after: Pattern, beforeBpm?: number, afterBpm?: number): PatternChange[] {
  const changes: PatternChange[] = [];
  for (const note of before.notes) {
    const next = after.notes.find(item => item.id === note.id);
    if (!next) changes.push({ kind: "remove", before: note, note_id: note.id });
    else if (JSON.stringify(note) !== JSON.stringify(next)) changes.push({ kind: "modify", before: note, after: next, note_id: note.id });
  }
  for (const note of after.notes) if (!before.notes.some(item => item.id === note.id)) changes.push({ kind: "add", after: note, note_id: note.id });
  if (before.bars !== after.bars) changes.push({ kind: "resize", before_bars: before.bars, after_bars: after.bars, removed_notes: before.notes.filter(note => note.bar > after.bars).length });
  if (beforeBpm !== undefined && afterBpm !== undefined && beforeBpm !== afterBpm) changes.push({ kind: "tempo", before_bpm: beforeBpm, after_bpm: afterBpm });
  return changes;
}
