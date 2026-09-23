import { KITS } from "../core/pattern/kits.js";
import { NODE_CHOICES, REQUEST_CATEGORIES, nodeOutcome } from "../core/pattern/request-tree.js";

const choice = (question, criteria, focus) => ({ selection: {
  type: "choice",
  instructions: { question, focus, inspect: ["request", "kit_id", "recent_history"], context: "The current request is authoritative. History only resolves references. Never act on an older request instead." },
  criteria,
} });

export const REQUEST_NODES = Object.freeze({
  root: {
    id: "root",
    buildQuestions: () => choice("Which single supported category does `request` belong to?", {
      ...Object.fromEntries(Object.entries(REQUEST_CATEGORIES).map(([id, description]) => [id, { meaning: description }])),
      unsupported: { meaning: "Outside supported capabilities, no actionable request, or combines different actions (such as undo plus editing, or kit swapping plus note editing). Effects, compression, tempo changes and per-instrument sample replacement are unsupported." },
    }, "Requests like 'Undo that', 'undo', 'revert the last change' and 'take that back' select undo. Undo restores the complete latest change locally; never route these to note editing. Requests to redo, undo several changes at once, or selectively undo an older change are unsupported. A kit change selects sounds while preserving every note. A note edit changes the rhythm or velocity. Route requests for unavailable whole kits to change_kit so that node can reject them."),
    validate: answers => nodeOutcome("root", answers),
  },
  change_kit: {
    id: "change_kit",
    buildQuestions: () => choice("Which available whole drum kit best satisfies `request`, given the current `kit_id`?", {
      ...Object.fromEntries(KITS.map(kit => [kit.id, { name: kit.name, sound: kit.description }])),
      keep_current: { meaning: "The user asks to keep this kit, or there is no suitable directional change." },
      unsupported: { meaning: "Explicitly requests an unavailable kit (including LinnDrum or 909), individual drum sound replacement, or a capability beyond whole-kit selection." },
    }, "Explicit kit names win. '505' means TR-505. 'Acoustic' or 'natural' means Acoustic. For generic 'more modern/electronic' from Acoustic choose 808 as this demo's default. 'Another electronic kit' changes between 808 and TR-505. Never substitute another kit for an explicitly named unavailable kit. 'Back' can refer to a previous kit in history."),
    validate: answers => nodeOutcome("change_kit", answers),
  },
});

export function validRequestState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || Object.keys(state).length !== 3) return false;
  if (typeof state.request !== "string" || !state.request.trim() || state.request.length > 500 || !KITS.some(kit => kit.id === state.kit_id)) return false;
  if (!Array.isArray(state.recent_history) || state.recent_history.length > 8) return false;
  return state.recent_history.every(entry => entry && Object.keys(entry).length === 3 && typeof entry.request === "string" && entry.request.length <= 500
    && [entry.applied_changes, entry.rejected_changes].every(items => Array.isArray(items) && items.length <= 8 && items.every(item => typeof item === "string" && item.length <= 300)));
}

export const isRequestNode = id => Object.hasOwn(NODE_CHOICES, id);
