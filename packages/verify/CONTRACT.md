# The replaceable-plugin contract

A Moult plugin is a _unit of deployment_: it can be installed, started, stopped, replaced, and uninstalled while the host keeps running. Replacement is only safe if every plugin obeys this contract. Half of it is statically checkable — that half is enforced by `@moult/verify` (`verifyDefinition` / `verifyGraph`). The other half is behavioral; it is documented here and enforced at runtime by the lifecycle engine.

## Static half (checked by `@moult/verify`)

These are shape rules. A definition that violates them fails at `install()` / `replace()` with `INVALID_DEFINITION` (or `DUPLICATE_PLUGIN` / `AMBIGUOUS_PROVIDER` for graph conflicts), so catching them statically is catching them early.

1. **Identity.** `id` is required and must match the runtime id grammar: dot-separated segments, each starting with a lowercase letter followed by lowercase letters, digits, or hyphens (e.g. `acme.storage`, `my-plugin.store-2`). `version` is required and must be valid semver. Consumers resolve providers by id and select by semver range — an id the grammar rejects, or a version no range can match, can never participate in the graph.
2. **Entry point.** `setup` is required and must be a function. It runs inside the generation's scope; everything the plugin owns must be created or adopted there.
3. **Declared surface.** `provides` and `requires` must be arrays when present. Each provided capability needs `{ id, version }` with a valid id and version; `multiple` must be a boolean when present and must agree with the token's own provider policy. Each requirement needs `capability: { id }` with a valid id; `range` must be a valid semver range when present; `optional` must be a boolean when present. No duplicate capability ids within one definition, in either direction. A plugin must not both require and provide the same capability id — the resolution graph is acyclic by construction, and a self-edge would make the plugin its own dependency.
4. **Configuration.** `config` must be a plain record when present; it is merged over definition defaults and validated by `validateConfig` before the plugin starts. `stateVersion` must be a string or number when present — `migrate` switches on it, not on the plugin version, when the shape of provided state changes independently of releases.
5. **Hooks are functions.** `validateConfig`, `migrate`, `drain`, and `healthCheck` must be functions when present. Unknown top-level fields are ignored by the runtime; the linter warns (`unknown-field`) rather than failing, so forward-compatible definitions keep working.
6. **Graph coherence.** Across a set of definitions: no two plugins share an id, and no capability id is claimed as a _single_ provider by two definitions. Either claim being `multiple: true` exempts the pair — multi-provider tokens aggregate by design. Violations surface at runtime as `DUPLICATE_PLUGIN` / `AMBIGUOUS_PROVIDER`.

## Behavioral half (enforced at runtime, documented here)

These cannot be proven from the definition object. They are obligations on the plugin author's code, and the engine is built on the assumption that they hold.

1. **Disposal must be idempotent and total.** Everything `setup` acquires — listeners, timers, sockets, file handles — must be released by the generation's scope disposers. Disposers run LIFO, continue on error, and run exactly once; a second call must be a no-op, because the engine may dispose a generation on the failure path as well as the normal path. Anything not adopted by the scope leaks across the replacement boundary and is a bug in the plugin, not the runtime.
2. **No uncaptured listeners or leaked timers.** A `setInterval`, a subscription on a host event bus, or a listener on a shared emitter that is not tied to the generation's scope (via `scope.onDispose` / the `AbortSignal`) survives replacement and keeps executing against a dead generation. If it touches state, that state is now shared mutable state across generations — the exact failure mode the generation model exists to prevent.
3. **No cross-generation object capture.** `migrate` receives the previous generation's provided values; it must treat them as _read-only input_ and re-provide fresh values (or explicitly adopted ones) from the new generation. Holding a reference to the old generation's mutable objects — caches, connection pools, registries — and mutating them from the new generation breaks the transaction's isolation: a failed replacement rolls back to the old generation, which must be intact.
4. **`setup` must not depend on wall-clock ordering.** A plugin whose setup assumes it runs before/after another plugin's setup, or assumes a fixed delay, is racing the resolver. Ordering comes only from declared `requires` edges; anything else is an undeclared dependency. (The one sanctioned exception: `migrate` runs after the candidate's own `setup`, inside the candidate's scope — that ordering is contractual.)
5. **`healthCheck` must be side-effect free and fast.** It runs as a readiness gate inside the replacement transaction and on demand via `checkHealth()`. It must not mutate state, start work, or block: a slow check burns the health timeout budget (`healthMs`), and expiry counts as unhealthy — failing the replacement. Keep it to reading already-maintained state.
6. **`drain` cooperates, then lets go.** `drain` lets in-flight work finish before disposers run, but the drain timeout aborts its signal and disposal proceeds regardless. A drain that ignores the signal wedges nothing (the engine moves on) but its abandoned work still belongs to the plugin — finish or cancel it; don't orphan it.
7. **Migrations must be total over declared `stateVersion`s.** If `stateVersion` can be `"v1"` in the wild, `migrate` must handle `"v1"` input — including the case where the previous generation declared no `stateVersion` at all (`undefined`). A migration that throws fails the replacement and rolls back; that is the safe outcome, but it should be a deliberate one, not a missing `switch` arm.

## Reading map

| Rule                     | Checked by                         | Runtime backstop                                                                                  |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1–6 (static half)        | `verifyDefinition` / `verifyGraph` | `install` / `replace` validation (`INVALID_DEFINITION`, `DUPLICATE_PLUGIN`, `AMBIGUOUS_PROVIDER`) |
| Disposal totality        | —                                  | scope disposal: LIFO, continue-on-error, exactly-once                                             |
| Leaked timers/listeners  | —                                  | `AbortSignal` on the scope; generation isolation                                                  |
| Cross-generation capture | —                                  | transaction rollback restores the old generation                                                  |
| Setup ordering           | —                                  | resolver topological order from declared edges                                                    |
| `healthCheck` discipline | —                                  | `healthMs` timeout; unhealthy fails the transaction                                               |
| `drain` cooperation      | —                                  | `drainMs` timeout aborts the drain signal                                                         |
| Migration totality       | —                                  | migration failure rolls the transaction back                                                      |
