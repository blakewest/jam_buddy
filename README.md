# Jam Partner experiments

Two local browser experiments for TypeSafe-powered musical interaction. No keyboard or microphone is needed.

## Run

Requires Node.js 22.20 or newer. From this folder:

```sh
npm install
npm start
```

Open either page in Chrome:

- http://127.0.0.1:3210/ — real-time MIDI fixture and start/stop timing test.
- http://127.0.0.1:3210/pattern.html — stateful one-to-four-bar drum pattern builder.

Copy `.env.example` to `.env`, add `TYPESAFE_API_KEY`, then start the server. The key never reaches the browser. TypeScript and Node type definitions are development dependencies; there are no runtime npm dependencies.

`npm start` builds the TypeScript source and copies static assets into `dist/`. To build or type-check separately:

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

The root `server.ts` only starts the HTTP service. All source and tests use `.ts`; strict type-checking runs during the build. Imports use `.js` paths to match the compiled output. Generated `dist/` files are ignored by Git.

Use wired headphones and keep the tab visible. Hiding the tab ends the run so browser suspension does not contaminate timing results.

## Pattern builder

The pattern builder starts with an empty 16-step bar at 120 BPM and can expand to four bars. Type a request such as `I want a 4 bar phrase`, `Give me a simple backbeat`, or `Add a snare on beat 2 of bar 4`. Jev receives the current pattern, the request, and the newest eight history entries.

Each request starts with a planning call that chooses the phrase length, identifies the involved instruments, and estimates zero through eight atomic note operations. The app then generates edit questions only for those instruments and runs at most the estimated number of sequential passes. Each pass sees the pattern produced by the prior pass and applies at most one change. A no-edit response stops the sequence early. Whole-pattern reset requires at least 90% confidence. Collisions are rejected and shown in the inspector. While the loop plays, the final accepted pattern begins at the next phrase boundary.

The current request is authoritative. Recent history is included only to resolve references such as “that” or “again,” so an older request cannot act as a competing instruction. Jev sees the loop grouped into kick, snare, closed-hat, and open-hat parts plus reference definitions for eighth notes, four-on-the-floor, and a backbeat. One request can make at most eight note changes; the raw inspector records every pass while the visible history keeps one row for the request.

Choose Acoustic, 808, or TR-505 with the Kit selector, or ask “Use the 808,” “Switch to the 505,” “Back to acoustic,” or “Swap the kit for something more modern.” The selector makes no API call. Kit swaps preserve every note and velocity, load all required samples first, and take effect at the next phrase boundary during playback. Swapping while stopped stays stopped. The saved kit survives reload; old sessions default to Acoustic. Clear pattern keeps the kit; New session restores Acoustic.

Every text request starts at `REQUEST_TREE.root` in `src/core/pattern/request-tree.ts`. Its children are `edit_pattern`, `change_kit`, `undo`, and `unsupported`; each child registers its own execution function. `REQUEST_QUESTIONS` in `src/ai/request-questions.ts` contains only the AI question builders used by decision branches. Only the editing branch uses the existing note planner and atomic edit loop. The kit branch gets the current kit and bounded history, without note data. Generic “more modern/electronic” from Acoustic favors 808 as a demo preference. Explicit unavailable kits, effects, individual sound replacement, and requests mixing kit and note changes return guidance without partial changes. Stop and New session cancel in-flight requests. The inspector records routing choices and includes their API usage.

Ask “Undo that” or click Undo to reverse the last completed change. All edit passes from one request form one undo unit; kit swaps and Clear pattern are also undoable. The last 20 units survive reloads. Failed requests and no-ops do not consume a slot, and undo during playback takes effect at the next phrase boundary. New session clears undo history. Changes made before undo was added have no saved snapshot; redo is not supported.

The page uses kick, snare, closed hi-hat, and open hi-hat sounds. Acoustic uses the public-domain Open Source Drumkit with five recorded velocity layers. The auditioned 808 and TR-505 each use one sample per instrument and five gain levels; these levels and kit balance are engineering choices. The 808 assets are AAC-derived preview samples decoded to WAV, not original lossless recordings. See `src/frontend/assets/ATTRIBUTION.md` for sources. Closed hats choke open hats. Pattern state and raw request/response history remain in browser IndexedDB and survive reloads. `Clear pattern` is local and makes no API call; `New session` clears the pattern and its history. Input remains text-based; hold-to-talk is planned separately.

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
