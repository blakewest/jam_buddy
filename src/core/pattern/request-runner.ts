import { filterPresets, loadPreset, presetById, PRESETS } from "./presets.js";
import { appendHistory, createPatternState } from "./state.js";
import { applyRhythmFill } from "./rhythm-fill.js";
import type { RhythmIntent } from "./rhythm-fill.js";
import { applyVelocityEdit } from "./velocity-edit.js";
import type { VelocityIntent } from "./velocity-edit.js";
import type { PatternState, PresetAttributes, PatternChange, HistoryEntry } from "./state.js";
import type { RootRoute } from "./request-tree.js";
import type { PatternRunResult, PatternPlan, PatternPass } from "./runner.js";
import type { Decision } from "../../ai/question-types.js";
export type SearchResult = Decision & { attributes?: PresetAttributes; candidate_ids: string[]; has_explicit_filters?: boolean; alternatives?: unknown };
export type TreeResult = { state: PatternState; route: RootRoute; visits: { node: string; response: unknown }[]; result: { applied_changes: PatternChange[]; message?: string | null; tempo_bpm?: number; preset_id?: string; preset_name?: string; alternatives?: unknown; rejected_changes?: PatternChange[]; ignored_changes?: PatternChange[]; history_entry?: HistoryEntry }; model: string | null; usage: Record<string, number>; question_count: number; latency_ms: number; plan?: PatternPlan | null; passes?: PatternPass[] };
type TreeOptions = { state: PatternState; request: string; route: (request: string) => Promise<Decision & { route: RootRoute }>; searchPresets: (request: string) => Promise<SearchResult>; selectPreset: (request: string, ids: string[]) => Promise<Decision & { preset_id: string }>; runEdit: () => Promise<PatternRunResult>; interpretRhythm?: () => Promise<Decision & { intent: RhythmIntent | null }>; interpretEdit?: () => Promise<Decision & { intent: VelocityIntent | null }>; random?: () => number };

export async function runPatternTree({ state, request, route, searchPresets, selectPreset, runEdit, interpretEdit, interpretRhythm, random = Math.random }: TreeOptions): Promise<TreeResult> {
  const visits: TreeResult["visits"] = [];
  const usage: Record<string, number> = {};
  let latencyMs = 0;
  let questionCount = 0;
  let model: string | null = null;
  const record = (node: string, response: unknown = {}) => {
    visits.push({ node, response });
    const metrics = response as Decision;
    latencyMs += Number(metrics.latency_ms) || 0;
    questionCount += Number(metrics.question_count) || 0;
    model = metrics.model ?? model;
    for (const [key, value] of Object.entries(metrics.usage ?? {})) if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
  };

  const routed = await route(request);
  record("root", routed);
  if (routed.route.category === "unsupported") return { state, route: routed.route, visits, result: { message: routed.route.message, applied_changes: [] }, model, usage, question_count: questionCount, latency_ms: latencyMs };

  if (routed.route.category === "clear_pattern") {
    const clean = createPatternState(state);
    const nextState = appendHistory({ ...clean, pattern: { ...clean.pattern, notes: [] } }, { request, applied_changes: ["Cleared the whole pattern"], rejected_changes: [] });
    const result = { message: "Cleared the whole pattern.", applied_changes: [{ kind: "reset" }] };
    record("pattern_clear", result);
    return { state: nextState, route: routed.route, visits, result, model, usage, question_count: questionCount, latency_ms: latencyMs };
  }

  if (routed.route.category === "fill_rhythm") {
    if (!interpretRhythm) throw new Error("Rhythm fill is unavailable.");
    const interpreted = await interpretRhythm();
    record("rhythm_interpret", interpreted);
    if (!interpreted.intent) return { state, route: routed.route, visits, result: { applied_changes: [], message: "Please name a drum and quarter, eighth or sixteenth notes, optionally with beat or bar numbers." }, model, usage, question_count: questionCount, latency_ms: latencyMs };
    const applied = applyRhythmFill(state, interpreted.intent, request);
    return { ...applied, route: routed.route, visits, model, usage, question_count: questionCount, latency_ms: latencyMs };
  }

  if (routed.route.category === "edit_pattern") {
    if (interpretEdit) {
      const interpreted = await interpretEdit();
      record("edit_interpret", interpreted);
      if (interpreted.intent) {
        const applied = applyVelocityEdit(state, interpreted.intent, request);
        record("velocity_apply", applied.result);
        return { ...applied, route: routed.route, visits, model, usage, question_count: questionCount, latency_ms: latencyMs };
      }
    }
    const edited = await runEdit();
    record("edit_plan", edited);
    return { ...edited, route: routed.route, visits, model: edited.model ?? model, usage, question_count: questionCount, latency_ms: latencyMs };
  }

  const shuffle = routed.route.category === "shuffle_preset";
  if (!shuffle && routed.route.category !== "load_preset") throw new Error("Invalid request route.");
  const search = await searchPresets(request);
  record("preset_search", search);
  let attributes = search.attributes;
  if (shuffle) {
    // Older browser sessions predate preset_context. Recover their last load.
    const lastLoad = [...state.recent_history].reverse().flatMap(entry => entry.applied_changes).find(change => /^Loaded .* preset$/.test(change));
    const previous = PRESETS.find(item => lastLoad === `Loaded ${item.name} preset`);
    const previousContext = state.preset_context !== undefined ? state.preset_context : (previous ? { preset_id: previous.id, attributes: { genres: [...previous.genres], meter: `${previous.meter.numerator}/${previous.meter.denominator}`, feels: [] } } : null);
    const explicit = search.has_explicit_filters ?? (attributes?.genres?.length || attributes?.feels?.length || (attributes?.meter && attributes.meter !== "unspecified"));
    if (!explicit) attributes = previousContext?.attributes ?? {};
    search.candidate_ids = filterPresets(attributes ?? {}).map(item => item.id).filter(id => id !== previousContext?.preset_id);
    if (!search.candidate_ids.length) return { state, route: routed.route, visits, result: { message: "There isn't another matching beat. Try a different genre or time signature.", applied_changes: [] }, model, usage, question_count: questionCount, latency_ms: latencyMs };
  }
  if (!search.candidate_ids?.length) return { state, route: routed.route, visits, result: { message: "No matching preset is available. Try one of the suggested genres or meters.", alternatives: search.alternatives, applied_changes: [] }, model, usage, question_count: questionCount, latency_ms: latencyMs };
  const selection = shuffle ? { preset_id: search.candidate_ids[Math.floor(random() * search.candidate_ids.length)] } : await selectPreset(request, search.candidate_ids);
  record(shuffle ? "preset_shuffle" : "preset_select", selection);
  const selected = presetById(selection.preset_id);
  if (!selected || !search.candidate_ids.includes(selected.id)) throw new Error("Invalid preset selection.");
  const nextState = loadPreset(state, selected, request);
  nextState.preset_context = { preset_id: selected.id, attributes: attributes ?? { genres: [...selected.genres], meter: `${selected.meter.numerator}/${selected.meter.denominator}`, feels: [] } };
  const result = { preset_id: selected.id, preset_name: selected.name, tempo_bpm: selected.tempo_bpm, message: `Loaded ${selected.name}.`, applied_changes: [{ kind: "load_preset", preset_id: selected.id, preset_name: selected.name }] };
  record("preset_load", result);
  return { state: nextState, route: routed.route, visits, result, model, usage, question_count: questionCount, latency_ms: latencyMs };
}
