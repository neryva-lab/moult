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
import { BoundedLog, OperationQueue, withTimeout } from './internal/async.js';
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
export type RuntimeListener = (event: {
  readonly type: 'installed' | 'started' | 'stopped' | 'replaced' | 'failed' | 'disposed';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  readonly cascade?: readonly string[] | undefined;
  readonly error?: unknown;
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
   */
  readonly config?: Record<string, unknown> | undefined;
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
  install(definition: PluginDefinition, options?: InstallOptions): void;
  uninstall(id: string): Promise<void>;
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
   * result. A missing hook reports healthy. Unlike the post-commit gate,
   * an unhealthy result here is only reported, never acted on.
   */
  checkHealth(id: string): Promise<HealthStatus>;
  getStatus(id: string): PluginStatus | undefined;
  inspect(): RuntimeInspection;
  subscribe(listener: RuntimeListener): () => void;
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
  const errors = definition.validateConfig?.(merged) ?? [];
  if (errors.length > 0) {
    throw new MoltError({
      code,
      message: `invalid configuration for plugin ${definition.id}: ${errors.join('; ')}`,
      pluginId: definition.id,
      details: { reason: 'invalid-config', errors: [...errors] },
    });
  }
  return Object.freeze(merged);
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
}

interface RuntimeEvent {
  readonly type: 'installed' | 'started' | 'stopped' | 'replaced' | 'failed' | 'disposed';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  readonly cascade?: readonly string[] | undefined;
  readonly error?: unknown;
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
    const overrides: Record<string, unknown> = { ...(options?.config ?? {}) };
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
    });
    this.#emit({ type: 'installed', pluginId: definition.id });
  }

  uninstall(id: string): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotSelfOperation(id, 'uninstall');
    this.#assertNotRebindOwned(id);
    return this.#enqueue(id, () => this.#uninstall(id));
  }

  start(id: string, options?: StartOptions): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotSelfOperation(id, 'start');
    this.#assertNotRebindOwned(id);
    return this.#enqueue(id, () => this.#start(id, this.#resolveTimeouts(options?.timeoutMs)));
  }

  stop(id: string, options?: StopOptions): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotRebindOwned(id);
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

  rollback(id: string): Promise<void> {
    this.#assertNotReentrant(id);
    this.#assertNotSelfOperation(id, 'rollback');
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
    const previous = record.history[record.history.length - 1];
    if (previous === undefined) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `plugin ${id} has no replacement history to roll back to`,
        pluginId: id,
        details: { reason: 'no-rollback-history' },
      });
    }
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
    // On-demand probe: reported, never acted on. Queued so it never
    // interleaves with a lifecycle operation on the same plugin.
    return this.#enqueue(id, () => {
      const context = this.#buildContext(
        generation.definition,
        generation,
        new StagedContributions(generation.pluginId, generation.id),
        new Map(),
        generation.plan,
      );
      return this.#runHealthCheck(generation, context, this.#resolveTimeouts(undefined).healthMs);
    });
  }

  getStatus(id: string): PluginStatus | undefined {
    return this.#plugins.get(id)?.status;
  }

  inspect(): RuntimeInspection {
    const plugins = [...this.#plugins.values()].map((record) => ({
      id: record.definition.id,
      status: record.status,
      generationId: record.generation?.id,
      error: record.error,
      blocked: this.#blockedOf(record),
      diagnostics: record.generation?.diagnostics.entries(),
    }));
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
      if (timedOut) {
        // The drain overran its budget; disposal proceeds regardless.
        return;
      }
      const retiredRecord = this.#plugins.get(retired.pluginId);
      if (retiredRecord !== undefined) {
        retiredRecord.error = new MoltError({
          code: 'DISPOSAL_FAILED',
          message: `drain of generation ${retired.id} failed`,
          pluginId: retired.pluginId,
          generation: retired.id,
          details: { reason: 'drain-failed', errors: [error] },
        });
      }
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

  async #start(id: string, timeouts: ResolvedTimeouts): Promise<void> {
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
      });
    } catch (error) {
      record.status = 'stopped';
      record.error = MoltError.from(error, 'ACTIVATION_FAILED');
      this.#emit({ type: 'failed', pluginId: id, error: record.error });
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
        const outcome = await this.#activateCoalesced(target, plan, timeouts);
        if (outcome.created) {
          committed.push(outcome.generation);
        }
      }
      const rootOutcome = await this.#activateCoalesced(record, plan, timeouts);
      if (rootOutcome.created) {
        committed.push(rootOutcome.generation);
      }
    } catch (error) {
      // Every generation committed by this attempt is disposed.
      await this.#rollback(committed);
      record.status = 'stopped';
      record.error = MoltError.from(error, 'ACTIVATION_FAILED');
      this.#emit({ type: 'failed', pluginId: id, error: record.error });
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
    const promise = this.#activate(record, plan, timeouts);
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
      });
    } catch (error) {
      record.status = 'stopped';
      record.generation = undefined;
      if (error instanceof PreparationFailure) {
        throw activationError(error.failureCause, pluginId, error.generationId);
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
      const report = await prepared.scope.dispose();
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
    const health = await this.#runHealthCheck(generation, healthContext, timeouts.healthMs);
    if (!health.ok) {
      this.#withdraw(generation);
      const disposeReport = await generation.scope.dispose();
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
      result = await withTimeout(
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
      );
    } catch (error) {
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
    return { ok: result.ok, message: result.message };
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
      const returned = await withTimeout(
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
        await withTimeout(
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
      const report = await scope.dispose();
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
      this.#emit({ type: 'failed', pluginId: definition.id, error: record.error });
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
      this.#emit({ type: 'failed', pluginId: definition.id, error: record.error });
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
      this.#emit({ type: 'failed', pluginId: definition.id, error: record.error });
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
          rebindOverlay: overlay,
          effectiveConfig: newEffectiveConfig,
          setupMs: timeouts.setupMs,
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
          rebindOverlay: overlay,
          // Dependents keep their own definitions and configurations; only
          // the replaced plugin's config changes.
          effectiveConfig: dependentRecord?.effectiveConfig ?? EMPTY_CONFIG,
          setupMs: timeouts.setupMs,
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
        const report = await candidate.scope.dispose();
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
      this.#emit({ type: 'failed', pluginId: definition.id, error: record.error });
      throw record.error;
    } finally {
      for (const owned of oldsInOrder) {
        this.#rebindOwners.delete(owned.pluginId);
      }
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
      const health = await this.#runHealthCheck(candidate, healthContext, timeouts.healthMs);
      if (!health.ok) {
        await this.#rollbackRebind(committed);
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
        this.#emit({ type: 'failed', pluginId: definition.id, error: record.error });
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
    // first (reverse provider-first order, mirroring cascade stop). Each
    // old generation's `drain` hook runs before its disposers, bounded by
    // the drain timeout — expiry aborts the drain and disposal proceeds
    // regardless. A disposal failure here is inspectable on the retired
    // plugin's record; the replacement already succeeded and is never
    // rolled back.
    for (const retired of [...oldsInOrder].reverse()) {
      await this.#drainGeneration(retired, timeouts.drainMs);
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

  // -- uninstall -----------------------------------------------------------------

  #uninstall(id: string): void {
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
  ): Promise<void> {
    for (const entry of [...committed].reverse()) {
      this.#withdraw(entry.prepared.generation);
      const report = await entry.prepared.scope.dispose();
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

  async #rollback(committed: Generation[]): Promise<void> {
    // Every resource acquired by the failed activation attempt is
    // disposed; failures are collected, teardown continues. Each committed
    // generation emitted 'started' at commit, so each disposal emits the
    // balancing 'stopped' — observers never see an unbalanced stream (F8).
    for (const generation of [...committed].reverse()) {
      if (!generation.scope.isDisposed()) {
        await generation.scope.dispose();
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

  #emit(event: RuntimeEvent): void {
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

function activationError(error: unknown, pluginId: string, generationId: string): MoltError {
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
        },
        error,
      );
    }
    // Structured errors thrown by provide/contribute already carry identity.
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new MoltError(
    {
      code: 'ACTIVATION_FAILED',
      message: `setup failed: ${message}`,
      pluginId,
      generation: generationId,
    },
    error,
  );
}
