# 1. Thesis and Boundaries

## The problem

Many plugin systems make installation easy and removal vague. A plugin registers listeners, commands, services, timers, routes, or workers, and the host later has to remember how to undo each one. Hot reload makes the weakness visible: repeated replacement leaves duplicate listeners, stale services, orphaned UI, or a half-installed plugin.

The runtime addresses one specific problem:

> How can a host replace a running plugin and know which runtime-managed resources belong to which plugin generation?

The answer is ownership plus a two-phase replacement protocol:

1. Prepare a candidate generation in a private scope.
2. Commit the candidate only after setup succeeds.
3. Dispose the previous generation after the commit.

## What is potentially differentiated

The interesting unit is not “a plugin registry” or “an event bus.” Those are common. The useful combination is:

- capability-based dependency resolution;
- per-generation resource ownership;
- staged contributions that are invisible before commit;
- replacement that keeps the old generation active if preparation fails;
- diagnostics that expose the ownership graph.

Positioning against existing systems is recorded in [8. Positioning and related work](./08-positioning-and-related-work.md).

This is a hypothesis to validate, not a marketing claim. It earns publication only if the implementation demonstrates stronger failure behavior than ordinary plugin registries and works in more than Sky.

## Guarantees

For resources created through the runtime API, the core guarantees:

- activation failure disposes every resource acquired by that activation attempt;
- disposal is attempted in reverse acquisition order;
- disposal continues after an individual disposer fails;
- a scope cannot be committed twice;
- a committed generation can be disposed at most once;
- a replacement candidate is not observable through staged runtime registries before commit;
- a failed replacement does not replace the active generation;
- a plugin cannot resolve a capability that its declared requirements do not permit it to use.

These guarantees are testable invariants and must not be stated more broadly.

## Deliberate non-goals

The core does not provide:

- a UI framework, router, component slot system, or React hooks;
- a database engine, persistence format, or migration policy;
- a package installer or JavaScript module loader;
- a security sandbox for untrusted JavaScript;
- automatic rollback of arbitrary external effects;
- a global singleton runtime;
- an implicit string event protocol presented as a type-safe API;
- a promise that every host can perform a physically atomic external switch.

A plugin can still call `fetch`, mutate a DOM node, or write to a database directly if the host gives it access. The runtime cannot undo those actions. The API and documentation must make this limitation explicit.

## Host model

The host creates a runtime instance and supplies host capabilities explicitly:

```ts
const runtime = createRuntime({
  providers: [
    { capability: loggerCapability, value: hostLogger },
    { capability: clockCapability, value: hostClock },
  ],
});

runtime.install(loggerPlugin);
await runtime.start('logger');
```

Multiple runtime instances must be supported in the same process. A test, preview, browser tab, or server request must not share hidden mutable state with another instance.

## Success criteria

The library is worth continuing only if it can satisfy all of these:

1. The core package has no browser, UI, or database imports.
2. The same core tests run in Node and a browser-like environment.
3. A failed candidate replacement leaves the old generation active and usable.
4. Replacing a plugin repeatedly produces no growth in runtime-owned resources.
5. A host can inspect why a plugin is blocked without reading internal maps.
6. At least two unrelated host adapters can use the same core contracts.
