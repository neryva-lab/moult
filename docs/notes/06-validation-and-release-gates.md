# 6. Validation and Release Gates

No publication decision should be made from a successful build alone. The runtime's value is in failure behavior, so the test suite must be designed around failure.

## Unit tests

Core tests must cover:

- definition validation and duplicate IDs;
- deterministic resolution order;
- missing, optional, incompatible, duplicate, and multi-provider capabilities;
- cycle diagnostics with the complete cycle path;
- independent runtime instances;
- resource acquisition and reverse disposal order;
- disposer failure aggregation;
- aborting a scope during asynchronous setup;
- idempotent scope and runtime disposal;
- duplicate contribution IDs;
- generation identity and stale-generation rejection.

## Transaction tests

These are release blockers:

1. Setup throws after acquiring three resources: all three are disposed.
2. A candidate replacement throws: the old generation remains active and usable.
3. Candidate validation fails: no candidate capability or contribution is visible.
4. Old disposal fails after commit: the new generation remains active and the failure is inspectable.
5. The same plugin is replaced 100 times: runtime-owned resource count returns to baseline.
6. A dependent is stopped without cascade: the operation is rejected and no state changes.
7. A provider is stopped with cascade: dependents stop first and the order is deterministic.
8. Runtime disposal is called twice: no duplicate disposer calls and no unhandled rejection.
9. A provider replacement with active dependents either replaces the affected closure atomically or is rejected without changing state.

## Property and stress tests

Generate random acyclic graphs with:

- at least 1,000 plugin definitions;
- single and multi-provider capabilities;
- optional and versioned requirements;
- random activation failures;
- random replacement and stop operations.

Assert graph invariants after every operation:

```text
active plugin → has exactly one active generation
visible capability → belongs to an active generation or host provider
visible contribution → belongs to an active generation
disposed generation → owns zero live runtime resources
```

Use fake resources with counters. Do not rely only on garbage collection or browser memory tooling.

## Adapter tests

The core test suite must run without adapter packages. Adapter suites should prove:

- React contributions disappear on replacement;
- a component error is isolated to its contribution;
- Vite update failures preserve the old generation;
- generation-scoped event subscriptions disappear with their generation;
- host integration errors preserve their structured cause and are not silently swallowed.

## Build and package checks

Before release:

- typecheck with strict TypeScript settings;
- run unit, integration, property, and stress tests;
- verify core bundle imports no browser/UI/database modules;
- test Node and browser-like environments;
- test the published dual ESM/CommonJS entry points;
- generate API declarations and inspect them as a consumer;
- verify package exports prevent accidental access to internal modules;
- run a clean install and build from the published tarball.

## Comparison demo

The replacement/leak benchmarks required below are one scripted, three-way comparison. The same scenario runs against three runtimes:

1. a naive registry (register, activate, no ownership);
2. the current Cordis release, with its version recorded;
3. Moult.

The scenario: a plugin acquires listeners, timers, and UI contributions, then receives a replacement whose setup fails, followed by one whose setup succeeds. Each run reports:

- whether the old generation kept serving during the failed window;
- resource counters after repeated replacement;
- the diagnostic a user sees for a blocked plugin.

The output is a table and a reproduction script. It is the evidence behind the README, and the README links to it. If Moult's row is not visibly better than the naive registry's row, the thesis fails and publication stops.

## Evidence required for a “publish” decision

Publish only when all of the following exist:

- a working core package;
- at least two real host adapters or example hosts;
- reproducible replacement/leak benchmarks (the comparison demo above);
- documented limitations;
- no known lifecycle invariant failures;
- an example showing why a normal event emitter or simple plugin list is insufficient.

If the implementation cannot meet these gates, keep the packages unreleased and
document the missing evidence. Sky integration is outside this repository's
scope, so publication must not depend on an undocumented downstream migration.
