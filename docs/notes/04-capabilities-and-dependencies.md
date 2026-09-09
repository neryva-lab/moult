# 4. Capabilities and Dependencies

## Why capabilities are not plain strings

String names alone do not answer:

- which provider owns the service;
- whether the provider's version is compatible;
- whether two providers are allowed;
- whether the requirement is optional;
- whether the consumer is allowed to access the service.

The runtime therefore resolves a declared requirement to exactly one capability value, unless the capability explicitly supports multiple providers.

## Provider rules

For a single-provider capability:

- zero providers is a missing-capability error if the requirement is required;
- one compatible provider is valid;
- more than one compatible provider is an ambiguity error;
- an incompatible provider does not satisfy the requirement;
- a plugin cannot provide a capability it did not declare.

For a multi-provider capability, the token must declare that policy. Consumers receive a stable ordered collection; map iteration order is not a valid policy. The ordering is host providers first, followed by plugin providers sorted by plugin ID in lexicographic order.

Built-in host capabilities are represented by the same token mechanism as plugin-provided capabilities. “Core” is not a magic string exception.

## Versioning

Capability versions and plugin versions are different:

- plugin version identifies the implementation being run;
- capability version identifies the contract exposed to consumers.

Requirements use a documented semver range. A provider may expose a capability version independent of its plugin version.

The implementation uses one well-defined semver implementation for range
validation and matching. It must not implement an ad-hoc comparison such as
lexical string sorting.

## Graph construction

The resolver builds a graph from actual provider selection, not merely from manifest order.

```text
consumer --requires--> capability --selected provider--> provider
```

The resolver must:

1. validate all plugin IDs and capability IDs;
2. validate that every requirement has a satisfiable provider;
3. reject duplicate IDs;
4. reject incompatible versions;
5. reject ambiguous single providers;
6. detect and report the full cycle path;
7. produce a deterministic activation order;
8. retain reverse edges for dependent-stop calculations.

The output should be an inspection object, not only an array of IDs:

```ts
interface ResolutionPlan {
  order: readonly string[];
  providers: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
  edges: readonly { from: string; to: string; reason: string }[];
}
```

## Dynamic changes

Installing a new provider does not silently replace an active provider. A host must request an explicit `replace` or `reconfigure` operation. This avoids changing the meaning of an active consumer because a new package happened to arrive.

Removing a definition that has active dependents is rejected unless the host explicitly requests a cascade. Persistence is host-owned; removing a stopped definition does not itself delete host data.

## Capability access during setup

Required capabilities are resolved before setup starts. Optional capabilities return `undefined` or a typed optional result. A plugin must not call a generic `get('anything')` escape hatch.

```ts
const analytics = ctx.optional(analyticsCapability);
analytics?.track('plugin.started');
```

If a plugin publishes a capability, it may use its own value during setup only if the runtime defines that behavior explicitly. The initial design should reject self-resolution to avoid initialization cycles.

## Diagnostics

For a blocked plugin, inspection should answer:

```text
example.consumer cannot start
└─ requires storage >= 2.0.0
   ├─ storage.local provides 1.4.0 (incompatible)
   └─ storage.remote provides 2.1.0 but is disabled
```

This is more useful than a generic “dependency not active” exception and is necessary for a general library.
