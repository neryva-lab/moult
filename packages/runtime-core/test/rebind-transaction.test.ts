// Transactional dependent-rebind tests (F5). Every test observes the runtime
// only through public API, observer events, inspection, and resource
// counters. The transaction contract under test:
//
// - replacing a provider rebinds every active dependent (transitively) onto
//   the new generation; dependents never observe a withdrawn provider;
// - candidates prepare privately: no staged binding or event is visible
//   before the whole closure commits;
// - any failure aborts the transaction: every candidate is disposed, every
//   old generation keeps serving, exactly one structured failure surfaces.

import type { MoltError, PluginDefinition, Runtime, RuntimeErrorCode } from '../src/index.js';
import { capability, createRuntime, isMoltError } from '../src/index.js';
import { createDeferred } from '../src/internal/async.js';

// -----------------------------------------------------------------------------
// Test scaffolding (mirrors replacement.test.ts conventions).

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

/**
 * The public lifecycle guards (reentrancy, self-operation, rebind
 * ownership) throw synchronously, before any promise is returned — so a
 * concurrent call under test needs a thunk, not a bare promise.
 */
async function expectMoltRejectionFrom(
  fn: () => Promise<unknown>,
  code: RuntimeErrorCode,
): Promise<MoltError> {
  try {
    return await expectMoltRejection(fn(), code);
  } catch (error) {
    if (isMoltError(error) && error.code === code) {
      return error;
    }
    throw error;
  }
}

interface Box {
  tag: string;
}

const capA = (version: string) => capability<Box>('test.chain.a', version);
const capB = (version: string) => capability<Box & { from: string }>('test.chain.b', version);
const capMulti = (version: string) => capability<Box[]>('test.multi', version, { multiple: true });
const capZ = (version: string) => capability<Box>('test.z', version);

/** Provider of capA: one counted resource, value tagged per definition. */
function providerA(
  counters: FakeResources,
  capVersion: string,
  tag: string,
  options: { onDispose?: () => void; failDispose?: boolean; gate?: Promise<void> } = {},
): PluginDefinition {
  const cap = capA(capVersion);
  return {
    id: 'test.a',
    version: '1.0.0',
    provides: [{ capability: cap }],
    setup: async (ctx) => {
      await ctx.scope.acquire(
        counters.create,
        options.failDispose
          ? counters.faultyDispose
          : () => {
              counters.dispose();
              options.onDispose?.();
            },
      );
      if (options.gate !== undefined) {
        await options.gate;
      }
      ctx.provide(cap, { tag });
    },
  };
}

/** Middle: requires capA, provides capB, re-exports the provider's tag. */
function middleB(
  counters: FakeResources,
  seen: Box[],
  options: {
    onDispose?: () => void;
    failSetup?: () => boolean;
    gate?: Promise<void>;
    entered?: () => void;
  } = {},
): PluginDefinition {
  return {
    id: 'test.b',
    version: '1.0.0',
    requires: [{ capability: capA('1.0.0'), range: '^1.0.0' }],
    provides: [{ capability: capB('1.0.0') }],
    setup: async (ctx) => {
      await ctx.scope.acquire(counters.create, () => {
        counters.dispose();
        options.onDispose?.();
      });
      options.entered?.();
      if (options.gate !== undefined) {
        await options.gate;
      }
      if (options.failSetup?.() === true) {
        throw new Error('injected dependent setup fault');
      }
      const a = ctx.require(capA('1.0.0'));
      const value = { tag: `b(${a.tag})`, from: a.tag };
      seen.push(value);
      ctx.provide(capB('1.0.0'), value);
    },
  };
}

/** Leaf consumer of capB. */
function leafC(seen: Box[], options: { entered?: () => void } = {}): PluginDefinition {
  return {
    id: 'test.c',
    version: '1.0.0',
    requires: [{ capability: capB('1.0.0'), range: '^1.0.0' }],
    setup: (ctx) => {
      options.entered?.();
      seen.push(ctx.require(capB('1.0.0')));
    },
  };
}

/** Direct consumer of capA with a configurable range/optionality. */
function directConsumer(
  id: string,
  seen: (Box | undefined)[],
  range: string,
  optional: boolean,
): PluginDefinition {
  return {
    id,
    version: '1.0.0',
    requires: [{ capability: capA('1.0.0'), range, optional }],
    setup: (ctx) => {
      seen.push(optional ? ctx.optional(capA('1.0.0')) : ctx.require(capA('1.0.0')));
    },
  };
}

function replacedEvents(runtime: Runtime) {
  const events: string[] = [];
  runtime.subscribe((event) => {
    if (event.type === 'replaced' && event.pluginId !== undefined) {
      events.push(event.pluginId);
    }
  });
  return events;
}

// -----------------------------------------------------------------------------
// Tests.

describe('transactional dependent rebind', () => {
  it('transitive chain rebinds provider-first; every generation observes the new values', async () => {
    const counters = makeCounters();
    const seenB: Box[] = [];
    const seenC: Box[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(middleB(counters, seenB));
    await runtime.start('test.b');
    runtime.install(leafC(seenC));
    await runtime.start('test.c');
    const events = replacedEvents(runtime);

    await runtime.replace(providerA(counters, '1.0.0', 'a2'));

    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    expect(runtime.getStatus('test.c')).toBe('active');
    // The middle rebound against the NEW provider value, and the leaf
    // against the NEW middle value — the transaction is provider-first.
    expect(seenB.at(-1)).toEqual({ tag: 'b(a2)', from: 'a2' });
    expect(seenC.at(-1)).toEqual({ tag: 'b(a2)', from: 'a2' });
    expect(events).toEqual(['test.a', 'test.b', 'test.c']);
    // Three old generations retired, three candidates prepared: net zero.
    // (The leaf holds no counted resource: 2 initial + 2 candidates.)
    expect(counters.counters.acquired).toBe(4);
    expect(counters.counters.released).toBe(2);
  });

  it('multiple direct dependents all rebind; unaffected providers keep their values', async () => {
    const counters = makeCounters();
    const seenB: (Box | undefined)[] = [];
    const seenC: (Box | undefined)[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(directConsumer('test.b', seenB, '^1.0.0', false));
    await runtime.start('test.b');
    runtime.install(directConsumer('test.c', seenC, '^1.0.0', false));
    await runtime.start('test.c');

    await runtime.replace(providerA(counters, '1.0.0', 'a2'));

    expect(seenB.at(-1)).toEqual({ tag: 'a2' });
    expect(seenC.at(-1)).toEqual({ tag: 'a2' });
    expect(runtime.getStatus('test.b')).toBe('active');
    expect(runtime.getStatus('test.c')).toBe('active');
  });

  it('multiple:true providers: rebound selection keeps the untouched provider value by identity', async () => {
    const counters = makeCounters();
    const seen: Box[][] = [];
    const cap = capMulti('1.0.0');
    const untouchedValue = { tag: 'p2' };
    const runtime = createRuntime();
    runtime.install({
      id: 'test.p1',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, [{ tag: 'p1-old' }]);
      },
    });
    await runtime.start('test.p1');
    runtime.install({
      id: 'test.p2',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, [untouchedValue]);
      },
    });
    await runtime.start('test.p2');
    runtime.install({
      id: 'test.consumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: (ctx) => {
        seen.push(ctx.require(cap));
      },
    });
    await runtime.start('test.consumer');
    expect(seen[0]).toHaveLength(2);

    await runtime.replace({
      id: 'test.p1',
      version: '2.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, [{ tag: 'p1-new' }]);
      },
    });

    const rebound = seen.at(-1) ?? [];
    expect(rebound.map((value) => value.tag).sort()).toEqual(['p1-new', 'p2']);
    // The untouched provider was NOT re-prepared: its value is identical.
    expect(rebound.find((value) => value.tag === 'p2')).toBe(untouchedValue);
    expect(counters.counters.acquired).toBe(0);
  });

  it('required range mismatch fails the transaction — zero state change, candidates disposed', async () => {
    const counters = makeCounters();
    const seen: (Box | undefined)[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(directConsumer('test.b', seen, '^1.0.0', false));
    await runtime.start('test.b');
    const capabilitiesBefore = structuredClone(runtime.inspect().capabilities);
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));

    const error = await expectMoltRejection(
      runtime.replace(providerA(counters, '2.0.0', 'a2')),
      'REPLACEMENT_FAILED',
    );
    expect(String(error.cause)).toContain('test.b');

    // Zero state change: the old provider still serves, the dependent never
    // re-ran, nothing was published, no replaced event leaked.
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    expect(runtime.inspect().capabilities).toEqual(capabilitiesBefore);
    expect(seen).toHaveLength(1);
    expect(events).not.toContain('replaced');
    expect(events.filter((type) => type === 'failed')).toHaveLength(1);
    // The prepared provider candidate was disposed; the old scope untouched.
    expect(counters.counters).toEqual({ acquired: 2, released: 1 });
  });

  it('per-consumer granularity: one dependent may pin the old range while another follows the new one', async () => {
    const counters = makeCounters();
    const seenStrict: (Box | undefined)[] = [];
    const seenLoose: (Box | undefined)[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    // Satisfies both 1.x and 2.x: follows the replacement.
    runtime.install(directConsumer('test.strict', seenStrict, '>=1.0.0', false));
    await runtime.start('test.strict');
    // Optional and pinned to 1.x: rebinds, but binds nothing afterwards.
    runtime.install(directConsumer('test.loose', seenLoose, '^1.0.0', true));
    await runtime.start('test.loose');
    expect(seenLoose.at(-1)).toEqual({ tag: 'a1' });

    await runtime.replace(providerA(counters, '2.0.0', 'a2'));

    expect(runtime.getStatus('test.strict')).toBe('active');
    expect(runtime.getStatus('test.loose')).toBe('active');
    expect(seenStrict.at(-1)).toEqual({ tag: 'a2' });
    expect(seenLoose.at(-1)).toBeUndefined();
  });

  it('dropped required capability fails the transaction with the dependent named', async () => {
    const counters = makeCounters();
    const cache = capability<Box>('test.cache', '1.0.0');
    const runtime = createRuntime();
    runtime.install({
      id: 'test.a',
      version: '1.0.0',
      provides: [{ capability: capA('1.0.0') }, { capability: cache }],
      setup: (ctx) => {
        ctx.provide(capA('1.0.0'), { tag: 'a1' });
        ctx.provide(cache, { tag: 'cache1' });
      },
    });
    await runtime.start('test.a');
    runtime.install({
      id: 'test.b',
      version: '1.0.0',
      requires: [
        { capability: capA('1.0.0'), range: '^1.0.0' },
        { capability: cache, range: '^1.0.0' },
      ],
      setup: () => {},
    });
    await runtime.start('test.b');
    void counters;

    const error = await expectMoltRejection(
      runtime.replace(providerA(makeCounters(), '1.0.0', 'a2')),
      'REPLACEMENT_FAILED',
    );
    expect(String(error.cause)).toContain('test.cache');
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    expect(runtime.inspect().capabilities.find((entry) => entry.id === 'test.cache')).toBeDefined();
  });
});

describe('rebind transaction isolation and failure', () => {
  it('no partial binding visibility: old generation serves until commit; dependent setup sees the candidate', async () => {
    const counters = makeCounters();
    const seenInSetup: { required: Box; publishedVersion: string | undefined }[] = [];
    const consumerEntered = createDeferred<void>();
    const consumerGate = createDeferred<void>();
    let gateConsumerSetup = false;
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    const oldGenerationId = runtime.inspect().plugins.find((p) => p.id === 'test.a')?.generation;
    runtime.install({
      id: 'test.b',
      version: '1.0.0',
      requires: [{ capability: capA('1.0.0'), range: '^1.0.0' }],
      setup: async (ctx) => {
        if (gateConsumerSetup) {
          consumerEntered.resolve();
          await consumerGate.promise;
        }
        seenInSetup.push({
          required: ctx.require(capA('1.0.0')),
          publishedVersion: runtime
            .inspect()
            .capabilities.find((entry) => entry.id === 'test.chain.a')?.version,
        });
      },
    });
    await runtime.start('test.b');
    seenInSetup.length = 0;

    // The replacement's provider candidate waits on a fresh gate; the
    // dependent candidate then waits on its own gate. While both are
    // pending, the old generation is the only visible one.
    const providerGate2 = createDeferred<void>();
    gateConsumerSetup = true;
    const replacement = runtime.replace(
      providerA(counters, '1.0.0', 'a2', { gate: providerGate2.promise }),
    );
    // Wait until the provider candidate is inside setup (gate pending),
    // then release it so the dependent candidate starts and blocks.
    await new Promise((resolve) => setTimeout(resolve, 10));
    providerGate2.resolve();
    await consumerEntered.promise;
    const midFlight = runtime.inspect();
    expect(midFlight.plugins.find((p) => p.id === 'test.a')?.generation).toBe(oldGenerationId);
    expect(midFlight.plugins.find((p) => p.id === 'test.a')?.status).toBe('active');
    expect(midFlight.plugins.find((p) => p.id === 'test.b')?.status).toBe('active');

    consumerGate.resolve();
    await replacement;

    // The dependent's setup resolved the CANDIDATE value even though the
    // candidate was never globally published before commit.
    expect(seenInSetup).toHaveLength(1);
    expect(seenInSetup[0]?.required).toEqual({ tag: 'a2' });
    const newGenerationId = runtime.inspect().plugins.find((p) => p.id === 'test.a')?.generation;
    expect(newGenerationId).not.toBe(oldGenerationId);
  });

  it('disposal and event ordering: replaced provider-first, old scopes retired dependents-first', async () => {
    const counters = makeCounters();
    const log: string[] = [];
    const seenB: Box[] = [];
    const seenC: Box[] = [];
    const runtime = createRuntime();
    runtime.subscribe((event) => {
      if (event.type === 'replaced' && event.pluginId !== undefined) {
        log.push(`replaced:${event.pluginId}`);
      }
    });
    runtime.install(
      providerA(counters, '1.0.0', 'a1', { onDispose: () => log.push('disposed:test.a') }),
    );
    await runtime.start('test.a');
    runtime.install(middleB(counters, seenB, { onDispose: () => log.push('disposed:test.b') }));
    await runtime.start('test.b');
    runtime.install(leafC(seenC));
    await runtime.start('test.c');
    void seenB;
    void seenC;

    await runtime.replace(providerA(counters, '1.0.0', 'a2'));

    expect(log).toEqual([
      'replaced:test.a',
      'replaced:test.b',
      'replaced:test.c',
      // Old scopes retire after every replaced event, dependents first.
      'disposed:test.b',
      'disposed:test.a',
    ]);
  });

  it('dependent setup failure aborts: one failed event, candidates disposed, olds untouched and serving', async () => {
    const counters = makeCounters();
    const seenB: Box[] = [];
    let failNextSetup = false;
    const events: { type: string; pluginId: string | undefined }[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(middleB(counters, seenB, { failSetup: () => failNextSetup }));
    await runtime.start('test.b');
    runtime.subscribe((event) => events.push({ type: event.type, pluginId: event.pluginId }));
    const oldBValue = seenB.at(-1);
    failNextSetup = true;

    const error = await expectMoltRejection(
      runtime.replace(providerA(counters, '1.0.0', 'a2')),
      'REPLACEMENT_FAILED',
    );
    expect(String(error.cause)).toContain('injected dependent setup fault');

    expect(events.filter((event) => event.type === 'replaced')).toHaveLength(0);
    const failed = events.filter((event) => event.type === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.pluginId).toBe('test.a');
    // The middle still serves its old value; both olds still active.
    expect(seenB.at(-1)).toBe(oldBValue);
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    // Both prepared candidates disposed (provider candidate + dependent
    // candidate); the old scopes were never touched.
    expect(counters.counters).toEqual({ acquired: 4, released: 2 });

    // Retry with a healthy dependent setup succeeds — the abort left no scar.
    failNextSetup = false;
    await runtime.replace(providerA(counters, '1.0.0', 'a3'));
    expect(seenB.at(-1)).toEqual({ tag: 'b(a3)', from: 'a3' });
    expect(runtime.getStatus('test.b')).toBe('active');
  });

  it('candidate disposal failure during abort is aggregated, not lost', async () => {
    const counters = makeCounters();
    const seenB: Box[] = [];
    let failNextSetup = false;
    const runtime = createRuntime();
    // The provider candidate's disposer throws: abort must still dispose the
    // dependent candidate and report everything.
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(middleB(counters, seenB, { failSetup: () => failNextSetup }));
    await runtime.start('test.b');
    failNextSetup = true;

    const error = await expectMoltRejection(
      runtime.replace(providerA(counters, '1.0.0', 'a2', { failDispose: true })),
      'REPLACEMENT_FAILED',
    );
    const details = (error.details ?? {}) as { disposalErrors?: unknown[] };
    expect(details.disposalErrors).toBeDefined();
    expect(details.disposalErrors?.length).toBeGreaterThan(0);
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
  });

  it('concurrent lifecycle operations on transaction-owned plugins fail loudly; unrelated plugins are unaffected', async () => {
    const counters = makeCounters();
    const seenB: (Box | undefined)[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(directConsumer('test.b', seenB, '^1.0.0', false));
    await runtime.start('test.b');
    runtime.install({
      id: 'test.unrelated',
      version: '1.0.0',
      setup: () => {},
    });
    await runtime.start('test.unrelated');

    const gate2 = createDeferred<void>();
    const replacement = runtime.replace(
      providerA(counters, '1.0.0', 'a2', { gate: gate2.promise }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Every lifecycle operation touching the closure fails explicitly.
    await expectMoltRejectionFrom(() => runtime.start('test.a'), 'INVALID_STATE');
    await expectMoltRejectionFrom(() => runtime.start('test.b'), 'INVALID_STATE');
    await expectMoltRejectionFrom(() => runtime.stop('test.b'), 'INVALID_STATE');
    await expectMoltRejectionFrom(
      () => runtime.replace(providerA(counters, '1.0.0', 'a3')),
      'INVALID_STATE',
    );
    await expectMoltRejectionFrom(() => runtime.uninstall('test.b'), 'INVALID_STATE');
    // An unrelated plugin is unaffected by the ownership claim.
    await runtime.stop('test.unrelated');
    expect(runtime.getStatus('test.unrelated')).toBe('stopped');

    gate2.resolve();
    await replacement;
    expect(seenB.at(-1)).toEqual({ tag: 'a2' });
  });

  it('retry after a range-mismatch abort succeeds with a compatible candidate', async () => {
    const counters = makeCounters();
    const seen: (Box | undefined)[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(directConsumer('test.b', seen, '^1.0.0', false));
    await runtime.start('test.b');

    await expectMoltRejection(
      runtime.replace(providerA(counters, '2.0.0', 'a2')),
      'REPLACEMENT_FAILED',
    );
    // The runtime is fully usable afterwards: stop/start still work.
    await runtime.stop('test.b');
    await runtime.start('test.b');
    expect(seen.at(-1)).toEqual({ tag: 'a1' });

    await runtime.replace(providerA(counters, '1.5.0', 'a1.5'));
    expect(seen.at(-1)).toEqual({ tag: 'a1.5' });
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
  });
});

describe('rebind transaction commit and isolation guarantees', () => {
  it('no partial events: every replaced event observes the whole closure already swapped', async () => {
    const counters = makeCounters();
    const seenB: Box[] = [];
    const seenC: Box[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install(middleB(counters, seenB));
    await runtime.start('test.b');
    runtime.install(leafC(seenC));
    await runtime.start('test.c');

    const oldGenerations = new Map(
      runtime.inspect().plugins.map((plugin) => [plugin.id, plugin.generation]),
    );
    const snapshots: { pluginId: string; generations: Map<string, string | undefined> }[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'replaced') {
        snapshots.push({
          pluginId: event.pluginId ?? '?',
          generations: new Map(
            runtime.inspect().plugins.map((plugin) => [plugin.id, plugin.generation]),
          ),
        });
      }
    });

    await runtime.replace(providerA(counters, '1.0.0', 'a2'));

    // Events fire provider-first, one per rebound plugin.
    expect(snapshots.map((snapshot) => snapshot.pluginId)).toEqual(['test.a', 'test.b', 'test.c']);
    // At every event, no closure member still showed its old generation:
    // state commits fully before the first event is visible.
    for (const snapshot of snapshots) {
      for (const id of ['test.a', 'test.b', 'test.c']) {
        expect(snapshot.generations.get(id)).not.toBe(oldGenerations.get(id));
        expect(snapshot.generations.get(id)).toBeDefined();
      }
    }
    expect(seenB.at(-1)).toEqual({ tag: 'b(a2)', from: 'a2' });
    expect(seenC.at(-1)).toEqual({ tag: 'b(a2)', from: 'a2' });
  });

  it('unrelated concurrent replacements keep transaction-local overlays', async () => {
    const capX = (version: string) => capability<Box>('test.iso.x', version);
    const capY = (version: string) => capability<Box>('test.iso.y', version);
    const seenX: Box[] = [];
    const seenY: Box[] = [];
    const runtime = createRuntime();
    const providerGateX = createDeferred<void>();
    const providerGateY = createDeferred<void>();
    const consumerEnteredX = createDeferred<void>();
    const consumerEnteredY = createDeferred<void>();
    const consumerGateX = createDeferred<void>();
    const consumerGateY = createDeferred<void>();
    let gateConsumerSetup = false;

    runtime.install({
      id: 'test.px',
      version: '1.0.0',
      provides: [{ capability: capX('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(capX('1.0.0'), { tag: 'x-old' });
      },
    });
    await runtime.start('test.px');
    runtime.install({
      id: 'test.cx',
      version: '1.0.0',
      requires: [{ capability: capX('1.0.0'), range: '^1.0.0' }],
      setup: async (ctx) => {
        if (gateConsumerSetup) {
          consumerEnteredX.resolve();
          await consumerGateX.promise;
        }
        seenX.push(ctx.require(capX('1.0.0')));
      },
    });
    await runtime.start('test.cx');
    runtime.install({
      id: 'test.py',
      version: '1.0.0',
      provides: [{ capability: capY('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(capY('1.0.0'), { tag: 'y-old' });
      },
    });
    await runtime.start('test.py');
    runtime.install({
      id: 'test.cy',
      version: '1.0.0',
      requires: [{ capability: capY('1.0.0'), range: '^1.0.0' }],
      setup: async (ctx) => {
        if (gateConsumerSetup) {
          consumerEnteredY.resolve();
          await consumerGateY.promise;
        }
        seenY.push(ctx.require(capY('1.0.0')));
      },
    });
    await runtime.start('test.cy');

    // Two disjoint closures, replaced concurrently with interleaved gates.
    gateConsumerSetup = true;
    const replacementX = runtime.replace({
      id: 'test.px',
      version: '1.0.0',
      provides: [{ capability: capX('1.0.0') }],
      setup: async (ctx) => {
        await providerGateX.promise;
        ctx.provide(capX('1.0.0'), { tag: 'x-new' });
      },
    });
    const replacementY = runtime.replace({
      id: 'test.py',
      version: '1.0.0',
      provides: [{ capability: capY('1.0.0') }],
      setup: async (ctx) => {
        await providerGateY.promise;
        ctx.provide(capY('1.0.0'), { tag: 'y-new' });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    providerGateX.resolve();
    await consumerEnteredX.promise;
    providerGateY.resolve();
    await consumerEnteredY.promise;
    // X commits first while Y's consumer is still blocked in setup: a
    // shared overlay would be cleared (or clobbered) here, and Y's
    // consumer would resolve the stale published value.
    consumerGateX.resolve();
    await replacementX;
    consumerGateY.resolve();
    await replacementY;

    expect(seenX.at(-1)).toEqual({ tag: 'x-new' });
    expect(seenY.at(-1)).toEqual({ tag: 'y-new' });
    expect(runtime.getStatus('test.px')).toBe('active');
    expect(runtime.getStatus('test.py')).toBe('active');
  });

  it('optional multiple:true omits only the incompatible rebound provider', async () => {
    // test.pa provides capA and capM; test.pb provides capM and requires
    // capA (so it is rebound too, with unchanged provides); test.c
    // optionally consumes capM from both. Replacing test.pa with an
    // incompatible capM must drop only pa's binding for c — pb's compatible
    // rebound binding must survive.
    const seen: Box[][] = [];
    const runtime = createRuntime();
    const pbValue = [{ tag: 'pb' }];
    runtime.install({
      id: 'test.pa',
      version: '1.0.0',
      provides: [{ capability: capA('1.0.0') }, { capability: capMulti('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(capA('1.0.0'), { tag: 'a-old' });
        ctx.provide(capMulti('1.0.0'), [{ tag: 'pa-old' }]);
      },
    });
    await runtime.start('test.pa');
    runtime.install({
      id: 'test.pb',
      version: '1.0.0',
      requires: [{ capability: capA('1.0.0'), range: '^1.0.0' }],
      provides: [{ capability: capMulti('1.0.0') }],
      setup: (ctx) => {
        ctx.require(capA('1.0.0'));
        ctx.provide(capMulti('1.0.0'), pbValue);
      },
    });
    await runtime.start('test.pb');
    runtime.install({
      id: 'test.c',
      version: '1.0.0',
      requires: [{ capability: capMulti('1.0.0'), range: '^1.0.0', optional: true }],
      setup: (ctx) => {
        seen.push(ctx.optional(capMulti('1.0.0')) ?? []);
      },
    });
    await runtime.start('test.c');
    expect(
      seen
        .at(-1)
        ?.map((value) => value.tag)
        .sort(),
    ).toEqual(['pa-old', 'pb']);

    // test.pa moves capM to 2.0.0, violating c's optional ^1.0.0 range.
    // The transaction succeeds; the rebound consumer keeps pb's binding
    // and drops only pa's.
    await runtime.replace({
      id: 'test.pa',
      version: '1.0.0',
      provides: [{ capability: capA('1.0.0') }, { capability: capMulti('2.0.0') }],
      setup: (ctx) => {
        ctx.provide(capA('1.0.0'), { tag: 'a-new' });
        ctx.provide(capMulti('2.0.0'), [{ tag: 'pa-new' }]);
      },
    });

    const rebound = seen.at(-1) ?? [];
    expect(rebound.map((value) => value.tag)).toEqual(['pb']);
    // The compatible rebound provider was not silently dropped: the value
    // is the same object its candidate provided.
    expect(rebound[0]).toBe(pbValue[0]);
    expect(runtime.getStatus('test.pb')).toBe('active');
    expect(runtime.getStatus('test.c')).toBe('active');
  });

  it('abort disposes prepared candidates in reverse preparation order', async () => {
    const counters = makeCounters();
    const disposed: string[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install({
      id: 'test.b',
      version: '1.0.0',
      requires: [{ capability: capA('1.0.0'), range: '^1.0.0' }],
      provides: [{ capability: capB('1.0.0') }],
      setup: async (ctx) => {
        await ctx.scope.acquire(
          () => ({ marker: 'b' }),
          () => {
            disposed.push('cand-b');
          },
        );
        const a = ctx.require(capA('1.0.0'));
        ctx.provide(capB('1.0.0'), { tag: `b(${a.tag})`, from: a.tag });
      },
    });
    await runtime.start('test.b');
    let failLeafSetup = false;
    runtime.install({
      id: 'test.c',
      version: '1.0.0',
      requires: [{ capability: capB('1.0.0'), range: '^1.0.0' }],
      setup: async (ctx) => {
        await ctx.scope.acquire(
          () => ({ marker: 'c' }),
          () => {
            disposed.push('cand-c');
          },
        );
        if (failLeafSetup) {
          throw new Error('injected leaf setup fault');
        }
        ctx.require(capB('1.0.0'));
      },
    });
    await runtime.start('test.c');
    disposed.length = 0;

    failLeafSetup = true;
    await expectMoltRejection(
      runtime.replace(
        providerA(counters, '1.0.0', 'a2', {
          onDispose: () => disposed.push('cand-a'),
        }),
      ),
      'REPLACEMENT_FAILED',
    );
    // Preparation order is a, b, c. The leaf candidate fails and its scope
    // is disposed immediately; the abort loop then disposes the surviving
    // candidates in reverse preparation order — b before a.
    expect(disposed).toEqual(['cand-c', 'cand-b', 'cand-a']);
    // Old generations are untouched and still serving.
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    expect(runtime.getStatus('test.c')).toBe('active');
  });

  it('a retired old generation that fails disposal is inspectable; the replacement stands', async () => {
    const counters = makeCounters();
    const seen: (Box | undefined)[] = [];
    const runtime = createRuntime();
    runtime.install(providerA(counters, '1.0.0', 'a1', { failDispose: true }));
    await runtime.start('test.a');
    runtime.install(directConsumer('test.b', seen, '^1.0.0', false));
    await runtime.start('test.b');

    await runtime.replace(providerA(counters, '1.0.0', 'a2'));

    // The replacement committed: the new generation serves.
    expect(seen.at(-1)).toEqual({ tag: 'a2' });
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    // The old scope's disposal fault is inspectable on the record — the
    // committed replacement is never rolled back.
    const plugin = runtime.inspect().plugins.find((entry) => entry.id === 'test.a');
    expect(plugin?.error).toBeDefined();
    expect(isMoltError(plugin?.error)).toBe(true);
    expect((plugin?.error as MoltError).code).toBe('DISPOSAL_FAILED');
  });
});

describe('rebind transaction ownership conflicts', () => {
  it('overlapping transaction closures fail fast with rebind-in-flight', async () => {
    // T1 = replace(test.a) owns {a, b, c}. While b's candidate is parked,
    // T2 = replace(test.p) would claim {p, c} — c is already owned. T2 must
    // fail loudly instead of preparing a competing candidate for test.c.
    const counters = makeCounters();
    const runtime = createRuntime();
    const enteredB = createDeferred<void>();
    const gateB = createDeferred<void>();
    let gateCandidateSetup = false;
    runtime.install(providerA(counters, '1.0.0', 'a1'));
    await runtime.start('test.a');
    runtime.install({
      id: 'test.b',
      version: '1.0.0',
      requires: [{ capability: capA('1.0.0'), range: '^1.0.0' }],
      provides: [{ capability: capB('1.0.0') }],
      setup: async (ctx) => {
        if (gateCandidateSetup) {
          enteredB.resolve();
          await gateB.promise;
        }
        const a = ctx.require(capA('1.0.0'));
        ctx.provide(capB('1.0.0'), { tag: `b(${a.tag})`, from: a.tag });
      },
    });
    await runtime.start('test.b');
    runtime.install({
      id: 'test.p',
      version: '1.0.0',
      provides: [{ capability: capZ('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(capZ('1.0.0'), { tag: 'z-old' });
      },
    });
    await runtime.start('test.p');
    const seenZ: Box[] = [];
    runtime.install({
      id: 'test.c',
      version: '1.0.0',
      requires: [
        { capability: capB('1.0.0'), range: '^1.0.0' },
        { capability: capZ('1.0.0'), range: '^1.0.0' },
      ],
      setup: (ctx) => {
        ctx.require(capB('1.0.0'));
        seenZ.push(ctx.require(capZ('1.0.0')));
      },
    });
    await runtime.start('test.c');

    // T1 starts; b's candidate parks inside setup.
    gateCandidateSetup = true;
    const first = runtime.replace(providerA(counters, '1.0.0', 'a2'));
    await enteredB.promise;
    // T2's closure {p, c} intersects T1's {a, b, c}: fail fast.
    const second = runtime.replace({
      id: 'test.p',
      version: '1.0.0',
      provides: [{ capability: capZ('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(capZ('1.0.0'), { tag: 'z-new' });
      },
    });
    const error = await expectMoltRejection(second, 'INVALID_STATE');
    expect(error.details).toMatchObject({ reason: 'rebind-in-flight' });

    // T1 completes undisturbed; the failed T2 changed nothing.
    gateB.resolve();
    await first;
    expect(runtime.getStatus('test.p')).toBe('active');
    expect(runtime.getStatus('test.c')).toBe('active');
    expect(seenZ.at(-1)).toEqual({ tag: 'z-old' });
    // And T2's plugin is replaceable again once T1 is done.
    await runtime.replace({
      id: 'test.p',
      version: '1.0.0',
      provides: [{ capability: capZ('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(capZ('1.0.0'), { tag: 'z-new' });
      },
    });
    expect(seenZ.at(-1)).toEqual({ tag: 'z-new' });
  });
});
