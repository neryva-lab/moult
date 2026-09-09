# 5. Adapters and Host Integration

The core stays small by making host integration explicit. Every adapter depends on core; core never depends on an adapter.

## Suggested package boundary

```text
packages/
  runtime-core/       # @moult/runtime: definitions, scopes, resolver, lifecycle
  test/               # @moult/test: fake host capabilities and leak assertions
  events/             # @moult/events: optional typed event capability
  react/              # @moult/react: React contributions and error boundaries
  vite/               # @moult/vite: Vite HMR bridge
```

The package names above are the current published set. The dependency direction
is final:

```text
host application ─┬─ @moult/react
                  ├─ @moult/vite
                  ├─ @moult/events
                  └─ @moult/runtime
```

## Package charters

Every package must state the problem it solves. This is a publication gate, not a slogan: a package that cannot state its problem is kept internal or deleted.

| Package | The problem it solves | Published? |
|---|---|---|
| `runtime-core` → `@moult/runtime` | How does a host replace a running plugin and know which runtime resources belong to which generation? | Yes — the only standalone unit. |
| `react` → `@moult/react` | Plugin UI unmounts exactly when its generation is disposed, with per-contribution error isolation. | Adapter; publishes with the core. |
| `vite` → `@moult/vite` | A failed module update keeps the old generation running instead of half-swapping it. | Adapter; also the headline demo of the replacement protocol. |
| `events` → `@moult/events` | Typed event subscriptions that disappear with their generation. | Adapter; publishes with the core because generation-scoped ownership is the problem it solves. |
| `test` → `@moult/test` | Fake host resources with leak counters, so replacement and leak invariants are assertable in any host. | Support package; ships with the core, not a product on its own. |

The adapters exist to prove the core, not to be products. If `runtime-core` does not demonstrate stronger failure behavior than a naive registry, no adapter changes that.

## React adapter

React is an adapter concern. It may define contribution keys such as `react.route`, `react.sidebar-item`, or `react.widget`, but these types must not appear in `runtime-core`.

The adapter is responsible for:

- subscribing to committed contribution snapshots;
- rendering only committed generations;
- placing an error boundary around plugin-provided components;
- removing a generation's components when its scope is disposed;
- preventing a stale component callback from mutating a newer generation.

React component state is not promised to survive replacement. Persisted application state must use a host-provided storage capability.

## Vite HMR adapter

The HMR adapter maps a module update to `runtime.replace(newDefinition)`. It must not implement its own deactivate-register-activate sequence.

Required behavior:

- module import failure leaves the old generation active;
- setup failure leaves the old generation active;
- updates are serialized per plugin ID;
- removed modules are explicit uninstall operations;
- a changed provider causes dependent plugins to be revalidated;
- HMR errors are reported through runtime diagnostics.

Vite's module graph and `import.meta.hot` are not visible to core.

## Event adapter

An event bus can be implemented as a capability. The core should not require one. If provided, subscriptions must be acquired through the plugin scope so they disappear with the generation.

The first event adapter should define:

- typed event maps;
- synchronous versus asynchronous delivery;
- error isolation;
- ordering;
- behavior when a subscriber is disposed during delivery.

“String event plus `unknown` payload” is an escape hatch, not a general type-safe event API.

## Security

The runtime is an orchestration and ownership library, not a sandbox. A plugin with JavaScript execution privileges can still access any object reachable from its imports or context. Untrusted extensions require a separate process, worker, iframe, permission layer, or capability-based sandbox host.
