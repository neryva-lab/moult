/**
 * Public test-host utilities for proving Moult lifecycle ownership.
 * @packageDocumentation
 */

import type { PluginContext, PluginDefinition, Runtime } from '@moult/runtime';
import { createRuntime } from '@moult/runtime';

/**
 * The three resource classes used by the standard leak fixtures.
 * @public
 */
export type ResourceKind = 'listener' | 'timer' | 'connection';

/**
 * A deterministic failure cue for one factory operation.
 * @public
 */
export interface FailureCue {
  /** Operation at which the failure is injected. */
  readonly operation: 'create' | 'dispose';
  /** One-based invocation number at which the failure is injected. */
  readonly occurrence: number;
  /** Defaults to true; false repeats the failure on every matching invocation. */
  readonly once?: boolean | undefined;
}

/**
 * A resource factory suitable for acquisition through a Moult scope.
 * @public
 */
export interface ResourceFactory<T> {
  /** Creates one fake resource and increments the acquired counter. */
  readonly create: () => T | Promise<T>;
  /** Disposes one fake resource and increments the released counter. */
  readonly dispose: (value: T) => void | Promise<void>;
  /** Adds a deterministic cue without changing the factory's ownership behavior. */
  failOn(cue: FailureCue): void;
  /** Removes all pending failure cues from this factory. */
  clearFailures(): void;
}

/** A listener-like fake resource. @public */
export type ListenerResource = ResourceFactory<{ readonly id: number }>;

/** A timer-like fake resource. @public */
export type TimerResource = ResourceFactory<{ readonly id: number }>;

/** A connection-like fake resource. @public */
export type ConnectionResource = ResourceFactory<{ readonly id: number }>;

/**
 * Observable resource factories and leak assertions for host-independent tests.
 * @public
 */
export interface FakeResources {
  /** Returns the shared listener resource factory. */
  listenerHost(): ListenerResource;
  /** Returns the shared timer resource factory. */
  timerHost(): TimerResource;
  /** Returns the shared connection resource factory. */
  connectionHost(): ConnectionResource;
  /** Returns a fresh factory of the requested kind, initially without faults. */
  failing(kind: ResourceKind): ResourceFactory<{ readonly id: number }>;
  /** Snapshot keys are `<kind>.acquired`, `<kind>.released`, and `<kind>.live`. */
  counters(): Readonly<Record<string, number>>;
  /** Throws with per-kind deltas if any owned fake resource remains live. */
  expectNoLeaks(): void;
}

/**
 * Creates fake host resources whose counters are incremented by the actual factory calls.
 * @throws `RangeError` when a failure cue has a non-positive occurrence.
 * @public
 */
export function fakeResources(): FakeResources {
  const counts: Record<string, number> = {};
  const nextIds: Record<ResourceKind, number> = { listener: 0, timer: 0, connection: 0 };
  const factories = new Map<ResourceKind, ResourceFactory<{ readonly id: number }>>();

  const createFactory = (kind: ResourceKind): ResourceFactory<{ readonly id: number }> => {
    const cues: FailureCue[] = [];
    let createCalls = 0;
    let disposeCalls = 0;
    const key = (suffix: string): string => `${kind}.${suffix}`;
    counts[key('acquired')] ??= 0;
    counts[key('released')] ??= 0;

    const shouldFail = (operation: FailureCue['operation'], occurrence: number): boolean => {
      const cueIndex = cues.findIndex(
        (cue) => cue.operation === operation && cue.occurrence === occurrence,
      );
      const cue = cueIndex < 0 ? undefined : cues[cueIndex];
      if (cue === undefined) return false;
      if (cue.once !== false) cues.splice(cueIndex, 1);
      return true;
    };

    const factory: ResourceFactory<{ readonly id: number }> = {
      create: () => {
        createCalls += 1;
        if (shouldFail('create', createCalls)) {
          throw new Error(`injected ${kind} create failure #${createCalls}`);
        }
        counts[key('acquired')] = (counts[key('acquired')] ?? 0) + 1;
        nextIds[kind] += 1;
        return Object.freeze({ id: nextIds[kind] });
      },
      dispose: (_value) => {
        disposeCalls += 1;
        counts[key('released')] = (counts[key('released')] ?? 0) + 1;
        if (shouldFail('dispose', disposeCalls)) {
          throw new Error(`injected ${kind} dispose failure #${disposeCalls}`);
        }
      },
      failOn: (cue) => {
        if (!Number.isInteger(cue.occurrence) || cue.occurrence < 1) {
          throw new RangeError('failure occurrence must be a positive integer');
        }
        cues.push(cue);
      },
      clearFailures: () => {
        cues.length = 0;
      },
    };
    return factory;
  };

  const getFactory = (kind: ResourceKind): ResourceFactory<{ readonly id: number }> => {
    const existing = factories.get(kind);
    if (existing !== undefined) return existing;
    const factory = createFactory(kind);
    factories.set(kind, factory);
    return factory;
  };

  return {
    listenerHost: () => getFactory('listener'),
    timerHost: () => getFactory('timer'),
    connectionHost: () => getFactory('connection'),
    failing: (kind) => createFactory(kind),
    counters: () => {
      const snapshot: Record<string, number> = {};
      for (const kind of ['listener', 'timer', 'connection'] as const) {
        const acquired = counts[`${kind}.acquired`] ?? 0;
        const released = counts[`${kind}.released`] ?? 0;
        snapshot[`${kind}.acquired`] = acquired;
        snapshot[`${kind}.released`] = released;
        snapshot[`${kind}.live`] = acquired - released;
      }
      return Object.freeze(snapshot);
    },
    expectNoLeaks: () => {
      const current: Record<ResourceKind, number> = {
        listener: (counts['listener.acquired'] ?? 0) - (counts['listener.released'] ?? 0),
        timer: (counts['timer.acquired'] ?? 0) - (counts['timer.released'] ?? 0),
        connection: (counts['connection.acquired'] ?? 0) - (counts['connection.released'] ?? 0),
      };
      const leaks = Object.entries(current).filter(([, live]) => live !== 0);
      if (leaks.length > 0) {
        throw new Error(
          `fake resource leak: ${leaks.map(([kind, live]) => `${kind}=${String(live)}`).join(', ')}`,
        );
      }
    },
  };
}

/**
 * Asserts, through inspection, that a plugin has no committed generation left.
 * @throws `Error` when the plugin is not stopped or still has a generation.
 * @public
 */
export function expectGenerationDisposed(rt: Runtime, pluginId: string): Promise<void> {
  if (rt.getStatus(pluginId) !== 'stopped') {
    throw new Error(`expected ${pluginId} to be stopped`);
  }
  const plugin = rt.inspect().plugins.find((entry) => entry.id === pluginId);
  if (plugin === undefined) throw new Error(`expected ${pluginId} in runtime inspection`);
  if (plugin.generation !== undefined) {
    throw new Error(`expected ${pluginId} to have no live generation`);
  }
  return Promise.resolve();
}

/**
 * A host-independent harness that activates one definition and exposes its public context.
 * @public
 */
export interface PluginHarness {
  /** Runtime instance used by this harness. */
  readonly runtime: Runtime;
  /** Frozen definition installed by the harness on first run. */
  readonly definition: PluginDefinition;
  /** Starts the definition and returns the public setup context. */
  run(): Promise<PluginContext>;
  /** Disposes the harness runtime and all generations it owns. */
  dispose(): Promise<void>;
}

/**
 * Creates a harness for setup-level tests without importing runtime internals.
 * @throws `MoltError` when the definition fails normal runtime validation.
 * @public
 */
export function pluginHarness(definition: PluginDefinition): PluginHarness {
  let context: PluginContext | undefined;
  let running: Promise<PluginContext> | undefined;
  // The test kit is a plausible host and depends only on the public runtime
  // package, never on runtime implementation modules.
  const runtime: Runtime = createRuntime();

  return {
    runtime,
    definition,
    run: () => {
      if (running !== undefined) return running;
      runtime.install({
        ...definition,
        setup: async (candidateContext) => {
          context = candidateContext;
          return definition.setup(candidateContext);
        },
      });
      running = runtime.start(definition.id).then(() => {
        if (context === undefined) throw new Error('setup did not receive a plugin context');
        return context;
      });
      return running;
    },
    dispose: () => runtime.dispose(),
  };
}
