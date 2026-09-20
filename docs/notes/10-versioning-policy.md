# Versioning policy — for plugin authors

Moult resolves providers by version, not by deployment order. This note tells
plugin authors how to version their plugins and capabilities so that
replacements stay safe and dependents keep resolving.

## Two version numbers, two jobs

Every plugin definition carries two different version numbers:

- **`version` (plugin version)** identifies the implementation being run. It
  is what `replace()` swaps and what `rollback()` restores.
- **`capability(...).version` (capability version)** identifies the contract
  exposed to consumers. It is what a dependent's `requires` range matches
  against.

These are deliberately independent: you can ship `myplugin@2.0.0` that still
provides `storage@1.3.0` when the contract did not change, and dependents
declared against `storage@^1.0.0` will keep resolving.

## Ranges: what dependents declare, what the runtime checks

A `requires` entry declares a semver range (for example `^1.2.0`, `~2.3.0`,
`>=1.0.0 <2.0.0`). Matching uses node-semver `satisfies` with default
options — the same rules npm uses, including the usual prerelease exclusion.

The runtime validates every range and every version once, at
install/replace time. A malformed range is an `INVALID_DEFINITION` error
before anything runs, never a surprise at resolution.

Ranges are re-checked whenever a dependent is re-prepared — including during
a provider's replacement. A provider whose new version falls outside a
dependent's declared range fails the replacement atomically
(`REPLACEMENT_FAILED`); the previous generation stays active and dependents
keep their old bindings. Moult never lets a consumer silently drift onto a
version it did not declare.

## What counts as a breaking change

For dependents, a new release is breaking when it can invalidate an existing
`requires` declaration:

- bumping a **capability version** outside the ranges dependents declared;
- renaming or removing a **capability id** or a **contribution** dependents
  consume;
- changing a **config schema** so a previously valid config is rejected;
- bumping **`stateVersion`** without a `migrate` path from the previous
  schema.

Bumping the **plugin version** alone is never breaking: if every capability
version, contribution, and schema is unchanged, dependents cannot tell the
replacement happened.

## Releasing a breaking change

1. Bump the capability version (major bump for a breaking contract change)
   and the plugin version together.
2. If dependents must keep working, keep the old capability version
   installable: a new plugin id can provide the old contract while the new
   one provides the new contract. Two plugins may not share one id, but they
   may provide the same capability id at different versions — dependents
   resolve by range.
3. If persisted state changes shape, bump `stateVersion` and provide a
   `migrate` hook from the previous schema. The runtime snapshots the
   previous generation's state, runs your hook before the new setup commits,
   and rolls the whole replacement back if migration fails.

## Multi-provider capabilities

A capability declared with `multiple: true` aggregates every selected
provider's value into an array. Version ranges apply per provider: each
candidate must satisfy the consumer's range independently, and an
incompatible candidate is rejected at replace time like any other.

## Replace-time behavior authors should know

- **Dependent rebind is the default.** Replacing a provider re-prepares its
  dependents against the new generation; if any dependent cannot rebind
  (range mismatch, missing requirement, cycle), the replacement fails and
  nothing changes.
- **`strictDependents: true`** (a `replace()` option) restores the old
  reject-on-dependents behavior for hosts that schedule dependent updates
  themselves.
- **Timeouts are host-configured.** `RuntimeOptions.timeouts` sets defaults
  for setup, disposal, and drain; a per-operation `timeoutMs` overrides
  them. Without configuration the runtime waits indefinitely — it never
  invents a deadline that could kill a healthy plugin.
- **Pins are manual.** A replace with `inFlight: 'pin'` keeps the old
  generation's scope alive until the plugin is replaced again, stopped,
  uninstalled, or the runtime is disposed. `retainPin(id)` extends that
  lifetime for external holders via refcounting; see the API reference.

## Id grammar

Plugin ids and capability ids share one grammar: dotted namespaces,
lowercase, no empty segments, no leading digits, hyphens allowed inside
segments — for example `memory.storage`, `my-plugin.cache.v2`.
