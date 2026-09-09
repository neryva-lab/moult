# 7. Implementation Roadmap

This roadmap intentionally delays React, package loading, and HMR. The core must prove its semantics before adapters add complexity.

Status: Phases 0–3 are implemented in this repository. Phase 4 is explicitly
out of scope for Moult, and Phase 5 is the current publication review. The
historical phase descriptions remain here because they define the stop
conditions that governed the implementation.

## Phase 0 — Decision record

Write tests for the replacement contract before writing the runtime. The tests should establish:

- old generation remains active on failed candidate setup;
- candidate resources are fully disposed;
- contributions are staged until commit;
- active dependents block provider stop by default.

Stop condition: if these semantics cannot be expressed without hidden globals or ambiguous ownership, revise the design before implementation.

## Phase 1 — Core package

Implement only:

- immutable plugin definitions;
- capability tokens and semver requirements;
- deterministic resolver;
- generation-scoped async disposal;
- staged capabilities and contributions;
- start, stop, replace, uninstall;
- structured inspection and errors;
- independent runtime instances.

Do not add a database, UI, event bus, loader, or HMR bridge in this phase.

Exit gate: all core unit, transaction, and stress tests pass.

## Phase 2 — Test host and examples

Build a fake host with observable resources:

- timers;
- event subscriptions;
- service providers;
- contributions;
- intentionally failing resources.

Create two unrelated examples, such as a command host and a worker host. They should share the core package but not share application code.

Exit gate: replacement and leak tests run in both examples.

## Phase 3 — Adapters

Add adapters one at a time:

1. typed event capability;
2. React contribution adapter;
3. Vite HMR adapter.

Each adapter must use the core lifecycle API rather than creating a parallel lifecycle implementation.

Exit gate: adapter failures preserve core invariants.

## Phase 4 — Sky integration (out of scope for this repository)

Sky integration is intentionally not a Moult repository deliverable. This
repository ends its implementation roadmap after the host-independent adapters
and proof artifacts in Phase 3. No Sky inventory, bridge, UI migration,
database migration, or registry removal is planned here.

If a downstream Sky project later adopts Moult, that work belongs to the Sky
project and must define its own transitional compatibility boundary and
validation plan.

## Phase 5 — Publication review

Review the results against the thesis:

- Is the core genuinely host-agnostic?
- Does failed replacement behave materially better than ordinary plugin systems?
- Are the guarantees narrow and proven?
- Do unrelated hosts benefit from it?
- Is there a reason for users to adopt it instead of Cordis, Pi extensions, or a small local registry?

If the answer to the final question is no, keep the packages unreleased and do
not publish a generic framework.

## First implementation files

When implementation begins, the package should start with a small surface:

```text
packages/runtime-core/src/
  capability.ts
  definition.ts
  errors.ts
  resolver.ts
  scope.ts
  contributions.ts
  runtime.ts
  inspection.ts
  index.ts
packages/runtime-core/test/
  scope.test.ts
  resolver.test.ts
  runtime.test.ts
  replacement.test.ts
```

The current Sky files should not be copied into this package as the initial implementation. They are application evidence and migration input, not a clean core boundary.
