# Jam Partner experiments

Local browser experiments for TypeSafe-powered musical interaction, with a groove audition library. No keyboard or microphone is needed.

## Run

Requires Node.js 22.20 or newer. From this folder:

```sh
npm install
npm start
```

Open either page in Chrome:

- http://127.0.0.1:3210/ — real-time MIDI fixture and start/stop timing test.
- http://127.0.0.1:3210/pattern.html — stateful one-to-eight-bar drum pattern builder.
- http://127.0.0.1:3210/presets.html — audition 50 original source-audio clips and mark favorites locally.

Copy `.env.example` to `.env`, add `TYPESAFE_API_KEY`, then start the server. The key never reaches the browser. TypeScript and Node type definitions are development dependencies; there are no runtime npm dependencies.

`npm start` builds the TypeScript source and copies static assets into `dist/`. You can also check, build, and run separately:

```sh
npm run typecheck
npm run build
node --env-file=.env dist/server.js
```

## Project layout

- `src/ai/` defines the TypeSafe questions.
- `src/core/` contains pure timing and pattern logic shared by the browser and tests.
- `src/frontend/` contains the two browser demos, shared UI helpers, and drum samples.
- `src/services/` contains the local HTTP server and TypeSafe proxy.
- `test/` contains the automated tests.

The root `server.ts` only starts the HTTP service.

Use wired headphones and keep the tab visible. Hiding the tab ends the run so browser suspension does not contaminate timing results.

## Pattern builder

Regular rhythm fills use a separate `fill_rhythm` branch. Try `16ths on the hi-hats`, `16th hats on beat 2`, or `do it on beats 2, 3 and 4 as well`. One interpretation call selects the drum, quarter/eighth/sixteenth spacing, beat/bar scope and new-note velocity. Code fills and verifies every missing position in one undoable change. Existing notes and velocities are preserved, including human timing within a 60-tick engineering tolerance; `the rest of the bar` fills missing positions without duplicating completed beats.

Eighth-note swing applies across the whole groove. Try `Add a little swing` (55%), `No, swing it harder` (+10 points, up to 85%), `Less swing` (−10 points, down to 50%), or `Remove swing` (50%, original timing). From straight timing, an increase starts at 55%. These amounts are product defaults. The current amount appears in the transport; changes take effect at the next loop boundary and support saving and undo. Original note ticks and velocities stay intact: playback stretches the first eighth and compresses the second, including intervening notes, without quantizing. Loading a new preset resets added swing; any swing already performed in its source notes remains.

The pattern builder starts with an empty 4/4 bar at 120 BPM and can expand to eight bars. Type a request such as `Give me a simple backbeat`, `Load a laid-back hip-hop beat`, or `Add a snare on beat 2`. Loading a preset replaces the current beat and sets its source tempo. The transport can then change it from 40–240 BPM.

Every request first passes through one small TypeSafe routing question. The deterministic request tree separates editing, preset loading, clearing, shuffling, kit changes, undo, and unsupported requests. Clearing executes locally. Shuffling excludes the current preset and retains the previous search filters for requests like `No, something else`. Unsupported guidance comes from the registered capabilities.

Relative velocity edits first use one structured interpretation call for operation, instrument, beats, bars, and subdivisions. Code then changes every matching note once. Other edits use a planning call for phrase length, involved instruments, and zero through eight atomic operations. Large patterns narrow by instrument/bar and then target note or addition before detailed questions are built. Each atomic pass sees the preceding result; a no-edit response stops early. Every API call is checked against question, choice, and context-size budgets. Collisions are rejected and shown in the inspector. While the loop plays, the final accepted pattern begins at the next phrase boundary; clearing stops it immediately.

The current request is authoritative. The structured velocity interpreter sees no old history. The atomic planner includes recent history only to resolve references such as “that” or “again.” Jev sees nine drum lanes; source pitch articulations remain in playback state. Atomic requests can make at most eight changes, while structured velocity edits can affect all matching notes. The raw inspector records each step and visible history keeps one row per request.

Patterns use 960 ticks per quarter note, preserve human timing and MIDI velocity (1–127), and support straight eighths, straight sixteenths, eighth-note triplets, and sixteenth-note triplets for editing. Playback uses a CC0 Virtuosity Drums subset with articulation-specific samples and velocity layers, loaded only as needed. Some source pitches use nearby articulations, documented in the kit manifest. Closing/pedal hats choke open hats. Pattern state and raw request/response history remain in browser IndexedDB and survive reloads.

The active catalog is exactly the ten approved source grooves plus the locally authored Simple Backbeat, all in 4/4. Jev chooses among matching presets using genre, feel, meter, tags, source tempo, and descriptions. Legacy demo presets are not selectable. Imported phrases retain up to eight source bars; audition clips play original audio, while the beat maker renders the matching MIDI with its own kit, so their timbres differ.

The approved shortlist is recorded in `CURATED_GROOVE_IDS` in `src/core/pattern/audition-grooves.ts`. Later Keep/Reject changes on the audition page are local browser preferences, not automatic changes to the active catalog. The bundled previews total about 140 MB but load only when played; the articulation kit totals about 23 MB. Asset sources and licenses are in `src/frontend/assets/ATTRIBUTION.md`.

The kit selector or requests like `Use the 808` switch between Acoustic, 808, and TR-505 without changing notes. The electronic packs contain kick, snare, and two hat voices; other lanes retain acoustic sounds. Electronic voices use gain-scaled single samples rather than acoustic articulation/velocity layers. Undo restores the last accepted request as one unit, including its kit, tempo, and preset context. Stop and New session cancel pending requests and sample loads.

To regenerate imported MIDI modules, first run `npm run build`, then `node tools/build-gmd-presets.mjs SELECTED_MIDI_DIR CURATED_MIDI_DIR` with the source MIDI directories. The generated files are TypeScript; build again afterward.

## Modes

- **Mock:** 60 seconds, local deterministic decisions, no API calls. Confirms the fixture and audio scheduler work.
- **Live:** Same fixture and playback; TypeSafe selects `start_next_bar`, `stop`, or `keep_current`.
- **Replay:** Replays the most recent saved or imported run using its accepted actions. Makes no API calls. Displayed request metrics belong to the original run.

Each 16-second phrase contains four seconds of rest, eight seconds of piano chords, then four seconds of rest. It repeats at 120 BPM in 4/4. Drum sounds and piano-like tones are synthesized locally. This is a timing test, not a realistic instrument library.

A fresh browser can replay the measured Live run saved in `recordings/live-60s.json`, when that local file is present. The browser saves the most recent completed Mock or Live run in IndexedDB. Download JSON to retain multiple runs; import a recording to replay after reloading or in another browser. Live replaces the previous saved run, so download first if needed. Recordings contain fixture state and API responses, never credentials.

## What Jev receives

Only the last 10 seconds / latest 500 MIDI events, local `silent_for_ms`, current drum status, and whether a start is scheduled. Note releases and sustain pedal affect silence calculations. Session IDs, current time, tempo, and next-bar deadlines stay local.

The explicit test rule is: join on the next bar after playing begins; stop after one second with no active/sustained notes; otherwise preserve the current state. `src/ai/timing-question.ts` contains the exact question. The TypeSafe model is `jev-latest`; each response's actual model identifier is recorded.

Snapshots are attempted every 100 ms, with one request in flight. Busy ticks are skipped; old states are never queued. Each request has a two-second timeout and no automatic retry of that snapshot. Errors use a fresh snapshot after backoff; rate-limit headers are respected. Invalid credentials or missing configuration end the Live run.

The local audio scheduler runs every 25 ms and schedules 100 ms ahead. A start decision uses the next-bar timestamp computed when that request was sent. If fewer than 100 ms remain, it is rejected as a missed deadline. Playback continues independently of API calls.

## Measurements

The UI reports median, 95th percentile, worst, and first-call request round-trip duration; counts errors separately; and shows skipped/busy ticks, backoff ticks, start deadlines, and agreement with the explicit policy. Select a log row for exact state and response data.

Snapshot age is time from input snapshot to response. Action delay includes any intentional wait until the next bar; it is not pure API latency. Software scheduler lateness counts hits whose intended time passed before scheduling. It does not measure actual speaker latency, audible glitches, or physical keyboard latency. AudioContext latency values in recordings are browser estimates.

## Checks

```sh
npm test
```

Automated tests use fake API responses and no credentials. They cover pattern arbitration, reset confidence, collisions, dynamic question generation, sample timing, causal fixture delivery, proxy boundaries, single-request concurrency, and replay.

Implementation references: [TypeSafe API](https://docs.typesafe.ai/api), [Web Audio sequencing](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques).

## Measured result — September 17, 2026

One 60-second Live run on this Mac, headless Chrome 153, Node 26.7, model `jev-1.13.0`, one request in flight. No separate API warmup; first call reported below. State request bodies ranged from 113 to 5,777 bytes (the server also adds the fixed question). A Mock run preceded Live to exercise local audio. These are observations from one run, not service guarantees.

| Measurement | Result |
| --- | --- |
| Completed responses | 281 (about 4.7 per second) |
| Median round trip | 137 ms |
| 95th percentile | 266 ms |
| Worst round trip | 742 ms |
| First call | 243 ms |
| Responses at or below 100 ms | 41 / 281 (14.6%) |
| Errors | 0 |
| Accepted starts / missed start deadlines | 4 / 0 |
| Agreement with the explicit policy | 100% |
| Busy polling ticks skipped | 317 |
| Aborted request at run end | 1 |
| Late hits reported by local scheduler | 0 |

Excluding the first call leaves the median and 95th percentile effectively unchanged. Bar-aligned starts succeeded even though this setup did not sustain ten decisions per second. The browser's generated output had a measurable nonzero audio signal. This does not establish audible quality, speaker timing, microphone performance, or real keyboard responsiveness.

The 60-second Replay run completed with zero API calls and no JavaScript errors. Both desktop and mobile layouts were checked; the mobile page had no horizontal overflow.

Local recordings and browser verification artifacts are in the gitignored `recordings/` folder.

### Record a rhythm

Run with Node 22.20+ and `npm start`, then open the pattern builder. Keep
`TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` in the project's ignored `.env`.
Transcription uses OpenRouter's `openai/whisper-1` with word timestamps;
Jev continues to use TypeSafe. Keys stay on the local server.

Use headphones. With Bluetooth earbuds, select the computer's built-in microphone
as input to avoid switching the earbuds into lower-quality microphone mode.
Hold **Hold to record** with a pointer, or focus it and
hold Space/Enter. Wait for **Recording…**, optionally speak an instruction,
beatbox, then release. Escape, lost focus, or a disconnected microphone cancels.
Permission is requested on first use; releasing before permission/setup finishes
cancels the take. Takes stop at 30 seconds.

Playback continues during recording and processing. Pattern and transport changes
are locked until processing ends. Successful changes apply automatically, at the
next available beat for note/velocity edits, or the next phrase for whole-pattern
replacements and timing changes. Already scheduled audio is preserved, so a beat
inside the scheduling lookahead may be skipped. Undo restores the whole change.
Say “those should be hi-hats” to correct the last take's instrument labels.

Input timing correction moves captured hits earlier when positive; adjust it for
your interface. Output latency is accounted for separately from scheduling
lookahead. During playback, tempo and phrase length stay fixed. Stopped replacement
takes infer tempo between 60–180 BPM and anchor their first hit to beat one.
Fewer than three hits retain the current tempo. Addition retains the existing
tempo and phrase. Replacement rejects takes longer than four bars.

Use the take controls to adjust the demonstration start, tempo (including
half/double), or bar-start rotation, then **Apply adjustment**. Start adjustment is
also offered when speech and beatboxing cannot be separated confidently. A failed
take stays in memory for **Retry take**. Speech retries use the current beat;
applying an old rhythm or adjusting it rejects a changed base to protect newer
edits. Raw audio is never saved automatically. **Export diagnostic
WAV + JSON** downloads the latest take and its timing/analysis details. Reloading
or starting a new session discards it.

The detector uses local volume, spectral balance and attack-shape heuristics,
not a trained classifier. Settings in `src/core/recording/analysis.ts` are demo
engineering choices. Speaker echo rejection, Bluetooth latency calibration,
continuous listening and generated speech are not supported. Whisper may
transcribe beatbox syllables; timestamps are evidence, not a reason to discard
all transcribed audio. Real-voice accuracy and release-to-result latency have
not yet been measured; synthetic tests do not establish those results.
