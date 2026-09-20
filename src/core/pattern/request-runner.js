import { loadPreset, presetById } from "./presets.js";

export async function runPatternTree({ state, request, route, searchPresets, selectPreset, runEdit }) {
  const visits = [];
  const usage = {};
  let latencyMs = 0;
  let questionCount = 0;
  let model = null;
  const record = (node, response = {}) => {
    visits.push({ node, response });
    latencyMs += Number(response.latency_ms) || 0;
    questionCount += Number(response.question_count) || 0;
    model = response.model ?? model;
    for (const [key, value] of Object.entries(response.usage ?? {})) if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
  };

  const routed = await route(request);
  record("root", routed);
  if (routed.route.category === "unsupported") return { state, route: routed.route, visits, result: { message: routed.route.message, applied_changes: [] }, model, usage, question_count: questionCount, latency_ms: latencyMs };

  if (routed.route.category === "edit_pattern") {
    const edited = await runEdit();
    record("edit_plan", edited);
    return { ...edited, route: routed.route, visits, model: edited.model ?? model, usage, question_count: questionCount, latency_ms: latencyMs };
  }

  if (routed.route.category !== "load_preset") throw new Error("Invalid request route.");
  const search = await searchPresets(request);
  record("preset_search", search);
  if (!search.candidate_ids?.length) return { state, route: routed.route, visits, result: { message: "No matching preset is available. Try one of the suggested genres or meters.", alternatives: search.alternatives, applied_changes: [] }, model, usage, question_count: questionCount, latency_ms: latencyMs };
  const selection = await selectPreset(request, search.candidate_ids);
  record("preset_select", selection);
  const selected = presetById(selection.preset_id);
  if (!selected || !search.candidate_ids.includes(selected.id)) throw new Error("Invalid preset selection.");
  const nextState = loadPreset(state, selected, request);
  const result = { preset_id: selected.id, preset_name: selected.name, message: `Loaded ${selected.name}.`, applied_changes: [{ kind: "load_preset", preset_id: selected.id, preset_name: selected.name }] };
  record("preset_load", result);
  return { state: nextState, route: routed.route, visits, result, model, usage, question_count: questionCount, latency_ms: latencyMs };
}
