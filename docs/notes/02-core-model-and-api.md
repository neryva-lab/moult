# 2. Core Model and API

This document describes the current public core contract implemented by
`@moult/runtime`. The names and semantics below are the release-candidate
surface; any future breaking change must be recorded as a separate public
decision.

## Core concepts

| Concept           | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| Plugin definition | Immutable metadata plus an asynchronous setup function                        |
| Capability        | A typed contract identified by a stable ID and version                        |
| Requirement       | A capability and compatible version range needed by a plugin                  |
| Scope             | The ownership boundary for resources acquired by one generation               |
| Generation        | One installed plugin instance, including its private scope                    |
| Contribution      | A staged runtime registration published at commit                             |
| Runtime           | The owner of definitions, dependency resolution, generations, and diagnostics |

## Capability tokens

Capabilities are tokens, not arbitrary strings passed around by convention.

```ts
export interface Capability<T> {
  readonly id: string;
  readonly version: string;
  readonly multiple: boolean;
  readonly __type?: T;
}

export function capability<T>(
  id: string,
  version: string,
  options?: { readonly multiple?: boolean },
): Capability<T>;
```

The token ID is stable. The version is compared using one documented semver implementation. A host may provide a capability before any plugin starts; a plugin may provide one during setup. The runtime must reject a provider that claims a token but does not publish a value before commit.

For `multiple: false`, a requirement resolves to one value. For
`multiple: true`, declare `T` as the collection type, normally
`readonly Element[]`. Each provider publishes one such collection and the
consumer receives a frozen, ordered concatenation of those collections. The
`multiple` option does not itself constrain `T` to an array at compile time;
the runtime validates that each published multi-provider value is an array.

## Plugin definition

```ts
export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly Requirement[];
  readonly provides?: readonly ProvidedCapability[];
  readonly setup: (
    context: PluginContext,
  ) => void | DisposableLike | Promise<void | DisposableLike>;
}

export interface DisposableLike {
  dispose: () => void | Promise<void>;
}

export type PluginStatus = 'installed' | 'preparing' | 'active' | 'disposing' | 'stopped';

export interface Requirement {
  readonly capability: Capability<unknown>;
  readonly range: string;
  readonly optional?: boolean;
}

export interface ProvidedCapability {
  readonly capability: Capability<unknown>;
  readonly multiple?: boolean;
}
```

`provides` is a declaration of intent and validation metadata. The actual value is published through the context:

```ts
const clock = capability<Clock>('clock', '1.0.0');

const plugin: PluginDefinition = {
  id: 'example.clock',
  version: '1.0.0',
  provides: [{ capability: clock }],
  setup(ctx) {
    ctx.provide(clock, { now: () => Date.now() });
  },
};
```

The setup function must not mutate the definition object. Definitions may be inspected before activation.

## Resource ownership

The core API uses explicit registration rather than an unbounded `effect(setup, teardown)` pair.

```ts
export interface Scope {
  readonly signal: AbortSignal;
  onDispose(disposer: () => void | Promise<void>): void;
  acquire<T>(create: () => T | Promise<T>, dispose: (value: T) => void | Promise<void>): Promise<T>;
  isDisposed(): boolean;
}
```

`acquire` records ownership only after creation succeeds. If disposal is registered manually, it must be idempotent. The runtime must wrap registered disposers so a repeated call cannot dispose the same resource twice.

If `setup` returns a `DisposableLike`, the runtime adopts it into the candidate scope before performing any later validation or commit step. A returned disposer is therefore cleaned up when validation fails as well as when normal shutdown occurs.

`DisposableLike` is the runtime's current `.dispose()` contract. `Scope`
supports asynchronous disposal through `Symbol.asyncDispose`; synchronous
`Symbol.dispose` interoperability is not currently part of the public Moult
contract. Hosts that need `using` declarations must provide that bridge
explicitly, while `await using` can target an object implementing
`Symbol.asyncDispose`.

The runtime must reject new acquisitions after scope disposal. Long-running resources should observe `signal` and stop their own work when aborted.

## Plugin context

```ts
export interface PluginContext {
  readonly pluginId: string;
  readonly generation: string;
  readonly signal: AbortSignal;
  readonly scope: Scope;
  require<T>(capability: Capability<T>): T;
  optional<T>(capability: Capability<T>): T | undefined;
  provide<T>(capability: Capability<T>, value: T): void;
  contribute<T>(key: ContributionKey<T>, value: T): void;
  diagnose(message: DiagnosticInput): void;
}

export interface DiagnosticInput {
  readonly message: string;
  readonly severity?: 'info' | 'warning' | 'error';
  readonly details?: Readonly<Record<string, unknown>>;
}
```

The context is generation-scoped. It must not be reused by a later activation or passed to `deactivate` as if it represented the old generation. Cleanup is represented by the generation's scope, not by a second context.

## Contributions

Host adapters use contributions instead of putting UI concepts in the core:

```ts
export interface ContributionKey<T> {
  readonly id: string;
  readonly __type?: T;
}

export const commandContribution: ContributionKey<CommandContribution> = ...;
```

Contributions are staged inside a candidate generation. On commit, the runtime publishes the candidate's contribution set and withdraws the old generation's set. The core treats the values as opaque; a host adapter decides how to render or execute them.

## Runtime surface

```ts
export interface Runtime {
  install(definition: PluginDefinition): void;
  uninstall(id: string): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string, options?: { cascade?: boolean }): Promise<void>;
  replace(definition: PluginDefinition): Promise<void>;
  getStatus(id: string): PluginStatus | undefined;
  inspect(): RuntimeInspection;
  subscribe(listener: RuntimeListener): () => void;
  contributions(): ContributionSnapshot;
  dispose(): Promise<void>;
}

export interface RuntimeOptions {
  readonly providers?: readonly {
    capability: Capability<unknown>;
    value: unknown;
  }[];
}

export function createRuntime(options?: RuntimeOptions): Runtime;

```

`replace(definition)` is only for an already installed plugin with the same ID. Installing a new ID uses `install`. Replacing an installed definition must validate the new plugin version and capability declarations before preparing its candidate generation.

```ts
export interface RuntimeInspection {
  readonly plugins: readonly {
    id: string;
    status: PluginStatus;
    generation?: string;
    error?: unknown;
    blockedBy?: readonly BlockedDiagnostic[];
    diagnostics?: readonly DiagnosticInput[];
  }[];
  readonly capabilities: readonly {
    id: string;
    provider: string;
    version: string;
  }[];
  readonly observerDiagnostics: readonly {
    readonly message: string;
    readonly cause: unknown;
  }[];
}

export interface RuntimeListener {
  (event: {
    type: 'installed' | 'started' | 'stopped' | 'replaced' | 'failed' | 'disposed';
    pluginId?: string;
    generation?: string;
    cascade?: readonly string[];
    error?: unknown;
  }): void;
}
```

There is no exported global registry. `createRuntime()` returns an independent instance.

`RuntimeInspection`, `ContributionSnapshot`, and observer event payloads are
fresh snapshots. Core-owned metadata is copied and frozen, including nested
diagnostic and blocked-provider records. Contribution values and error causes
are opaque host/plugin values and are not recursively frozen by core.

## Error model

Errors must be structured and preserve causes:

```ts
type RuntimeErrorCode =
  | 'DUPLICATE_PLUGIN'
  | 'INVALID_DEFINITION'
  | 'MISSING_CAPABILITY'
  | 'INCOMPATIBLE_CAPABILITY'
  | 'AMBIGUOUS_PROVIDER'
  | 'DEPENDENCY_CYCLE'
  | 'ACTIVE_DEPENDENTS'
  | 'ACTIVATION_FAILED'
  | 'DISPOSAL_FAILED'
  | 'REPLACEMENT_FAILED'
  | 'INVALID_STATE';
```

`INVALID_STATE` covers lifecycle misuse such as starting an active plugin,
uninstalling an active plugin, replacing an uninstalled ID, accessing a
disposed scope, or re-entering an observer synchronously. Capability
resolution failures keep their more specific resolution codes. Resolution is
keyed by token `id`, never by token object identity; type identity is a
compile-time concern, so separately bundled copies of the token factory resolve
identically.

The error should include the plugin ID, generation if applicable, dependency path, capability ID, and original cause. A log line alone is not an API.
