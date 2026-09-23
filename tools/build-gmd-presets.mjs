import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDITION_GROOVES, CURATED_GROOVE_IDS } from "../src/core/pattern/audition-grooves.js";
import { instrumentForPitch } from "../src/core/pattern/drum-pitches.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_IDS = ["drummer3/session1/10", "drummer1/session2/6", "drummer1/eval_session/2", "drummer3/session2/31"];
const SELECTED_FILES = {
  "drummer3/session1/10": "10_rock_105_beat_4-4.mid",
  "drummer1/session2/6": "6_rock_102_beat_3-4.mid",
  "drummer1/eval_session/2": "2_funk-groove2_105_beat_4-4.mid",
  "drummer3/session2/31": "31_hiphop_92_beat_4-4.mid",
};

function vlq(bytes, cursor) {
  let value = 0;
  while (true) {
    const byte = bytes[cursor.offset++];
    value = (value << 7) | (byte & 127);
    if (!(byte & 128)) return value;
  }
}

export function parseMidi(bytes, sourceBars) {
  const division = bytes.readUInt16BE(12);
  const trackStart = 14;
  if (bytes.toString("ascii", trackStart, trackStart + 4) !== "MTrk") throw new Error("Missing MIDI track.");
  const end = trackStart + 8 + bytes.readUInt32BE(trackStart + 4);
  const cursor = { offset: trackStart + 8 };
  let absolute = 0;
  let runningStatus = null;
  let meter = { numerator: 4, denominator: 4 };
  const events = [];
  while (cursor.offset < end) {
    absolute += vlq(bytes, cursor);
    let status = bytes[cursor.offset];
    if (status & 128) {
      cursor.offset++;
      runningStatus = status;
    } else status = runningStatus;
    if (status === 255) {
      const type = bytes[cursor.offset++];
      const length = vlq(bytes, cursor);
      if (type === 0x58 && length >= 2) meter = { numerator: bytes[cursor.offset], denominator: 2 ** bytes[cursor.offset + 1] };
      cursor.offset += length;
      runningStatus = null;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      cursor.offset += vlq(bytes, cursor);
      runningStatus = null;
      continue;
    }
    const command = status & 0xf0;
    const dataLength = command === 0xc0 || command === 0xd0 ? 1 : 2;
    const pitch = bytes[cursor.offset];
    const velocity = dataLength === 2 ? bytes[cursor.offset + 1] : 0;
    cursor.offset += dataLength;
    if (command === 0x90 && velocity > 0) events.push({ pitch, velocity, sourceTick: absolute });
  }
  const barTicks = division * meter.numerator * 4 / meter.denominator;
  const startTick = (sourceBars[0] - 1) * barTicks;
  const endTick = sourceBars[1] * barTicks;
  const notes = new Map();
  for (const event of events) {
    if (event.sourceTick < startTick || event.sourceTick >= endTick) continue;
    const instrument = instrumentForPitch(event.pitch);
    if (!instrument) throw new Error(`Unsupported source MIDI pitch ${event.pitch}.`);
    const relative = event.sourceTick - startTick;
    const note = { instrument, midi_pitch: event.pitch, bar: Math.floor(relative / barTicks) + 1, tick: Math.round(relative % barTicks * 960 / division), velocity: event.velocity };
    const key = `${note.midi_pitch}:${note.bar}:${note.tick}`;
    if (!notes.has(key) || notes.get(key).velocity < note.velocity) notes.set(key, note);
  }
  return { bars: sourceBars[1] - sourceBars[0] + 1, notes: [...notes.values()].sort((a, b) => a.bar - b.bar || a.tick - b.tick || a.instrument.localeCompare(b.instrument) || a.midi_pitch - b.midi_pitch) };
}

function build(ids, selectedDir, curatedDir) {
  return Object.fromEntries(ids.map(id => {
    const source = AUDITION_GROOVES.find(groove => groove.source_id === id);
    if (!source) throw new Error(`Missing catalog entry for ${id}.`);
    const filename = SELECTED_FILES[id] ?? fs.readdirSync(curatedDir).find(name => name.startsWith(`${id.replaceAll("/", "_")}_`) && name.endsWith(".mid"));
    if (!filename) throw new Error(`Missing MIDI file for ${id}.`);
    const directory = SELECTED_FILES[id] ? selectedDir : curatedDir;
    return [id, parseMidi(fs.readFileSync(path.join(directory, filename)), source.source_bars)];
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [selectedDir, curatedDir] = process.argv.slice(2);
  if (!selectedDir || !curatedDir) throw new Error("Usage: node tools/build-gmd-presets.mjs SELECTED_MIDI_DIR CURATED_MIDI_DIR");
  const write = (file, name, ids) => fs.writeFileSync(path.join(ROOT, "src/core/pattern", file), `export const ${name} = Object.freeze(${JSON.stringify(build(ids, selectedDir, curatedDir), null, 2)});\n`);
  write("gmd-presets.js", "GMD_PRESETS", BASE_IDS);
  const curatedSources = CURATED_GROOVE_IDS.map(id => AUDITION_GROOVES.find(groove => groove.id === id)?.source_id).filter(id => id && !BASE_IDS.includes(id));
  write("gmd-curated-presets.js", "GMD_CURATED_PRESETS", curatedSources);
}
