import { appendHistory, createPatternState, INSTRUMENTS } from "./state.js";
import { ticksPerBar, TICKS_PER_QUARTER, validMeter } from "./musical-time.js";
import { GMD_PRESETS } from "./gmd-presets.js";
import { GMD_CURATED_PRESETS } from "./gmd-curated-presets.js";
import { AUDITION_GROOVES, CURATED_GROOVE_IDS } from "./audition-grooves.js";
import { pitchForNote, validPitchForInstrument } from "./drum-pitches.js";

import type { Instrument, PatternNote, PatternState, PresetAttributes } from "./state.js";
import type { Meter } from "./musical-time.js";
export type Preset = { id: string; name: string; genres: readonly string[]; meter: Meter; feel: readonly string[]; tags: readonly string[]; bars: number; tempo_bpm: number; source: { kind: string; id?: string; bpm?: number; style?: string; drummer?: string; source_bars?: readonly number[]; attribution: string }; description: string; notes: readonly Omit<PatternNote, "id">[] };
const hit = (instrument: Instrument, tick: number, velocity: number, bar = 1) => ({ instrument, bar, tick, velocity });
const hats = (count: number, step: number, velocity = 62, offset = 0) => Array.from({ length: count }, (_, index) => hit("closed_hat", index * step + (index ? offset : 0), velocity + (index % 2 ? -10 : 8)));
const GMD_SOURCES = Object.freeze(Object.fromEntries(AUDITION_GROOVES.map(groove => [groove.source_id, groove])));
const AUTHORED_BPM: Readonly<Record<string, number>> = Object.freeze({
  simple_backbeat: 100,
  pop_bright: 112,
  jazz_brush: 92,
  blues_six_eight: 72,
  disco_floor: 120,
  electronic_house: 124,
  reggae_one_drop: 76,
  latin_six_eight: 100,
  punk_fast: 176,
});
const preset = (id: string, name: string, genres: string[], meter: Meter, feel: string[], authoredNotes: Omit<PatternNote, "id">[], description: string, sourceId: string | null = null): Preset => {
  const sourcePreset = sourceId ? GMD_PRESETS[sourceId] ?? GMD_CURATED_PRESETS[sourceId] : null;
  const sourceDetails = sourceId ? GMD_SOURCES[sourceId] : null;
  const notes = sourcePreset?.notes ?? authoredNotes;
  const tags = [...new Set([...genres, ...feel, ...(sourceDetails?.style.split(/[/-]/) ?? [])])];
  return Object.freeze({
  id, name, genres: Object.freeze(genres), meter: Object.freeze(meter), feel: Object.freeze(feel), tags: Object.freeze(tags), bars: sourcePreset?.bars ?? 1, tempo_bpm: sourceDetails?.bpm ?? AUTHORED_BPM[id],
  source: Object.freeze(sourceId ? { kind: "gmd", id: sourceId, bpm: sourceDetails!.bpm, style: sourceDetails!.style, drummer: sourceDetails!.drummer, source_bars: Object.freeze(sourceDetails!.source_bars), attribution: "Groove MIDI Dataset (CC BY 4.0)" } : { kind: "authored", attribution: "Jam Partner preset library" }),
  description, notes: Object.freeze(notes.map(note => Object.freeze(note))),
});
};

const CURATED_DETAILS: Readonly<Record<string, { name: string; genres: string[]; feel: string[]; description: string }>> = Object.freeze({
  "drummer8/session1/16": { name: "Afrobeat 90", genres: ["afrobeat"], feel: ["syncopated", "flowing"], description: "Human-played Afrobeat groove at 90 BPM" },
  "drummer1/session2/10": { name: "Country 114", genres: ["country"], feel: ["straight", "laid_back"], description: "Human-played country groove at 114 BPM" },
  "drummer1/session3/6": { name: "Disco 120", genres: ["dance", "disco"], feel: ["driving", "bright"], description: "Human-played disco groove at 120 BPM" },
  "drummer1/session1/126": { name: "Fast Funk 125", genres: ["funk"], feel: ["fast", "syncopated"], description: "Human-played fast funk groove at 125 BPM" },
  "drummer8/session1/23": { name: "Slow Hip-Hop 70", genres: ["hiphop"], feel: ["laid_back", "heavy"], description: "Human-played hip-hop groove at 70 BPM" },
  "drummer7/session3/11": { name: "Soft Pop 83", genres: ["pop"], feel: ["laid_back", "light"], description: "Human-played soft pop groove at 83 BPM" },
  "drummer1/eval_session/9": { name: "Soul Groove 105", genres: ["soul"], feel: ["pocket", "laid_back"], description: "Human-played soul groove at 105 BPM" },
  "drummer7/session2/54": { name: "Motown Soul 148", genres: ["soul", "motown"], feel: ["driving", "bright"], description: "Human-played Motown soul groove at 148 BPM" },
});

const catalog = [
  preset("simple_backbeat", "Simple Backbeat", ["rock", "pop"], { numerator: 4, denominator: 4 }, ["simple", "straight"], [hit("kick", 0, 100), hit("kick", 1920, 100), hit("snare", 960, 104), hit("snare", 2880, 104), ...Array.from({ length: 8 }, (_, index) => hit("closed_hat", index * 480, 64))], "Basic one-bar 4/4 backbeat: kick on beats 1 and 3, snare on 2 and 4, steady eighth-note closed hats. No fills, ghost notes, or syncopation. Ideal for a simple or basic backbeat."),
  preset("rock_straight", "Straight Rock", ["rock"], { numerator: 4, denominator: 4 }, ["driving", "straight"], [hit("snare", 12, 100), hit("kick", 16, 67), hit("snare", 468, 60), hit("snare", 744, 68), hit("kick", 970, 63), hit("snare", 974, 119), hit("kick", 1950, 64), hit("snare", 1962, 116), hit("open_hat", 2012, 19), hit("snare", 2462, 112), hit("kick", 2858, 64), hit("snare", 3208, 85), hit("snare", 3726, 102)], "Driving human-played rock backbeat", "drummer3/session1/10"),
  preset("rock_waltz", "Rock Waltz", ["rock"], { numerator: 3, denominator: 4 }, ["driving", "waltz"], [hit("closed_hat", 0, 95), hit("kick", 8, 82), hit("closed_hat", 438, 67), hit("snare", 464, 29), hit("kick", 680, 90), hit("closed_hat", 918, 65), hit("snare", 964, 125), hit("closed_hat", 1398, 70), hit("kick", 1652, 52), hit("closed_hat", 1886, 57), hit("kick", 1918, 53), hit("snare", 2160, 42), hit("closed_hat", 2360, 67), hit("kick", 2598, 46), hit("closed_hat", 2838, 67), hit("kick", 2846, 95)], "Human-played rock in three", "drummer1/session2/6"),
  preset("pop_bright", "Bright Pop", ["pop"], { numerator: 4, denominator: 4 }, ["bright", "straight"], [hit("kick", 0, 108), hit("kick", 1684, 86), hit("kick", 2398, 94), hit("snare", 960, 112), hit("snare", 2882, 114), ...hats(8, 480, 68, -3)], "Clean modern pop pulse"),
  preset("funk_pocket", "Funk Pocket", ["funk", "soul"], { numerator: 4, denominator: 4 }, ["syncopated", "pocket"], [], "Downbeat-aligned human-played funk pocket", "drummer1/eval_session/2"),
  preset("jazz_brush", "Late-Night Jazz", ["jazz"], { numerator: 4, denominator: 4 }, ["swing", "light"], [hit("kick", 4, 48), hit("snare", 952, 50), hit("snare", 2870, 54), hit("closed_hat", 0, 76), hit("closed_hat", 642, 48), hit("closed_hat", 960, 70), hit("closed_hat", 1607, 46), hit("closed_hat", 1920, 76), hit("closed_hat", 2565, 48), hit("closed_hat", 2880, 70), hit("closed_hat", 3521, 48)], "Light swung jazz time"),
  preset("blues_six_eight", "Slow Blues 6/8", ["blues"], { numerator: 6, denominator: 8 }, ["shuffle", "laid_back"], [hit("kick", 0, 103), hit("kick", 1434, 84), hit("snare", 959, 111), hit("snare", 2398, 108), ...hats(6, 480, 62, 9)], "Rolling six-eight blues groove"),
  preset("disco_floor", "Disco Floor", ["disco", "dance"], { numerator: 4, denominator: 4 }, ["driving", "bright"], [hit("kick", 0, 116), hit("kick", 960, 111), hit("kick", 1920, 114), hit("kick", 2880, 112), hit("snare", 960, 110), hit("snare", 2880, 112), ...hats(8, 480, 68), hit("open_hat", 480, 90), hit("open_hat", 1440, 91), hit("open_hat", 2400, 92), hit("open_hat", 3360, 94)], "Four-on-the-floor disco beat"),
  preset("hiphop_headnod", "Hip-Hop Head Nod", ["hiphop"], { numerator: 4, denominator: 4 }, ["laid_back", "heavy"], [hit("closed_hat", 18, 127), hit("kick", 24, 127), hit("closed_hat", 492, 22), hit("snare", 996, 127), hit("closed_hat", 1442, 43), hit("closed_hat", 1898, 60), hit("open_hat", 2378, 127), hit("kick", 2388, 127), hit("snare", 2876, 127), hit("closed_hat", 2890, 110), hit("closed_hat", 3352, 122), hit("kick", 3808, 127), hit("crash", 3808, 98)], "Human-played laid-back hip-hop pocket", "drummer3/session2/31"),
  preset("electronic_house", "House Pulse", ["electronic", "dance"], { numerator: 4, denominator: 4 }, ["driving", "straight"], [hit("kick", 0, 120), hit("kick", 960, 120), hit("kick", 1920, 120), hit("kick", 2880, 120), hit("snare", 960, 104), hit("snare", 2880, 104), hit("open_hat", 480, 92), hit("open_hat", 1440, 92), hit("open_hat", 2400, 92), hit("open_hat", 3360, 92)], "Steady electronic house groove"),
  preset("reggae_one_drop", "Reggae One Drop", ["reggae"], { numerator: 4, denominator: 4 }, ["laid_back", "syncopated"], [hit("kick", 1928, 102), hit("snare", 1932, 111), hit("closed_hat", 482, 64), hit("closed_hat", 1444, 66), hit("closed_hat", 2406, 65), hit("closed_hat", 3367, 70)], "Spacious one-drop reggae beat"),
  preset("latin_six_eight", "Afro-Latin 6/8", ["latin"], { numerator: 6, denominator: 8 }, ["syncopated", "flowing"], [hit("kick", 0, 108), hit("kick", 1281, 91), hit("kick", 2238, 96), hit("snare", 962, 98), hit("snare", 2397, 104), hit("closed_hat", 0, 69), hit("closed_hat", 479, 58), hit("closed_hat", 961, 68), hit("closed_hat", 1442, 57), hit("closed_hat", 1918, 70), hit("open_hat", 2404, 78)], "Flowing Afro-Latin six-eight pulse"),
  preset("punk_fast", "Fast Punk", ["punk", "rock"], { numerator: 4, denominator: 4 }, ["fast", "driving"], [hit("kick", 0, 122), hit("kick", 480, 102), hit("kick", 1920, 118), hit("kick", 2400, 104), hit("snare", 960, 124), hit("snare", 2880, 124), ...hats(8, 480, 84)], "Urgent punk eighth-note beat"),
  ...CURATED_GROOVE_IDS.map(id => AUDITION_GROOVES.find(groove => groove.id === id)!)
    .filter(groove => GMD_CURATED_PRESETS[groove.source_id])
    .map(groove => {
      const details = CURATED_DETAILS[groove.source_id];
      const [numerator, denominator] = groove.meter.split("/").map(Number);
      return preset(groove.id, details.name, details.genres, { numerator, denominator }, details.feel, [], details.description, groove.source_id);
    }),
];

const curatedSources = new Set(CURATED_GROOVE_IDS.map(id => AUDITION_GROOVES.find(groove => groove.id === id)!.source_id));
export const PRESETS = Object.freeze(catalog.filter(item => item.id === "simple_backbeat" || curatedSources.has(item.source.id ?? "")));

export function validatePreset(item: Preset | null | undefined) {
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.genres) || !item.genres.length || !validMeter(item.meter) || !Number.isInteger(item.bars) || item.bars < 1 || item.bars > 8 || !Number.isInteger(item.tempo_bpm) || item.tempo_bpm < 40 || item.tempo_bpm > 240 || !Array.isArray(item.notes)) return false;
  const cells = new Set();
  return item.notes.every(note => {
    const cell = `${note.instrument}:${note.bar}:${note.tick}:${pitchForNote(note)}`;
    if (!INSTRUMENTS.includes(note.instrument) || !Number.isInteger(note.bar) || note.bar < 1 || note.bar > item.bars || !Number.isInteger(note.tick) || note.tick < 0 || note.tick >= ticksPerBar(item.meter) || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127 || (note.midi_pitch !== undefined && !validPitchForInstrument(note.midi_pitch, note.instrument)) || cells.has(cell)) return false;
    cells.add(cell);
    return true;
  });
}

export function filterPresets({ genres = [], meter = "unspecified", feels = [] }: PresetAttributes = {}) {
  return PRESETS.filter(item => (!genres.length || genres.some(genre => item.genres.includes(genre)))
    && (meter === "unspecified" || `${item.meter.numerator}/${item.meter.denominator}` === meter)
    && (!feels.includes("simple") || item.feel.includes("simple"))
    && (!feels.length || feels.some(feel => item.feel.includes(feel))));
}

export const presetById = (id: string) => PRESETS.find(item => item.id === id) ?? null;

export function loadPreset(inputState: PatternState, selected: Preset | null | undefined, request: string) {
  if (!selected || !validatePreset(selected)) throw new Error("Invalid preset.");
  const state = createPatternState(inputState);
  let nextId = state.next_note_id;
  const notes = selected.notes.map(note => ({ id: `note_${nextId++}`, ...note }));
  const entry = { request, applied_changes: [`Loaded ${selected.name} preset`], rejected_changes: [] };
  return appendHistory({ ...state, tempo_bpm: selected.tempo_bpm, pattern: { kit_id: state.pattern.kit_id, swing_percent: 50, ...(state.pattern.effects ? { effects: state.pattern.effects } : {}), bars: selected.bars, meter: structuredClone(selected.meter), ticks_per_quarter: TICKS_PER_QUARTER, notes }, next_note_id: nextId }, entry);
}
