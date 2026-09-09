# Moult

[![verify](https://github.com/neryva-lab/moult/actions/workflows/verify.yml/badge.svg)](https://github.com/neryva-lab/moult/actions/workflows/verify.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A general plugin runtime for safe replacement, in TypeScript.

> **Thesis** — a plugin is a versioned capability provider running inside an
> owned resource scope. A replacement is prepared in isolation, committed only
> after successful preparation, and followed by disposal of the previous
> generation.

The name is the mechanism: a crab grows a new exoskeleton beneath the old one
and sheds the old shell only after the new one is complete. A failed moult
leaves the old shell intact.

## The problem it solves

Every plugin system can _start_ and _stop_ plugins. Almost none can _replace_
one safely. Swapping a live plugin for a new version of it — a new dependency
bundle, a hot-reloaded module, an upgraded driver — is a transaction: the new
version must be prepared without disturbing the old one, committed only if
preparation fully succeeds, and the old generation must then be disposed
completely. Get any of that wrong and a failed upgrade has already torn down
the working system.

Moult makes that transaction the primitive. The engine enforces fifteen named
invariants (INV-01…INV-15, documented in [`docs/guarantees.md`](docs/guarantees.md)),
each proven by tests, including nine replacement-contract tests written before the
implementation existed:

| Guarantee           | Statement                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Failed replacement  | A candidate whose setup fails is disposed completely; the old generation stays active **and usable** (INV-01/07)                 |
| Atomic commit       | Staged capabilities and contributions are invisible until commit; after commit there is no rollback — ever (INV-06/08)           |
| Owned resources     | Every resource belongs to a scope; disposal runs LIFO, survives disposer failures, and leaves zero live resources (INV-02/03/12) |
| Dependents          | Stopping a provider with active dependents is rejected unless cascade is explicit, ordered, and recorded (INV-11)                |
| Structured failures | Every failure is a `MoltError` with a stable code — never a warning, never a log line (INV-10)                                   |
| No globals          | Runtime instances share nothing; resolution is deterministic and order-independent (INV-13)                                      |

## Why a simple registry is not enough

A registry that replaces the current value as soon as setup begins cannot
preserve a working generation when the replacement fails:

```ts
registry.set('storage', await next.setup()); // the old value is already lost
```

Moult prepares `next` in an isolated generation, publishes only after complete
validation, and disposes the previous generation after commit. The measured
comparison, including naive-registry and Cordis rows, is in
[`demo/comparison/RESULTS.md`](demo/comparison/RESULTS.md).

## Non-goals

- **Not a sandbox.** Plugins are trusted code; Moult governs lifecycle and
  capability _visibility_, not permissions.
- **Not an effect system.** No algebraic effects, no managed runtime — plugins
  are ordinary async functions with a scope.
- **Not a loader or bundler.** You hand Moult definitions; how they were
  imported is your business.
- **No global registry.** No `app.use(...)` singleton; the host owns instances.
- **No automatic rebinding.** v1 rejects provider replacement with active
  dependents rather than silently re-wiring them.

## Why not …

**…Effect?** Effect is a programming model — it replaces how you write
application logic. Moult is a lifecycle kernel — it governs how _plugins as
units of deployment_ start, compose, and get replaced. They compose; they do
not compete.

**…TC39 `using` / `DisposableStack`?** Explicit resource management scopes a
resource to a lexical block you wrote ahead of time. It cannot resolve a
dependency graph, version-check providers, or atomically replace a
long-running generation while consumers hold its capabilities — Moult is built
out of scopes, not instead of them.

**…Cordis?** Cordis is a closely related lifecycle system, and the comparison
demo includes a pinned Cordis release. Moult makes a narrower claim: in the
documented scenario, a failed candidate replacement keeps the previous
generation serving until a new generation is fully prepared and committed.
Moult records disposal failures as inspectable diagnostics rather than claiming
to roll back arbitrary external effects.

## Packages

| Package                                             | Status                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@moult/runtime`](packages/runtime-core/README.md) | The core runtime. Implemented; not yet released.                             |
| [`@moult/test`](packages/test/README.md)            | Implemented support package for ownership, replacement, and leak assertions. |
| [`@moult/events`](packages/events/README.md)        | Implemented typed, generation-scoped event capability.                       |
| [`@moult/react`](packages/react/README.md)          | Implemented committed-snapshot React adapter.                                |
| [`@moult/vite`](packages/vite/README.md)            | Implemented host-neutral Vite HMR lifecycle bridge.                          |

## Development

```bash
pnpm install && pnpm verify   # typecheck + type-checked lint + knip
pnpm build                    # dual ESM/CJS via tsdown
pnpm test                     # unit suite (node + happy-dom)
pnpm test:coverage            # unit suite with coverage thresholds
pnpm test:property            # fast-check property suite (model-based)
pnpm test:stress              # stress suite (1k definitions, replace-100×, soak)
pnpm test:adapters             # host and adapter failure suites
pnpm test:browser              # Playwright browser smoke (Chromium required)
pnpm bench                     # naive registry vs Cordis vs Moult evidence
pnpm check:pkg                # publint + arethetypeswrong
pnpm check:arch               # dependency-cruiser core-purity rules
pnpm check:api                # api-extractor diff vs the reviewed API file
pnpm release:dry-run          # Changesets plan + no-upload package publish simulation
```

Comparison results are regenerated by `pnpm bench` in [`demo/comparison/RESULTS.md`](demo/comparison/RESULTS.md).
The public validation and publication criteria are summarized in
[`docs/notes/06-validation-and-release-gates.md`](docs/notes/06-validation-and-release-gates.md).

## Contributing

Read the [design notes](docs/notes/README.md) and [guarantees](docs/guarantees.md)
first — the invariants are the product, and a PR that simplifies one to make
implementation easier is rejected regardless of what else it adds. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the mechanics.

## License

[MIT](LICENSE)
