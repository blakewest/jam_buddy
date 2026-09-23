import { createServer as httpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { TIMING_QUESTION } from "../ai/timing-question.mjs";
import { buildPatternQuestions, PLANNING_QUESTIONS } from "../ai/pattern-questions.mjs";
import { REQUEST_NODES, validRequestState, isRequestNode } from "../ai/request-questions.mjs";
import { ACTIONS } from "../core/timing/session.js";
import { INSTRUMENTS, MUSIC_REFERENCE, POSITIONS } from "../core/pattern/state.js";

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
  ["/core/pattern/state.js", staticFile("../core/pattern/state.js", "text/javascript")],
  ["/core/pattern/runner.js", staticFile("../core/pattern/runner.js", "text/javascript")],
  ["/core/pattern/audio-schedule.js", staticFile("../core/pattern/audio-schedule.js", "text/javascript")],
  ["/frontend/shared/idle-submit.js", staticFile("../frontend/shared/idle-submit.js", "text/javascript")],
  ["/recorded-run.json", staticFile("../../recordings/live-60s.json", "application/json")],
]);
for (const name of ["kits", "request-tree", "undo"]) PUBLIC_FILES.set(`/core/pattern/${name}.js`, staticFile(`../core/pattern/${name}.js`, "text/javascript"));

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
  if (!exactKeys(state.pattern, ["bars", "slots_per_bar", "parts"]) || !Number.isInteger(state.pattern.bars) || state.pattern.bars < 1 || state.pattern.bars > 4 || state.pattern.slots_per_bar !== 16 || !exactKeys(state.pattern.parts, INSTRUMENTS)) return false;
  const ids = new Set();
  const cells = new Set();
  for (const instrument of INSTRUMENTS) {
    if (!Array.isArray(state.pattern.parts[instrument])) return false;
    for (const note of state.pattern.parts[instrument]) {
      if (!exactKeys(note, ["id", "bar", "position", "velocity_layer"]) || !/^note_[1-9]\d*$/.test(note.id) || ids.has(note.id) || !Number.isInteger(note.bar) || note.bar < 1 || note.bar > state.pattern.bars || !POSITIONS.includes(note.position) || !Number.isInteger(note.velocity_layer) || note.velocity_layer < 1 || note.velocity_layer > 5) return false;
      const cell = `${instrument}:${note.bar}:${note.position}`;
      if (cells.has(cell)) return false;
      ids.add(note.id);
      cells.add(cell);
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
    const electronicSample = /^\/assets\/(tr_808|tr_505)\/(kick|snare|closed_hat|open_hat)\.wav$/.test(path);
    const samplePath = electronicSample || /^\/assets\/osdk\/(kick|snare|closed_hat|open_hat)\/layer-[1-5]\.wav$/.test(path);
    if (req.method === "GET" && samplePath) {
      try {
        const content = await readFile(new URL(`../frontend${path}`, import.meta.url));
        res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=86400" }).end(content);
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
    if (!["/api/decision", "/api/pattern-decision", "/api/pattern-plan", "/api/request-decision"].includes(path) || req.method !== "POST") return json(res, 404, { error: "Not found." });
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
    const editRequest = path === "/api/pattern-decision";
    const treeRequest = path === "/api/request-decision";
    const patternRequest = editRequest || planRequest;
    const validInstruments = editRequest && exactKeys(payload, ["state", "instruments"]) && Array.isArray(payload.instruments) && payload.instruments.length >= 1 && payload.instruments.length <= 4 && new Set(payload.instruments).size === payload.instruments.length && payload.instruments.every(instrument => INSTRUMENTS.includes(instrument));
    const validPayload = treeRequest ? exactKeys(payload, ["node_id", "state"]) && isRequestNode(payload.node_id) : planRequest ? exactKeys(payload, ["state"]) : editRequest ? validInstruments : exactKeys(payload, ["state"]);
    if (!validPayload || !(treeRequest ? validRequestState(payload.state) : patternRequest ? validPatternState(payload.state) : validState(payload.state))) return json(res, 400, { error: patternRequest ? "Invalid pattern state." : "Invalid decision state." });
    if (!apiKey?.trim()) return json(res, 503, { code: "missing_api_key", error: "Set TYPESAFE_API_KEY in the local .env file, then restart the server." });
    const questions = treeRequest ? REQUEST_NODES[payload.node_id].buildQuestions(payload.state) : planRequest ? PLANNING_QUESTIONS : editRequest ? buildPatternQuestions(payload.state, payload.instruments) : { action: TIMING_QUESTION };
    const abort = new AbortController();
    const timeoutMs = (patternRequest || treeRequest) ? 10000 : 2000;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", disconnect);
    try {
      const upstream = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST", signal: abort.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: payload.state, model: "jev-latest", questions }),
      });
      if (!upstream.ok) {
        const retry = upstream.headers.get("Retry-After");
        return json(res, upstream.status, { error: `TypeSafe returned HTTP ${upstream.status}.` }, retry ? { "Retry-After": retry } : {});
      }
      const data = await upstream.json();
      if (treeRequest) {
        if (!validPatternAnswers(data, questions)) return json(res, 502, { error: "TypeSafe returned invalid request answers." });
        const outcome = REQUEST_NODES[payload.node_id].validate(data.answers);
        return json(res, 200, { answers: data.answers, outcome, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
      }
      if (patternRequest) {
        if (!validPatternAnswers(data, questions)) return json(res, 502, { error: "TypeSafe returned invalid pattern answers." });
        if (planRequest) {
          const operationCount = Number(/^operations_([0-8])$/.exec(data.answers.operation_count.choice)?.[1]);
          if (!Number.isInteger(operationCount)) return json(res, 502, { error: "TypeSafe returned an invalid operation count." });
          const phraseChoice = data.answers.phrase_length.choice;
          const requestedBars = Number(/^bars_([1-4])$/.exec(phraseChoice)?.[1]);
          const phraseBars = phraseChoice === "keep_current" ? payload.state.pattern.bars : requestedBars;
          if (!Number.isInteger(phraseBars)) return json(res, 502, { error: "TypeSafe returned an invalid phrase length." });
          const scores = INSTRUMENTS.map(instrument => [instrument, data.answers[`involves_${instrument}`].noul]);
          let relevantInstruments = scores.filter(([, score]) => score >= 0.5).map(([instrument]) => instrument);
          if (!relevantInstruments.length) relevantInstruments = [scores.reduce((best, item) => item[1] > best[1] ? item : best)[0]];
          return json(res, 200, { operation_count: operationCount, phrase_bars: phraseBars, relevant_instruments: relevantInstruments, answers: data.answers, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
        }
        return json(res, 200, { answers: data.answers, model: data.model, usage: data.usage, question_count: Object.keys(questions).length });
      }
      const answer = data.answers?.action;
      if (!ACTIONS.includes(answer?.choice) || answer.type !== "choice" || typeof data.model !== "string") return json(res, 502, { error: "TypeSafe returned an invalid action." });
      json(res, 200, { answer, model: data.model, usage: data.usage });
    } catch {
      json(res, abort.signal.aborted ? 504 : 502, { error: abort.signal.aborted ? `TypeSafe request timed out after ${timeoutMs / 1000} seconds.` : "Could not reach TypeSafe." });
    } finally { clearTimeout(timer); res.off("close", disconnect); }
  });
}
