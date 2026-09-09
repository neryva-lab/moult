# Moult

A general plugin runtime for safe replacement, extracted from the lessons of Sky.

Moult is named after the way a crab replaces its shell: the new exoskeleton forms beneath the old one, and the old shell is shed only after the new one is complete. A failed moult leaves the old shell intact. The runtime applies the same rule to plugins.

The working thesis is:

> A plugin is a versioned capability provider running inside an owned resource scope. A replacement is prepared in isolation, committed only after successful preparation, and followed by disposal of the previous generation.

This is the public design and contract for an implemented, not-yet-released
library. It records the thesis, guarantees, boundaries, and publication
criteria; the package READMEs and generated API reference describe the current
implementation.

## Documents

1. [Thesis and boundaries](./01-thesis-and-boundaries.md) — what problem the library solves and what it refuses to promise.
2. [Core model and API](./02-core-model-and-api.md) — the host-neutral contracts.
3. [Lifecycle and transactionality](./03-lifecycle-and-transactionality.md) — activation, failure, replacement, and disposal semantics.
4. [Capabilities and dependencies](./04-capabilities-and-dependencies.md) — typed services, version ranges, provider selection, and dependent plugins.
5. [Adapters and host integration](./05-adapters-and-host-integration.md) — package charters, React, Vite HMR, and host integration outside the core.
6. [Validation and release gates](./06-validation-and-release-gates.md) — tests, the comparison demo, and evidence required before publication.
7. [Implementation roadmap](./07-implementation-roadmap.md) — an intentionally staged build plan with stop conditions.
8. [Positioning and related work](./08-positioning-and-related-work.md) — existing systems, the unoccupied claim, and the naming record.
9. [Packages and distribution](./09-packages-and-distribution.md) — publishable set, TanStack/Effect-style scoped distribution, install patterns, and how to add a new adapter.
10. [Public guarantees](../guarantees.md) — the INV-01…INV-15 guarantee registry in a concise public form.

The executable engineering plan and release ledger are maintainer-only
materials and are not part of the published repository. The public contract is
summarized in [`../guarantees.md`](../guarantees.md).

## Non-negotiable design rules

- Every package must state the problem it solves. A package that cannot state its problem is not published.
- The core must run without React, Zustand, sql.js, IndexedDB, Vite, or browser globals.
- Every runtime-managed resource must have an owner and an idempotent disposer.
- A failed activation must leave no resource registered in the runtime.
- A failed replacement must leave the previous active generation intact.
- Dependency ambiguity, missing requirements, version conflicts, and cycles are errors—not warnings that are pushed to runtime.
- Uninstalling a plugin must not silently destroy persisted data.
- Security isolation is out of scope unless a separate sandbox host is used.

## Naming and publication record

- Name: **Moult**. The rationale and the rejected alternatives are recorded in [8](./08-positioning-and-related-work.md).
- npm scope: `@moult` (for example `@moult/runtime`, `@moult/react`, `@moult/vite`, `@moult/test`). The project uses the scoped namespace; package availability and ownership of unscoped names must be rechecked immediately before release.
- Directory names such as `runtime-core` remain working names; published names use the scope.
- The `github.com/molt` account is a dormant personal account, not a project collision. The repository lives at `github.com/neryva-lab/moult` (moved 2026-09-09 from `github.com/neryva-lab/molt`, which had moved 2026-09-08 from `github.com/Luke23-45/molt`; the planned `moltjs` organization was never created; the remote, package metadata, and publication docs now point to the new location; 2026-09-09: the project adopted the npm scope `@moult`; organization creation remains an owner action).
