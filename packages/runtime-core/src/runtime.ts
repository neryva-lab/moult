// The lifecycle engine. State machine, per-plugin queues, the replacement
// protocol, cascade stops, observer bus, and runtime disposal live here.
// The public guarantees are registered in docs/guarantees.md; the tests in
// test/replacement.test.ts and test/runtime.test.ts are their enforcement.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Capability } from './capability.js';
import type { ContributionEntry, ContributionKey, ContributionSnapshot } from './contributions.js';
import { StagedContributions } from './contributions.js';
import type {
  DiagnosticInput,
  DisposableLike,
  DrainContext,
  HealthStatus,
  MigrationPrevious,
  PluginContext,
  PluginDefinition,
  PluginStatus,
} from './definition.js';
import { freezeDefinition, validateDefinition } from './definition.js';
import type { DisposalReport } from './errors.js';
import { isMoltError, MoltError } from './errors.js';
import { buildInspection } from './inspection.js';
import { abortable, BoundedLog, OperationQueue, withTimeout } from './internal/async.js';
import { satisfiesRange } from './internal/semver.js';
import type {
  BlockedDiagnostic,
  CandidateProvider,
  HostProvider,
  ResolutionPlan,
} from './resolver.js';
import { resolve, resolveCandidate } from './resolver.js';
import { ScopeImpl } from './scope.js';

/**
 * A frozen snapshot of runtime state: plugin statuses with blocked-plugin
 * data, the committed capability bindings (staged state never
 * appears), and the capped diagnostic logs. Mutating the snapshot cannot
 * affect the runtime.
 *
 * @public
 */
export interface RuntimeInspection {
  readonly plugins: readonly {
    readonly id: string;
    readonly status: PluginStatus;
    readonly generation?: string;
    readonly error?: unknown;
    readonly blockedBy?: readonly BlockedDiagnostic[];
    /**
     * Last observed health of the committed generation: `'unknown'` until
     * the first probe (post-commit gate or `checkHealth()`).
     */
    readonly health?: 'unknown' | 'healthy' | 'unhealthy';
    /**
     * True while the generation is quarantined: withdrawn from provider
     * selection, scope alive, existing holders keep serving.
     */
    readonly quarantined?: boolean;
    /**
     * True when the plugin was installed lazy and has never been
     * explicitly started.
     */
    readonly lazy?: boolean;
    /**
     * The id of the plugin's pinned generation, when one is kept alive by
     * `inFlight: 'pin'`. At most one pin per plugin.
     */
    readonly pinnedGeneration?: string;
    /**
     * The generation's capped diagnostic log — what the plugin passed to
     * `ctx.diagnose`, oldest first. Present only while a committed
     * generation exists; bounded by capacity, never by history.
     */
    readonly diagnostics?: readonly DiagnosticInput[];
  }[];
  readonly capabilities: readonly {
    readonly id: string;
    readonly provider: string;
    readonly version: string;
  }[];
  /**
   * Failures thrown by observers, capped. Observer throws never propagate
   * into lifecycle outcomes; they surface here so hosts can see broken
   * listeners.
   */
  readonly observerDiagnostics: readonly {
    readonly message: string;
    readonly cause: unknown;
  }[];
}

/**
 * One observer event. Payloads are frozen snapshots; `cascade` lists the
 * plugins stopped so far in the current cascade stop, in stop order.
 * Observer throws never affect lifecycle outcomes — they are recorded in
 * the capped observer diagnostics.
 *
 * @public
 */
/**
 * The pipeline stage at which a `failed` event occurred:
 * - `'resolve'`: dependency resolution found no viable plan.
 * - `'validate'`: the definition or its claims were rejected.
 * - `'config'`: configuration resolution or `validateConfig` failed.
 * - `'setup'`: a `setup` hook (or the `migrate` hook inside it) failed.
 * - `'prepare'`: candidate preparation for a rebind transaction failed.
 * - `'health'`: the post-commit health gate rejected a candidate.
 *
 * @public
 */
export type FailedStage = 'resolve' | 'validate' | 'config' | 'setup' | 'prepare' | 'health';

export type RuntimeListener = (event: {
  readonly type: 'installed' | 'started' | 'stopped' | 'replaced' | 'failed' | 'disposed';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  readonly cascade?: readonly string[] | undefined;
  readonly error?: unknown;
  /** Present on `'failed'` events: the pipeline stage that failed. */
  readonly stage?: FailedStage | undefined;
}) => void;

/**
 * Per-phase lifecycle timeouts, in milliseconds. Each phase of an operation
 * gets its own budget: a `timeoutMs` on a single operation overrides every
 * phase that operation performs. `undefined` (the default) means no timeout —
 * the phase waits as long as it takes.
 *
 * @public
 */
export interface TimeoutOptions {
  /** Bound for `setup` (and the `migrate` hook, which runs inside setup). */
  readonly setupMs?: number | undefined;
  /** Bound for scope disposal. */
  readonly disposeMs?: number | undefined;
  /** Bound for the `drain` hook; expiry aborts the drain and disposal proceeds. */
  readonly drainMs?: number | undefined;
  /** Bound for the `healthCheck` hook; expiry counts as an unhealthy result. */
  readonly healthMs?: number | undefined;
}

/**
 * Options for {@link Runtime.install}.
 *
 * @public
 */
export interface InstallOptions {
  /**
   * Install-time configuration overrides, merged over the definition's
   * `config` defaults and validated by `validateConfig`. A failing
   * validation rejects the install.
   *
   * The definition object is deep-frozen in place: after `install`
   * returns, the caller must treat it as immutable. Mutating it later is
   * a programming error — generations keep the frozen reference.
   */
  readonly config?: Record<string, unknown> | undefined;
  /**
   * Install a lazy plugin: it registers without activating, and it is
   * excluded from automatic provider selection until it is explicitly
   * started. A dependent that requires a capability provided only by a
   * lazy, unstarted plugin fails resolution with `MISSING_CAPABILITY`
   * (or skips the requirement when optional) until the lazy plugin is
   * started — the host owns the activation trigger.
   */
  readonly lazy?: boolean | undefined;
  /**
   * Abort signal for the install. `install` is synchronous, so the signal
   * is only an entry gate: an already-aborted signal rejects the install
   * with `ABORTED` before any state changes.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options for {@link Runtime.start}.
 *
 * @public
 */
export interface StartOptions {
  /**
   * Per-operation timeout override, in milliseconds: bounds the setup and
   * health phases of this activation. Overrides the runtime defaults for
   * this call only.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Abort signal for the activation. An already-aborted signal is an entry
   * gate: the call throws `ABORTED` synchronously before any state
   * changes. Aborting mid-flight rejects the operation with `ABORTED` and
   * rolls back the in-flight activation like a setup failure; phases that
   * already committed run to completion.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options for {@link Runtime.stop}.
 *
 * @public
 */
export interface StopOptions {
  /** Stop dependents of the stopped plugins as well. */
  readonly cascade?: boolean | undefined;
  /**
   * Per-operation timeout override, in milliseconds: bounds the disposal
   * phase of this stop. Overrides the runtime defaults for this call only.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Abort signal for the stop. `stop` is disposal-bounded, so the signal
   * is an entry gate: an already-aborted signal rejects with `ABORTED`
   * before any state changes; once disposal starts it runs to completion.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options for `uninstall`.
 *
 * @public
 */
export interface UninstallOptions {
  /**
   * Per-operation timeout override, in milliseconds: bounds the disposal
   * phase of this uninstall (including releasing a pinned generation).
   * Overrides the runtime defaults for this call only.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Abort signal for the uninstall. Like `stop`, the signal is an entry
   * gate: an already-aborted signal rejects with `ABORTED` before any
   * state changes; once disposal starts it runs to completion.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Options for {@link Runtime.replace}.
 *
 * @public
 */
export interface ReplaceOptions {
  /**
   * Opt-in v1 behavior: reject the replacement with `REPLACEMENT_FAILED`
   * when the replaced generation has active dependents, instead of
   * rebinding those dependents onto the new generation transactionally.
   *
   * The default (`false`) rebinds dependents: every active dependent is
   * re-prepared against the candidate and the whole closure commits
   * atomically, so dependents never observe a withdrawn provider.
   */
  readonly strictDependents?: boolean | undefined;
  /**
   * Per-operation timeout override, in milliseconds: bounds the setup,
   * health, drain, and disposal phases of this replacement. Overrides the
   * runtime defaults for this call only.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Abort signal for the replacement. An already-aborted signal is an
   * entry gate: the call throws `ABORTED` synchronously before any state
   * changes. Aborting mid-flight rejects the operation with `ABORTED` and
   * rolls back the in-flight transaction like a preparation failure;
   * phases that already committed (drain, disposal of the retired
   * generations) run to completion.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * What happens to the generations retired by this replacement:
   * - `'drain'` (default): each retired generation's `drain` hook runs,
   *   bounded by the drain timeout; disposal proceeds regardless of the
   *   outcome.
   * - `'immediate'`: the `drain` hook is skipped and retired generations
   *   are disposed immediately.
   * - `'pin'`: retired generations are withdrawn from provider selection
   *   but their scopes are kept alive — no drain hook, no disposal — for
   *   existing holders of their capability values (the transactional
   *   rebind already guarantees no active generation still resolves to
   *   them; only holders outside the runtime, such as host code, can
   *   remain). The runtime cannot observe those external holders, so a
   *   pin is a manual lifecycle: at most one pinned generation per
   *   plugin, visible in `inspect()`; it is released (disposed, with a
   *   `stopped` event) when the plugin is replaced again, stopped,
   *   uninstalled, or when the runtime is disposed. A new pin supersedes
   *   the previous one.
   *
   * Note: true holder refcounting would require handle-based capabilities;
   * with direct values the host owns the release decision.
   */
  readonly inFlight?: 'drain' | 'immediate' | 'pin' | undefined;
}

/**
 * The lifecycle engine surface: install, start, stop, replace, uninstall,
 * inspect, and dispose. All operations serialize per plugin id
 * (queue-and-wait); every failure is a structured `MoltError`.
 * Runtime instances share nothing.
 *
 * @public
 */
export interface Runtime {
  /**
   * Installs a plugin definition. The definition object you pass is
   * frozen in place (`Object.freeze`, recursively over `requires`,
   * `provides`, and `config`) — after this call, mutating it throws.
   * Pass a fresh object per install, or spread-copy one you intend to
   * reuse: `install({ ...def, version: '2.0.0' })`. `replace()` freezes
   * its definition the same way.
   */
  install(definition: PluginDefinition, options?: InstallOptions): void;
  /**
   * Uninstalls a stopped (or never-started) plugin, releasing its pinned
   * generation if any. Disposal is bounded by `options.timeoutMs` or the
   * runtime's default disposal timeout.
   */
  uninstall(id: string, options?: UninstallOptions): Promise<void>;
  start(id: string, options?: StartOptions): Promise<void>;
  stop(id: string, options?: StopOptions): Promise<void>;
  replace(definition: PluginDefinition, options?: ReplaceOptions): Promise<void>;
  /**
   * Replaces the plugin's effective configuration. The patch is merged over
   * the current effective configuration and validated by the definition's
   * `validateConfig`; a failing validation rejects with `INVALID_STATE`
   * and changes nothing. The current generation keeps the frozen object it
   * started with — the next generation (after a stop/start or replace)
   * sees the new configuration.
   */
  updateConfig(id: string, patch: Record<string, unknown>): void;
  /**
   * Rolls the plugin back to the definition it had before its most recent
   * replacement, via the normal replacement pipeline (dependents rebind,
   * `migrate` runs, the health gate applies). Fails with `INVALID_STATE`
   * when there is no replacement history. History is bounded — only the
   * most recent replacements are retained.
   */
  rollback(id: string): Promise<void>;
  /**
   * Runs the active generation's `healthCheck` hook now and returns its
   * result. The result is recorded on the generation, and an unhealthy
   * result applies the runtime's `onUnhealthy` policy: `'fail'` (default)
   * reports only, `'quarantine'` withdraws the generation from provider
   * selection until a healthy re-probe, and `'rollback'` rolls the plugin
   * back to its previous definition through the normal replacement
   * pipeline (throws `INVALID_STATE` when there is no replacement history).
   * Unlike the post-commit gate, the probe's own result is always returned
   * — even when the policy takes further action.
   */
  checkHealth(id: string): Promise<HealthStatus>;
  getStatus(id: string): PluginStatus | undefined;
  inspect(): RuntimeInspection;
  subscribe(listener: RuntimeListener): () => void;
  /**
   * Re-checks the whole active graph for consistency: every active
   * generation's non-optional requirements must resolve to a selectable
   * provider (optional requirements may dangle by design), every recorded
   * provider edge must still satisfy its declared range, no
   * single-provider capability or contribution key may be claimed twice,
   * and no published binding may point at a dead generation. Returns the
   * list of problems found — empty means the graph is consistent. This is
   * a read-only diagnostic; a healthy runtime always returns `[]`.
   */
  validate(): readonly GraphIssue[];
  /**
   * Dry-runs `start(id)`: resolves the activation plan without starting
   * anything and without emitting events. Throws the same `MoltError`
   * `start()` would throw when the requirements cannot be satisfied.
   * Planning the start of an already-active plugin returns an empty plan.
   */
  planStart(id: string): StartPlan;
  /**
   * Dry-runs `stop(id)`: returns the plugins that would be stopped, in
   * stop order (dependents first). Without `cascade: true`, throws
   * `ACTIVE_DEPENDENTS` exactly when `stop()` would.
   */
  planStop(id: string, options?: { readonly cascade?: boolean | undefined }): StopPlan;
  /**
   * Dry-runs `replace(definition)`: validates the definition and reports
   * the active dependents that would be re-prepared and rebound. Throws
   * the same errors `replace()` would throw before preparing candidates
   * (invalid definition, conflicting claims, `strictDependents`
   * rejection).
   */
  planReplace(
    definition: PluginDefinition,
    options?: { readonly strictDependents?: boolean | undefined },
  ): ReplacePlan;
  /**
   * The transitive active dependents of a plugin, in provider-first
   * (activation) order. Empty when the plugin has no active dependents
   * or is not active.
   */
  inspectDependents(id: string): readonly DependentInfo[];
  /**
   * The bounded transition audit log, oldest first. Every lifecycle
   * transition — installs, starts, stops, replacements, failures,
   * quarantine and pin transitions, and final disposal — is recorded
   * exactly once, in order, with a monotonic sequence number. The buffer
   * holds the most recent 128 entries; older entries are evicted. The
   * bound is fixed: the log is a diagnostic aid, not a correctness
   * mechanism, so it is not configurable.
   */
  transitions(): readonly TransitionRecord[];
  contributions(): ContributionSnapshot;
  dispose(options?: { readonly timeoutMs?: number | undefined }): Promise<void>;
}

/**
 * Host-side providers supplied at construction: permanent single-publisher
 * bindings owned by the host. A plugin providing a host-claimed
 * single-provider token fails at install (`AMBIGUOUS_PROVIDER`); multi-provider tokens may coexist with a host
 * provider — the host's value is served first.
 *
 * @public
 */
export interface RuntimeOptions {
  readonly providers?: readonly {
    readonly capability: Capability<unknown>;
    readonly value: unknown;
  }[];
  /**
   * Default per-phase lifecycle timeouts. A per-operation `timeoutMs`
   * overrides these for that call only.
   */
  readonly timeouts?: TimeoutOptions | undefined;
  /**
   * What happens when an on-demand `checkHealth()` probe reports an
   * unhealthy live generation:
   * - `'fail'` (default): the status is reported and nothing else happens.
   * - `'quarantine'`: the generation is quarantined — withdrawn from
   *   provider selection (new `require()` calls no longer resolve to it)
   *   while its scope stays alive and existing holders keep serving. A
   *   later healthy probe lifts the quarantine.
   * - `'rollback'`: the plugin is rolled back to its previous definition
   *   through the normal replacement pipeline — including the post-commit
   *   health gate, so a previous generation that is also unhealthy fails
   *   the rollback with `REPLACEMENT_FAILED` and `checkHealth` rejects.
   *   Throws `INVALID_STATE` when there is no replacement history.
   *
   * The post-commit health gate always fails the transaction — a candidate
   * that fails its readiness probe never commits, regardless of this
   * policy.
   */
  readonly onUnhealthy?: 'quarantine' | 'rollback' | 'fail' | undefined;
}

/**
 * Creates a runtime instance: a self-contained plugin runtime with its own
 * definition table, bindings, and diagnostics — no global registry exists.
 *
 * @param options - Host providers and construction-time policy.
 * @throws `AMBIGUOUS_PROVIDER` when two host providers claim the same
 * capability id — host misconfiguration fails at construction, not at
 * runtime.
 * @public
 */
export function createRuntime(options?: RuntimeOptions): Runtime {
  return new RuntimeImpl(options);
}

const HOST_PROVIDER_LABEL = '(host)';
// Upper bound for per-generation and observer diagnostic logs: a chatty
// plugin cannot grow the runtime unboundedly.
const DIAGNOSTIC_CAPACITY = 100;

/**
 * Tracks whose `setup` is currently executing, across awaits. A lifecycle
 * call for a plugin made from that plugin's own setup would queue behind
 * the in-flight activation and deadlock if awaited (F3); the public
 * methods consult this to handle self-operations deterministically
 * instead. AsyncLocalStorage propagates through the setup's continuations,
 * and nested `run` calls (a setup that starts another plugin) shadow the
 * outer store for the inner setup only.
 */
const setupTracker = new AsyncLocalStorage<{ readonly pluginId: string }>();

// Shared frozen empty config for definitions that declare none. The
// definition's own config (when present) is frozen at install by
// freezeDefinition, so the context can hand out the reference directly.
const EMPTY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});

/** Maximum retained replacement history per plugin; `rollback` pops from it. */
const HISTORY_CAPACITY = 10;

/**
 * Merges definition defaults with user overrides and validates the result.
 * Throws INVALID_DEFINITION (install/replace) or INVALID_STATE
 * (updateConfig) when `validateConfig` reports errors; a throw from
 * `validateConfig` itself propagates raw as the plugin's own error.
 */
function resolveConfig(
  definition: PluginDefinition,
  overrides: Record<string, unknown>,
  code: 'INVALID_DEFINITION' | 'INVALID_STATE',
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = {
    ...(definition.config ?? {}),
    ...overrides,
  };
  // Frozen before validation: a throwing or mutating validateConfig cannot
  // corrupt the object the runtime is about to publish as ctx.config.
  const frozenMerged = Object.freeze(merged);
  const rawErrors: unknown = definition.validateConfig?.(frozenMerged) ?? [];
  // The declared return type is `readonly string[]`, but a hand-written
  // plugin can return anything at runtime — fail loudly instead of
  // crashing on `.join` or silently accepting garbage.
  if (!Array.isArray(rawErrors) || rawErrors.some((entry) => typeof entry !== 'string')) {
    throw new MoltError({
      code,
      message: `validateConfig for plugin ${definition.id} must return an array of strings`,
      pluginId: definition.id,
      details: { reason: 'invalid-validateConfig-result' },
    });
  }
  const errors: readonly string[] = rawErrors;
  if (errors.length > 0) {
    throw new MoltError({
      code,
      message: `invalid configuration for plugin ${definition.id}: ${errors.join('; ')}`,
      pluginId: definition.id,
      details: { reason: 'invalid-config', errors: [...errors] },
    });
  }
  return frozenMerged;
}

interface PublishedBinding {
  readonly pluginId: string | null; // null = host
  readonly capability: Capability<unknown>;
  readonly value: unknown;
}

interface Generation {
  readonly id: string;
  readonly pluginId: string;
  readonly scope: ScopeImpl;
  /** The frozen definition this generation was built from. */
  readonly definition: PluginDefinition;
  /** capabilityId → range, from the definition this generation runs. */
  readonly consumed: { capabilityId: string; range: string }[];
  /**
   * capabilityId → generationIds of the providers this generation resolved.
   * Multi-provider tokens resolve to several providers — every one of them
   * must be tracked, or dependent tracking misses dependents.
   */
  readonly resolvedProviders: Map<string, Set<string>>;
  /** Published token ids; filled at commit, used by withdrawal. */
  readonly providedTokenIds: string[];
  readonly diagnostics: BoundedLog<DiagnosticInput>;
  /**
   * Transaction-local binding overlay (F5): while a rebind transaction
   * prepares candidates, their staged bindings shadow the still-published
   * old ones so rebound dependents resolve candidate values during setup.
   * Set only on candidates prepared inside a rebind transaction; undefined
   * everywhere else, where `#bindingFor` resolves through `#published`.
   */
  readonly rebindOverlay: RebindOverlay | undefined;
  /**
   * The frozen effective configuration this generation started with:
   * definition defaults merged with the record's overrides, validated.
   * A later `updateConfig` replaces the record's object, never this one.
   */
  readonly config: Readonly<Record<string, unknown>>;
  /** The resolution plan this generation was built from. */
  readonly plan: ResolutionPlan;
  /**
   * Last observed health: 'unknown' until the first probe (post-commit
   * gate or `checkHealth`). Mutable — updated by every probe.
   */
  health: 'unknown' | 'healthy' | 'unhealthy';
  /**
   * Quarantined generations are excluded from provider selection while
   * their scope stays alive and existing holders keep serving. Mutable —
   * set by the `onUnhealthy: 'quarantine'` policy and cleared by a healthy
   * re-probe or by replacement.
   */
  quarantined: boolean;
  /**
   * Bindings and contributions stashed while quarantined; restored on
   * unquarantine. Undefined when not quarantined.
   */
  quarantinedState:
    | {
        readonly bindings: readonly {
          readonly tokenId: string;
          readonly binding: PublishedBinding;
        }[];
        readonly contributions: readonly {
          readonly keyId: string;
          readonly entry: ContributionEntry;
        }[];
      }
    | undefined;
  /**
   * True while the generation is pinned: retired by a replace with
   * `inFlight: 'pin'`, withdrawn from provider selection, scope kept
   * alive for existing holders. Mutable — set on pin, cleared on release.
   */
  pinned: boolean;
}

/**
 * Transaction-local binding overlay for dependent rebind (F5). Keyed
 * tokenId → provider pluginId. Entries shadow the still-published old
 * bindings while candidates prepare; nothing is globally visible until
 * commit. Kept off the runtime instance so two unrelated replacement
 * transactions can prepare concurrently without clobbering each other.
 */
type RebindOverlay = Map<
  string,
  Map<string, { capability: Capability<unknown>; value: unknown; generationId: string }>
>;

interface PluginRecord {
  definition: PluginDefinition;
  status: PluginStatus;
  generation: Generation | undefined;
  error: unknown;
  /**
   * Accumulated configuration overrides from install options and
   * `updateConfig` patches. The effective configuration is
   * `{...definition.config, ...configOverrides}`, frozen.
   */
  configOverrides: Record<string, unknown>;
  /** Frozen effective configuration; replaced wholesale by `updateConfig`. */
  effectiveConfig: Readonly<Record<string, unknown>>;
  /**
   * Previous definitions, oldest first, bounded — `rollback` pops the
   * most recent. Pushed on every successful replacement.
   */
  history: PluginDefinition[];
  /**
   * Installed with `lazy: true`: excluded from automatic provider
   * selection until explicitly started.
   */
  lazy: boolean;
}

/**
 * One entry in the runtime's bounded transition audit log (`transitions()`).
 * Every lifecycle transition the runtime performs is recorded here in
 * order: installs, starts, stops, replacements, failures, disposal, and
 * the quarantine/pin transitions that have no subscriber event of their
 * own. The log is a ring buffer — the oldest entries are evicted beyond
 * the capacity bound.
 *
 * @public
 */
export interface TransitionRecord {
  /** Monotonic sequence number: 0, 1, 2, … across the runtime's life. */
  readonly seq: number;
  /** `Date.now()` timestamp of the transition. */
  readonly at: number;
  readonly type:
    | 'installed'
    | 'started'
    | 'stopped'
    | 'replaced'
    | 'failed'
    | 'disposed'
    | 'pinned'
    | 'quarantined'
    | 'unquarantined';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  /** Present on `'failed'` transitions. */
  readonly error?: unknown;
  /** Present on `'failed'` transitions: the pipeline stage that failed. */
  readonly stage?: FailedStage | undefined;
}

interface RuntimeEvent {
  readonly type: 'installed' | 'started' | 'stopped' | 'replaced' | 'failed' | 'disposed';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  readonly cascade?: readonly string[] | undefined;
  readonly error?: unknown;
  readonly stage?: FailedStage | undefined;
}

/** Maximum number of entries retained in the transition audit log. */
const TRANSITION_CAPACITY = 128;

/**
 * The dry-run activation plan for `planStart()`: the order plugins would
 * activate in (providers first) and the provider selected for each
 * requirement. Nothing is started; on unresolvable requirements the call
 * throws the same `MoltError` `start()` would throw.
 *
 * @public
 */
export interface StartPlan {
  readonly order: readonly string[];
  readonly selections: readonly {
    readonly consumer: string;
    readonly capabilityId: string;
    readonly range: string;
    readonly optional: boolean;
    readonly providers: readonly {
      /** Provider plugin id, or `null` for a host provider. */
      readonly pluginId: string | null;
      readonly version: string;
    }[];
  }[];
}

/**
 * The dry-run stop plan for `planStop()`: plugin ids in the order they
 * would be stopped (dependents first).
 *
 * @public
 */
export interface StopPlan {
  readonly stopped: readonly string[];
}

/**
 * The dry-run replacement plan for `planReplace()`: the plugin being
 * replaced and the active dependents that would be re-prepared and
 * rebound onto the new generation, in provider-first order.
 *
 * @public
 */
export interface ReplacePlan {
  readonly replaced: string;
  readonly rebound: readonly string[];
}

/**
 * One entry of `inspectDependents()`: an active plugin that transitively
 * depends on the inspected plugin.
 *
 * @public
 */
export interface DependentInfo {
  readonly pluginId: string;
  readonly generation: string;
}

/**
 * One inconsistency found by `validate()`. An empty result means the
 * active graph is consistent.
 *
 * Reachability: `unresolvable-requirement` is the user-facing diagnostic
 * (quarantined or incompatible providers, unsatisfiable ranges). The
 * other kinds are corruption detectors — the install/replace/commit
 * paths reject those states up front (`AMBIGUOUS_PROVIDER`, staged
 * conflict checks, atomic withdrawal), so a non-empty result there means
 * the runtime's own bookkeeping is broken, not the plugin graph.
 *
 * @public
 */
export interface GraphIssue {
  readonly kind:
    | 'unresolvable-requirement'
    | 'range-mismatch'
    | 'duplicate-provider'
    | 'duplicate-contribution'
    | 'stale-binding'
    | 'orphaned-generation';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  readonly capabilityId?: string | undefined;
  readonly message: string;
}

interface RequirementLike {
  readonly capability: Capability<unknown>;
  readonly range: string;
  readonly optional?: boolean | undefined;
}

/**
 * A generation that passed setup and validation but is not yet committed.
 * Shared by activation and transactional dependent rebind (F5).
 */
interface PreparedGeneration {
  readonly generation: Generation;
  readonly scope: ScopeImpl;
  readonly stagedProvides: Map<string, { capability: Capability<unknown>; value: unknown }>;
  readonly staged: StagedContributions;
}

/** Options for `#prepareGeneration`. */
interface PrepareOptions {
  /**
   * The generation being replaced: single-provider and contribution
   * conflict checks ignore its claims, since it is withdrawn at commit.
   */
  readonly shadowed?: Generation | undefined;
  /**
   * The rebind transaction's binding overlay (F5). Candidates prepared
   * inside the transaction resolve staged candidate bindings through it;
   * generations prepared outside any transaction leave it undefined.
   */
  readonly rebindOverlay?: RebindOverlay | undefined;
  /** Frozen effective configuration for the generation being prepared. */
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  /** Bound for the setup (and migrate) phase, in milliseconds. */
  readonly setupMs?: number | undefined;
  /** Bound for disposing the candidate scope on failure, in milliseconds. */
  readonly disposeMs?: number | undefined;
  /**
   * Caller abort signal. Aborting rejects the preparation with `ABORTED`;
   * the candidate scope is disposed exactly like a setup failure.
   */
  readonly signal?: AbortSignal | undefined;
}

/** Fully-resolved per-phase timeouts for one operation. */
interface ResolvedTimeouts {
  readonly setupMs: number | undefined;
  readonly disposeMs: number | undefined;
  readonly drainMs: number | undefined;
  readonly healthMs: number | undefined;
}

/** Validates a timeout value; throws INVALID_STATE on nonsense. */
function checkTimeoutMs(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MoltError({
      code: 'INVALID_STATE',
      message: `timeout ${field} must be a non-negative finite number`,
      details: { reason: 'invalid-timeout', field },
    });
  }
  return value;
}

/**
 * Internal failure carrier from `#prepareGeneration`: the setup/validation
 * cause plus any errors from disposing the uncommitted scope. Callers
 * unwrap it and apply their own failure semantics.
 */
class PreparationFailure extends Error {
  readonly generationId: string;
  readonly failureCause: unknown;
  readonly disposalErrors: readonly unknown[];

  constructor(generationId: string, failureCause: unknown, disposalErrors: readonly unknown[]) {
    super(`preparation of generation ${generationId} failed`);
    this.name = 'PreparationFailure';
    this.generationId = generationId;
    this.failureCause = failureCause;
    this.disposalErrors = disposalErrors;
  }
}

class RuntimeImpl implements Runtime {
  readonly #plugins = new Map<string, PluginRecord>();
  readonly #hostProviders = new Map<string, HostProvider>();
  readonly #generations = new Map<string, Generation>();
  readonly #preparing = new Map<string, Generation>();
  // capabilityId → generationId → binding; published at commit only.
  readonly #published = new Map<string, Map<string, PublishedBinding>>();
  // contribution keyId → generationId → entry.
  readonly #contributions = new Map<string, Map<string, ContributionEntry>>();
  readonly #activationOrder: string[] = [];
  readonly #observers = new Set<RuntimeListener>();
  readonly #observerDiagnostics = new BoundedLog<{ message: string; cause: unknown }>(
    DIAGNOSTIC_CAPACITY,
  );
  #generationCounter = 0;
  #disposed = false;
  #disposedPromise: Promise<void> | undefined;
  readonly #onUnhealthy: 'quarantine' | 'rollback' | 'fail';
  /**
   * Pinned generations: plugin id → the retired generation kept alive by
   * the most recent `inFlight: 'pin'` replace. At most one per plugin;
   * withdrawn from provider selection, scope alive.
   */
  readonly #pinned = new Map<string, Generation>();
  /** Bounded audit log of lifecycle transitions, oldest first. */
  readonly #transitions: TransitionRecord[] = [];
  #transitionSeq = 0;
  readonly #queue = new OperationQueue();
  /**
   * Default per-phase lifecycle timeouts from RuntimeOptions. A
   * per-operation `timeoutMs` overrides every phase for that call.
   */
  readonly #defaultTimeouts: ResolvedTimeouts;
  /**
   * In-flight activations keyed by plugin id. Every activation attempt
   * registers here before its first await, so concurrent attempts for the
   * same plugin coalesce onto one instead of double-activating (F10).
   */
  readonly #activations = new Map<string, Promise<Generation>>();
  /**
   * Observer-dispatch stack for the reentrancy guard. Nested synchronous
   * emits (a listener that installs a plugin) push and pop; the guard
   * therefore survives nesting instead of being clobbered to empty (F9).
   */
  readonly #reentrancyGuards: string[] = [];
  /**
   * Plugin ids owned by an in-flight dependent-rebind transaction (F5).
   * Lifecycle operations for an owned plugin fail loudly with
   * INVALID_STATE instead of interleaving with the transaction; the set is
   * populated synchronously before the transaction's first await and
   * cleared when the transaction commits or aborts.
   */
  readonly #rebindOwners = new Set<string>();

  constructor(options?: RuntimeOptions) {
    for (const provider of options?.providers ?? []) {
      if (this.#hostProviders.has(provider.capability.id)) {
        throw new MoltError({
          code: 'AMBIGUOUS_PROVIDER',
          message: `two host providers claim ${provider.capability.id}`,
          capabilityId: provider.capability.id,
        });
      }
      this.#hostProviders.set(provider.capability.id, {
        capability: provider.capability,
        value: provider.value,
      });
    }
    const timeouts = options?.timeouts ?? {};
    this.#defaultTimeouts = {
      setupMs: checkTimeoutMs(timeouts.setupMs, 'timeouts.setupMs'),
      disposeMs: checkTimeoutMs(timeouts.disposeMs, 'timeouts.disposeMs'),
      drainMs: checkTimeoutMs(timeouts.drainMs, 'timeouts.drainMs'),
      healthMs: checkTimeoutMs(timeouts.healthMs, 'timeouts.healthMs'),
    };
    const onUnhealthy = options?.onUnhealthy ?? 'fail';
    if (onUnhealthy !== 'quarantine' && onUnhealthy !== 'rollback' && onUnhealthy !== 'fail') {
      throw new MoltError({
        code: 'INVALID_DEFINITION',
        message: `invalid onUnhealthy policy: ${String(onUnhealthy)}`,
        details: { reason: 'invalid-onUnhealthy' },
      });
    }
    this.#onUnhealthy = onUnhealthy;
  }

  /**
   * Resolves the effective per-phase timeouts for one operation: a
   * per-operation `timeoutMs` overrides every phase; otherwise the
   * runtime defaults apply.
   */
  #resolveTimeouts(timeoutMs: number | undefined): ResolvedTimeouts {
    const override = checkTimeoutMs(timeoutMs, 'timeoutMs');
    if (override === undefined) {
      return this.#defaultTimeouts;
    }
    return {
      setupMs: override,
      disposeMs: override,
      drainMs: override,
      healthMs: override,
    };
  }

  // -- public surface --------------------------------------------------------

  install(definition: PluginDefinition, options?: InstallOptions): void {
    this.#assertUsable();
    this.#assertNotAborted(options?.signal, definition.id);
    const failure = validateDefinition(definition);
    if (failure !== undefined) {
      throw failure;
    }
    for (const provided of definition.provides ?? []) {
      if (!provided.capability.multiple && this.#hostProviders.has(provided.capability.id)) {
        // Host providers are permanent: a second single-provider claim can
        // never be selected, so it fails here instead of at start.
        // Multi-provider tokens may coexist with a host provider — the
        // documented ordering puts the host first.
        throw new MoltError({
          code: 'AMBIGUOUS_PROVIDER',
          message: `a host provider already claims ${provided.capability.id}`,
          pluginId: definition.id,
          capabilityId: provided.capability.id,
        });
      }
    }
    if (this.#plugins.has(definition.id)) {
      throw new MoltError({
        code: 'DUPLICATE_PLUGIN',
        message: `plugin ${definition.id} is already installed`,
        pluginId: definition.id,
      });
    }
    const rawConfig = options?.config;
    if (
      rawConfig !== undefined &&
      (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig))
    ) {
      throw new MoltError({
        code: 'INVALID_DEFINITION',
        message: `install options config for plugin ${definition.id} must be a record`,
        pluginId: definition.id,
        details: { reason: 'invalid-config' },
      });
    }
    const overrides: Record<string, unknown> = { ...(rawConfig ?? {}) };
    const frozen = freezeDefinition(definition);
    const effectiveConfig = resolveConfig(frozen, overrides, 'INVALID_DEFINITION');
    this.#plugins.set(definition.id, {
      definition: frozen,
      status: 'installed',
      generation: undefined,
      error: undefined,
      configOverrides: overrides,
      effectiveConfig,
      history: [],
      lazy: options?.lazy === true,
    });
    this.#emit({ type: 'installed', pluginId: definition.id });
  }

  uninstall(id: string, options?: UninstallOptions): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotSelfOperation(id, 'uninstall');
    this.#assertNotRebindOwned(id);
    this.#assertNotAborted(options?.signal, id);
    const disposeMs = this.#resolveTimeouts(options?.timeoutMs).disposeMs;
    return this.#enqueue(id, () => this.#uninstall(id, disposeMs));
  }

  start(id: string, options?: StartOptions): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotSelfOperation(id, 'start');
    this.#assertNotRebindOwned(id);
    this.#assertNotAborted(options?.signal, id);
    const signal = options?.signal;
    return this.#enqueue(id, () =>
      this.#start(id, this.#resolveTimeouts(options?.timeoutMs), signal),
    );
  }

  stop(id: string, options?: StopOptions): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotRebindOwned(id);
    this.#assertNotAborted(options?.signal, id);
    // A preparing plugin is stopped cooperatively: its scope signal aborts
    // now, because the queued stop below can only run after the start has
    // settled.
    const preparing = this.#preparing.get(id);
    if (preparing !== undefined) {
      void preparing.scope.dispose();
      if (setupTracker.getStore()?.pluginId === id) {
        // Self-stop from the plugin's own setup: queueing behind the
        // in-flight activation would deadlock, because the activation
        // awaits this setup and the setup awaits the stop. The scope is
        // already disposed above, so the activation aborts and the plugin
        // ends stopped — the stop's intent — without touching the queue.
        return Promise.resolve();
      }
    }
    const timeouts = this.#resolveTimeouts(options?.timeoutMs);
    return this.#enqueue(id, () => this.#stop(id, options?.cascade === true, timeouts.disposeMs));
  }

  replace(definition: PluginDefinition, options?: ReplaceOptions): Promise<void> {
    this.#assertNotReentrant(definition.id);
    this.#assertNotSelfOperation(definition.id, 'replace');
    this.#assertNotRebindOwned(definition.id);
    this.#assertNotAborted(options?.signal, definition.id);
    return this.#enqueue(definition.id, () =>
      this.#replace(definition, options, this.#resolveTimeouts(options?.timeoutMs), false),
    );
  }

  updateConfig(id: string, patch: Record<string, unknown>): void {
    this.#assertUsable();
    this.#assertNotReentrant(id);
    this.#assertNotRebindOwned(id);
    const record = this.#plugins.get(id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is not installed`,
        pluginId: id,
        details: { reason: 'not-installed' },
      });
    }
    if (patch === undefined || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `updateConfig patch for plugin ${id} must be a record`,
        pluginId: id,
        details: { reason: 'invalid-patch' },
      });
    }
    const overrides = { ...record.configOverrides, ...patch };
    // Validates; throws INVALID_STATE on failure and changes nothing.
    const effectiveConfig = resolveConfig(record.definition, overrides, 'INVALID_STATE');
    record.configOverrides = overrides;
    record.effectiveConfig = effectiveConfig;
  }

  /**
   * Returns the most recent pre-replacement definition for `rollback`.
   * Throws synchronously when there is nothing to roll back to.
   */
  #previousDefinition(id: string): PluginDefinition {
    const record = this.#plugins.get(id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is not installed`,
        pluginId: id,
        details: { reason: 'not-installed' },
      });
    }
    const previous = record.history[record.history.length - 1];
    if (previous === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} has no replacement history to roll back to`,
        pluginId: id,
        details: { reason: 'no-rollback-history' },
      });
    }
    return previous;
  }

  rollback(id: string): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotSelfOperation(id, 'rollback');
    this.#assertNotRebindOwned(id);
    const previous = this.#previousDefinition(id);
    // Rolls back through the normal replacement pipeline (dependents
    // rebind, migrate runs, the health gate applies). The history entry is
    // popped only on success — a failed rollback leaves history untouched.
    // A rollback is an undo, not a new replacement, so success pops rather
    // than pushing.
    return this.#enqueue(id, () =>
      this.#replace(previous, undefined, this.#resolveTimeouts(undefined), true),
    );
  }

  checkHealth(id: string): Promise<HealthStatus> {
    this.#assertUsable();
    this.#assertNotReentrant(id);
    const record = this.#plugins.get(id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is not installed`,
        pluginId: id,
        details: { reason: 'not-installed' },
      });
    }
    const generation = record.generation;
    if (generation === undefined || record.status !== 'active') {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is not active`,
        pluginId: id,
        details: { reason: 'not-active' },
      });
    }
    // On-demand probe: the result is recorded on the generation and the
    // configured onUnhealthy policy is applied. Queued so it never
    // interleaves with a lifecycle operation on the same plugin.
    return this.#enqueue(id, async () => {
      const context = this.#buildContext(
        generation.definition,
        generation,
        new StagedContributions(generation.pluginId, generation.id),
        new Map(),
        generation.plan,
      );
      const status = await this.#runHealthCheck(
        generation,
        context,
        this.#resolveTimeouts(undefined).healthMs,
      );
      generation.health = status.ok ? 'healthy' : 'unhealthy';
      if (status.ok) {
        // A healthy re-probe lifts a quarantine imposed by the policy.
        if (generation.quarantined) {
          this.#unquarantineGeneration(generation);
        }
        return status;
      }
      if (this.#onUnhealthy === 'quarantine') {
        this.#quarantineGeneration(generation);
      } else if (this.#onUnhealthy === 'rollback') {
        const previous = this.#previousDefinition(id);
        await this.#replace(previous, undefined, this.#resolveTimeouts(undefined), true);
      }
      return status;
    });
  }

  getStatus(id: string): PluginStatus | undefined {
    return this.#plugins.get(id)?.status;
  }

  inspect(): RuntimeInspection {
    const plugins = [...this.#plugins.values()].map((record) => {
      const pinned = this.#pinned.get(record.definition.id);
      return {
        id: record.definition.id,
        status: record.status,
        generationId: record.generation?.id,
        error: record.error,
        blocked: this.#blockedOf(record),
        diagnostics: record.generation?.diagnostics.entries(),
        health: record.generation?.health,
        quarantined: record.generation?.quarantined,
        lazy: record.lazy === true && record.generation === undefined,
        pinnedGeneration: pinned?.id,
      };
    });
    const capabilities: { id: string; provider: string; version: string }[] = [];
    for (const host of this.#hostProviders.values()) {
      capabilities.push({
        id: host.capability.id,
        provider: HOST_PROVIDER_LABEL,
        version: host.capability.version,
      });
    }
    for (const [capabilityId, byGeneration] of this.#published) {
      for (const binding of byGeneration.values()) {
        capabilities.push({
          id: capabilityId,
          provider: binding.pluginId ?? HOST_PROVIDER_LABEL,
          version: binding.capability.version,
        });
      }
    }
    return buildInspection({
      plugins,
      capabilities,
      observerDiagnostics: this.#observerDiagnostics.entries(),
    });
  }

  transitions(): readonly TransitionRecord[] {
    return Object.freeze([...this.#transitions]);
  }

  validate(): readonly GraphIssue[] {
    const issues: GraphIssue[] = [];
    const pinnedIds = new Set<string>();
    for (const generation of this.#pinned.values()) {
      pinnedIds.add(generation.id);
    }
    // Every published binding must point at a live generation: active or
    // pinned. Anything else is a leak in withdrawal bookkeeping.
    for (const [tokenId, byGeneration] of this.#published) {
      for (const generationId of byGeneration.keys()) {
        if (!this.#generations.has(generationId) && !pinnedIds.has(generationId)) {
          const binding = byGeneration.get(generationId);
          issues.push({
            kind: 'stale-binding',
            pluginId: binding?.pluginId ?? undefined,
            generation: generationId,
            capabilityId: tokenId,
            message: `capability ${tokenId} is published by unknown generation ${generationId}`,
          });
        }
      }
    }
    // Single-provider capabilities and contribution keys admit exactly one
    // live, selectable claim each.
    for (const [tokenId, byGeneration] of this.#published) {
      const live = [...byGeneration.entries()].filter(([generationId, binding]) => {
        const generation = this.#generations.get(generationId);
        return generation !== undefined && !generation.quarantined && !binding.capability.multiple;
      });
      if (live.length > 1) {
        issues.push({
          kind: 'duplicate-provider',
          capabilityId: tokenId,
          message: `capability ${tokenId} is claimed by ${live.length} live generations: ${live
            .map(([generationId]) => generationId)
            .join(', ')}`,
        });
      }
    }
    for (const [keyId, byGeneration] of this.#contributions) {
      const live = [...byGeneration.keys()].filter((generationId) => {
        const generation = this.#generations.get(generationId);
        return generation !== undefined && !generation.quarantined;
      });
      if (live.length > 1) {
        issues.push({
          kind: 'duplicate-contribution',
          capabilityId: keyId,
          message: `contribution key ${keyId} is owned by ${live.length} live generations: ${live.join(', ')}`,
        });
      }
    }
    for (const generation of this.#generations.values()) {
      const record = this.#plugins.get(generation.pluginId);
      if (record === undefined || record.status !== 'active' || record.generation !== generation) {
        issues.push({
          kind: 'orphaned-generation',
          pluginId: generation.pluginId,
          generation: generation.id,
          message: `generation ${generation.id} is published but not the active generation of ${generation.pluginId}`,
        });
        continue;
      }
      // Every non-optional requirement must resolve to a selectable
      // provider right now, and every recorded provider edge must still
      // satisfy its declared range.
      for (const requirement of generation.definition.requires ?? []) {
        const capabilityId = requirement.capability.id;
        if (requirement.optional === true) {
          continue;
        }
        if (!this.#hasSelectableProvider(capabilityId, requirement.range)) {
          issues.push({
            kind: 'unresolvable-requirement',
            pluginId: generation.pluginId,
            generation: generation.id,
            capabilityId,
            message: `${generation.pluginId} requires ${capabilityId}@${requirement.range} but no live provider satisfies it`,
          });
        }
      }
      for (const [capabilityId, providerIds] of generation.resolvedProviders) {
        const declared = generation.consumed.find((entry) => entry.capabilityId === capabilityId);
        for (const providerId of providerIds) {
          const provider = this.#generations.get(providerId);
          const binding = this.#published.get(capabilityId)?.get(providerId);
          if (
            declared !== undefined &&
            provider !== undefined &&
            binding !== undefined &&
            !satisfiesRange(binding.capability.version, declared.range)
          ) {
            issues.push({
              kind: 'range-mismatch',
              pluginId: generation.pluginId,
              generation: generation.id,
              capabilityId,
              message: `${generation.pluginId} bound ${capabilityId}@${binding.capability.version} from ${providerId}, which no longer satisfies ${declared.range}`,
            });
          }
        }
      }
    }
    return Object.freeze(issues);
  }

  planStart(id: string): StartPlan {
    this.#assertUsable();
    const record = this.#requireRecord(id);
    if (record.status === 'active') {
      return Object.freeze({
        order: Object.freeze([]),
        selections: Object.freeze([]),
      });
    }
    let plan: ResolutionPlan;
    try {
      plan = resolve({
        definitions: [...this.#plugins.values()].map((entry) => entry.definition),
        statuses: this.#statuses(),
        hostProviders: this.#hostProviders,
        root: id,
        quarantined: this.#quarantinedPluginIds(),
        lazy: this.#lazyPluginIds(),
      });
    } catch (error) {
      // Same error a real start() would surface; nothing was mutated and
      // nothing was emitted — this is a dry run.
      throw MoltError.from(error, 'ACTIVATION_FAILED');
    }
    const selections = plan.edges.map((edge) => {
      const providers = plan.providers.get(edge.from)?.get(edge.capabilityId) ?? [];
      return Object.freeze({
        consumer: edge.from,
        capabilityId: edge.capabilityId,
        range: edge.range,
        optional: edge.optional,
        providers: Object.freeze(
          providers.map((provider) =>
            Object.freeze({ pluginId: provider.pluginId, version: provider.capabilityVersion }),
          ),
        ),
      });
    });
    return Object.freeze({
      order: Object.freeze([...plan.order]),
      selections: Object.freeze(selections),
    });
  }

  planStop(id: string, options?: { readonly cascade?: boolean | undefined }): StopPlan {
    this.#assertUsable();
    const record = this.#requireRecord(id);
    if (record.status !== 'active' || record.generation === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `stop requires an active plugin (${id} is ${record.status})`,
        pluginId: id,
        details: { reason: 'not-active' },
      });
    }
    const generation = record.generation;
    const dependents = this.#activeDependentsOf(generation);
    if (dependents.length > 0 && options?.cascade !== true) {
      throw new MoltError({
        code: 'ACTIVE_DEPENDENTS',
        message: `plugin ${id} has active dependents; pass { cascade: true }`,
        pluginId: id,
        path: [...dependents.map((dependent) => dependent.pluginId), id],
        details: { dependents: dependents.map((dependent) => dependent.pluginId) },
      });
    }
    const closure = this.#stopClosure(generation);
    return Object.freeze({
      stopped: Object.freeze(closure.map((target) => target.pluginId)),
    });
  }

  planReplace(
    definition: PluginDefinition,
    options?: { readonly strictDependents?: boolean | undefined },
  ): ReplacePlan {
    this.#assertUsable();
    const failure = validateDefinition(definition);
    if (failure !== undefined) {
      throw failure;
    }
    const record = this.#plugins.get(definition.id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `replace requires an installed plugin (${definition.id})`,
        pluginId: definition.id,
        details: { reason: 'not-installed' },
      });
    }
    if (record.status === 'preparing' || record.status === 'disposing') {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin is ${record.status}`,
        pluginId: definition.id,
        details: { reason: 'busy' },
      });
    }
    const old = record.generation;
    if (old === undefined) {
      // No active generation to protect — replace would delegate to
      // activation, rebounding nothing.
      return Object.freeze({
        replaced: definition.id,
        rebound: Object.freeze([]),
      });
    }
    const frozen = freezeDefinition(definition);
    this.#validateReplacementClaims(frozen, old);
    const closure = this.#dependentClosure(old);
    if (closure.length > 0 && options?.strictDependents === true) {
      const dependents = this.#activeDependentsOf(old);
      throw new MoltError({
        code: 'REPLACEMENT_FAILED',
        message: `replacement of ${definition.id} has active dependents`,
        pluginId: definition.id,
        path: [...dependents.map((generation) => generation.pluginId), definition.id],
        details: { dependents: dependents.map((generation) => generation.pluginId) },
      });
    }
    return Object.freeze({
      replaced: definition.id,
      rebound: Object.freeze(closure.map((generation) => generation.pluginId)),
    });
  }

  inspectDependents(id: string): readonly DependentInfo[] {
    this.#assertUsable();
    const record = this.#requireRecord(id);
    const generation = record.generation;
    if (generation === undefined) {
      return Object.freeze([]);
    }
    const closure = this.#dependentClosure(generation);
    return Object.freeze(
      closure.map((dependent) =>
        Object.freeze({ pluginId: dependent.pluginId, generation: dependent.id }),
      ),
    );
  }

  /**
   * Whether a capability has a selectable provider right now, mirroring
   * the resolver's eligibility including its tiers:
   * - Tier 1: a host provider, or a published, non-quarantined live
   *   generation, whose version satisfies the range.
   * - Tier 2 (revival): a stopped plugin whose definition provides a
   *   range-satisfying version — `start()` would revive it.
   * Quarantined plugins and non-active lazy plugins stay excluded in both
   * tiers, exactly as the resolver excludes them.
   */
  #hasSelectableProvider(capabilityId: string, range: string): boolean {
    const host = this.#hostProviders.get(capabilityId);
    // The resolver range-checks host candidates like any other provider:
    // a host capability whose version misses the range is not selectable.
    if (host !== undefined && satisfiesRange(host.capability.version, range)) {
      return true;
    }
    const byGeneration = this.#published.get(capabilityId);
    if (byGeneration !== undefined) {
      for (const [generationId, binding] of byGeneration) {
        const generation = this.#generations.get(generationId);
        if (
          generation === undefined ||
          generation.quarantined ||
          !satisfiesRange(binding.capability.version, range)
        ) {
          continue;
        }
        return true;
      }
    }
    const quarantined = this.#quarantinedPluginIds();
    const lazy = this.#lazyPluginIds();
    for (const [id, record] of this.#plugins) {
      if (record.status !== 'stopped' || quarantined.has(id)) {
        continue;
      }
      if (lazy.has(id)) {
        continue;
      }
      for (const provided of record.definition.provides ?? []) {
        if (
          provided.capability.id === capabilityId &&
          satisfiesRange(provided.capability.version, range)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  subscribe(listener: RuntimeListener): () => void {
    this.#observers.add(listener);
    return () => {
      this.#observers.delete(listener);
    };
  }

  contributions(): ContributionSnapshot {
    const entries = new Map<string, readonly ContributionEntry[]>();
    for (const [keyId, byGeneration] of this.#contributions) {
      entries.set(keyId, Object.freeze([...byGeneration.values()]));
    }
    return Object.freeze({ entries });
  }

  dispose(options?: { readonly timeoutMs?: number | undefined }): Promise<void> {
    if (this.#disposedPromise !== undefined) {
      return this.#disposedPromise; // idempotent
    }
    this.#disposed = true;
    // Abort every in-flight preparation synchronously. The preparation may
    // still resume later, but its commit-time guard below makes an aborted or
    // disposed generation permanently unpublishable.
    for (const preparing of this.#preparing.values()) {
      void preparing.scope.dispose();
    }
    const disposeMs = this.#resolveTimeouts(options?.timeoutMs).disposeMs;
    const run = async (): Promise<void> => {
      // Reverse activation order.
      for (const generationId of [...this.#activationOrder].reverse()) {
        const generation = this.#generations.get(generationId);
        if (generation === undefined || generation.scope.isDisposed()) {
          continue;
        }
        const report = await this.#disposeBounded(
          generation.scope,
          generation.pluginId,
          generationId,
          disposeMs,
        );
        const record = this.#plugins.get(generation.pluginId);
        if (record !== undefined) {
          record.status = 'stopped';
          record.generation = undefined;
          if (report.errors.length > 0) {
            record.error = this.#disposalFailure(generation, report);
          }
        }
        this.#withdraw(generation);
      }
      for (const pluginId of [...this.#pinned.keys()]) {
        await this.#releasePin(pluginId, disposeMs);
      }
      this.#emit({ type: 'disposed' });
    };
    this.#disposedPromise = run();
    return this.#disposedPromise;
  }

  /**
   * Pushes a replaced definition onto the plugin's rollback history,
   * evicting the oldest entry beyond the capacity bound.
   */
  #pushHistory(record: PluginRecord, definition: PluginDefinition): void {
    record.history.push(definition);
    while (record.history.length > HISTORY_CAPACITY) {
      record.history.shift();
    }
  }

  /**
   * Runs a retired generation's `drain` hook before its scope is disposed.
   * Bounded by the drain timeout: expiry aborts the drain's signal and
   * disposal proceeds regardless. A throw from the hook is collected into
   * the retired plugin's record error like a disposal failure — the
   * replacement already succeeded.
   */
  async #drainGeneration(retired: Generation, drainMs: number | undefined): Promise<void> {
    const drain = retired.definition.drain;
    if (drain === undefined) {
      return;
    }
    const controller = new AbortController();
    const context: DrainContext = {
      pluginId: retired.pluginId,
      generation: retired.id,
      signal: controller.signal,
    };
    let timedOut = false;
    try {
      await withTimeout(
        Promise.resolve().then(() => drain(context)),
        drainMs,
        () =>
          // Unreachable in practice: onTimeout records the timeout and
          // disposal proceeds; the error never escapes.
          new MoltError({
            code: 'INVALID_STATE',
            message: `drain of generation ${retired.id} timed out`,
            pluginId: retired.pluginId,
            generation: retired.id,
            details: { reason: 'drain-timeout', timeoutMs: drainMs },
          }),
        () => {
          timedOut = true;
          controller.abort();
        },
      );
    } catch (error) {
      const retiredRecord = this.#plugins.get(retired.pluginId);
      if (retiredRecord === undefined) {
        return;
      }
      // A drain problem is inspectable on the retired plugin's record, but
      // it never overwrites a more important error already recorded there:
      // the timeout especially is best-effort (disposal proceeds regardless),
      // so a later disposal failure still wins the record.
      if (retiredRecord.error !== undefined) {
        return;
      }
      if (timedOut) {
        // The drain overran its budget; disposal proceeds regardless.
        retiredRecord.error = new MoltError({
          code: 'DISPOSAL_TIMEOUT',
          message: `drain of generation ${retired.id} timed out after ${String(drainMs)}ms`,
          pluginId: retired.pluginId,
          generation: retired.id,
          details: { reason: 'drain-timeout', timeoutMs: drainMs },
        });
        return;
      }
      retiredRecord.error = new MoltError({
        code: 'DISPOSAL_FAILED',
        message: `drain of generation ${retired.id} failed`,
        pluginId: retired.pluginId,
        generation: retired.id,
        details: { reason: 'drain-failed', errors: [error] },
      });
    }
  }

  /**
   * Disposes a scope bounded by the disposal timeout. A timeout never
   * throws: the disposal keeps running in the background and the timeout
   * surfaces as a DISPOSAL_TIMEOUT entry in the report's errors, collected
   * like any other disposal failure by the caller.
   */
  async #disposeBounded(
    scope: ScopeImpl,
    pluginId: string,
    generationId: string,
    disposeMs: number | undefined,
  ): Promise<DisposalReport> {
    let timedOut = false;
    try {
      return await withTimeout(
        scope.dispose(),
        disposeMs,
        () =>
          // Unreachable in practice: onTimeout records the timeout and the
          // synthetic report below carries it; the error never escapes.
          new MoltError({
            code: 'INVALID_STATE',
            message: `disposal of generation ${generationId} timed out`,
            pluginId,
            generation: generationId,
            details: { reason: 'disposal-timeout', timeoutMs: disposeMs },
          }),
        () => {
          timedOut = true;
        },
      );
    } catch (error) {
      if (timedOut) {
        return {
          errors: [
            new MoltError({
              code: 'DISPOSAL_TIMEOUT',
              message: `disposal of generation ${generationId} timed out after ${String(disposeMs)}ms`,
              pluginId,
              generation: generationId,
              details: { reason: 'disposal-timeout', timeoutMs: disposeMs },
            }),
          ],
        };
      }
      throw error;
    }
  }

  // -- queue and guards --------------------------------------------------------

  #enqueue<T>(id: string, operation: () => Promise<T> | T): Promise<T> {
    return this.#queue.run(id, () => operation());
  }

  /**
   * Synchronous re-entry from an observer is rejected for the same plugin at
   * call time — a queued check would run after the emit finished and never
   * fire. Cross-plugin operations queue normally. The stack form keeps the
   * guard correct under nested synchronous emits (F9).
   */
  #assertNotReentrant(id: string): void {
    if (this.#reentrancyGuards.includes(id)) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: 'observer re-entered a lifecycle operation synchronously',
        pluginId: id,
        details: { reason: 're-entrant-observer' },
      });
    }
  }

  /**
   * Entry gate for caller abort signals. An already-aborted signal rejects
   * the operation with `ABORTED` before any state changes.
   */
  #assertNotAborted(signal: AbortSignal | undefined, pluginId?: string): void {
    if (signal?.aborted === true) {
      throw abortedError(pluginId);
    }
  }

  /**
   * A lifecycle call for a plugin made from that plugin's own setup would
   * queue behind the in-flight activation and deadlock if awaited (F3).
   * `stop` short-circuits cooperatively in the public method; every other
   * self-operation is a programming error and fails fast here, at call
   * time, instead of deadlocking or failing later with a confusing `busy`.
   */
  #assertNotSelfOperation(
    id: string,
    operation: 'start' | 'replace' | 'uninstall' | 'rollback',
  ): void {
    if (this.#preparing.has(id) && setupTracker.getStore()?.pluginId === id) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} cannot ${operation} itself during setup`,
        pluginId: id,
        details: { reason: 'self-operation-during-setup' },
      });
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: 'runtime is disposed',
        details: { reason: 'runtime-disposed' },
      });
    }
  }

  /**
   * A plugin owned by an in-flight dependent-rebind transaction (F5) cannot
   * take another lifecycle operation: the transaction commits or aborts
   * atomically, and interleaving would break that. Fails loudly with
   * INVALID_STATE instead of queueing behind the transaction or silently
   * observing half-rebound state.
   */
  #assertNotRebindOwned(id: string): void {
    if (this.#rebindOwners.has(id)) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is being rebound by an in-flight replacement`,
        pluginId: id,
        details: { reason: 'rebind-in-flight' },
      });
    }
  }

  // -- start / activation --------------------------------------------------------

  async #start(id: string, timeouts: ResolvedTimeouts, signal?: AbortSignal): Promise<void> {
    this.#assertUsable();
    this.#assertNotRebindOwned(id);
    let record = this.#requireRecord(id);
    if (record.status === 'active') {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: 'plugin is already active',
        pluginId: id,
        details: { reason: 'already-active' },
      });
    }
    if (record.status === 'preparing') {
      // F10: a concurrent activation is in flight — most often another
      // root's provider loop activating this plugin as a dependency.
      // Waiting for it beats the old spurious INVALID_STATE('busy'): the
      // start the caller asked for either already happened or gets a fresh
      // attempt below.
      const inflight = this.#activations.get(id);
      if (inflight === undefined) {
        // Defensive: every activation registers before its first await, so
        // an observable 'preparing' always has a tracked attempt.
        throw new MoltError({
          code: 'INVALID_STATE',
          message: `plugin is ${record.status}`,
          pluginId: id,
          details: { reason: 'busy' },
        });
      }
      try {
        await inflight;
      } catch {
        // The in-flight attempt failed; a fresh attempt starts below.
      }
      record = this.#requireRecord(id);
      if (record.status === 'active') {
        return;
      }
    }
    if (record.status === 'disposing') {
      // Unreachable behind the per-plugin queue; guarded defensively.
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin is ${record.status}`,
        pluginId: id,
        details: { reason: 'busy' },
      });
    }

    record.status = 'preparing';
    let plan: ResolutionPlan;
    try {
      plan = resolve({
        definitions: [...this.#plugins.values()].map((entry) => entry.definition),
        statuses: this.#statuses(),
        hostProviders: this.#hostProviders,
        root: id,
        quarantined: this.#quarantinedPluginIds(),
        lazy: this.#lazyPluginIds(),
      });
    } catch (error) {
      record.status = 'stopped';
      record.error = MoltError.from(error, 'ACTIVATION_FAILED');
      this.#emit({ type: 'failed', pluginId: id, error: record.error, stage: 'resolve' });
      throw record.error;
    }

    // Internal activation path: providers activate directly in closure
    // order — never by enqueueing public starts (deadlock). Concurrent
    // attempts for one provider coalesce onto the first (F10); only
    // generations this start created are rolled back on failure.
    const committed: Generation[] = [];
    try {
      for (const pluginId of plan.order) {
        if (pluginId === id) {
          continue; // the root activates last
        }
        const target = this.#plugins.get(pluginId);
        if (target === undefined) {
          // Removed by a concurrent queued op while an earlier provider's
          // setup was in flight.
          throw new MoltError({
            code: 'INVALID_STATE',
            message: `provider ${pluginId} was removed during activation`,
            pluginId,
            details: { reason: 'removed-during-activation' },
          });
        }
        if (target.status === 'active') {
          continue; // live providers are reused, never restarted
        }
        const outcome = await this.#activateCoalesced(target, plan, timeouts, signal);
        if (outcome.created) {
          committed.push(outcome.generation);
        }
      }
      const rootOutcome = await this.#activateCoalesced(record, plan, timeouts, signal);
      if (rootOutcome.created) {
        committed.push(rootOutcome.generation);
      }
    } catch (error) {
      // Every generation committed by this attempt is disposed.
      await this.#rollback(committed, timeouts.disposeMs);
      record.status = 'stopped';
      record.error = MoltError.from(error, 'ACTIVATION_FAILED');
      this.#emit({ type: 'failed', pluginId: id, error: record.error, stage: 'setup' });
      throw record.error;
    }
  }

  /**
   * Activates one plugin, coalescing concurrent attempts for the same id
   * onto the first (F10). A caller that arrives while an attempt is in
   * flight waits for it and reuses its generation; if that attempt failed,
   * the caller makes its own attempt instead of double-activating. Returns
   * whether this call created the generation — only the creator rolls it
   * back.
   */
  async #activateCoalesced(
    record: PluginRecord,
    plan: ResolutionPlan,
    timeouts: ResolvedTimeouts,
    signal?: AbortSignal,
  ): Promise<{ generation: Generation; created: boolean }> {
    const pluginId = record.definition.id;
    // A concurrent start's provider loop must not double-prepare a plugin
    // owned by a rebind transaction (F5); the transaction owns its
    // candidates exclusively.
    this.#assertNotRebindOwned(pluginId);
    const inflight = this.#activations.get(pluginId);
    if (inflight !== undefined) {
      try {
        const generation = await inflight;
        return { generation, created: false };
      } catch {
        // The in-flight attempt failed; fall through for our own attempt.
      }
      // Re-check: another attempt may have registered while we waited.
      const raced = this.#activations.get(pluginId);
      if (raced !== undefined) {
        try {
          const generation = await raced;
          return { generation, created: false };
        } catch {
          // Fall through for our own attempt.
        }
      }
    }
    if (this.#plugins.get(pluginId) === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `provider ${pluginId} was removed during activation`,
        pluginId,
        details: { reason: 'removed-during-activation' },
      });
    }
    const promise = this.#activate(record, plan, timeouts, signal);
    // Registered synchronously: concurrent attempts observe it before any
    // await can interleave.
    this.#activations.set(pluginId, promise);
    try {
      const generation = await promise;
      return { generation, created: true };
    } finally {
      if (this.#activations.get(pluginId) === promise) {
        this.#activations.delete(pluginId);
      }
    }
  }

  /**
   * Activates one plugin: private scope, setup, provide verification,
   * conflict validation, atomic commit. Nothing is globally visible before
   * commit; a failure anywhere disposes the candidate scope and
   * leaves the record stopped.
   */
  async #activate(
    record: PluginRecord,
    plan: ResolutionPlan,
    timeouts: ResolvedTimeouts,
    signal?: AbortSignal,
  ): Promise<Generation> {
    const definition = record.definition;
    const pluginId = definition.id;
    if (record.status === 'active') {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: 'plugin became active during activation',
        pluginId,
        details: { reason: 'race' },
      });
    }
    record.status = 'preparing';
    let prepared: PreparedGeneration;
    try {
      prepared = await this.#prepareGeneration(definition, plan, {
        effectiveConfig: record.effectiveConfig,
        setupMs: timeouts.setupMs,
        disposeMs: timeouts.disposeMs,
        signal,
      });
    } catch (error) {
      record.status = 'stopped';
      record.generation = undefined;
      if (error instanceof PreparationFailure) {
        throw activationError(
          error.failureCause,
          pluginId,
          error.generationId,
          error.disposalErrors,
        );
      }
      throw error;
    }
    const { generation, stagedProvides, staged } = prepared;
    const generationId = generation.id;

    try {
      // Dependency edges are recorded at commit from the resolution plan —
      // a plugin that never calls require() still creates a dependency
      // so dependent tracking sees complete edges.
      this.#recordResolvedProviders(definition, generation, plan);
      // Atomic commit.
      if (this.#disposed || prepared.scope.isDisposed()) {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: 'runtime was disposed before activation commit',
          pluginId,
          generation: generationId,
          details: { reason: 'runtime-disposed' },
        });
      }
      record.status = 'active';
      record.generation = generation;
      record.error = undefined;
      for (const [tokenId, binding] of stagedProvides) {
        let byGeneration = this.#published.get(tokenId);
        if (byGeneration === undefined) {
          byGeneration = new Map<string, PublishedBinding>();
          this.#published.set(tokenId, byGeneration);
        }
        byGeneration.set(generationId, {
          pluginId,
          capability: binding.capability,
          value: binding.value,
        });
        generation.providedTokenIds.push(tokenId);
      }
      for (const [keyId, entry] of staged.commit()) {
        let byGeneration = this.#contributions.get(keyId);
        if (byGeneration === undefined) {
          byGeneration = new Map<string, ContributionEntry>();
          this.#contributions.set(keyId, byGeneration);
        }
        byGeneration.set(generationId, entry);
      }
      this.#generations.set(generationId, generation);
      this.#activationOrder.push(generationId);
      this.#emit({ type: 'started', pluginId, generation: generationId });
    } catch (error) {
      // The scope is disposed so no resource leaks; the report is discarded
      // because the activation failure below carries the cause.
      const report = await this.#disposeBounded(
        prepared.scope,
        pluginId,
        generationId,
        timeouts.disposeMs,
      );
      void report;
      record.status = 'stopped';
      record.generation = undefined;
      throw activationError(error, pluginId, generationId);
    }

    // Post-commit readiness gate. The generation is fully live — bindings
    // published, contributions visible — so the hook can probe the real
    // wiring. A failing gate rolls the activation back: withdraw, dispose,
    // and report the generation as stopped, as if it never started.
    const healthContext = this.#buildContext(
      definition,
      generation,
      new StagedContributions(pluginId, generationId),
      new Map(),
      plan,
    );
    const health = await this.#runHealthCheck(generation, healthContext, timeouts.healthMs, signal);
    generation.health = health.ok ? 'healthy' : 'unhealthy';
    if (!health.ok) {
      this.#withdraw(generation);
      const disposeReport = await this.#disposeBounded(
        generation.scope,
        pluginId,
        generationId,
        timeouts.disposeMs,
      );
      void disposeReport;
      record.status = 'stopped';
      record.generation = undefined;
      const error = new MoltError({
        code: 'ACTIVATION_FAILED',
        message: `plugin ${pluginId} failed its health check${health.message !== undefined ? `: ${health.message}` : ''}`,
        pluginId,
        generation: generationId,
        details: { reason: 'unhealthy', healthMessage: health.message },
      });
      record.error = error;
      this.#emit({ type: 'stopped', pluginId, generation: generationId });
      throw error;
    }
    return generation;
  }

  /**
   * Runs a generation's `healthCheck` hook. A missing hook reports healthy.
   * A timeout counts as an unhealthy result (never an error); a throw from
   * the hook is also an unhealthy result carrying the error. A malformed
   * return value fails closed to unhealthy.
   */
  async #runHealthCheck(
    generation: Generation,
    context: PluginContext,
    healthMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<HealthStatus> {
    const hook = generation.definition.healthCheck;
    if (hook === undefined) {
      return { ok: true };
    }
    const pluginId = generation.pluginId;
    const generationId = generation.id;
    let result: HealthStatus | undefined;
    let timedOut = false;
    try {
      result = await abortable(
        withTimeout(
          Promise.resolve().then(() => hook(context)),
          healthMs,
          () =>
            // Unreachable in practice: onTimeout records the timeout and the
            // resulting unhealthy status below; the error never escapes.
            new MoltError({
              code: 'INVALID_STATE',
              message: `health check of plugin ${pluginId} timed out`,
              pluginId,
              generation: generationId,
              details: { reason: 'health-timeout', timeoutMs: healthMs },
            }),
          () => {
            timedOut = true;
          },
        ),
        signal,
        () => abortedError(pluginId),
      );
    } catch (error) {
      // A caller abort is cancellation, not an unhealthy verdict — it must
      // propagate instead of being recorded as a failed probe.
      if (isMoltError(error) && error.code === 'ABORTED') {
        throw error;
      }
      if (timedOut) {
        return { ok: false, message: `health check timed out after ${String(healthMs)}ms` };
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (result === undefined || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      return { ok: false, message: 'health check returned a malformed result' };
    }
    return {
      ok: result.ok,
      message: typeof result.message === 'string' ? result.message : undefined,
    };
  }

  /**
   * Prepare a generation without committing it: private scope, setup,
   * provide verification, conflict validation. Nothing is globally visible;
   * a failure disposes the candidate scope and throws `PreparationFailure`
   * carrying the cause and any scope-disposal errors. Callers commit via
   * `#publishPrepared` (or `#activate`'s inline commit) and apply their own
   * failure semantics.
   */
  async #prepareGeneration(
    definition: PluginDefinition,
    plan: ResolutionPlan,
    options: PrepareOptions,
  ): Promise<PreparedGeneration> {
    const pluginId = definition.id;
    this.#generationCounter += 1;
    const generationId = `${pluginId}#${String(this.#generationCounter)}`;
    const scope = new ScopeImpl();
    const generation: Generation = {
      id: generationId,
      pluginId,
      scope,
      definition,
      consumed: (definition.requires ?? []).map((requirement) => ({
        capabilityId: requirement.capability.id,
        range: requirement.range,
      })),
      resolvedProviders: new Map<string, Set<string>>(),
      providedTokenIds: [],
      diagnostics: new BoundedLog<DiagnosticInput>(DIAGNOSTIC_CAPACITY),
      rebindOverlay: options.rebindOverlay,
      config: options.effectiveConfig,
      plan,
      health: 'unknown',
      quarantined: false,
      quarantinedState: undefined,
      pinned: false,
    };
    this.#preparing.set(pluginId, generation);
    const staged = new StagedContributions(pluginId, generationId);
    const stagedProvides = new Map<string, { capability: Capability<unknown>; value: unknown }>();
    const context = this.#buildContext(definition, generation, staged, stagedProvides, plan);
    const setupMs = options.setupMs;

    try {
      // Setup. A creation error is the plugin's own error and propagates
      // raw; the caller wraps it once with identity context. Runs inside
      // the setup tracker so lifecycle calls made from this setup are
      // recognized as self-operations (F3). Bounded by the setup timeout:
      // on expiry the candidate scope is disposed (aborting its signal)
      // and the preparation fails with SETUP_TIMEOUT.
      const returned = await abortable(
        withTimeout(
          Promise.resolve(setupTracker.run({ pluginId }, () => definition.setup(context))),
          setupMs,
          () =>
            new MoltError({
              code: 'SETUP_TIMEOUT',
              message: `setup of plugin ${pluginId} timed out`,
              pluginId,
              generation: generationId,
              details: { reason: 'setup-timeout', timeoutMs: setupMs },
            }),
        ),
        options.signal,
        () => abortedError(pluginId),
      );
      if (adoptable(returned)) {
        // A returned disposer is adopted before any validation or
        // commit step — cleaned up on validation failure too.
        await adoptReturnedDisposer(scope, returned);
      }
      if (this.#disposed) {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: 'runtime was disposed during activation',
          pluginId,
          generation: generationId,
          details: { reason: 'runtime-disposed' },
        });
      }
      if (scope.isDisposed()) {
        // Cooperative abort: stop() was called for this plugin while its
        // setup was in flight — including the self-stop short-circuit (F3).
        throw new MoltError({
          code: 'INVALID_STATE',
          message: `setup was aborted for ${pluginId}`,
          pluginId,
          generation: generationId,
          details: { reason: 'preparation-aborted' },
        });
      }
      // F6 state migration. Runs after setup and before commit, inside the
      // candidate's scope: a throw fails the replacement (the catch below
      // disposes the candidate scope) and the old generation keeps serving.
      // Only replacements have a shadowed generation — first start and
      // restart never migrate. Runs inside the setup tracker so the hook
      // is unambiguously part of preparation: lifecycle calls from it get
      // setup's self-operation semantics (F3) rather than running as
      // unrelated reentrant work.
      const shadowed = options?.shadowed;
      const migrate = definition.migrate;
      if (migrate !== undefined && shadowed !== undefined) {
        const provided = new Map<string, unknown>();
        for (const byGeneration of this.#published.values()) {
          const binding = byGeneration.get(shadowed.id);
          if (binding !== undefined) {
            provided.set(binding.capability.id, binding.value);
          }
        }
        const previous: MigrationPrevious = {
          pluginId: shadowed.pluginId,
          generation: shadowed.id,
          version: shadowed.definition.version,
          stateVersion: shadowed.definition.stateVersion,
          provided,
        };
        await abortable(
          withTimeout(
            Promise.resolve(
              setupTracker.run({ pluginId }, () =>
                migrate(
                  previous,
                  this.#migrateContext(definition, generation, stagedProvides, context),
                ),
              ),
            ),
            setupMs,
            () =>
              new MoltError({
                code: 'SETUP_TIMEOUT',
                message: `migration of plugin ${pluginId} timed out`,
                pluginId,
                generation: generationId,
                details: { reason: 'migrate-timeout', timeoutMs: setupMs },
              }),
          ),
          options.signal,
          () => abortedError(pluginId),
        );
        if (scope.isDisposed()) {
          // A self-stop from the hook disposes the candidate scope via the
          // same short-circuit as setup — abort preparation the same way.
          throw new MoltError({
            code: 'INVALID_STATE',
            message: `migration was aborted for ${pluginId}`,
            pluginId,
            generation: generationId,
            details: { reason: 'preparation-aborted' },
          });
        }
      }
      // Declared provides must have been published.
      for (const provided of definition.provides ?? []) {
        if (!stagedProvides.has(provided.capability.id)) {
          throw new MoltError({
            code: 'ACTIVATION_FAILED',
            message: `declared capability ${provided.capability.id} was never published`,
            pluginId,
            generation: generationId,
            capabilityId: provided.capability.id,
            details: { reason: 'declared-not-published' },
          });
        }
      }
      // Conflicts: a single-provider token may collide with no unrelated
      // active generation; multi-provider tokens coexist by design. A
      // rebound generation shadows the generation it replaces, which is
      // withdrawn at commit.
      this.#assertNoStagedConflicts(
        stagedProvides,
        staged,
        options?.shadowed?.id,
        pluginId,
        generationId,
      );
      return { generation, scope, stagedProvides, staged };
    } catch (error) {
      const report = await this.#disposeBounded(scope, pluginId, generationId, options.disposeMs);
      throw new PreparationFailure(generationId, error, report.errors);
    } finally {
      this.#preparing.delete(pluginId);
    }
  }

  /**
   * Publish a prepared generation: staged provides, staged contributions,
   * record swap. Synchronous — callers withdraw the replaced generation
   * first so the swap is atomic.
   */
  #publishPrepared(
    record: PluginRecord,
    definition: PluginDefinition,
    prepared: PreparedGeneration,
  ): void {
    const { generation, stagedProvides, staged } = prepared;
    const generationId = generation.id;
    for (const [tokenId, binding] of stagedProvides) {
      let byGeneration = this.#published.get(tokenId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, PublishedBinding>();
        this.#published.set(tokenId, byGeneration);
      }
      byGeneration.set(generationId, {
        pluginId: definition.id,
        capability: binding.capability,
        value: binding.value,
      });
      generation.providedTokenIds.push(tokenId);
    }
    for (const [keyId, entry] of staged.commit()) {
      let byGeneration = this.#contributions.get(keyId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, ContributionEntry>();
        this.#contributions.set(keyId, byGeneration);
      }
      byGeneration.set(generationId, entry);
    }
    record.definition = definition;
    record.generation = generation;
    record.error = undefined;
    this.#generations.set(generationId, generation);
    this.#activationOrder.push(generationId);
  }

  // -- replacement -------------------------------------------------------------

  async #replace(
    definition: PluginDefinition,
    options: ReplaceOptions | undefined,
    timeouts: ResolvedTimeouts,
    isRollback: boolean,
  ): Promise<void> {
    this.#assertUsable();
    this.#assertNotRebindOwned(definition.id);
    const failure = validateDefinition(definition);
    if (failure !== undefined) {
      throw failure;
    }
    const inFlight = options?.inFlight ?? 'drain';
    if (inFlight !== 'drain' && inFlight !== 'immediate' && inFlight !== 'pin') {
      throw new MoltError({
        code: 'INVALID_DEFINITION',
        message: `invalid inFlight policy: ${String(options?.inFlight)}`,
        pluginId: definition.id,
        details: { reason: 'invalid-inFlight' },
      });
    }
    const record = this.#plugins.get(definition.id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `replace requires an installed plugin (${definition.id})`,
        pluginId: definition.id,
        details: { reason: 'not-installed' },
      });
    }
    if (record.status === 'preparing' || record.status === 'disposing') {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin is ${record.status}`,
        pluginId: definition.id,
        details: { reason: 'busy' },
      });
    }
    const frozen = freezeDefinition(definition);
    // The new definition's defaults merge with the carried-over user
    // overrides; a failing validateConfig rejects the replacement before
    // anything is prepared.
    let newEffectiveConfig: Readonly<Record<string, unknown>>;
    try {
      newEffectiveConfig = resolveConfig(frozen, record.configOverrides, 'INVALID_DEFINITION');
    } catch (error) {
      record.error = this.#replacementFailure(error, definition.id);
      this.#emit({ type: 'failed', pluginId: definition.id, error: record.error, stage: 'config' });
      throw record.error;
    }
    const old = record.generation;
    if (old === undefined) {
      // No active generation to protect — delegate to activation.
      const previousDefinition = record.definition;
      const previousEffectiveConfig = record.effectiveConfig;
      record.definition = frozen;
      record.effectiveConfig = newEffectiveConfig;
      try {
        await this.#start(definition.id, timeouts);
      } catch (error) {
        // Activation failed: restore the previous definition so a failed
        // replace/rollback leaves the record as it was.
        record.definition = previousDefinition;
        record.effectiveConfig = previousEffectiveConfig;
        throw error;
      }
      if (isRollback) {
        record.history.pop();
      } else {
        this.#pushHistory(record, previousDefinition);
      }
      return;
    }

    // The transitive active dependent closure (provider-first). With the
    // default policy these dependents are rebound onto the candidate
    // transactionally; `strictDependents` opts back into the v1 rejection.
    const closure = this.#dependentClosure(old);
    if (closure.length > 0 && options?.strictDependents === true) {
      // Rejected before any candidate scope exists, so a rejected
      // replacement acquires nothing. Reports direct dependents, as v1 did.
      const dependents = this.#activeDependentsOf(old);
      throw new MoltError({
        code: 'REPLACEMENT_FAILED',
        message: `replacement of ${definition.id} has active dependents`,
        pluginId: definition.id,
        path: [...dependents.map((generation) => generation.pluginId), definition.id],
        details: { dependents: dependents.map((generation) => generation.pluginId) },
      });
    }

    try {
      this.#validateReplacementClaims(frozen, old);
    } catch (error) {
      record.error = this.#replacementFailure(error, definition.id);
      this.#emit({
        type: 'failed',
        pluginId: definition.id,
        error: record.error,
        stage: 'validate',
      });
      throw record.error;
    }

    let candidatePlan: ResolutionPlan;
    try {
      const providers: CandidateProvider[] = [];
      for (const host of this.#hostProviders.values()) {
        providers.push({ pluginId: null, capability: host.capability });
      }
      for (const byGeneration of this.#published.values()) {
        for (const binding of byGeneration.values()) {
          providers.push({ pluginId: binding.pluginId, capability: binding.capability });
        }
      }
      candidatePlan = resolveCandidate({ definition: frozen, providers });
    } catch (error) {
      record.error = this.#replacementFailure(error, definition.id);
      this.#emit({
        type: 'failed',
        pluginId: definition.id,
        error: record.error,
        stage: 'resolve',
      });
      throw record.error;
    }

    // Transactional dependent rebind (F5). Every old generation in the
    // closure is replaced by a privately prepared candidate; the candidates
    // become visible atomically at commit, or nothing changes at all.
    // Ownership is claimed synchronously before the first await, so
    // concurrent lifecycle operations for the involved plugins fail loudly
    // instead of interleaving. The old generations keep serving until
    // commit; dependent setups resolve candidate values through the
    // transaction overlay, which is never globally visible.
    const items: {
      old: Generation;
      definition: PluginDefinition;
      plan: ResolutionPlan | undefined;
      prepared: PreparedGeneration | undefined;
    }[] = [{ old, definition: frozen, plan: candidatePlan, prepared: undefined }];
    for (const dependentOld of closure) {
      const dependentRecord = this.#plugins.get(dependentOld.pluginId);
      if (dependentRecord === undefined || dependentRecord.status !== 'active') {
        // Defensive: closure discovery runs synchronously just above, so no
        // interleaving is possible — but a violated assumption must fail
        // before anything is acquired, never mid-transaction.
        throw this.#replacementFailure(
          new MoltError({
            code: 'INVALID_STATE',
            message: `dependent ${dependentOld.pluginId} changed during replacement`,
            pluginId: definition.id,
            details: { reason: 'concurrent-modification' },
          }),
          definition.id,
        );
      }
      items.push({
        old: dependentOld,
        definition: dependentRecord.definition,
        plan: undefined,
        prepared: undefined,
      });
    }
    const oldsInOrder = items.map((item) => item.old);
    const reboundIds = new Set(oldsInOrder.map((generation) => generation.id));
    // A second transaction whose closure intersects this one's would
    // prepare competing candidates for the same plugin — e.g. replace(P)
    // while replace(A) is in flight, where C depends on both. The public
    // entry point already rejects the replaced plugin itself; the closure
    // needs the same guard here. Check-and-claim is synchronous, so two
    // transactions can never both believe they own a plugin.
    for (const owned of oldsInOrder) {
      this.#assertNotRebindOwned(owned.pluginId);
    }
    for (const owned of oldsInOrder) {
      this.#rebindOwners.add(owned.pluginId);
    }
    // The binding overlay is a transaction-local value, not runtime state:
    // unrelated replacements may prepare concurrently, and a shared field
    // would let one transaction resolve another's staged bindings.
    const overlay: RebindOverlay = new Map();
    const prepared: PreparedGeneration[] = [];
    let committed:
      | {
          old: Generation;
          definition: PluginDefinition;
          plan: ResolutionPlan;
          prepared: PreparedGeneration;
          oldBindings: Map<string, PublishedBinding>;
          oldContributions: Map<string, ContributionEntry>;
        }[]
      | undefined;
    // Ownership spans the whole transaction — preparation, health gate,
    // commit, and retirement. Releasing it before the health gate would let
    // a concurrent stop/updateConfig/replace interleave with the awaited
    // probes and corrupt the commit or the rollback.
    try {
      try {
        // The provider candidate prepares first: range checks and dependent
        // plans need its staged provides.
        const providerItem = items[0];
        if (providerItem === undefined || providerItem.plan === undefined) {
          throw new MoltError({
            code: 'INVALID_STATE',
            message: 'rebind transaction is internally inconsistent',
            pluginId: definition.id,
            details: { reason: 'transaction-corrupt' },
          });
        }
        providerItem.prepared = await this.#prepareGeneration(
          providerItem.definition,
          providerItem.plan,
          {
            shadowed: providerItem.old,
            disposeMs: timeouts.disposeMs,
            rebindOverlay: overlay,
            effectiveConfig: newEffectiveConfig,
            setupMs: timeouts.setupMs,
            signal: options?.signal,
          },
        );
        prepared.push(providerItem.prepared);
        this.#stageRebindBindings(providerItem.prepared, overlay);

        // Every dependent's declared range must still be satisfied by the
        // rebound providers. Optional requirements the candidate no longer
        // satisfies bind nothing instead of failing the transaction.
        const droppedByDependent = this.#checkDependentRanges(
          oldsInOrder,
          reboundIds,
          providerItem.prepared.stagedProvides,
          definition.id,
        );

        for (const item of items.slice(1)) {
          const plan = this.#rebindPlan(
            item.old,
            item.definition,
            droppedByDependent.get(item.old.id) ?? new Set<string>(),
            reboundIds,
            overlay,
          );
          item.plan = plan;
          const dependentRecord = this.#plugins.get(item.old.pluginId);
          item.prepared = await this.#prepareGeneration(item.definition, plan, {
            shadowed: item.old,
            disposeMs: timeouts.disposeMs,
            rebindOverlay: overlay,
            // Dependents keep their own definitions and configurations; only
            // the replaced plugin's config changes.
            effectiveConfig: dependentRecord?.effectiveConfig ?? EMPTY_CONFIG,
            setupMs: timeouts.setupMs,
            signal: options?.signal,
          });
          prepared.push(item.prepared);
          this.#stageRebindBindings(item.prepared, overlay);
        }

        // Synchronous state commit: validate, withdraw every old generation,
        // publish every candidate, swap records. No awaits: nothing can
        // interleave between validation and publication. No event is emitted
        // yet — the health gate below runs first, so observers never see a
        // replacement that gets rolled back.
        committed = this.#commitRebindState(definition.id, items);
      } catch (error) {
        // Abort: dispose every prepared candidate in reverse preparation
        // order (dependents before the providers they resolved) and leave
        // every old generation exactly as it was — the olds were never
        // withdrawn, so there is nothing to restore.
        const disposalErrors: unknown[] = [];
        for (const candidate of [...prepared].reverse()) {
          const report = await this.#disposeBounded(
            candidate.scope,
            candidate.generation.pluginId,
            candidate.generation.id,
            timeouts.disposeMs,
          );
          disposalErrors.push(...report.errors);
        }
        if (error instanceof PreparationFailure) {
          record.error = this.#replacementFailure(
            error.failureCause,
            definition.id,
            error.generationId,
            [...error.disposalErrors, ...disposalErrors],
          );
        } else {
          record.error = this.#replacementFailure(error, definition.id, undefined, disposalErrors);
        }
        this.#emit({
          type: 'failed',
          pluginId: definition.id,
          error: record.error,
          stage: 'prepare',
        });
        throw record.error;
      }

      if (committed === undefined) {
        // Unreachable: the try block either commits or throws, and the catch
        // always rethrows. Guarded for the type checker.
        throw new MoltError({
          code: 'INVALID_STATE',
          message: 'rebind transaction is internally inconsistent',
          pluginId: definition.id,
          details: { reason: 'transaction-corrupt' },
        });
      }

      // Post-commit readiness gate over every candidate in the closure. A
      // failing gate rolls the whole transaction back: candidates are
      // withdrawn and disposed, olds restored exactly as they were.
      for (const entry of committed) {
        const candidate = entry.prepared.generation;
        const healthContext = this.#buildContext(
          entry.definition,
          candidate,
          new StagedContributions(candidate.pluginId, candidate.id),
          new Map(),
          entry.plan,
        );
        const health = await this.#runHealthCheck(
          candidate,
          healthContext,
          timeouts.healthMs,
          options?.signal,
        );
        candidate.health = health.ok ? 'healthy' : 'unhealthy';
        if (!health.ok) {
          await this.#rollbackRebind(committed, timeouts.disposeMs);
          record.error = this.#replacementFailure(
            new MoltError({
              code: 'REPLACEMENT_FAILED',
              message: `plugin ${candidate.pluginId} failed its health check${health.message !== undefined ? `: ${health.message}` : ''}`,
              pluginId: candidate.pluginId,
              generation: candidate.id,
              details: { reason: 'unhealthy', healthMessage: health.message },
            }),
            definition.id,
            candidate.id,
          );
          this.#emit({
            type: 'failed',
            pluginId: definition.id,
            error: record.error,
            stage: 'health',
          });
          throw record.error;
        }
      }

      // The replacement sticks: record the new effective config, push the
      // replaced definition onto the rollback history (or pop on rollback),
      // then emit, provider-first.
      record.definition = frozen;
      record.effectiveConfig = newEffectiveConfig;
      if (isRollback) {
        record.history.pop();
      } else {
        this.#pushHistory(record, old.definition);
      }
      for (const entry of committed) {
        this.#emit({
          type: 'replaced',
          pluginId: entry.old.pluginId,
          generation: entry.prepared.generation.id,
        });
      }

      // Only after a successful commit: retire the old scopes, dependents
      // first (reverse provider-first order, mirroring cascade stop). The
      // in-flight policy selects the treatment:
      // - 'drain' (default): the `drain` hook runs before the disposers,
      //   bounded by the drain timeout — expiry aborts the drain and
      //   disposal proceeds regardless.
      // - 'immediate': the drain hook is skipped, scopes are disposed at
      //   once.
      // - 'pin': scopes are kept alive for existing holders (no drain, no
      //   dispose); at most one pinned generation per plugin.
      // A disposal failure here is inspectable on the retired plugin's
      // record; the replacement already succeeded and is never rolled back.
      for (const retired of [...oldsInOrder].reverse()) {
        // A quarantined generation never returns to selection: drop the
        // stash instead of leaving it dangling on a retired generation.
        if (retired.quarantined) {
          retired.quarantined = false;
          retired.quarantinedState = undefined;
        }
        if (inFlight === 'pin') {
          await this.#pinGeneration(retired, timeouts.disposeMs);
          continue;
        }
        if (inFlight === 'drain') {
          await this.#drainGeneration(retired, timeouts.drainMs);
        }
        const report = await this.#disposeBounded(
          retired.scope,
          retired.pluginId,
          retired.id,
          timeouts.disposeMs,
        );
        if (report.errors.length > 0) {
          const retiredRecord = this.#plugins.get(retired.pluginId);
          if (retiredRecord !== undefined) {
            retiredRecord.error = this.#disposalFailure(retired, report);
          }
        }
      }
    } finally {
      for (const owned of oldsInOrder) {
        this.#rebindOwners.delete(owned.pluginId);
      }
    }
  }

  // -- stop / cascade -------------------------------------------------------------

  async #stop(id: string, cascade: boolean, disposeMs: number | undefined): Promise<void> {
    this.#assertUsable();
    this.#assertNotRebindOwned(id);
    const record = this.#requireRecord(id);
    if (record.status === 'stopped') {
      return; // no-op
    }
    if (record.status !== 'active' || record.generation === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `stop requires an active plugin (${id} is ${record.status})`,
        pluginId: id,
        details: { reason: 'not-active' },
      });
    }
    const generation = record.generation;
    const dependents = this.#activeDependentsOf(generation);
    if (dependents.length > 0 && !cascade) {
      throw new MoltError({
        code: 'ACTIVE_DEPENDENTS',
        message: `plugin ${id} has active dependents; pass { cascade: true }`,
        pluginId: id,
        path: [...dependents.map((dependent) => dependent.pluginId), id],
        details: { dependents: dependents.map((dependent) => dependent.pluginId) },
      });
    }

    const closure = this.#stopClosure(generation);

    const stoppedIds: string[] = [];
    for (const target of closure) {
      const targetRecord = this.#plugins.get(target.pluginId);
      if (targetRecord !== undefined) {
        targetRecord.status = 'disposing';
      }
      const report = await this.#disposeBounded(
        target.scope,
        target.pluginId,
        target.id,
        disposeMs,
      );
      if (targetRecord !== undefined) {
        targetRecord.status = 'stopped';
        targetRecord.generation = undefined;
        if (report.errors.length > 0) {
          targetRecord.error = this.#disposalFailure(target, report);
        }
      }
      this.#withdraw(target);
      stoppedIds.push(target.pluginId);
      // A stopped plugin releases its pin: nothing is active anymore, and
      // the host asked for teardown.
      await this.#releasePin(target.pluginId, disposeMs);
      this.#emit({
        type: 'stopped',
        pluginId: target.pluginId,
        generation: target.id,
        // A frozen copy per event: sharing the growing array would let a
        // later step mutate earlier listeners' snapshots.
        cascade: cascade && closure.length > 1 ? Object.freeze([...stoppedIds]) : undefined,
      });
    }
  }

  /**
   * The stop closure for a generation: transitive active dependents first
   * (dependents before the providers they resolved), then the generation
   * itself. Shared by `#stop` and `planStop`.
   */
  #stopClosure(generation: Generation): Generation[] {
    // Reverse dependency order: dependents first, deterministic.
    const closure: Generation[] = [];
    const visited = new Set<string>([generation.id]);
    const visit = (target: Generation): void => {
      for (const dependent of this.#activeDependentsOf(target)) {
        if (!visited.has(dependent.id)) {
          visited.add(dependent.id);
          visit(dependent);
          closure.push(dependent);
        }
      }
    };
    visit(generation);
    closure.push(generation);
    return closure;
  }

  // -- uninstall -----------------------------------------------------------------

  async #uninstall(id: string, disposeMs: number | undefined): Promise<void> {
    this.#assertUsable();
    this.#assertNotRebindOwned(id);
    const record = this.#plugins.get(id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is not installed`,
        pluginId: id,
        details: { reason: 'not-installed' },
      });
    }
    if (record.status !== 'installed' && record.status !== 'stopped') {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `uninstall requires a stopped or installed plugin (${id} is ${record.status})`,
        pluginId: id,
        details: { reason: 'not-stopped' },
      });
    }
    if (this.#activeDependentsOfPlugin(id).length > 0) {
      // Defensive: unreachable while the provider is not active; kept as a
      // structured guard.
      throw new MoltError({
        code: 'ACTIVE_DEPENDENTS',
        message: `plugin ${id} has active dependents`,
        pluginId: id,
      });
    }
    // Uninstalling drops the plugin entirely, pins included.
    await this.#releasePin(id, disposeMs);
    this.#plugins.delete(id);
  }

  // -- helpers -----------------------------------------------------------------------

  #validateReplacementClaims(definition: PluginDefinition, old: Generation): void {
    for (const provided of definition.provides ?? []) {
      if (provided.capability.multiple) {
        continue;
      }
      if (this.#hostProviders.has(provided.capability.id)) {
        throw new MoltError({
          code: 'AMBIGUOUS_PROVIDER',
          message: `a host provider already claims ${provided.capability.id}`,
          pluginId: definition.id,
          capabilityId: provided.capability.id,
        });
      }
      const byGeneration = this.#published.get(provided.capability.id);
      if (byGeneration === undefined) {
        continue;
      }
      for (const generationId of byGeneration.keys()) {
        if (generationId !== old.id) {
          throw new MoltError({
            code: 'AMBIGUOUS_PROVIDER',
            message: `capability ${provided.capability.id} is already published by another active generation`,
            pluginId: definition.id,
            capabilityId: provided.capability.id,
          });
        }
      }
    }
  }

  #replacementFailure(
    error: unknown,
    pluginId: string,
    generation?: string,
    disposalErrors: readonly unknown[] = [],
  ): MoltError {
    // Cancellation is not a candidate failure: a caller-aborted replace
    // surfaces ABORTED so hosts can distinguish it from a bad candidate.
    if (isMoltError(error) && error.code === 'ABORTED') {
      return error;
    }
    const details = disposalErrors.length > 0 ? { disposalErrors } : undefined;
    return new MoltError(
      {
        code: 'REPLACEMENT_FAILED',
        message: `candidate replacement of ${pluginId} failed`,
        pluginId,
        ...(generation !== undefined ? { generation } : {}),
        ...(details !== undefined ? { details } : {}),
      },
      error,
    );
  }

  /**
   * Stage a provided capability value. Shared by setup-phase `provide` and
   * the F6 `migrate` hook: the declaration and shape checks are identical,
   * but during migration a provide overwrites a value `setup` staged, so
   * the hook owns the final published values.
   */
  #stageProvided(
    definition: PluginDefinition,
    stagedProvides: Map<string, { capability: Capability<unknown>; value: unknown }>,
    pluginId: string,
    generationId: string,
    token: Capability<unknown>,
    value: unknown,
    allowOverwrite: boolean,
  ): void {
    const declared = definition.provides?.some((p) => p.capability.id === token.id);
    if (declared !== true) {
      // A plugin cannot provide a capability it did not declare.
      throw new MoltError({
        code: 'ACTIVATION_FAILED',
        message: `provided undeclared capability ${token.id}`,
        pluginId,
        generation: generationId,
        capabilityId: token.id,
      });
    }
    if (stagedProvides.has(token.id) && !allowOverwrite) {
      throw new MoltError({
        code: 'ACTIVATION_FAILED',
        message: `capability ${token.id} provided twice`,
        pluginId,
        generation: generationId,
        capabilityId: token.id,
      });
    }
    if (token.multiple === true && !Array.isArray(value)) {
      // Multi-provider tokens aggregate collections: each provider
      // publishes an array, consumers receive the concatenation.
      throw new MoltError({
        code: 'ACTIVATION_FAILED',
        message: `multi-provider capability ${token.id} must be published as an array`,
        pluginId,
        generation: generationId,
        capabilityId: token.id,
      });
    }
    stagedProvides.set(token.id, { capability: token, value });
  }

  /**
   * The context handed to a definition's `migrate` hook: the candidate's
   * own context, except `provide` may overwrite a value `setup` staged.
   * Everything else — scope, signal, require, config — is identical, so
   * the hook runs with the candidate's full authority inside its scope.
   */
  #migrateContext(
    definition: PluginDefinition,
    generation: Generation,
    stagedProvides: Map<string, { capability: Capability<unknown>; value: unknown }>,
    context: PluginContext,
  ): PluginContext {
    return {
      ...context,
      provide: <T>(token: Capability<T>, value: T): void => {
        this.#stageProvided(
          definition,
          stagedProvides,
          generation.pluginId,
          generation.id,
          token,
          value,
          true,
        );
      },
    };
  }

  #buildContext(
    definition: PluginDefinition,
    generation: Generation,
    staged: StagedContributions,
    stagedProvides: Map<string, { capability: Capability<unknown>; value: unknown }>,
    plan: ResolutionPlan,
  ): PluginContext {
    const pluginId = generation.pluginId;
    const generationId = generation.id;
    return {
      pluginId,
      generation: generationId,
      signal: generation.scope.signal,
      scope: generation.scope,
      // The generation's frozen effective config: definition defaults
      // merged with install/updateConfig overrides, validated. Shared by
      // reference — a later updateConfig replaces the record's object,
      // never this one.
      config: generation.config,
      require: <T>(token: Capability<T>): T => {
        const requirement = definition.requires?.find((r) => r.capability.id === token.id);
        if (requirement === undefined) {
          // The type system prevents this in TS; the runtime check
          // protects JS consumers.
          throw new MoltError({
            code: 'INVALID_STATE',
            message: `capability ${token.id} is not a declared requirement`,
            pluginId,
            generation: generationId,
            capabilityId: token.id,
            details: { reason: 'undeclared-requirement' },
          });
        }
        return this.#requirementValue(requirement, token, generation, plan) as T;
      },
      optional: <T>(token: Capability<T>): T | undefined => {
        const requirement = definition.requires?.find(
          (r) => r.capability.id === token.id && r.optional === true,
        );
        if (requirement === undefined) {
          throw new MoltError({
            code: 'INVALID_STATE',
            message: `capability ${token.id} is not a declared optional requirement`,
            pluginId,
            generation: generationId,
            capabilityId: token.id,
            details: { reason: 'undeclared-requirement' },
          });
        }
        return this.#requirementValue(requirement, token, generation, plan) as T | undefined;
      },
      provide: <T>(token: Capability<T>, value: T): void => {
        this.#stageProvided(
          definition,
          stagedProvides,
          pluginId,
          generationId,
          token,
          value,
          false,
        );
      },
      contribute: <T>(key: ContributionKey<T>, value: T): void => {
        staged.stage(key, value);
      },
      diagnose: (input: DiagnosticInput): void => {
        generation.diagnostics.push(snapshotDiagnosticInput(input));
      },
    };
  }

  /**
   * Records the dependency edges of a generation at commit time — a plugin
   * that never calls require() still creates a dependency, because
   * dependent tracking needs complete edges.
   */
  #recordResolvedProviders(
    definition: PluginDefinition,
    generation: Generation,
    plan: ResolutionPlan,
  ): void {
    for (const requirement of definition.requires ?? []) {
      const capabilityId = requirement.capability.id;
      const selections = plan.providers.get(definition.id)?.get(capabilityId) ?? [];
      for (const selection of selections) {
        if (selection.pluginId === null) {
          continue; // host providers are never stop/replace targets
        }
        const byGeneration = this.#published.get(capabilityId);
        if (byGeneration === undefined) {
          continue;
        }
        for (const [providerGenerationId, binding] of byGeneration) {
          if (binding.pluginId === selection.pluginId) {
            this.#recordProviderEdge(generation, capabilityId, providerGenerationId);
            break;
          }
        }
      }
    }
  }

  #recordProviderEdge(
    generation: Generation,
    capabilityId: string,
    providerGenerationId: string,
  ): void {
    const providers = generation.resolvedProviders.get(capabilityId);
    if (providers === undefined) {
      generation.resolvedProviders.set(capabilityId, new Set([providerGenerationId]));
      return;
    }
    providers.add(providerGenerationId);
  }

  /**
   * Resolves one declared requirement to its value. Multi-provider
   * tokens yield every selected provider in documented order; providers are
   * recorded in `resolvedProviders` so dependent tracking works.
   */
  #requirementValue(
    requirement: RequirementLike,
    token: Capability<unknown>,
    generation: Generation,
    plan: ResolutionPlan,
  ): unknown {
    const capabilityId = token.id;
    const fromPlan = plan.providers.get(generation.pluginId)?.get(capabilityId);
    const resolvedSelections = fromPlan ?? [];

    if (resolvedSelections.length === 0) {
      if (requirement.optional === true) {
        return undefined; // optional with nothing selected
      }
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `requirement ${capabilityId} was not resolved before setup`,
        pluginId: generation.pluginId,
        generation: generation.id,
        capabilityId,
        details: { reason: 'requirement-unresolved' },
      });
    }

    if (token.multiple === true) {
      // Each provider publishes a collection; the consumer receives the
      // concatenation in documented order.
      const values: unknown[] = [];
      for (const selection of resolvedSelections) {
        const resolved = this.#bindingFor(capabilityId, selection.pluginId, generation);
        if (!Array.isArray(resolved.value)) {
          throw new MoltError({
            code: 'INVALID_STATE',
            message: `published value for multi-provider capability ${capabilityId} is not an array`,
            pluginId: generation.pluginId,
            generation: generation.id,
            capabilityId,
            details: { reason: 'requirement-unresolved' },
          });
        }
        // Boundary: Array.isArray above narrows to any[]; treat elements as
        // unknown while aggregating.
        const published = resolved.value as readonly unknown[];
        values.push(...published);
      }
      return Object.freeze(values);
    }
    const first = resolvedSelections[0];
    if (first === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `requirement ${capabilityId} has an empty selection`,
        pluginId: generation.pluginId,
        generation: generation.id,
        capabilityId,
        details: { reason: 'requirement-unresolved' },
      });
    }
    return this.#bindingFor(capabilityId, first.pluginId, generation).value;
  }

  #bindingFor(
    capabilityId: string,
    pluginId: string | null,
    generation: Generation,
  ): { value: unknown; generationId: string | undefined } {
    if (pluginId === null) {
      const host = this.#hostProviders.get(capabilityId);
      if (host === undefined) {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: `host provider for ${capabilityId} disappeared during activation`,
          pluginId: generation.pluginId,
          generation: generation.id,
          capabilityId,
          details: { reason: 'requirement-unresolved' },
        });
      }
      return { value: host.value, generationId: undefined };
    }
    // F5: during a rebind transaction the candidate's staged bindings shadow
    // the still-published old ones, so a rebound dependent's setup resolves
    // candidate values. The overlay is transaction-local — nothing here is
    // globally visible until commit.
    const staged = generation.rebindOverlay?.get(capabilityId)?.get(pluginId);
    if (staged !== undefined) {
      // Same drift guard as the published path (F2): a staged binding that
      // stopped satisfying the consumer's range fails loudly, never binds
      // silently.
      const declared = generation.consumed.find((entry) => entry.capabilityId === capabilityId);
      if (declared !== undefined && !satisfiesRange(staged.capability.version, declared.range)) {
        throw new MoltError({
          code: 'INCOMPATIBLE_CAPABILITY',
          message: `bound ${capabilityId}@${staged.capability.version} no longer satisfies ${declared.range}`,
          pluginId: generation.pluginId,
          generation: generation.id,
          capabilityId,
          details: { reason: 'binding-drifted' },
        });
      }
      this.#recordProviderEdge(generation, capabilityId, staged.generationId);
      return { value: staged.value, generationId: staged.generationId };
    }
    const byGeneration = this.#published.get(capabilityId);
    if (byGeneration !== undefined) {
      for (const [providerGenerationId, binding] of byGeneration) {
        if (binding.pluginId === pluginId) {
          // F2: the provider may have been replaced while this consumer was
          // preparing. Revalidate the bound version against the consumer's
          // declared range — a drifted binding fails loudly here, never
          // binds silently.
          const declared = generation.consumed.find((entry) => entry.capabilityId === capabilityId);
          if (
            declared !== undefined &&
            !satisfiesRange(binding.capability.version, declared.range)
          ) {
            throw new MoltError({
              code: 'INCOMPATIBLE_CAPABILITY',
              message: `bound ${capabilityId}@${binding.capability.version} no longer satisfies ${declared.range}`,
              pluginId: generation.pluginId,
              generation: generation.id,
              capabilityId,
              details: { reason: 'binding-drifted' },
            });
          }
          this.#recordProviderEdge(generation, capabilityId, providerGenerationId);
          return { value: binding.value, generationId: providerGenerationId };
        }
      }
    }
    throw new MoltError({
      code: 'INVALID_STATE',
      message: `provider binding for ${capabilityId} disappeared during activation`,
      pluginId: generation.pluginId,
      generation: generation.id,
      capabilityId,
      details: { reason: 'requirement-unresolved' },
    });
  }

  #activeDependentsOf(provider: Generation): Generation[] {
    const dependents: Generation[] = [];
    for (const generationId of this.#activationOrder) {
      const generation = this.#generations.get(generationId);
      if (
        generation === undefined ||
        generation.pluginId === provider.pluginId ||
        generation.scope.isDisposed()
      ) {
        continue;
      }
      for (const providers of generation.resolvedProviders.values()) {
        if (providers.has(provider.id)) {
          dependents.push(generation);
          break;
        }
      }
    }
    return dependents;
  }

  /**
   * The transitive active dependent closure of a provider generation, in
   * provider-first order. `#activationOrder` is topological (providers
   * commit before their dependents), so filtering it yields a valid
   * rebind order: every dependent appears after the providers it rebinds
   * onto.
   */
  #dependentClosure(provider: Generation): Generation[] {
    const seen = new Set<string>([provider.id]);
    const frontier: Generation[] = [provider];
    for (let index = 0; index < frontier.length; index += 1) {
      const current = frontier[index];
      if (current === undefined) {
        break; // unreachable: the bound is re-read every iteration
      }
      for (const dependent of this.#activeDependentsOf(current)) {
        if (!seen.has(dependent.id)) {
          seen.add(dependent.id);
          frontier.push(dependent);
        }
      }
    }
    seen.delete(provider.id);
    const closure: Generation[] = [];
    for (const generationId of this.#activationOrder) {
      const generation = this.#generations.get(generationId);
      if (generation !== undefined && seen.has(generation.id)) {
        closure.push(generation);
      }
    }
    return closure;
  }

  /**
   * Verify every dependent's declared range against the rebound providers'
   * versions, before any dependent prepares. Returns, per old dependent
   * generation id, the capability ids whose rebound-provider binding is
   * gone: capabilities the candidate dropped, and optional requirements
   * whose range the candidate no longer satisfies (the rebound generation
   * binds nothing for those — `optional()` resolves `undefined`). A
   * required mismatch or a dropped required capability fails the
   * transaction loudly.
   *
   * Versions come from the replaced provider's staged provides and — for
   * rebound dependents, whose definitions (and therefore provides) are
   * unchanged — from their still-published old bindings. The check is
   * per-dependent, per-requirement, and per-provider: two dependents may
   * request the same capability with different ranges, and one incompatible
   * rebound provider must not drag down the compatible providers of the
   * same `multiple` capability.
   *
   * Returns, per dependent old generation id, the rebound provider
   * generation ids whose bindings that dependent must omit (dropped
   * capability or unsatisfied optional range).
   */
  #checkDependentRanges(
    oldsInOrder: Generation[],
    reboundIds: ReadonlySet<string>,
    candidateProvides: Map<string, { capability: Capability<unknown>; value: unknown }>,
    replacedId: string,
  ): Map<string, Set<string>> {
    const versions = new Map<string, Map<string, string>>();
    const replacedOld = oldsInOrder[0];
    if (replacedOld !== undefined) {
      const staged = new Map<string, string>();
      for (const [tokenId, binding] of candidateProvides) {
        staged.set(tokenId, binding.capability.version);
      }
      versions.set(replacedOld.id, staged);
    }
    for (const oldGeneration of oldsInOrder.slice(1)) {
      const published = new Map<string, string>();
      for (const tokenId of oldGeneration.providedTokenIds) {
        const version = this.#published.get(tokenId)?.get(oldGeneration.id)?.capability.version;
        if (version !== undefined) {
          published.set(tokenId, version);
        }
      }
      versions.set(oldGeneration.id, published);
    }

    const droppedByDependent = new Map<string, Set<string>>();
    for (const dependentOld of oldsInOrder.slice(1)) {
      const droppedProviders = new Set<string>();
      const dependentRecord = this.#plugins.get(dependentOld.pluginId);
      for (const [capabilityId, providerGenerationIds] of dependentOld.resolvedProviders) {
        for (const providerGenerationId of providerGenerationIds) {
          if (!reboundIds.has(providerGenerationId)) {
            continue;
          }
          const version = versions.get(providerGenerationId)?.get(capabilityId);
          const consumed = dependentOld.consumed.find(
            (entry) => entry.capabilityId === capabilityId,
          );
          const optional =
            dependentRecord?.definition.requires?.find(
              (requirement) => requirement.capability.id === capabilityId,
            )?.optional === true;
          const mismatch =
            version !== undefined &&
            consumed !== undefined &&
            !satisfiesRange(version, consumed.range);
          if (version === undefined || mismatch) {
            if (optional) {
              droppedProviders.add(providerGenerationId);
              continue;
            }
            throw new MoltError({
              code: 'INCOMPATIBLE_CAPABILITY',
              message:
                version === undefined
                  ? `dependent ${dependentOld.pluginId} requires ${capabilityId} ` +
                    `but the replacement no longer provides it`
                  : `dependent ${dependentOld.pluginId} requires ${capabilityId}@${consumed?.range} ` +
                    `but the replacement provides ${version}`,
              pluginId: replacedId,
              capabilityId,
              path: [dependentOld.pluginId, replacedId],
              details: {
                reason:
                  version === undefined
                    ? 'dependent-capability-dropped'
                    : 'dependent-range-mismatch',
                dependentId: dependentOld.pluginId,
              },
            });
          }
        }
      }
      droppedByDependent.set(dependentOld.id, droppedProviders);
    }
    return droppedByDependent;
  }

  /**
   * Build the resolution plan for rebinding one dependent: the dependent's
   * current provider topology, preserved selection-for-selection. Selections
   * keep the provider's plugin id — `#bindingFor` resolves rebound
   * providers through the transaction overlay to the candidate's staged
   * value, and untouched providers through `#published` as usual. A
   * rebound provider whose binding is gone for this dependent (dropped
   * capability or unsatisfied optional range) contributes no selection, so
   * `optional()` resolves `undefined`.
   */
  #rebindPlan(
    oldDependent: Generation,
    definition: PluginDefinition,
    droppedProviders: ReadonlySet<string>,
    reboundIds: ReadonlySet<string>,
    overlay: RebindOverlay,
  ): ResolutionPlan {
    const providers = new Map<
      string,
      Map<string, { pluginId: string | null; capabilityVersion: string }[]>
    >();
    const capMap = new Map<string, { pluginId: string | null; capabilityVersion: string }[]>();
    for (const requirement of definition.requires ?? []) {
      const capabilityId = requirement.capability.id;
      const selections: { pluginId: string | null; capabilityVersion: string }[] = [];
      const oldProviderGenerationIds = oldDependent.resolvedProviders.get(capabilityId);
      if (oldProviderGenerationIds !== undefined) {
        for (const oldProviderGenerationId of oldProviderGenerationIds) {
          if (
            reboundIds.has(oldProviderGenerationId) &&
            droppedProviders.has(oldProviderGenerationId)
          ) {
            // This rebound provider no longer satisfies this dependent's
            // requirement (dropped capability or unsatisfied optional
            // range): bind nothing for it; optional() resolves undefined.
            // Other providers of the same capability are unaffected.
            continue;
          }
          const providerGeneration = this.#generations.get(oldProviderGenerationId);
          if (providerGeneration === undefined || providerGeneration.scope.isDisposed()) {
            // The provider went away mid-transaction; require() fails
            // loudly at setup (or optional() resolves undefined).
            // Commit-time validation aborts the transaction when a rebound
            // provider vanished, so this only covers unrelated providers
            // racing the transaction.
            continue;
          }
          const hasStaged = overlay.get(capabilityId)?.has(providerGeneration.pluginId) === true;
          const hasPublished =
            this.#published.get(capabilityId)?.has(oldProviderGenerationId) === true;
          if (!hasStaged && !hasPublished) {
            // An unrelated concurrent replace withdrew this provider's
            // binding mid-transaction; require() fails loudly at setup.
            continue;
          }
          selections.push({
            pluginId: providerGeneration.pluginId,
            capabilityVersion: this.#stagedOrPublishedVersion(
              capabilityId,
              providerGeneration,
              overlay,
            ),
          });
        }
      }
      capMap.set(capabilityId, selections);
    }
    providers.set(definition.id, capMap);
    return { order: [], providers, edges: [], diagnostics: [] };
  }

  /**
   * The capability version a rebind plan should record for a provider: the
   * candidate's staged version while the transaction overlay covers it,
   * otherwise the published version. Reaching neither is an internal
   * inconsistency — the caller skips vanished providers — so it throws
   * instead of inventing a version.
   */
  #stagedOrPublishedVersion(
    capabilityId: string,
    providerGeneration: Generation,
    overlay: RebindOverlay,
  ): string {
    const staged = overlay.get(capabilityId)?.get(providerGeneration.pluginId);
    if (staged !== undefined) {
      return staged.capability.version;
    }
    const published = this.#published.get(capabilityId)?.get(providerGeneration.id)
      ?.capability.version;
    if (published !== undefined) {
      return published;
    }
    throw new MoltError({
      code: 'INVALID_STATE',
      message: `rebind transaction lost the binding for ${capabilityId}`,
      pluginId: providerGeneration.pluginId,
      generation: providerGeneration.id,
      capabilityId,
      details: { reason: 'transaction-corrupt' },
    });
  }

  /**
   * Stage a prepared candidate's provides in the transaction overlay so
   * dependents prepared later resolve the candidate's values during setup.
   * Called provider-first as each candidate finishes preparation.
   */
  #stageRebindBindings(prepared: PreparedGeneration, overlay: RebindOverlay): void {
    const pluginId = prepared.generation.pluginId;
    for (const [tokenId, binding] of prepared.stagedProvides) {
      let byPlugin = overlay.get(tokenId);
      if (byPlugin === undefined) {
        byPlugin = new Map();
        overlay.set(tokenId, byPlugin);
      }
      byPlugin.set(pluginId, {
        capability: binding.capability,
        value: binding.value,
        generationId: prepared.generation.id,
      });
    }
  }

  /**
   * Synchronous commit of a rebind transaction: validate that every old
   * generation is still current and every candidate scope still live,
   * re-verify staged conflicts (a concurrent operation may have published
   * while candidates were preparing), then withdraw every old generation
   * and publish every candidate in provider-first order. Either everything
   * commits or — via the caller's abort path — nothing does.
   */
  /**
   * Synchronous state commit of a rebind transaction: validate, withdraw
   * every old generation, publish every candidate, swap records. Returns
   * the committed entries with their pre-withdrawal binding snapshots, so
   * a post-commit health-gate failure can roll the transaction back.
   * Emits nothing — the caller emits `replaced` only after the health gate
   * passes, so observers never see a replacement that gets rolled back.
   */
  #commitRebindState(
    replacedId: string,
    items: {
      old: Generation;
      definition: PluginDefinition;
      plan: ResolutionPlan | undefined;
      prepared: PreparedGeneration | undefined;
    }[],
  ): {
    old: Generation;
    definition: PluginDefinition;
    plan: ResolutionPlan;
    prepared: PreparedGeneration;
    oldBindings: Map<string, PublishedBinding>;
    oldContributions: Map<string, ContributionEntry>;
  }[] {
    const committed: {
      old: Generation;
      definition: PluginDefinition;
      plan: ResolutionPlan;
      prepared: PreparedGeneration;
    }[] = [];
    for (const item of items) {
      const plan = item.plan;
      const prepared = item.prepared;
      if (plan === undefined || prepared === undefined) {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: 'rebind transaction is internally inconsistent',
          pluginId: replacedId,
          details: { reason: 'transaction-corrupt' },
        });
      }
      const record = this.#plugins.get(item.old.pluginId);
      if (
        record === undefined ||
        record.generation !== item.old ||
        record.status !== 'active' ||
        item.old.scope.isDisposed()
      ) {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: `plugin ${item.old.pluginId} changed during replacement`,
          pluginId: replacedId,
          details: { reason: 'concurrent-modification' },
        });
      }
      if (this.#disposed || prepared.scope.isDisposed()) {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: 'runtime was disposed during replacement',
          pluginId: replacedId,
          details: { reason: 'runtime-disposed' },
        });
      }
      // Conflict re-verification: same rule as preparation, shadowing the
      // generation being replaced. A concurrent start may have published a
      // conflicting binding while candidates were preparing.
      this.#assertNoStagedConflicts(
        prepared.stagedProvides,
        prepared.staged,
        item.old.id,
        item.old.pluginId,
        prepared.generation.id,
      );
      committed.push({ old: item.old, definition: item.definition, plan, prepared });
    }
    // Snapshot each old generation's published state before withdrawal so
    // a health-gate rollback can restore it exactly.
    const withSnapshots = committed.map((entry) => ({
      ...entry,
      oldBindings: this.#snapshotBindings(entry.old),
      oldContributions: this.#snapshotContributions(entry.old),
    }));
    for (const entry of withSnapshots) {
      this.#withdraw(entry.old);
    }
    // Publish every candidate and re-record dependency edges before any
    // event is emitted: a listener observing `replaced` for one plugin
    // must already see the whole closure's new state, never a half-swapped
    // mix of old and new generations. Every step below is non-throwing by
    // construction (map/set writes, single-shot staged commit), so once the
    // olds are withdrawn the commit cannot fail midway.
    for (const entry of withSnapshots) {
      const record = this.#plugins.get(entry.old.pluginId);
      if (record === undefined || record.generation !== entry.old || record.status !== 'active') {
        throw new MoltError({
          code: 'INVALID_STATE',
          message: `plugin ${entry.old.pluginId} changed during replacement`,
          pluginId: replacedId,
          details: { reason: 'concurrent-modification' },
        });
      }
      this.#publishPrepared(record, entry.definition, entry.prepared);
      // Dependency edges for requirements the setup never called require()
      // for; edges recorded during setup (via the overlay) are idempotent.
      this.#recordResolvedProviders(entry.definition, entry.prepared.generation, entry.plan);
    }
    return withSnapshots;
  }

  /** Snapshots an old generation's published capability bindings. */
  #snapshotBindings(generation: Generation): Map<string, PublishedBinding> {
    const snapshot = new Map<string, PublishedBinding>();
    for (const tokenId of generation.providedTokenIds) {
      const binding = this.#published.get(tokenId)?.get(generation.id);
      if (binding !== undefined) {
        snapshot.set(tokenId, binding);
      }
    }
    return snapshot;
  }

  /** Snapshots an old generation's published contributions. */
  #snapshotContributions(generation: Generation): Map<string, ContributionEntry> {
    const snapshot = new Map<string, ContributionEntry>();
    for (const [keyId, byGeneration] of this.#contributions) {
      const entry = byGeneration.get(generation.id);
      if (entry !== undefined) {
        snapshot.set(keyId, entry);
      }
    }
    return snapshot;
  }

  /**
   * Rolls back a committed rebind transaction after a health-gate failure:
   * withdraws and disposes every candidate (reverse order), then restores
   * every old generation's published state and record exactly as it was.
   * The old scopes were never disposed, so restoration is pure state
   * bookkeeping. Emits nothing — `replaced` was never emitted.
   */
  async #rollbackRebind(
    committed: {
      old: Generation;
      definition: PluginDefinition;
      plan: ResolutionPlan;
      prepared: PreparedGeneration;
      oldBindings: Map<string, PublishedBinding>;
      oldContributions: Map<string, ContributionEntry>;
    }[],
    disposeMs: number | undefined,
  ): Promise<void> {
    for (const entry of [...committed].reverse()) {
      this.#withdraw(entry.prepared.generation);
      const report = await this.#disposeBounded(
        entry.prepared.scope,
        entry.prepared.generation.pluginId,
        entry.prepared.generation.id,
        disposeMs,
      );
      void report;
    }
    for (const entry of committed) {
      const old = entry.old;
      const generationId = old.id;
      for (const [tokenId, binding] of entry.oldBindings) {
        let byGeneration = this.#published.get(tokenId);
        if (byGeneration === undefined) {
          byGeneration = new Map<string, PublishedBinding>();
          this.#published.set(tokenId, byGeneration);
        }
        byGeneration.set(generationId, binding);
      }
      for (const [keyId, contribution] of entry.oldContributions) {
        let byGeneration = this.#contributions.get(keyId);
        if (byGeneration === undefined) {
          byGeneration = new Map<string, ContributionEntry>();
          this.#contributions.set(keyId, byGeneration);
        }
        byGeneration.set(generationId, contribution);
      }
      this.#generations.set(generationId, old);
      this.#activationOrder.push(generationId);
      const record = this.#plugins.get(old.pluginId);
      if (record !== undefined) {
        record.definition = old.definition;
        record.effectiveConfig = old.config;
        record.generation = old;
        record.status = 'active';
      }
    }
  }

  /**
   * The conflict rule shared by preparation and commit-time re-verification:
   * a staged single-provider token may collide with no published generation
   * except the one being replaced, and a staged contribution key may be
   * owned by no published generation except the one being replaced.
   */
  #assertNoStagedConflicts(
    stagedProvides: Map<string, { capability: Capability<unknown>; value: unknown }>,
    staged: StagedContributions,
    shadowedId: string | undefined,
    pluginId: string,
    generationId: string,
  ): void {
    for (const [tokenId, binding] of stagedProvides) {
      if (binding.capability.multiple) {
        continue;
      }
      const byGeneration = this.#published.get(tokenId);
      if (byGeneration !== undefined) {
        for (const otherGenerationId of byGeneration.keys()) {
          if (otherGenerationId !== shadowedId) {
            throw new MoltError({
              code: 'AMBIGUOUS_PROVIDER',
              message: `capability ${tokenId} is already published by another active generation`,
              pluginId,
              generation: generationId,
              capabilityId: tokenId,
            });
          }
        }
      }
    }
    for (const keyId of staged.stagedIds()) {
      const byGeneration = this.#contributions.get(keyId);
      if (byGeneration !== undefined) {
        for (const otherGenerationId of byGeneration.keys()) {
          if (otherGenerationId !== shadowedId) {
            throw new MoltError({
              code: 'ACTIVATION_FAILED',
              message: `contribution ${keyId} is owned by an unrelated active generation`,
              pluginId,
              generation: generationId,
              details: { reason: 'contribution-conflict', contributionKeyId: keyId },
            });
          }
        }
      }
    }
  }

  #activeDependentsOfPlugin(pluginId: string): Generation[] {
    const dependents: Generation[] = [];
    for (const generationId of this.#activationOrder) {
      const generation = this.#generations.get(generationId);
      if (generation === undefined || generation.scope.isDisposed()) {
        continue;
      }
      for (const capabilityId of generation.resolvedProviders.keys()) {
        const byGeneration = this.#published.get(capabilityId);
        if (byGeneration === undefined) {
          continue;
        }
        for (const binding of byGeneration.values()) {
          if (binding.pluginId === pluginId) {
            dependents.push(generation);
          }
        }
      }
    }
    return dependents;
  }

  /**
   * Pin a retired generation: withdrawn from provider selection (already
   * done at commit), scope kept alive for existing external holders. At
   * most one pin per plugin — a previous pin is disposed first. Emits
   * `stopped` for the superseded pin, if any.
   */
  async #pinGeneration(generation: Generation, disposeMs: number | undefined): Promise<void> {
    const previous = this.#pinned.get(generation.pluginId);
    if (previous !== undefined && previous !== generation) {
      await this.#releasePin(generation.pluginId, disposeMs);
    }
    generation.pinned = true;
    this.#pinned.set(generation.pluginId, generation);
    this.#logTransition('pinned', generation.pluginId, generation.id);
  }

  /**
   * Release a plugin's pinned generation, if any: dispose its scope
   * (bounded) and emit `stopped`. Disposal errors are recorded on the
   * plugin's record like any post-commit disposal failure.
   */
  async #releasePin(pluginId: string, disposeMs: number | undefined): Promise<void> {
    const pinned = this.#pinned.get(pluginId);
    if (pinned === undefined) {
      return;
    }
    this.#pinned.delete(pluginId);
    pinned.pinned = false;
    const report = await this.#disposeBounded(pinned.scope, pinned.pluginId, pinned.id, disposeMs);
    if (report.errors.length > 0) {
      const record = this.#plugins.get(pluginId);
      if (record !== undefined) {
        record.error = this.#disposalFailure(pinned, report);
      }
    }
    this.#emit({ type: 'stopped', pluginId: pinned.pluginId, generation: pinned.id });
  }

  /**
   * Quarantine a live generation: it is withdrawn from provider selection
   * (bindings and contributions are stashed, not dropped) while its scope
   * stays alive — existing holders keep serving, new `require()` calls no
   * longer resolve to it. Idempotent.
   */
  #quarantineGeneration(generation: Generation): void {
    if (generation.quarantined) {
      return;
    }
    generation.quarantined = true;
    this.#logTransition('quarantined', generation.pluginId, generation.id);
    const bindings: { readonly tokenId: string; readonly binding: PublishedBinding }[] = [];
    for (const tokenId of generation.providedTokenIds) {
      const byGeneration = this.#published.get(tokenId);
      if (byGeneration === undefined) {
        continue;
      }
      const binding = byGeneration.get(generation.id);
      if (binding !== undefined) {
        bindings.push({ tokenId, binding });
        byGeneration.delete(generation.id);
        if (byGeneration.size === 0) {
          this.#published.delete(tokenId);
        }
      }
    }
    const contributions: { readonly keyId: string; readonly entry: ContributionEntry }[] = [];
    for (const [keyId, byGeneration] of this.#contributions) {
      const entry = byGeneration.get(generation.id);
      if (entry !== undefined) {
        contributions.push({ keyId, entry });
        byGeneration.delete(generation.id);
        if (byGeneration.size === 0) {
          this.#contributions.delete(keyId);
        }
      }
    }
    generation.quarantinedState = { bindings, contributions };
  }

  /**
   * Lift a quarantine: the stashed bindings and contributions are
   * republished. Throws `AMBIGUOUS_PROVIDER` — leaving the quarantine in
   * place — when another generation claimed one of the stashed
   * single-provider capabilities while this generation was quarantined.
   */
  #unquarantineGeneration(generation: Generation): void {
    if (!generation.quarantined) {
      return;
    }
    // The transition is logged only after the restoration commits: the
    // conflict check below can throw AMBIGUOUS_PROVIDER, and the log must
    // never claim an unquarantine that did not happen.
    const stashed = generation.quarantinedState;
    if (stashed !== undefined) {
      for (const { tokenId, binding } of stashed.bindings) {
        const byGeneration = this.#published.get(tokenId);
        if (!binding.capability.multiple && byGeneration !== undefined && byGeneration.size > 0) {
          throw new MoltError({
            code: 'AMBIGUOUS_PROVIDER',
            message:
              `cannot unquarantine ${generation.pluginId}: capability ` +
              `${binding.capability.id} was claimed while quarantined`,
            pluginId: generation.pluginId,
            generation: generation.id,
            capabilityId: binding.capability.id,
          });
        }
      }
      for (const { tokenId, binding } of stashed.bindings) {
        let byGeneration = this.#published.get(tokenId);
        if (byGeneration === undefined) {
          byGeneration = new Map<string, PublishedBinding>();
          this.#published.set(tokenId, byGeneration);
        }
        byGeneration.set(generation.id, binding);
      }
      for (const { keyId, entry } of stashed.contributions) {
        let byGeneration = this.#contributions.get(keyId);
        if (byGeneration === undefined) {
          byGeneration = new Map<string, ContributionEntry>();
          this.#contributions.set(keyId, byGeneration);
        }
        byGeneration.set(generation.id, entry);
      }
    }
    generation.quarantined = false;
    generation.quarantinedState = undefined;
    this.#logTransition('unquarantined', generation.pluginId, generation.id);
  }

  #withdraw(generation: Generation): void {
    for (const tokenId of generation.providedTokenIds) {
      const byGeneration = this.#published.get(tokenId);
      if (byGeneration !== undefined) {
        byGeneration.delete(generation.id);
        if (byGeneration.size === 0) {
          this.#published.delete(tokenId);
        }
      }
    }
    for (const [keyId, byGeneration] of this.#contributions) {
      if (byGeneration.delete(generation.id) && byGeneration.size === 0) {
        this.#contributions.delete(keyId);
      }
    }
    this.#generations.delete(generation.id);
    const orderIndex = this.#activationOrder.indexOf(generation.id);
    if (orderIndex >= 0) {
      this.#activationOrder.splice(orderIndex, 1);
    }
  }

  #disposalFailure(generation: Generation, report: DisposalReport): MoltError {
    // A disposal timeout surfaces as DISPOSAL_TIMEOUT, not the generic
    // DISPOSAL_FAILED — the caller set a budget and the disposer overran it.
    const timeout = report.errors.find(
      (error): error is MoltError => isMoltError(error) && error.code === 'DISPOSAL_TIMEOUT',
    );
    if (timeout !== undefined) {
      return timeout;
    }
    return new MoltError({
      code: 'DISPOSAL_FAILED',
      message: `disposal of generation ${generation.id} failed`,
      pluginId: generation.pluginId,
      generation: generation.id,
      details: { errors: report.errors },
    });
  }

  #blockedOf(record: PluginRecord): readonly BlockedDiagnostic[] | undefined {
    if (!isMoltError(record.error)) {
      return undefined;
    }
    const blocked = record.error.details?.['blocked'];
    if (blocked === undefined) {
      return undefined;
    }
    // Boundary cast: the resolver constructed this exact shape.
    return blocked as readonly BlockedDiagnostic[];
  }

  #statuses(): Map<string, PluginStatus> {
    const statuses = new Map<string, PluginStatus>();
    for (const [id, record] of this.#plugins) {
      statuses.set(id, record.status);
    }
    return statuses;
  }

  /**
   * Ids of plugins whose active generation is quarantined: excluded from
   * provider selection in the next resolution.
   */
  #quarantinedPluginIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, record] of this.#plugins) {
      if (record.generation?.quarantined === true) {
        ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Ids of plugins installed lazy. The resolver excludes them from
   * provider selection until they have been explicitly started (the
   * resolver consults the status map to make that determination).
   */
  #lazyPluginIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, record] of this.#plugins) {
      if (record.lazy === true) {
        ids.add(id);
      }
    }
    return ids;
  }

  #requireRecord(id: string): PluginRecord {
    const record = this.#plugins.get(id);
    if (record === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} is not installed`,
        pluginId: id,
        details: { reason: 'not-installed' },
      });
    }
    return record;
  }

  async #rollback(committed: Generation[], disposeMs: number | undefined): Promise<void> {
    // Every resource acquired by the failed activation attempt is
    // disposed; failures are collected, teardown continues. Each committed
    // generation emitted 'started' at commit, so each disposal emits the
    // balancing 'stopped' — observers never see an unbalanced stream (F8).
    for (const generation of [...committed].reverse()) {
      if (!generation.scope.isDisposed()) {
        await this.#disposeBounded(generation.scope, generation.pluginId, generation.id, disposeMs);
      }
      this.#withdraw(generation);
      const record = this.#plugins.get(generation.pluginId);
      if (record !== undefined && record.generation === generation) {
        record.status = 'stopped';
        record.generation = undefined;
      }
      this.#emit({ type: 'stopped', pluginId: generation.pluginId, generation: generation.id });
    }
  }

  /**
   * Appends a transition to the bounded audit log, evicting the oldest
   * entries beyond the capacity. The stored record is frozen.
   */
  #logTransition(
    type: TransitionRecord['type'],
    pluginId?: string,
    generation?: string,
    error?: unknown,
    stage?: FailedStage,
  ): void {
    const record: TransitionRecord = Object.freeze({
      seq: this.#transitionSeq++,
      at: Date.now(),
      type,
      pluginId,
      generation,
      error,
      stage,
    });
    this.#transitions.push(record);
    while (this.#transitions.length > TRANSITION_CAPACITY) {
      this.#transitions.shift();
    }
  }

  #emit(event: RuntimeEvent): void {
    this.#logTransition(event.type, event.pluginId, event.generation, event.error, event.stage);
    const snapshot = Object.freeze({ ...event });
    // The reentrancy guard is a stack: a listener that emits synchronously
    // (e.g. an observer that installs another plugin) pushes its own
    // plugin id and pops it when done. The old single-string guard was
    // clobbered to empty by any nested emit; the stack keeps the outer
    // guard intact while the inner emit is dispatched (F9).
    const guard = event.pluginId;
    if (guard !== undefined) {
      this.#reentrancyGuards.push(guard);
    }
    try {
      for (const listener of this.#observers) {
        try {
          listener(snapshot);
        } catch (error) {
          // Observer failures never propagate into lifecycle outcomes;
          // they become bounded diagnostics.
          this.#observerDiagnostics.push(
            Object.freeze({
              message: `observer threw during ${String(event.type)}`,
              cause: error,
            }),
          );
        }
      }
    } finally {
      if (guard !== undefined) {
        this.#reentrancyGuards.pop();
      }
    }
  }
}

function adoptable(returned: void | DisposableLike): returned is DisposableLike {
  return (
    typeof returned === 'object' && returned !== null && typeof returned.dispose === 'function'
  );
}

async function adoptReturnedDisposer(scope: ScopeImpl, returned: DisposableLike): Promise<void> {
  if (scope.isDisposed()) {
    // The runtime may abort a preparation while setup is suspended. A
    // disposer returned after that point still owns cleanup responsibility
    // and must run exactly once.
    await returned.dispose();
    return;
  }
  scope.onDispose(() => returned.dispose());
}

function snapshotDiagnosticInput(input: DiagnosticInput): DiagnosticInput {
  const details = input.details;
  return Object.freeze({
    message: input.message,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(details !== undefined ? { details: cloneDiagnosticDetails(details) } : {}),
  });
}

function cloneDiagnosticDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const cloned = cloneDiagnosticValue(details);
  // Validated boundary: DiagnosticInput.details is a record; the clone keeps
  // that shape while isolating nested plain objects and arrays.
  return cloned as Readonly<Record<string, unknown>>;
}

function cloneDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneDiagnosticValue(entry)));
  }
  if (typeof value === 'object' && value !== null) {
    if (Object.prototype.toString.call(value) === '[object Object]') {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        // Validated boundary: the object tag above limits this copy to record-like data.
        const entry = (value as Readonly<Record<string, unknown>>)[key];
        copy[key] = cloneDiagnosticValue(entry);
      }
      return Object.freeze(copy);
    }
  }
  return value;
}

function abortedError(pluginId?: string): MoltError {
  return new MoltError({
    code: 'ABORTED',
    message: `operation aborted${pluginId !== undefined ? ` for ${pluginId}` : ''}`,
    ...(pluginId !== undefined ? { pluginId } : {}),
    details: { reason: 'aborted' },
  });
}

function activationError(
  error: unknown,
  pluginId: string,
  generationId: string,
  disposalErrors: readonly unknown[] = [],
): MoltError {
  const details = disposalErrors.length > 0 ? { disposalErrors: [...disposalErrors] } : undefined;
  if (isMoltError(error)) {
    if (
      error.code === 'INVALID_STATE' &&
      (error.details?.['reason'] === 'runtime-disposed' ||
        error.details?.['reason'] === 'preparation-aborted')
    ) {
      return new MoltError(
        {
          code: 'ACTIVATION_FAILED',
          message: `setup was interrupted for ${pluginId}`,
          pluginId,
          generation: generationId,
          ...(details !== undefined ? { details } : {}),
        },
        error,
      );
    }
    // Structured errors thrown by provide/contribute already carry identity
    // and pass through unchanged — unless cleaning up the failed candidate
    // also failed, in which case the wrapper preserves the original code
    // and identity and records the disposal failures in details.
    if (details === undefined) {
      return error;
    }
    return new MoltError(
      {
        code: error.code,
        message: error.message,
        pluginId: error.pluginId ?? pluginId,
        generation: error.generation ?? generationId,
        capabilityId: error.capabilityId,
        path: error.path === undefined ? undefined : [...error.path],
        details,
      },
      error,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new MoltError(
    {
      code: 'ACTIVATION_FAILED',
      message: `setup failed: ${message}`,
      pluginId,
      generation: generationId,
      ...(details !== undefined ? { details } : {}),
    },
    error,
  );
}
