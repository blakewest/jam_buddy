import { recordingQuestions, validEvidence, validateRecordingDecision } from "../core/recording/decision.js";
import { handleTranscription } from "./transcription.js";
import { createServer as httpServer } from "node:http";
import { readFile } from "node:fs/promises";
import kitManifest from "../frontend/assets/virtuosity/manifest.json" with { type: "json" };
import { TIMING_QUESTION } from "../ai/timing-question.js";
import { buildPatternQuestions, buildScopeQuestion, buildTargetQuestion, buildTargetDetails, patternSummary, buildPlanningQuestions } from "../ai/pattern-questions.js";
import { requestBudgetError } from "../ai/request-budget.js";
import { buildRhythmFillQuestions, rhythmFillContext, rhythmFillIntent } from "../ai/rhythm-fill-questions.js";
import { buildVelocityEditQuestions, velocityIntent } from "../ai/velocity-edit-questions.js";
import { ROOT_QUESTIONS } from "../ai/request-tree-questions.js";
import { attributesFromAnswers, buildPresetSelectionQuestions, PRESET_SEARCH_QUESTIONS } from "../ai/preset-questions.js";
import { ACTIONS } from "../core/timing/session.js";
import { INSTRUMENTS, MAX_BARS, MUSIC_REFERENCE } from "../core/pattern/state.js";
import { resolveRoot } from "../core/pattern/request-tree.js";
import { filterPresets, presetById } from "../core/pattern/presets.js";
import { ticksPerBar, TICKS_PER_QUARTER, validMeter } from "../core/pattern/musical-time.js";

import type { ServerResponse } from "node:http";
import type { PatternJevState, Instrument } from "../core/pattern/state.js";
import type { Questions, Answers } from "../ai/question-types.js";
import type { Preset } from "../core/pattern/presets.js";
import { REQUEST_QUESTIONS, validRequestState, isRequestQuestion } from "../ai/request-questions.js";
type Payload = { state: PatternJevState; instruments: Instrument[]; request: string; candidate_ids: string[]; node_id: keyof typeof REQUEST_QUESTIONS };
type JevResponse = { model: string; answers: Answers; usage?: Record<string, number> };
const staticFile = (path: string, contentType: string): [URL, string] => [new URL(path, import.meta.url), contentType];
const PUBLIC_FILES = new Map<string, [URL, string]>([
  ["/", staticFile("../frontend/timing/index.html", "text/html")],
  ["/style.css", staticFile("../frontend/timing/style.css", "text/css")],
  ["/app.js", staticFile("../frontend/timing/app.js", "text/javascript")],
  ["/timing-audio.js", staticFile("../frontend/timing/audio.js", "text/javascript")],
  ["/core/timing/session.js", staticFile("../core/timing/session.js", "text/javascript")],
  ["/core/timing/runner.js", staticFile("../core/timing/runner.js", "text/javascript")],
  ["/pattern.html", staticFile("../frontend/pattern/index.html", "text/html")],
  ["/pattern.css", staticFile("../frontend/pattern/styles.css", "text/css")],
  ["/pattern-app.js", staticFile("../frontend/pattern/app.js", "text/javascript")],
  ["/pattern-audio.js", staticFile("../frontend/pattern/audio.js", "text/javascript")],
  ["/frontend/pattern/audio.js", staticFile("../frontend/pattern/audio.js", "text/javascript")],
  ["/presets.html", staticFile("../frontend/presets/index.html", "text/html")],
  ["/presets.css", staticFile("../frontend/presets/styles.css", "text/css")],
  ["/presets-app.js", staticFile("../frontend/presets/app.js", "text/javascript")],
  ["/core/pattern/state.js", staticFile("../core/pattern/state.js", "text/javascript")],
  ["/core/pattern/runner.js", staticFile("../core/pattern/runner.js", "text/javascript")],
  ["/core/pattern/audio-schedule.js", staticFile("../core/pattern/audio-schedule.js", "text/javascript")],
  ["/core/pattern/drum-pitches.js", staticFile("../core/pattern/drum-pitches.js", "text/javascript")],
  ["/assets/virtuosity/manifest.json", staticFile("../frontend/assets/virtuosity/manifest.json", "application/json")],
  ["/core/pattern/musical-time.js", staticFile("../core/pattern/musical-time.js", "text/javascript")],
  ["/core/pattern/presets.js", staticFile("../core/pattern/presets.js", "text/javascript")],
  ["/core/pattern/audition-grooves.js", staticFile("../core/pattern/audition-grooves.js", "text/javascript")],
  ["/core/pattern/gmd-presets.js", staticFile("../core/pattern/gmd-presets.js", "text/javascript")],
  ["/core/pattern/gmd-curated-presets.js", staticFile("../core/pattern/gmd-curated-presets.js", "text/javascript")],
  ["/core/pattern/request-runner.js", staticFile("../core/pattern/request-runner.js", "text/javascript")],
  ["/core/pattern/velocity-edit.js", staticFile("../core/pattern/velocity-edit.js", "text/javascript")],
  ["/frontend/shared/idle-submit.js", staticFile("../frontend/shared/idle-submit.js", "text/javascript")],
  ["/recorded-run.json", staticFile("../../recordings/live-60s.json", "application/json")],
]);
for (const name of ["capture", "analysis", "rhythm", "decision"]) PUBLIC_FILES.set(`/core/recording/${name}.js`, staticFile(`../core/recording/${name}.js`, "text/javascript"));
for (const name of ["capture", "capture-worklet"]) PUBLIC_FILES.set(`/frontend/pattern/${name}.js`, staticFile(`../frontend/pattern/${name}.js`, "text/javascript"));
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const KIT_SAMPLE_PATHS = new Set(Object.values(kitManifest.families).flat().map(file => `/assets/virtuosity/${file}`));
for (const name of ["kits", "request-tree", "undo", "swing", "rhythm-fill"]) PUBLIC_FILES.set(`/core/pattern/${name}.js`, staticFile(`../core/pattern/${name}.js`, "text/javascript"));
for (const page of ["pattern", "timing", "presets"]) PUBLIC_FILES.set(`/frontend/${page}/app.js`, staticFile(`../frontend/${page}/app.js`, "text/javascript"));
PUBLIC_FILES.set("/frontend/timing/audio.js", staticFile("../frontend/timing/audio.js", "text/javascript"));
const MODULE_ALIASES: Record<string, string> = { "/app.js": "/frontend/timing/app.js", "/pattern-app.js": "/frontend/pattern/app.js", "/pattern-audio.js": "/frontend/pattern/audio.js", "/timing-audio.js": "/frontend/timing/audio.js", "/presets-app.js": "/frontend/presets/app.js" };
const exactKeys = (obj: unknown, keys: readonly string[]): obj is Record<string, unknown> => obj !== null && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
const midiValue = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 127;

function validState(input: unknown) {
  const state = input as import("../core/timing/session.js").TimingState;
  if (!exactKeys(state, ["piano", "drums"]) || !exactKeys(state.piano, ["recent_events", "silent_for_ms"]) || !exactKeys(state.drums, ["status", "scheduled_start"])) return false;
  const { recent_events: events, silent_for_ms: silence } = state.piano;
  if (!Number.isFinite(silence) || silence < 0 || silence > 600000 || !["playing", "stopped"].includes(state.drums.status) || typeof state.drums.scheduled_start !== "boolean" || !Array.isArray(events) || events.length > 500) return false;
  let previous = -1;
  return events.every(event => {
    if (!Number.isFinite(event.time_ms) || event.time_ms < 0 || event.time_ms < previous || event.time_ms > 600000) return false;
    previous = event.time_ms;
    if (event.type === "sustain") return exactKeys(event, ["time_ms", "type", "value"]) && midiValue(event.value);
    return exactKeys(event, ["time_ms", "type", "note", "velocity"]) && ["note_on", "note_off"].includes(event.type) && midiValue(event.note) && midiValue(event.velocity);
  });
}

function validPatternState(input: unknown): input is PatternJevState {
  const state = input as PatternJevState;
  if (isRecord(state) && state.recent_take !== undefined) {
    if (!exactKeys(state.recent_take, ["id", "note_ids"]) || typeof state.recent_take.id !== "string" || state.recent_take.id.length > 100 || !Array.isArray(state.recent_take.note_ids) || state.recent_take.note_ids.length > 256 || !state.recent_take.note_ids.every(id => typeof id === "string" && /^note_[1-9]\d*$/.test(id))) return false;
  }
  if (!exactKeys(state, ["request", "pattern", "music_reference", "recent_history", ...(isRecord(state) && state.recent_take !== undefined ? ["recent_take"] : [])]) || typeof state.request !== "string" || !state.request.trim() || state.request.length > 500) return false;
  if (JSON.stringify(state.music_reference) !== JSON.stringify(MUSIC_REFERENCE)) return false;
  if (!exactKeys(state.pattern, ["bars", "meter", "ticks_per_quarter", "parts"]) || !Number.isInteger(state.pattern.bars) || state.pattern.bars < 1 || state.pattern.bars > MAX_BARS || !validMeter(state.pattern.meter) || state.pattern.ticks_per_quarter !== TICKS_PER_QUARTER || !exactKeys(state.pattern.parts, INSTRUMENTS)) return false;
  const ids = new Set();
  for (const instrument of INSTRUMENTS) {
    if (!Array.isArray(state.pattern.parts[instrument])) return false;
    for (const note of state.pattern.parts[instrument]) {
      if (!exactKeys(note, ["id", "bar", "tick", "position", "velocity"]) || !/^note_[1-9]\d*$/.test(note.id) || ids.has(note.id) || !Number.isInteger(note.bar) || note.bar < 1 || note.bar > state.pattern.bars || !Number.isInteger(note.tick) || note.tick < 0 || note.tick >= ticksPerBar(state.pattern.meter) || typeof note.position !== "string" || !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) return false;
      ids.add(note.id);
    }
  }
  if (ids.size > state.pattern.bars * 64) return false;
  if (!Array.isArray(state.recent_history) || state.recent_history.length > 8) return false;
  return state.recent_history.every(entry => exactKeys(entry, ["request", "applied_changes", "rejected_changes"])
    && typeof entry.request === "string" && entry.request.length <= 500
    && [entry.applied_changes, entry.rejected_changes].every(items => Array.isArray(items) && items.length <= 8 && items.every(item => typeof item === "string" && item.length <= 300)));
}

function validRecordingState(state: unknown) {
  return isRecord(state) && validEvidence(state.evidence) && validPatternState(state.pattern_state) && isRecord(state.playback);
}

function validPatternAnswers(input: unknown, questions: Questions): input is JevResponse {
  const data = input as JevResponse;
  if (!data || typeof data.model !== "string" || !exactKeys(data.answers, Object.keys(questions))) return false;
  return Object.entries(questions).every(([key, question]) => {
    const answer = data.answers[key];
    if (!answer || answer.type !== question.type) return false;
    if (question.type === "noul") return Number.isFinite(answer.noul) && typeof answer.noul === "number" && answer.noul >= 0 && answer.noul <= 1;
    return typeof answer.choice === "string" && Object.hasOwn(question.criteria ?? {}, answer.choice)
      && answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)
      && Object.values(answer.probabilities).every(value => Number.isFinite(value) && value >= 0 && value <= 1);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(body));
}

export function createServer({ apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = fetch, openRouterKey = process.env.OPENROUTER_API_KEY } = {}) {
  return httpServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'");
    const host = req.headers.host;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? "")) return json(res, 403, { error: "Local access only." });
    const path = new URL(req.url ?? "/", `http://${host}`).pathname;
    if (req.method === "GET" && MODULE_ALIASES[path]) {
      res.writeHead(302, { Location: MODULE_ALIASES[path], "Cache-Control": "no-store" }).end();
      return;
    }
    const samplePath = /^\/assets\/(tr_808|tr_505)\/(kick|snare|closed_hat|open_hat)\.wav$/.test(path) || /^\/assets\/osdk\/(kick|snare|closed_hat|open_hat|ride|crash|high_tom|mid_tom|floor_tom)\/layer-[1-5]\.wav$/.test(path)
      || /^\/assets\/gmd\/[a-z0-9_-]+\.wav$/.test(path)
      || KIT_SAMPLE_PATHS.has(path);
    if (req.method === "GET" && samplePath) {
      try {
        const content = await readFile(new URL(`../frontend${path}`, import.meta.url));
        const headers = { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=86400", "Accept-Ranges": "bytes" };
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const first = match?.[1] ? Number(match[1]) : null;
          const last = match?.[2] ? Number(match[2]) : null;
          const start = first ?? (last === null ? NaN : Math.max(0, content.length - last));
          const end = first === null ? content.length - 1 : Math.min(last ?? content.length - 1, content.length - 1);
          if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= content.length || (first === null && (last === null || !Number.isSafeInteger(last) || last < 1))) {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${content.length}` }).end();
            return;
          }
          const body = content.subarray(start, end + 1);
          res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${content.length}`, "Content-Length": body.length }).end(body);
          return;
        }
        res.writeHead(200, { ...headers, "Content-Length": content.length }).end(content);
      } catch { json(res, 404, { error: "File not found." }); }
      return;
    }
    if (req.method === "GET" && PUBLIC_FILES.has(path)) {
      const [file, contentType] = PUBLIC_FILES.get(path)!;
      try {
        const content = await readFile(file);
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" }).end(content);
      } catch { json(res, 404, { error: "File not found." }); }
      return;
    }
    if (path === "/api/transcribe" && req.method === "POST") {
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "Foreign origin rejected." });
      await handleTranscription(req, res, openRouterKey, fetchImpl);
      return;
    }
    if (!["/api/recording-decision", "/api/rhythm-fill", "/api/request-decision", "/api/decision", "/api/pattern-decision", "/api/pattern-plan", "/api/pattern-edit-intent", "/api/pattern-route", "/api/preset-search", "/api/preset-select"].includes(path) || req.method !== "POST") return json(res, 404, { error: "Not found." });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: "Foreign origin rejected." });
    if (req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "Cross-site request rejected." });
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") return json(res, 415, { error: "JSON required." });
    if (Number(req.headers["content-length"]) > 100000) return json(res, 413, { error: "Request too large." });
    let payload: Payload;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 100000) { json(res, 413, { error: "Request too large." }); return; }
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString());
    } catch { return json(res, 400, { error: "Invalid JSON." }); }
    const recordingRequest = path === "/api/recording-decision";
    const planRequest = path === "/api/pattern-plan";
    const rhythmRequest = path === "/api/rhythm-fill";
    const intentRequest = path === "/api/pattern-edit-intent";
    const editRequest = path === "/api/pattern-decision";
    const routeRequest = path === "/api/pattern-route";
    const treeRequest = path === "/api/request-decision";
    const presetSearchRequest = path === "/api/preset-search";
    const presetSelectRequest = path === "/api/preset-select";
    const patternRequest = editRequest || planRequest || intentRequest || rhythmRequest;
    const validInstruments = editRequest && exactKeys(payload, ["state", "instruments"]) && Array.isArray(payload.instruments) && payload.instruments.length >= 1 && payload.instruments.length <= INSTRUMENTS.length && new Set(payload.instruments).size === payload.instruments.length && payload.instruments.every(instrument => INSTRUMENTS.includes(instrument));
    const validRequestText = typeof payload?.request === "string" && Boolean(payload.request.trim()) && payload.request.length <= 500;
    const validCandidateIds = presetSelectRequest && exactKeys(payload, ["request", "candidate_ids"]) && validRequestText && Array.isArray(payload.candidate_ids) && payload.candidate_ids.length >= 1 && payload.candidate_ids.length <= 8 && new Set(payload.candidate_ids).size === payload.candidate_ids.length && payload.candidate_ids.every(id => presetById(id));
    const validPayload = recordingRequest ? exactKeys(payload, ["state"]) : treeRequest ? exactKeys(payload, ["node_id", "state"]) && isRequestQuestion(payload.node_id) && validRequestState(payload.state, payload.node_id) : planRequest ? exactKeys(payload, ["state"]) : editRequest ? validInstruments : routeRequest || presetSearchRequest ? exactKeys(payload, ["request"]) && validRequestText : presetSelectRequest ? validCandidateIds : exactKeys(payload, ["state"]);
    if (!validPayload || (recordingRequest && !validRecordingState(payload.state)) || (patternRequest && !validPatternState(payload.state)) || (!recordingRequest && !treeRequest && !patternRequest && !routeRequest && !presetSearchRequest && !presetSelectRequest && !validState(payload.state))) return json(res, 400, { error: patternRequest ? "Invalid pattern state." : "Invalid decision state." });
    if (!apiKey?.trim()) return json(res, 503, { code: "missing_api_key", error: "Set TYPESAFE_API_KEY in the local .env file, then restart the server." });
    const candidates = presetSelectRequest ? payload.candidate_ids.map(id => presetById(id)!) : [];
    let largeEdit = editRequest && (payload.state.pattern.bars > 1 || payload.instruments.reduce((sum, instrument) => sum + payload.state.pattern.parts[instrument].length, 0) > 6);
    let questions: Questions = routeRequest ? ROOT_QUESTIONS : presetSearchRequest ? PRESET_SEARCH_QUESTIONS : presetSelectRequest ? buildPresetSelectionQuestions(candidates) : planRequest ? buildPlanningQuestions(payload.state) : editRequest && !largeEdit ? buildPatternQuestions(payload.state, payload.instruments) : { action: TIMING_QUESTION };
    if (editRequest && !largeEdit && requestBudgetError(payload.state, questions)) largeEdit = true;
    let upstreamState: unknown = routeRequest || presetSearchRequest ? { request: payload.request } : presetSelectRequest ? { request: payload.request, candidates: candidates.map(({ id, name, genres, meter, feel, tags, bars, source, description }) => ({ id, name, genres, meter, feel, tags, bars, source_bpm: source.bpm ?? null, description })) } : payload.state;
    if (intentRequest) {
      questions = buildVelocityEditQuestions(payload.state);
      upstreamState = { request: payload.state.request, pattern: { bars: payload.state.pattern.bars, meter: payload.state.pattern.meter } };
    }
    if (rhythmRequest) {
      questions = buildRhythmFillQuestions(payload.state);
      upstreamState = rhythmFillContext(payload.state);
    }
    if (recordingRequest) questions = recordingQuestions((payload.state as unknown as { evidence: import("../core/recording/decision.js").RecordingEvidence }).evidence);
    if (treeRequest) questions = REQUEST_QUESTIONS[payload.node_id].buildQuestions();
    const abort = new AbortController();
    const timeoutMs = (patternRequest || treeRequest || recordingRequest) ? 10000 : 2000;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", disconnect);
    try {
      let questionCount = 0;
      const usage: Record<string, number> = {};
      const traversal = [];
      const evaluate = async (state: unknown, nodeQuestions: Questions) => {
        const budgetError = requestBudgetError(state, nodeQuestions);
        if (budgetError) throw Object.assign(new Error(`${budgetError} Please narrow the edit to one instrument and bar.`), { status: 413 });
        const upstream = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST", signal: abort.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: "jev-latest", questions: nodeQuestions }),
      });
      if (!upstream.ok) {
        const retry = upstream.headers.get("Retry-After");
        const details = await upstream.json().catch(() => null);
        const exceeded = details?.detail?.error_type === "max_tokens_exceeded";
        throw Object.assign(new Error(exceeded ? "TypeSafe's context limit was exceeded. Please narrow the edit to one instrument and bar." : `TypeSafe returned HTTP ${upstream.status}.`), { status: upstream.status, retry });
      }
      const data = await upstream.json();
        if ((recordingRequest || treeRequest || patternRequest || routeRequest || presetSearchRequest || presetSelectRequest) && !validPatternAnswers(data, nodeQuestions)) throw Object.assign(new Error("TypeSafe returned invalid pattern answers."), { status: 502 });
        questionCount += Object.keys(nodeQuestions).length;
        for (const [key, value] of Object.entries(data.usage ?? {})) if (typeof value === "number" && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
        return data;
      };
      if (largeEdit) {
        const scope = await evaluate(patternSummary(payload.state), buildScopeQuestion(payload.state, payload.instruments));
        const choice = scope.answers.edit_scope.choice!;
        traversal.push({ node: "edit_scope", answers: scope.answers });
        if (choice === "none") return json(res, 200, { answers: {}, model: scope.model, usage, question_count: questionCount, traversal });
        const [instrumentText, barText] = choice.split(":");
        const instrument = instrumentText as Instrument;
        const bar = Number(barText);
        upstreamState = { ...payload.state, pattern: { ...payload.state.pattern, parts: Object.fromEntries(INSTRUMENTS.map(name => [name, name === instrument ? payload.state.pattern.parts[name].filter(note => note.bar === bar) : []])) }, scope: { instrument, bar }, pattern_summary: patternSummary(payload.state).pattern };
        const target = await evaluate(upstreamState, buildTargetQuestion(upstreamState as PatternJevState, instrument, bar));
        traversal.push({ node: "edit_target", answers: target.answers });
        if (target.answers.edit_target.choice === "none") return json(res, 200, { answers: {}, model: target.model, usage, question_count: questionCount, traversal });
        questions = buildTargetDetails(upstreamState as PatternJevState, instrument, bar, target.answers.edit_target.choice!);
      }
      if (planRequest && requestBudgetError(upstreamState, questions)) upstreamState = patternSummary(payload.state);
      const data = await evaluate(upstreamState, questions);
      if (recordingRequest) {
        const decision = validateRecordingDecision((payload.state as unknown as { evidence: import("../core/recording/decision.js").RecordingEvidence }).evidence, data.answers);
        return json(res, 200, { decision, answers: data.answers, model: data.model, usage, question_count: questionCount });
      }
      if (treeRequest) {
        const outcome = REQUEST_QUESTIONS[payload.node_id].validate(data.answers);
        return json(res, 200, { answers: data.answers, outcome, model: data.model, usage, question_count: questionCount });
      }
      if (rhythmRequest) return json(res, 200, { intent: rhythmFillIntent(payload.state, data.answers), answers: data.answers, model: data.model, usage, question_count: questionCount });
      if (intentRequest) return json(res, 200, { intent: velocityIntent(payload.state, data.answers), answers: data.answers, model: data.model, usage, question_count: questionCount });
      if (routeRequest || presetSearchRequest || presetSelectRequest) {
        if (!validPatternAnswers(data, questions)) return json(res, 502, { error: "TypeSafe returned invalid request-tree answers." });
        if (routeRequest) return json(res, 200, { route: resolveRoot(data.answers.request_category.choice!), answers: data.answers, model: data.model, usage: data.usage, question_count: 1 });
        if (presetSearchRequest) {
          const attributes = attributesFromAnswers(data.answers);
          const matches = filterPresets(attributes).slice(0, 8);
          const alternatives = matches.length ? null : { genres: [...new Set(filterPresets({ meter: attributes.meter }).flatMap(item => item.genres))].sort(), meters: [...new Set(filterPresets().map(item => `${item.meter.numerator}/${item.meter.denominator}`))] };
          return json(res, 200, { attributes, has_explicit_filters: data.answers.explicit_filters.noul! >= 0.5, candidate_ids: matches.map(item => item.id), alternatives, answers: data.answers, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
        }
        return json(res, 200, { preset_id: data.answers.preset.choice, answers: data.answers, model: data.model, usage: data.usage, question_count: 1 });
      }
      if (patternRequest) {
        if (!validPatternAnswers(data, questions)) return json(res, 502, { error: "TypeSafe returned invalid pattern answers." });
        if (planRequest) {
          const operationCount = Number(/^operations_([0-8])$/.exec(data.answers.operation_count.choice ?? "")?.[1]);
          if (!Number.isInteger(operationCount)) return json(res, 502, { error: "TypeSafe returned an invalid operation count." });
          const phraseChoice = data.answers.phrase_length.choice ?? "";
          const requestedBars = Number(/^bars_([1-8])$/.exec(phraseChoice)?.[1]);
          const phraseBars = phraseChoice === "keep_current" ? payload.state.pattern.bars : requestedBars;
          if (!Number.isInteger(phraseBars)) return json(res, 502, { error: "TypeSafe returned an invalid phrase length." });
          const scores: [Instrument, number][] = INSTRUMENTS.map(instrument => [instrument, data.answers[`involves_${instrument}`].noul!]);
          let relevantInstruments = scores.filter(([, score]) => score >= 0.5).map(([instrument]) => instrument);
          if (!relevantInstruments.length) relevantInstruments = [scores.reduce((best, item) => item[1] > best[1] ? item : best)[0]];
          return json(res, 200, { operation_count: operationCount, ...(data.answers.recorded_take_instrument?.choice && data.answers.recorded_take_instrument.choice !== "ordinary_edit" ? { recorded_take_instrument: data.answers.recorded_take_instrument.choice } : {}), phrase_bars: phraseBars, relevant_instruments: relevantInstruments, answers: data.answers, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
        }
        return json(res, 200, { answers: data.answers, model: data.model, usage, question_count: questionCount, traversal });
      }
      const answer = data.answers?.action;
      if (!ACTIONS.some(action => action === answer?.choice) || answer.type !== "choice" || typeof data.model !== "string") return json(res, 502, { error: "TypeSafe returned an invalid action." });
      json(res, 200, { answer, model: data.model, usage: data.usage });
    } catch (caught) {
      const error = caught as Error & { status?: number; retry?: string };
      json(res, abort.signal.aborted ? 504 : error.status ?? 502, { error: abort.signal.aborted ? `TypeSafe request timed out after ${timeoutMs / 1000} seconds.` : error.status ? error.message : "Could not reach TypeSafe." }, error.retry ? { "Retry-After": error.retry } : {});
    } finally { clearTimeout(timer); res.off("close", disconnect); }
  });
}
