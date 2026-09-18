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

Frederic's research-specific perceptual-model requirements and prohibition on learned models do not apply to this TypeSafe demo.
