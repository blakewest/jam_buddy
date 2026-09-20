export const REQUEST_CATEGORIES = Object.freeze({
  edit_pattern: Object.freeze({ description: "edit the current beat", next_node: "edit_plan" }),
  load_preset: Object.freeze({ description: "pick a beat preset", next_node: "preset_search" }),
  unsupported: Object.freeze({ description: "request something outside the available beat tools", next_node: null }),
});

export function unsupportedMessage() {
  const supported = Object.entries(REQUEST_CATEGORIES).filter(([id]) => id !== "unsupported").map(([, category]) => category.description);
  return `I didn't get that. I can ${supported.join(" or ")}.`;
}

export function resolveRoot(category) {
  if (!Object.hasOwn(REQUEST_CATEGORIES, category)) throw new Error("Invalid request category.");
  return { category, next_node: REQUEST_CATEGORIES[category].next_node, message: category === "unsupported" ? unsupportedMessage() : null };
}
