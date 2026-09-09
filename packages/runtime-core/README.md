# @moult/runtime

A general plugin runtime for safe replacement.

> A plugin is a versioned capability provider running inside an owned resource
> scope. A replacement is prepared in isolation, committed only after
> successful preparation, and followed by disposal of the previous generation.

The name is the mechanism: a crab grows a new exoskeleton beneath the old one
and sheds the old shell only after the new one is complete. A failed moult
leaves the old shell intact.

## What it guarantees

- **Failed replacement is invisible.** A candidate whose `setup` throws is
  disposed completely; the previous generation stays active and usable
  (INV-01/07).
- **Commit is atomic.** Staged capabilities and contributions are invisible
  until commit, and the old generation is never restored after it (INV-06/08).
- **Every resource has an owner.** Disposal runs LIFO, continues after
  individual failures, and leaves zero live resources behind (INV-02/03/12).
- **Dependents are respected.** Stopping a provider with active dependents is
  rejected unless you ask for an explicit, ordered, recorded cascade (INV-11);
  replacing a provider whose dependents are active is rejected in v1 (INV-15).
- **Nothing global.** Instances share nothing; resolution is deterministic;
  every failure is a structured `MoltError` with a stable code (INV-10/13).

## Install

```bash
npm install @moult/runtime
```

Node ≥ 22. Dual ESM/CJS, one runtime dependency (`semver`).

## Related packages

- [`@moult/events`](https://www.npmjs.com/package/@moult/events) — typed,
  generation-scoped events.
- [`@moult/react`](https://www.npmjs.com/package/@moult/react) — committed
  React contributions.
- [`@moult/test`](https://www.npmjs.com/package/@moult/test) — public test-host
  and leak assertions.
- [`@moult/vite`](https://www.npmjs.com/package/@moult/vite) — Vite HMR
  lifecycle bridge.

## Example

```ts
import { capability, createRuntime } from '@moult/runtime';

const storage = capability<{ get(key: string): string | undefined }>('storage', '1.0.0');

const runtime = createRuntime();
runtime.install({
  id: 'memory-storage',
  version: '1.0.0',
  provides: [{ capability: storage }],
  setup: (context) => {
    const map = new Map<string, string>();
    context.provide(storage, { get: (key) => map.get(key) });
  },
});
await runtime.start('memory-storage');

// A broken replacement leaves the old generation serving:
await runtime.replace({
  id: 'memory-storage',
  version: '2.0.0',
  provides: [{ capability: storage }],
  setup: () => {
    throw new Error('bug in the new version');
  },
}); // rejects — and memory-storage is still active
```

## Status

Implemented; packaged but not yet released. The design notes and the full
invariant registry (INV-01…INV-15) live in the repository
under `docs/`. See the root README for scope, non-goals, and how Moult compares
to Effect, TC39 `using`, and Cordis.

## Documentation

See the [Moult repository](https://github.com/neryva-lab/moult), the
[lifecycle guarantees](https://github.com/neryva-lab/moult/blob/main/docs/guarantees.md),
and the [adapter design](https://github.com/neryva-lab/moult/blob/main/docs/notes/05-adapters-and-host-integration.md).
