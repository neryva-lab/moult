---
'@moult/runtime': minor
---

Add a dedicated `rolledback` lifecycle event and pin refcounting via `retainPin`.

`rolledback` is emitted once after a successful `rollback()` — after the replacement pipeline's `replaced` events — and by the `onUnhealthy: 'rollback'` health policy after its automatic rollback. The event carries the restored generation id, and `transitions()` records it as a `rolledback` transition following the pipeline's `replaced` entry. Subscribers tracking only `replaced` are unaffected.

`retainPin(id)` extends a pinned generation's lifetime for external holders: it increments the pin's retainer count and returns an idempotent release function. A superseding pin, `stop()`, `uninstall()`, or runtime disposal releases the runtime's own hold but never disposes a generation with live retainers — it survives in `inspect().retainedPins` until the last release, which disposes it with a `stopped` event. Only runtime disposal force-releases live retainers. `retainPin` throws `INVALID_STATE` when the plugin has no pinned generation.
