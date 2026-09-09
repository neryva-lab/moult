# 3. Lifecycle and Transactionality

## State machine

Each plugin definition and each running generation have separate state. A definition may remain installed while its generation is stopped.

```text
installed
   │ start
   ▼
preparing ── failure ──► stopped
   │ commit
   ▼
active ── stop ──► disposing ──► stopped
   │ replace
   └──────────────► preparing(candidate)
```

The runtime must serialize lifecycle operations for the same plugin ID. A second `start`, `stop`, or `replace` waits for or receives a structured busy error according to the chosen API policy; it must not race the first operation. The chosen policy is queue-and-wait: a queued operation waits for its turn and re-reads state when it runs, because state may have changed between enqueue and execution.

## Normal activation

1. Validate the definition and its declared capabilities.
2. Resolve the complete dependency closure.
3. Ensure required providers are active or can be started.
4. Create a unique generation ID and private scope.
5. Run `setup(context)`.
6. Verify that declared provided capabilities were actually published.
7. Verify contribution IDs and capability registrations are conflict-free with unrelated active generations. A candidate may intentionally shadow the IDs owned by the generation it replaces.
8. Commit the generation and publish its staged contributions.
9. Notify observers that the generation is active.

No external observer may see a partially prepared contribution set.

## Activation failure

If setup, validation, or commit preparation fails:

1. Abort the candidate scope.
2. Dispose candidate resources in reverse acquisition order.
3. Remove candidate capabilities and contributions.
4. Record the structured error and disposal errors.
5. Leave the plugin stopped, or leave the previous generation active during replacement.

The runtime must not mark a plugin active before all of these steps succeed.

## Replacement protocol

Replacement is the feature that justifies the runtime's complexity.

```text
old active generation
          │
          ├── prepare candidate in private scope
          │       ├── setup succeeds → validate candidate
          │       └── setup fails ────► dispose candidate; keep old
          │
          └── commit candidate
                  ├── publish candidate contributions/capabilities
                  ├── mark candidate active
                  ├── withdraw old contributions/capabilities
                  └── dispose old scope
```

The old generation remains the authoritative active generation until candidate commit. If old disposal fails after commit, the replacement still succeeds but returns or records a `DISPOSAL_FAILED` diagnostic. The runtime must never silently restore the old generation after the new generation has become observable, because both generations may have already interacted with the host.

Candidate resolution and static provider-conflict checks happen before a
candidate scope is created. A failure in candidate resolution or preparation is
reported as `REPLACEMENT_FAILED`, with the structured underlying failure
preserved as its cause. The old generation remains active and usable.

If the replaced plugin provides capabilities consumed by active dependents, the runtime must not leave those dependents holding references to the old provider. The current implementation rejects that replacement with a structured `REPLACEMENT_FAILED` error before creating a candidate scope. A future implementation may add an atomic dependent-closure transaction, but silent rebinding is not allowed.

## What “transactional” means here

The transaction covers runtime-managed state:

- capabilities published through `ctx.provide`;
- contributions published through `ctx.contribute`;
- resources owned by `ctx.scope`;
- lifecycle state and diagnostics.

It does not cover arbitrary side effects performed directly by plugin code. A host adapter that needs stronger atomicity must provide a staging API and require plugins to use it. This distinction is mandatory in documentation and release notes.

## Stop and dependent plugins

Stopping a provider with active dependents is not silently allowed. The default policy is to reject with `ACTIVE_DEPENDENTS` and identify the dependent path.

With `{ cascade: true }`, the runtime:

1. Computes the active dependent closure.
2. Stops dependents in reverse dependency order.
3. Stops the requested provider.
4. Records which plugins were stopped by the cascade.

Restarting is explicit. The runtime must not unexpectedly restart user-disabled plugins.

## Disposal semantics

- Disposal is best effort across all owned resources.
- Disposers run LIFO within one scope.
- A failed disposer does not prevent later disposers from running.
- All disposal errors are collected.
- `dispose()` is idempotent.
- An aborted scope cannot be committed.
- The runtime closes all active scopes when the runtime itself is disposed.
- Runtime disposal emits the terminal `disposed` event after active scopes have
  been closed; it does not synthesize per-plugin `stopped` events.

Async disposers are awaited. Hosts may choose a timeout, but a timeout must produce a diagnostic and must not be described as successful cleanup.

## Events and observers

Lifecycle observers receive immutable snapshots. They must not mutate runtime internals or synchronously re-enter lifecycle operations for the same plugin. If re-entry is supported later, it requires an explicit queueing policy and tests.
