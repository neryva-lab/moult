// Replacement-contract tests. Every test asserts the structured MoltError code,
// never a bare throw, and observes the runtime only through public API,
// observer events, inspection, and resource counters.
//
// Sources: the public guarantees INV-01…INV-15 in docs/guarantees.md.

import type { MoltError, PluginDefinition, RuntimeErrorCode } from '../src/index.js';
import { capability, contributionKey, createRuntime, isMoltError } from '../src/index.js';
import { createDeferred } from '../src/internal/async.js';

// -----------------------------------------------------------------------------
// Fake resources with counters. Counting happens inside the factory/disposer
// the plugin actually uses — counting is observation, never coordination.

interface Counters {
  acquired: number;
  released: number;
}

function makeCounters() {
  const counters: Counters = { acquired: 0, released: 0 };
  return {
    counters,
    create: () => {
      counters.acquired += 1;
      return { handle: Symbol('fake-resource') };
    },
    dispose: () => {
      counters.released += 1;
    },
    faultyDispose: () => {
      counters.released += 1;
      throw new Error('injected disposal fault');
    },
  };
}
type FakeResources = ReturnType<typeof makeCounters>;

// -----------------------------------------------------------------------------
// Capabilities and contribution keys under test.

const storage = capability<{ read(): number }>('test.storage', '1.0.0');
const midCap = capability<{ ok(): boolean }>('test.mid.cap', '1.0.0');
const sharedUi = contributionKey<{ id: string }>('test.shared.ui');

// -----------------------------------------------------------------------------
// Plugin factories. Resource accounting is uniform: one fake resource per
// generation, acquired through the generation's scope.

interface ProviderOptions {
  version?: string;
  failSetup?: boolean;
  failDispose?: boolean;
  onDispose?: () => void;
}

function storagePlugin(counters: FakeResources, options: ProviderOptions = {}): PluginDefinition {
  return {
    id: 'test.provider',
    version: options.version ?? '1.0.0',
    provides: [{ capability: storage }],
    setup: async (ctx) => {
      const dispose = (): void => {
        counters.dispose();
        options.onDispose?.();
      };
      await ctx.scope.acquire(
        counters.create,
        options.failDispose ? counters.faultyDispose : dispose,
      );
      ctx.provide(storage, { read: () => 1 });
      if (options.failSetup) {
        throw new Error('injected setup fault');
      }
    },
  };
}

function consumerPlugin(onReady: (value: { read(): number }) => void): PluginDefinition {
  return {
    id: 'test.consumer',
    version: '1.0.0',
    requires: [{ capability: storage, range: '^1.0.0' }],
    setup: (ctx) => {
      onReady(ctx.require(storage));
    },
  };
}

interface StoppedEvent {
  pluginId?: string | undefined;
  cascade?: readonly string[] | undefined;
}

// -----------------------------------------------------------------------------
// Assertion helpers.

async function expectMoltRejection(
  promise: Promise<unknown>,
  code: RuntimeErrorCode,
): Promise<MoltError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (!isMoltError(caught)) {
    throw new Error(`expected MoltError(${code}), got: ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
  return caught;
}

async function startProviderWithConsumer(counters: FakeResources) {
  const runtime = createRuntime();
  let storageValue: { read(): number } | undefined;
  runtime.install(storagePlugin(counters));
  await runtime.start('test.provider');
  runtime.install(
    consumerPlugin((value) => {
      storageValue = value;
    }),
  );
  await runtime.start('test.consumer');
  return { runtime, storageValue: () => storageValue };
}

// -----------------------------------------------------------------------------
// The nine replacement transaction tests plus the two
// ordering tests.

describe('replacement contract', () => {
  it('INV-01: setup throws after acquiring three resources — all three are disposed, error is ACTIVATION_FAILED', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    runtime.install({
      id: 'test.boom',
      version: '1.0.0',
      setup: async (ctx) => {
        await ctx.scope.acquire(counters.create, counters.dispose);
        await ctx.scope.acquire(counters.create, counters.dispose);
        await ctx.scope.acquire(counters.create, counters.dispose);
        throw new Error('injected setup fault');
      },
    });

    await expectMoltRejection(runtime.start('test.boom'), 'ACTIVATION_FAILED');
    expect(counters.counters).toEqual({ acquired: 3, released: 3 });
  });

  it('INV-07: failed candidate replacement keeps the old generation active and usable', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    runtime.install(storagePlugin(counters));
    await runtime.start('test.provider');

    // No dependents exist here: replacements that DO have active dependents
    // are rejected before any candidate scope is created.
    await expectMoltRejection(
      runtime.replace(storagePlugin(counters, { version: '2.0.0', failSetup: true })),
      'REPLACEMENT_FAILED',
    );

    expect(runtime.getStatus('test.provider')).toBe('active');
    // Usable: a consumer started AFTER the failed window binds to
    // the old generation's value - the runtime still serves it.
    let bound: { read(): number } | undefined;
    runtime.install(
      consumerPlugin((value) => {
        bound = value;
      }),
    );
    await runtime.start('test.consumer');
    expect(bound?.read()).toBe(1);
    // acquired: old generation + candidate; released: only the candidate's
    // resource — a leaked candidate would leave live = 2.
    expect(counters.counters).toEqual({ acquired: 2, released: 1 });
  });

  it('INV-06: failed candidate validation publishes nothing — no capability, no contribution', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    runtime.install(storagePlugin(counters));
    await runtime.start('test.provider');
    runtime.install({
      id: 'test.other',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.contribute(sharedUi, { id: 'other-widget' });
      },
    });
    await runtime.start('test.other');

    const capabilitiesBefore = structuredClone(runtime.inspect().capabilities);
    const contributionsBefore = runtime.contributions().entries;

    const candidate: PluginDefinition = {
      id: 'test.provider',
      version: '2.0.0',
      provides: [{ capability: storage }],
      setup: async (ctx) => {
        await ctx.scope.acquire(counters.create, counters.dispose);
        ctx.provide(storage, { read: () => 2 });
        // test.shared.ui is owned by the unrelated active generation
        // test.other — commit validation must reject this candidate.
        ctx.contribute(sharedUi, { id: 'candidate-widget' });
      },
    };
    await expectMoltRejection(runtime.replace(candidate), 'REPLACEMENT_FAILED');

    expect(runtime.inspect().capabilities).toEqual(capabilitiesBefore);
    expect(runtime.contributions().entries).toEqual(contributionsBefore);
    expect(runtime.getStatus('test.provider')).toBe('active');
    expect(runtime.getStatus('test.other')).toBe('active');
    // The candidate acquired one resource and it was disposed with the
    // candidate scope.
    expect(counters.counters).toEqual({ acquired: 2, released: 1 });
  });

  it('INV-08 + INV-14: old disposal failure after commit — replacement still succeeds, failure inspectable, no restore', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    runtime.install(storagePlugin(counters, { failDispose: true }));
    await runtime.start('test.provider');

    await runtime.replace(storagePlugin(counters, { version: '2.0.0' }));

    expect(runtime.getStatus('test.provider')).toBe('active');
    const error: unknown = runtime.inspect().plugins.find((p) => p.id === 'test.provider')?.error;
    if (!isMoltError(error)) {
      throw new Error('expected the DISPOSAL_FAILED diagnostic to be inspectable');
    }
    expect(error.code).toBe('DISPOSAL_FAILED');
    // Old resource: release attempted (faulting disposer still counted);
    // new generation's resource is the single live one. Nothing was rolled back.
    expect(counters.counters).toEqual({ acquired: 2, released: 1 });
  });

  it('INV-12: 100 replacements leave resource counters at baseline', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    runtime.install(storagePlugin(counters));
    await runtime.start('test.provider');

    for (let i = 0; i < 100; i += 1) {
      await runtime.replace(storagePlugin(counters, { version: `1.0.${i + 1}` }));
    }

    expect(counters.counters.acquired).toBe(101);
    expect(counters.counters.released).toBe(100);
    expect(counters.counters.acquired - counters.counters.released).toBe(1); // exactly the active generation's resource
  });

  it('INV-11: stopping a provider with active dependents is rejected — zero state change', async () => {
    const counters = makeCounters();
    const { runtime } = await startProviderWithConsumer(counters);

    const error = await expectMoltRejection(runtime.stop('test.provider'), 'ACTIVE_DEPENDENTS');

    expect(error.path).toContain('test.consumer');
    expect(runtime.getStatus('test.provider')).toBe('active');
    expect(runtime.getStatus('test.consumer')).toBe('active');
    expect(counters.counters).toEqual({ acquired: 1, released: 0 });
  });

  it('INV-11: cascade stop — dependents first in deterministic reverse order, cascade recorded', async () => {
    const counters = makeCounters();
    const stopped: StoppedEvent[] = [];
    const runtime = createRuntime();
    runtime.subscribe((event) => {
      if (event.type === 'stopped') {
        stopped.push({ pluginId: event.pluginId, cascade: event.cascade });
      }
    });

    runtime.install(storagePlugin(counters));
    runtime.install({
      id: 'test.mid',
      version: '1.0.0',
      requires: [{ capability: storage, range: '^1.0.0' }],
      provides: [{ capability: midCap }],
      setup: async (ctx) => {
        await ctx.scope.acquire(counters.create, counters.dispose);
        ctx.provide(midCap, { ok: () => true });
      },
    });
    runtime.install({
      id: 'test.top',
      version: '1.0.0',
      requires: [{ capability: midCap, range: '^1.0.0' }],
      setup: async (ctx) => {
        await ctx.scope.acquire(counters.create, counters.dispose);
      },
    });
    await runtime.start('test.top'); // internal activation starts the whole closure
    expect(stopped).toEqual([]);

    await runtime.stop('test.provider', { cascade: true });

    expect(stopped.map((event) => event.pluginId)).toEqual([
      'test.top',
      'test.mid',
      'test.provider',
    ]);
    const recordedCascade = stopped.some(
      (event) => event.cascade?.includes('test.mid') && event.cascade?.includes('test.top'),
    );
    expect(recordedCascade).toBe(true); // which plugins were stopped is recorded
    expect(runtime.getStatus('test.provider')).toBe('stopped');
    expect(runtime.getStatus('test.mid')).toBe('stopped');
    expect(runtime.getStatus('test.top')).toBe('stopped');
    expect(counters.counters).toEqual({ acquired: 3, released: 3 });
  });

  it('INV-05: runtime disposal is idempotent — no duplicate disposer calls, no unhandled rejection', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    runtime.install(storagePlugin(counters));
    await runtime.start('test.provider');

    await runtime.dispose();
    expect(counters.counters).toEqual({ acquired: 1, released: 1 });

    // A second dispose resolves without side effects; if the engine ever
    // re-runs disposers or leaves a floating rejection here, vitest fails
    // this suite through its unhandled-rejection tracking.
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(counters.counters).toEqual({ acquired: 1, released: 1 });

    // Lifecycle operations after runtime disposal are structured errors.
    await expectMoltRejection(runtime.start('test.provider'), 'INVALID_STATE');
  });

  it('INV-15: replacing a provider with active dependents is rejected — zero state change, dependent path named', async () => {
    const counters = makeCounters();
    const { runtime } = await startProviderWithConsumer(counters);
    const capabilitiesBefore = structuredClone(runtime.inspect().capabilities);

    const error = await expectMoltRejection(
      runtime.replace(storagePlugin(counters, { version: '2.0.0' })),
      'REPLACEMENT_FAILED',
    );

    expect(error.path).toContain('test.consumer');
    expect(runtime.getStatus('test.provider')).toBe('active');
    expect(runtime.getStatus('test.consumer')).toBe('active');
    expect(runtime.inspect().capabilities).toEqual(capabilitiesBefore);
    // Rejected before any candidate scope existed — not even one acquisition.
    expect(counters.counters).toEqual({ acquired: 1, released: 0 });
  });

  it('commit ordering — candidate published and marked active before the old scope is disposed (event sequence)', async () => {
    const counters = makeCounters();
    const log: string[] = [];
    const runtime = createRuntime();
    runtime.subscribe((event) => {
      if (event.type === 'replaced' && event.pluginId === 'test.provider') {
        log.push('replaced');
      }
    });
    runtime.install(storagePlugin(counters, { onDispose: () => log.push('old-disposed') }));
    await runtime.start('test.provider');

    await runtime.replace(storagePlugin(counters, { version: '2.0.0' }));

    // The 'replaced' publication must be observable before old-scope
    // disposal runs — commit is never interleaved with teardown.
    expect(log).toEqual(['replaced', 'old-disposed']);
  });

  it('INV-06: stop during preparing - activation fails cleanly, resources disposed, nothing published', async () => {
    const counters = makeCounters();
    const runtime = createRuntime();
    const entered = createDeferred<void>();
    runtime.install({
      id: 'test.slow',
      version: '1.0.0',
      provides: [{ capability: storage }],
      setup: async (ctx) => {
        await ctx.scope.acquire(counters.create, counters.dispose);
        ctx.provide(storage, { read: () => 1 });
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('aborted during preparation');
      },
    });

    const starting = runtime.start('test.slow');
    await entered.promise; // the start op is now inside setup: status preparing
    const stopping = runtime.stop('test.slow'); // aborts the preparing scope
    await expectMoltRejection(starting, 'ACTIVATION_FAILED');
    await stopping;

    expect(runtime.getStatus('test.slow')).toBe('stopped');
    expect(counters.counters).toEqual({ acquired: 1, released: 1 });
    expect(runtime.inspect().capabilities).toEqual([]); // staged provide never became visible
  });
});
