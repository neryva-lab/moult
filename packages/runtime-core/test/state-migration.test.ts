// State migration tests (F6). Every test observes the runtime only through
// public API, observer events, inspection, and resource counters. The
// migration contract under test:
//
// - during replacement, the candidate's `migrate` hook runs after its
//   `setup` and before commit, inside the candidate's scope;
// - `migrate` receives what the previous generation published
//   (`MigrationPrevious`: pluginId, generation, version, stateVersion,
//   capabilityId → value), and may `ctx.provide` to carry values over —
//   during migrate a provide overwrites a value setup staged;
// - a throwing `migrate` fails the replacement (REPLACEMENT_FAILED with the
//   hook's error as cause); the old generation keeps serving and the
//   candidate scope is disposed;
// - `migrate` never runs on first start or restart — only on replacement;
// - `stateVersion` lets the hook switch on the state schema independently
//   of the plugin version.

import type {
  MigrationPrevious,
  MoltError,
  PluginDefinition,
  RuntimeErrorCode,
} from '../src/index.js';
import { capability, createRuntime, isMoltError } from '../src/index.js';
import { createDeferred } from '../src/internal/async.js';

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

const counterCap = (version: string) => capability<{ count: number }>('test.counter', version);
const labelCap = (version: string) => capability<{ label: string }>('test.label', version);
const otherCap = (version: string) => capability<{ tag: string }>('test.other', version);

/** A stateful counter: v1 exposes its live state object for the test to mutate. */
function counterV1(
  onState: (state: { count: number }) => void,
  options: { stateVersion?: string } = {},
): PluginDefinition {
  return {
    id: 'test.store',
    version: '1.0.0',
    ...(options.stateVersion !== undefined ? { stateVersion: options.stateVersion } : {}),
    provides: [{ capability: counterCap('1.0.0') }],
    setup: (ctx) => {
      const state = { count: 0 };
      onState(state);
      ctx.provide(counterCap('1.0.0'), state);
    },
  };
}

function counterReader(seen: number[]): PluginDefinition {
  return {
    id: 'test.reader',
    version: '1.0.0',
    requires: [{ capability: counterCap('1.0.0'), range: '^1.0.0' }],
    setup: (ctx) => {
      seen.push(ctx.require(counterCap('1.0.0')).count);
    },
  };
}

describe('state migration across replacement', () => {
  it('migrate carries previous state into the new generation and owns the final value', async () => {
    const runtime = createRuntime();
    const seen: number[] = [];
    const box: { state: { count: number } } = { state: { count: -1 } };
    runtime.install(counterV1((state) => (box.state = state), { stateVersion: '1' }));
    await runtime.start('test.store');
    runtime.install(counterReader(seen));
    await runtime.start('test.reader');
    expect(seen).toEqual([0]);

    // The old generation accumulates live state while serving.
    box.state.count = 41;

    let observed: MigrationPrevious | undefined;
    await runtime.replace({
      id: 'test.store',
      version: '2.0.0',
      stateVersion: '2',
      provides: [{ capability: counterCap('1.0.0') }],
      setup: (ctx) => {
        // The fresh generation starts empty...
        ctx.provide(counterCap('1.0.0'), { count: 0 });
      },
      migrate: (previous, ctx) => {
        observed = previous;
        const oldCounter = previous.provided.get('test.counter') as { count: number };
        // ...but migration owns the final published value: carry the old
        // count over, overwriting what setup staged.
        ctx.provide(counterCap('1.0.0'), { count: oldCounter.count + 1 });
      },
    });

    expect(observed?.pluginId).toBe('test.store');
    expect(observed?.generation).toMatch(/^test\.store#/);
    expect(observed?.version).toBe('1.0.0');
    expect(observed?.stateVersion).toBe('1');
    // The rebound reader sees the migrated value, not setup's fresh zero.
    expect(seen).toEqual([0, 42]);
    expect(runtime.getStatus('test.store')).toBe('active');
  });

  it('a throwing migrate fails the replacement; the old generation keeps serving', async () => {
    const runtime = createRuntime();
    const seen: number[] = [];
    const box: { state: { count: number } } = { state: { count: -1 } };
    runtime.install(counterV1((state) => (box.state = state)));
    await runtime.start('test.store');
    runtime.install(counterReader(seen));
    await runtime.start('test.reader');
    box.state.count = 7;

    const disposed: string[] = [];
    const error = await expectMoltRejection(
      runtime.replace({
        id: 'test.store',
        version: '2.0.0',
        provides: [{ capability: counterCap('1.0.0') }],
        setup: async (ctx) => {
          await ctx.scope.acquire(
            () => ({ handle: 1 }),
            () => {
              disposed.push('setup-resource');
            },
          );
          ctx.provide(counterCap('1.0.0'), { count: 0 });
        },
        migrate: async (previous, ctx) => {
          // The hook runs inside the candidate's scope: resources it
          // acquires are cleaned up when migration fails.
          await ctx.scope.acquire(
            () => ({ handle: 2 }),
            () => {
              disposed.push('migrate-resource');
            },
          );
          expect(previous.provided.get('test.counter')).toBe(box.state);
          throw new Error('injected migration fault');
        },
      }),
      'REPLACEMENT_FAILED',
    );
    expect(String(error.cause)).toContain('injected migration fault');

    // Both candidate scopes tore down, in reverse preparation order.
    expect(disposed).toEqual(['migrate-resource', 'setup-resource']);
    // The old generation never stopped serving its state.
    expect(runtime.getStatus('test.store')).toBe('active');
    expect(runtime.getStatus('test.reader')).toBe('active');
    expect(seen).toEqual([0]);
    box.state.count = 8;
    // A failed replacement leaves no trace: a retry without the fault works.
    await runtime.replace({
      id: 'test.store',
      version: '2.0.0',
      provides: [{ capability: counterCap('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(counterCap('1.0.0'), { count: 0 });
      },
      migrate: (previous, ctx) => {
        const oldCounter = previous.provided.get('test.counter') as { count: number };
        ctx.provide(counterCap('1.0.0'), { count: oldCounter.count });
      },
    });
    expect(seen).toEqual([0, 8]);
  });

  it('migrate runs only on replacement — not on first start or restart', async () => {
    const runtime = createRuntime();
    let migrateCalls = 0;
    const definition: PluginDefinition = {
      id: 'test.store',
      version: '1.0.0',
      provides: [{ capability: counterCap('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(counterCap('1.0.0'), { count: 0 });
      },
      migrate: () => {
        migrateCalls += 1;
      },
    };
    runtime.install(definition);
    await runtime.start('test.store');
    expect(migrateCalls).toBe(0);
    await runtime.stop('test.store');
    await runtime.start('test.store');
    expect(migrateCalls).toBe(0);
    await runtime.replace({ ...definition, version: '1.0.1' });
    expect(migrateCalls).toBe(1);
  });

  it('migrate can switch on the previous stateVersion independently of the plugin version', async () => {
    const runtime = createRuntime();
    const seen: number[] = [];
    const box: { state: { count: number } } = { state: { count: -1 } };
    runtime.install(counterV1((state) => (box.state = state), { stateVersion: 'legacy-shape' }));
    await runtime.start('test.store');
    runtime.install(counterReader(seen));
    await runtime.start('test.reader');
    box.state.count = 10;

    let observedVersion: string | undefined;
    let observedStateVersion: string | undefined = 'unset';
    await runtime.replace({
      id: 'test.store',
      // Plugin version moved two minors; the state schema is what matters.
      version: '1.2.0',
      stateVersion: 'new-shape',
      provides: [{ capability: counterCap('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(counterCap('1.0.0'), { count: -1 });
      },
      migrate: (previous, ctx) => {
        observedVersion = previous.version;
        observedStateVersion = previous.stateVersion;
        const oldCounter = previous.provided.get('test.counter') as { count: number };
        const count = previous.stateVersion === 'legacy-shape' ? oldCounter.count : -1;
        ctx.provide(counterCap('1.0.0'), { count });
      },
    });

    expect(observedVersion).toBe('1.0.0');
    expect(observedStateVersion).toBe('legacy-shape');
    expect(seen).toEqual([0, 10]);
  });

  it("a rebound dependent's migrate carries its own previous state", async () => {
    const runtime = createRuntime();
    const seenLabels: string[] = [];
    runtime.install({
      id: 'test.base',
      version: '1.0.0',
      provides: [{ capability: otherCap('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(otherCap('1.0.0'), { tag: 'base-v1' });
      },
    });
    await runtime.start('test.base');

    let observedByDependent: MigrationPrevious | undefined;
    const dependentStates: { label: string }[] = [];
    runtime.install({
      id: 'test.dependent',
      version: '1.0.0',
      requires: [{ capability: otherCap('1.0.0'), range: '^1.0.0' }],
      provides: [{ capability: labelCap('1.0.0') }],
      setup: (ctx) => {
        const base = ctx.require(otherCap('1.0.0'));
        const state = { label: `derived-from-${base.tag}` };
        dependentStates.push(state);
        ctx.provide(labelCap('1.0.0'), state);
      },
      migrate: (previous, ctx) => {
        observedByDependent = previous;
        const oldProvided = previous.provided.get('test.label') as { label: string };
        // Carry the dependent's own label forward, annotated.
        ctx.provide(labelCap('1.0.0'), { label: `${oldProvided.label}+migrated` });
      },
    });
    await runtime.start('test.dependent');
    runtime.install({
      id: 'test.reader',
      version: '1.0.0',
      requires: [{ capability: labelCap('1.0.0'), range: '^1.0.0' }],
      setup: (ctx) => {
        seenLabels.push(ctx.require(labelCap('1.0.0')).label);
      },
    });
    await runtime.start('test.reader');
    expect(seenLabels).toEqual(['derived-from-base-v1']);

    // Replacing the provider rebinds the dependent; the dependent's own
    // migrate carries its state — previous is the dependent's generation.
    await runtime.replace({
      id: 'test.base',
      version: '1.0.0',
      provides: [{ capability: otherCap('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(otherCap('1.0.0'), { tag: 'base-v2' });
      },
    });

    expect(observedByDependent?.pluginId).toBe('test.dependent');
    expect(observedByDependent?.version).toBe('1.0.0');
    expect(seenLabels).toEqual(['derived-from-base-v1', 'derived-from-base-v1+migrated']);
    // The old generation's state object was never mutated by migration.
    expect(dependentStates[0]?.label).toBe('derived-from-base-v1');
    expect(dependentStates[1]?.label).toBe('derived-from-base-v2');
  });

  it('previous.provided maps every capability the old generation published', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.multi',
      version: '1.0.0',
      provides: [{ capability: counterCap('1.0.0') }, { capability: labelCap('2.0.0') }],
      setup: (ctx) => {
        ctx.provide(counterCap('1.0.0'), { count: 3 });
        ctx.provide(labelCap('2.0.0'), { label: 'three' });
      },
    });
    await runtime.start('test.multi');

    let keys: string[] = [];
    await runtime.replace({
      id: 'test.multi',
      version: '1.0.1',
      provides: [{ capability: counterCap('1.0.0') }, { capability: labelCap('2.0.0') }],
      setup: (ctx) => {
        ctx.provide(counterCap('1.0.0'), { count: 0 });
        ctx.provide(labelCap('2.0.0'), { label: '' });
      },
      migrate: (previous, ctx) => {
        keys = [...previous.provided.keys()].sort();
        const count = (previous.provided.get('test.counter') as { count: number }).count;
        const label = (previous.provided.get('test.label') as { label: string }).label;
        ctx.provide(counterCap('1.0.0'), { count: count * 2 });
        ctx.provide(labelCap('2.0.0'), { label: `${label}!` });
      },
    });

    expect(keys).toEqual(['test.counter', 'test.label']);
    const inspected = runtime.inspect().plugins.find((plugin) => plugin.id === 'test.multi');
    expect(inspected?.status).toBe('active');
  });

  it('migrate providing an undeclared capability fails the replacement', async () => {
    const runtime = createRuntime();
    const seen: number[] = [];
    runtime.install(counterV1(() => {}));
    await runtime.start('test.store');
    runtime.install(counterReader(seen));
    await runtime.start('test.reader');

    const error = await expectMoltRejection(
      runtime.replace({
        id: 'test.store',
        version: '2.0.0',
        provides: [{ capability: counterCap('1.0.0') }],
        setup: (ctx) => {
          ctx.provide(counterCap('1.0.0'), { count: 0 });
        },
        migrate: (_previous, ctx) => {
          ctx.provide(otherCap('1.0.0'), { tag: 'undeclared' });
        },
      }),
      'REPLACEMENT_FAILED',
    );
    expect(String(error.cause)).toContain('provided undeclared capability');
    expect(runtime.getStatus('test.store')).toBe('active');
    expect(seen).toEqual([0]);
  });

  it('an async migrate is awaited before commit', async () => {
    const runtime = createRuntime();
    runtime.install(counterV1(() => {}));
    await runtime.start('test.store');

    const gate = createDeferred<void>();
    let committed = false;
    runtime.subscribe((event) => {
      if (event.type === 'replaced' && event.pluginId === 'test.store') {
        committed = true;
      }
    });

    const replacement = runtime.replace({
      id: 'test.store',
      version: '2.0.0',
      provides: [{ capability: counterCap('1.0.0') }],
      setup: (ctx) => {
        ctx.provide(counterCap('1.0.0'), { count: 0 });
      },
      migrate: async (_previous, ctx) => {
        await gate.promise;
        ctx.provide(counterCap('1.0.0'), { count: 99 });
      },
    });
    // Let the transaction reach the migrate hook.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toBe(false);
    gate.resolve();
    await replacement;
    expect(committed).toBe(true);
    expect(runtime.getStatus('test.store')).toBe('active');
  });

  it('invalid stateVersion is rejected at install', () => {
    const runtime = createRuntime();
    let threw = false;
    try {
      runtime.install({
        id: 'test.bad',
        version: '1.0.0',
        stateVersion: 42 as unknown as string,
        provides: [{ capability: counterCap('1.0.0') }],
        setup: (ctx) => {
          ctx.provide(counterCap('1.0.0'), { count: 0 });
        },
      });
    } catch (error) {
      threw = isMoltError(error) && error.code === 'INVALID_DEFINITION';
    }
    expect(threw).toBe(true);
  });
});

describe('migrate hook safety', () => {
  it('lifecycle calls from migrate fail explicitly instead of deadlocking', async () => {
    const runtime = createRuntime();
    runtime.install(counterV1(() => {}));
    await runtime.start('test.store');

    // The plugin is transaction-owned: the public guard rejects the
    // self-stop loudly instead of queueing behind the in-flight
    // transaction and deadlocking.
    const error = await expectMoltRejection(
      runtime.replace({
        id: 'test.store',
        version: '2.0.0',
        provides: [{ capability: counterCap('1.0.0') }],
        setup: (ctx) => {
          ctx.provide(counterCap('1.0.0'), { count: 0 });
        },
        migrate: () => runtime.stop('test.store'),
      }),
      'REPLACEMENT_FAILED',
    );
    expect(isMoltError(error.cause) ? error.cause.code : undefined).toBe('INVALID_STATE');
    expect(String(error.cause)).toContain('being rebound by an in-flight replacement');
    expect(runtime.getStatus('test.store')).toBe('active');
  });
});
