# Project guidance

General engineering conventions adapted from the Frederic project.

- Keep responses concise and solutions simple. Avoid speculative abstractions.
- Prefer clear ownership, explicit data models, small orchestration functions, and stable interfaces.
- Treat long signatures, repeated conditionals, deep nesting, and implementation-specific dispatch as signals to reconsider responsibilities, not reasons to impose arbitrary size limits.
- Mock, replay, and live implementations should share the same contracts.
- Keep pure state and timing logic separate from browser UI, audio playback, and network calls.
- For JavaScript, follow Frederic's observed conventions: ES modules, two-space indentation, semicolons, double-quoted strings, and camelCase functions/local variables. Preserve the agreed snake_case fields in model state and recordings.
- Make time units explicit. Keep observed input distinct from future scheduled output; never leak future fixture events into a live snapshot.
- Bound history and queues. Avoid repeated work and unnecessary allocations in event and audio scheduling paths.
- Measure performance through the real user workflow. Report environment, warmup, repetitions, timing results, and correctness evidence; do not call an unmet timing target complete.
- Label demo thresholds and timing defaults as engineering choices rather than facts about human hearing.
- Keep generated plans and reports under `.superpowers/` or `docs/superpowers/` local and uncommitted.
- Use the installed TypeSafe skill for this project's TypeSafe decisions and integration.
- Route every natural-language pattern request through one explicit decision tree. The root asks which supported category the request belongs to; deterministic code owns traversal and execution.
- Keep TypeSafe tree nodes small and typed, with stable IDs, question builders, answer validation, and explicit next-node or handler outcomes.
- Ask all independent, branch-relevant questions in the same API call. Add context only after the selected branch needs it, and keep candidate answer sets small and concrete.
- Preserve the existing pattern-edit planner and atomic edit loop as the `edit_pattern` branch. Add new capabilities as separate root branches rather than mixing their behavior into editing prompts.
- Generate unsupported-request guidance from the registered root categories so the message stays consistent with actual capabilities.

Frederic's research-specific perceptual-model requirements and prohibition on learned models do not apply to this TypeSafe demo.
