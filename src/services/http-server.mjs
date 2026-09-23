import { createServer as httpServer } from "node:http";
import { readFile } from "node:fs/promises";
import kitManifest from "../frontend/assets/virtuosity/manifest.json" with { type: "json" };
import { TIMING_QUESTION } from "../ai/timing-question.mjs";
import { buildPatternQuestions, buildScopeQuestion, buildTargetQuestion, buildTargetDetails, patternSummary, PLANNING_QUESTIONS } from "../ai/pattern-questions.mjs";
import { requestBudgetError } from "../ai/request-budget.mjs";
import { buildVelocityEditQuestions, velocityIntent } from "../ai/velocity-edit-questions.mjs";
import { ROOT_QUESTIONS } from "../ai/request-tree-questions.mjs";
import { attributesFromAnswers, buildPresetSelectionQuestions, PRESET_SEARCH_QUESTIONS } from "../ai/preset-questions.mjs";
import { ACTIONS } from "../core/timing/session.js";
import { INSTRUMENTS, MAX_BARS, MUSIC_REFERENCE } from "../core/pattern/state.js";
import { resolveRoot } from "../core/pattern/request-tree.js";
import { filterPresets, presetById } from "../core/pattern/presets.js";
import { ticksPerBar, TICKS_PER_QUARTER, validMeter } from "../core/pattern/musical-time.js";

const staticFile = (path, contentType) => [new URL(path, import.meta.url), contentType];
const PUBLIC_FILES = new Map([
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
const KIT_SAMPLE_PATHS = new Set(Object.values(kitManifest.families).flat().map(file => `/assets/virtuosity/${file}`));
const exactKeys = (obj, keys) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
const midiValue = value => Number.isInteger(value) && value >= 0 && value <= 127;

function validState(state) {
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

function validPatternState(state) {
  if (!exactKeys(state, ["request", "pattern", "music_reference", "recent_history"]) || typeof state.request !== "string" || !state.request.trim() || state.request.length > 500) return false;
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

function validPatternAnswers(data, questions) {
  if (!data || typeof data.model !== "string" || !exactKeys(data.answers, Object.keys(questions))) return false;
  return Object.entries(questions).every(([key, question]) => {
    const answer = data.answers[key];
    if (!answer || answer.type !== question.type) return false;
    if (question.type === "noul") return Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
    return Object.hasOwn(question.criteria, answer.choice)
      && answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)
      && Object.values(answer.probabilities).every(value => Number.isFinite(value) && value >= 0 && value <= 1);
  });
}

function json(res, status, body, headers = {}) {
  if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(body));
}

export function createServer({ apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = fetch } = {}) {
  return httpServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'");
    const host = req.headers.host;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? "")) return json(res, 403, { error: "Local access only." });
    const path = new URL(req.url, `http://${host}`).pathname;
    const samplePath = /^\/assets\/osdk\/(kick|snare|closed_hat|open_hat|ride|crash|high_tom|mid_tom|floor_tom)\/layer-[1-5]\.wav$/.test(path)
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
          if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= content.length || (first === null && (!Number.isSafeInteger(last) || last < 1))) {
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
      const [file, contentType] = PUBLIC_FILES.get(path);
      try {
        const content = await readFile(file);
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" }).end(content);
      } catch { json(res, 404, { error: "File not found." }); }
      return;
    }
    if (!["/api/decision", "/api/pattern-decision", "/api/pattern-plan", "/api/pattern-edit-intent", "/api/pattern-route", "/api/preset-search", "/api/preset-select"].includes(path) || req.method !== "POST") return json(res, 404, { error: "Not found." });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: "Foreign origin rejected." });
    if (req.headers["sec-fetch-site"] === "cross-site") return json(res, 403, { error: "Cross-site request rejected." });
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") return json(res, 415, { error: "JSON required." });
    if (Number(req.headers["content-length"]) > 100000) return json(res, 413, { error: "Request too large." });
    let payload;
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
    const planRequest = path === "/api/pattern-plan";
    const intentRequest = path === "/api/pattern-edit-intent";
    const editRequest = path === "/api/pattern-decision";
    const routeRequest = path === "/api/pattern-route";
    const presetSearchRequest = path === "/api/preset-search";
    const presetSelectRequest = path === "/api/preset-select";
    const patternRequest = editRequest || planRequest || intentRequest;
    const validInstruments = editRequest && exactKeys(payload, ["state", "instruments"]) && Array.isArray(payload.instruments) && payload.instruments.length >= 1 && payload.instruments.length <= INSTRUMENTS.length && new Set(payload.instruments).size === payload.instruments.length && payload.instruments.every(instrument => INSTRUMENTS.includes(instrument));
    const validRequestText = typeof payload?.request === "string" && Boolean(payload.request.trim()) && payload.request.length <= 500;
    const validCandidateIds = presetSelectRequest && exactKeys(payload, ["request", "candidate_ids"]) && validRequestText && Array.isArray(payload.candidate_ids) && payload.candidate_ids.length >= 1 && payload.candidate_ids.length <= 8 && new Set(payload.candidate_ids).size === payload.candidate_ids.length && payload.candidate_ids.every(id => presetById(id));
    const validPayload = planRequest ? exactKeys(payload, ["state"]) : editRequest ? validInstruments : routeRequest || presetSearchRequest ? exactKeys(payload, ["request"]) && validRequestText : presetSelectRequest ? validCandidateIds : exactKeys(payload, ["state"]);
    if (!validPayload || (patternRequest && !validPatternState(payload.state)) || (!patternRequest && !routeRequest && !presetSearchRequest && !presetSelectRequest && !validState(payload.state))) return json(res, 400, { error: patternRequest ? "Invalid pattern state." : "Invalid decision state." });
    if (!apiKey?.trim()) return json(res, 503, { code: "missing_api_key", error: "Set TYPESAFE_API_KEY in the local .env file, then restart the server." });
    const candidates = presetSelectRequest ? payload.candidate_ids.map(presetById) : null;
    let largeEdit = editRequest && (payload.state.pattern.bars > 1 || payload.instruments.reduce((sum, instrument) => sum + payload.state.pattern.parts[instrument].length, 0) > 6);
    let questions = routeRequest ? ROOT_QUESTIONS : presetSearchRequest ? PRESET_SEARCH_QUESTIONS : presetSelectRequest ? buildPresetSelectionQuestions(candidates) : planRequest ? PLANNING_QUESTIONS : editRequest && !largeEdit ? buildPatternQuestions(payload.state, payload.instruments) : { action: TIMING_QUESTION };
    if (editRequest && !largeEdit && requestBudgetError(payload.state, questions)) largeEdit = true;
    let upstreamState = routeRequest || presetSearchRequest ? { request: payload.request } : presetSelectRequest ? { request: payload.request, candidates: candidates.map(({ id, name, genres, meter, feel, tags, bars, source, description }) => ({ id, name, genres, meter, feel, tags, bars, source_bpm: source.bpm ?? null, description })) } : payload.state;
    if (intentRequest) {
      questions = buildVelocityEditQuestions(payload.state);
      upstreamState = { request: payload.state.request, pattern: { bars: payload.state.pattern.bars, meter: payload.state.pattern.meter } };
    }
    const abort = new AbortController();
    const timeoutMs = patternRequest ? 10000 : 2000;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", disconnect);
    try {
      let questionCount = 0;
      const usage = {};
      const traversal = [];
      const evaluate = async (state, nodeQuestions) => {
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
        if ((patternRequest || routeRequest || presetSearchRequest || presetSelectRequest) && !validPatternAnswers(data, nodeQuestions)) throw Object.assign(new Error("TypeSafe returned invalid pattern answers."), { status: 502 });
        questionCount += Object.keys(nodeQuestions).length;
        for (const [key, value] of Object.entries(data.usage ?? {})) if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
        return data;
      };
      if (largeEdit) {
        const scope = await evaluate(patternSummary(payload.state), buildScopeQuestion(payload.state, payload.instruments));
        const choice = scope.answers.edit_scope.choice;
        traversal.push({ node: "edit_scope", answers: scope.answers });
        if (choice === "none") return json(res, 200, { answers: {}, model: scope.model, usage, question_count: questionCount, traversal });
        const [instrument, barText] = choice.split(":");
        const bar = Number(barText);
        upstreamState = { ...payload.state, pattern: { ...payload.state.pattern, parts: Object.fromEntries(INSTRUMENTS.map(name => [name, name === instrument ? payload.state.pattern.parts[name].filter(note => note.bar === bar) : []])) }, scope: { instrument, bar }, pattern_summary: patternSummary(payload.state).pattern };
        const target = await evaluate(upstreamState, buildTargetQuestion(upstreamState, instrument, bar));
        traversal.push({ node: "edit_target", answers: target.answers });
        if (target.answers.edit_target.choice === "none") return json(res, 200, { answers: {}, model: target.model, usage, question_count: questionCount, traversal });
        questions = buildTargetDetails(upstreamState, instrument, bar, target.answers.edit_target.choice);
      }
      if (planRequest && requestBudgetError(upstreamState, questions)) upstreamState = patternSummary(payload.state);
      const data = await evaluate(upstreamState, questions);
      if (intentRequest) return json(res, 200, { intent: velocityIntent(payload.state, data.answers), answers: data.answers, model: data.model, usage, question_count: questionCount });
      if (routeRequest || presetSearchRequest || presetSelectRequest) {
        if (!validPatternAnswers(data, questions)) return json(res, 502, { error: "TypeSafe returned invalid request-tree answers." });
        if (routeRequest) return json(res, 200, { route: resolveRoot(data.answers.request_category.choice), answers: data.answers, model: data.model, usage: data.usage, question_count: 1 });
        if (presetSearchRequest) {
          const attributes = attributesFromAnswers(data.answers);
          const matches = filterPresets(attributes).slice(0, 8);
          const alternatives = matches.length ? null : { genres: [...new Set(filterPresets({ meter: attributes.meter }).flatMap(item => item.genres))].sort(), meters: [...new Set(filterPresets().map(item => `${item.meter.numerator}/${item.meter.denominator}`))] };
          return json(res, 200, { attributes, has_explicit_filters: data.answers.explicit_filters.noul >= 0.5, candidate_ids: matches.map(item => item.id), alternatives, answers: data.answers, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
        }
        return json(res, 200, { preset_id: data.answers.preset.choice, answers: data.answers, model: data.model, usage: data.usage, question_count: 1 });
      }
      if (patternRequest) {
        if (!validPatternAnswers(data, questions)) return json(res, 502, { error: "TypeSafe returned invalid pattern answers." });
        if (planRequest) {
          const operationCount = Number(/^operations_([0-8])$/.exec(data.answers.operation_count.choice)?.[1]);
          if (!Number.isInteger(operationCount)) return json(res, 502, { error: "TypeSafe returned an invalid operation count." });
          const phraseChoice = data.answers.phrase_length.choice;
          const requestedBars = Number(/^bars_([1-8])$/.exec(phraseChoice)?.[1]);
          const phraseBars = phraseChoice === "keep_current" ? payload.state.pattern.bars : requestedBars;
          if (!Number.isInteger(phraseBars)) return json(res, 502, { error: "TypeSafe returned an invalid phrase length." });
          const scores = INSTRUMENTS.map(instrument => [instrument, data.answers[`involves_${instrument}`].noul]);
          let relevantInstruments = scores.filter(([, score]) => score >= 0.5).map(([instrument]) => instrument);
          if (!relevantInstruments.length) relevantInstruments = [scores.reduce((best, item) => item[1] > best[1] ? item : best)[0]];
          return json(res, 200, { operation_count: operationCount, phrase_bars: phraseBars, relevant_instruments: relevantInstruments, answers: data.answers, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
        }
        return json(res, 200, { answers: data.answers, model: data.model, usage, question_count: questionCount, traversal });
      }
      const answer = data.answers?.action;
      if (!ACTIONS.includes(answer?.choice) || answer.type !== "choice" || typeof data.model !== "string") return json(res, 502, { error: "TypeSafe returned an invalid action." });
      json(res, 200, { answer, model: data.model, usage: data.usage });
    } catch (error) {
      json(res, abort.signal.aborted ? 504 : error.status ?? 502, { error: abort.signal.aborted ? `TypeSafe request timed out after ${timeoutMs / 1000} seconds.` : error.status ? error.message : "Could not reach TypeSafe." }, error.retry ? { "Retry-After": error.retry } : {});
    } finally { clearTimeout(timer); res.off("close", disconnect); }
  });
}
