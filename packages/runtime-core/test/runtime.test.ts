// Runtime engine tests. Complements the replacement-contract tests, which
// cover the failure transaction paths.

import type { PluginDefinition, RuntimeInspection } from '../src/index.js';
import { capability, contributionKey } from '../src/index.js';
import { createRuntime } from '../src/index.js';
import { isMoltError, MoltError } from '../src/index.js';
import { createDeferred } from '../src/internal/async.js';

const storage = capability<{ read(): number }>('test.storage', '1.0.0');
const multi = capability<readonly { name: string }[]>('test.multi', '1.0.0', { multiple: true });
const widget = contributionKey<{ id: string }>('test.ui.widget');

function expectCode(error: unknown, code: MoltError['code']): MoltError {
  if (!isMoltError(error)) {
    throw new Error(`expected MoltError(${code}), got: ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}

function providerPlugin(overrides: {
  id?: string;
  version?: string;
  setup?: PluginDefinition['setup'];
  provides?: PluginDefinition['provides'];
}): PluginDefinition {
  return {
    id: 'test.provider',
    version: '1.0.0',
    provides: [{ capability: storage }],
    setup: (ctx) => {
      ctx.provide(storage, { read: () => 1 });
    },
    ...overrides,
  };
}

describe('install validation and freezing', () => {
  it('validates definitions and rejects duplicates with DUPLICATE_PLUGIN', () => {
    const runtime = createRuntime();
    runtime.install(providerPlugin({}));
    expect(() => runtime.install(providerPlugin({}))).toThrow(MoltError);
    let thrown: unknown;
    try {
      runtime.install(providerPlugin({}));
    } catch (error) {
      thrown = error;
    }
    expectCode(thrown, 'DUPLICATE_PLUGIN');
  });

  it('rejects invalid definitions before anything is recorded', () => {
    const runtime = createRuntime();
    expectCode(
      (() => {
        try {
          runtime.install({ id: 'Bad.Id', version: '1.0.0', setup: () => undefined });
        } catch (error) {
          return error;
        }
        return undefined;
      })(),
      'INVALID_DEFINITION',
    );
    expect(runtime.inspect().plugins).toEqual([]);
  });

  it('freezes the definition at install — mutation fails loudly', () => {
    const runtime = createRuntime();
    const definition = providerPlugin({});
    runtime.install(definition);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(() => {
      (definition as { version: string }).version = '2.0.0';
    }).toThrow(TypeError);
  });

  it('rejects a plugin providing a host-held token with AMBIGUOUS_PROVIDER', () => {
    const runtime = createRuntime({
      providers: [{ capability: storage, value: { read: () => 0 } }],
    });
    let thrown: unknown;
    try {
      runtime.install(providerPlugin({}));
    } catch (error) {
      thrown = error;
    }
    expectCode(thrown, 'AMBIGUOUS_PROVIDER');
  });
});

describe('start lifecycle and events (INV-06)', () => {
  it('traverses installed → preparing → active and emits exactly one immutable snapshot per event', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'started' && event.pluginId === 'test.provider') {
        events.push(event.type);
        // Immutability: mutation attempts on the snapshot must not affect the runtime.
        (event as { type: string }).type = 'tampered';
      }
    });
    runtime.install(providerPlugin({}));
    await runtime.start('test.provider');
    expect(events).toEqual(['started']);
    expect(runtime.getStatus('test.provider')).toBe('active');
    const inspected = runtime.inspect();
    expect(inspected.plugins[0]?.status).toBe('active');
    expect(inspected.plugins[0]?.generation).toBeDefined();
    expect(inspected.capabilities).toEqual([
      { id: 'test.storage', provider: 'test.provider', version: '1.0.0' },
    ]);
  });

  it('setup providing an undeclared capability → ACTIVATION_FAILED, resources disposed (INV-01)', async () => {
    const runtime = createRuntime();
    let released = 0;
    runtime.install({
      id: 'test.cheat',
      version: '1.0.0',
      setup: async (ctx) => {
        await ctx.scope.acquire(
          () => ({ id: 1 }),
          () => {
            released += 1;
          },
        );
        ctx.provide(storage, { read: () => 1 }); // not declared
      },
    });
    const error = expectCode(await rejectionOf(runtime.start('test.cheat')), 'ACTIVATION_FAILED');
    expect(error.pluginId).toBe('test.cheat');
    expect(released).toBe(1);
    expect(runtime.getStatus('test.cheat')).toBe('stopped');
  });

  it('a declared provide that is never published → ACTIVATION_FAILED', async () => {
    const runtime = createRuntime();
    runtime.install(providerPlugin({ setup: () => undefined })); // declares storage, publishes nothing
    const error = expectCode(
      await rejectionOf(runtime.start('test.provider')),
      'ACTIVATION_FAILED',
    );
    expect(error.details?.['reason']).toBe('declared-not-published');
  });

  it('require of an undeclared token is INVALID_STATE — INV-09 holds for JS consumers', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.sniffer',
      version: '1.0.0',
      setup: (ctx) => {
        // Bypass the type system the way a JS consumer would: a token that is
        // structurally valid but NOT declared by this plugin.
        const forged = {
          id: 'test.undeclared',
          version: '1.0.0',
          multiple: false,
        } as typeof storage;
        ctx.require(forged);
      },
    });
    const error = expectCode(await rejectionOf(runtime.start('test.sniffer')), 'INVALID_STATE');
    expect(error.details?.['reason']).toBe('undeclared-requirement');
  });

  it('staged provides and contributions are invisible until commit (INV-06)', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.stager',
      version: '1.0.0',
      provides: [{ capability: storage }],
      setup: (ctx) => {
        ctx.provide(storage, { read: () => 1 });
        ctx.contribute(widget, { id: 'w1' });
        // Snapshot taken during setup must not see this generation's state.
        const mid = runtime.inspect();
        expect(mid.capabilities).toEqual([]);
        expect(runtime.contributions().entries.size).toBe(0);
      },
    });
    await runtime.start('test.stager');
    expect(runtime.inspect().capabilities).toHaveLength(1);
    const generationId = runtime.inspect().plugins.find((p) => p.id === 'test.stager')?.generation;
    const widgetEntries = runtime.contributions().entries.get('test.ui.widget');
    expect(widgetEntries).toEqual([{ generationId, pluginId: 'test.stager', value: { id: 'w1' } }]);
  });

  it('multi-provider requirements resolve to every selected provider in documented order', async () => {
    const runtime = createRuntime({
      providers: [{ capability: multi, value: [{ name: 'host' }] }],
    });
    let seen: readonly { name: string }[] | undefined;
    runtime.install({
      id: 'test.consumer',
      version: '1.0.0',
      requires: [{ capability: multi, range: '*' }],
      setup: (ctx) => {
        seen = ctx.require(multi);
      },
    });
    runtime.install(
      providerPlugin({
        id: 'test.plugin',
        provides: [{ capability: multi }],
        setup: (ctx) => {
          ctx.provide(multi, [{ name: 'plugin' }]);
        },
      }),
    );
    await runtime.start('test.consumer');
    expect(seen?.map((value) => value.name)).toEqual(['host', 'plugin']);
  });
});

describe('contribution ownership', () => {
  it('a candidate generation claiming an unrelated generation’s contribution id fails validation', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.owner',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.contribute(widget, { id: 'owned' });
      },
    });
    await runtime.start('test.owner');
    runtime.install({
      id: 'test.claimant',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.contribute(widget, { id: 'stolen' });
      },
    });
    const error = expectCode(
      await rejectionOf(runtime.start('test.claimant')),
      'ACTIVATION_FAILED',
    );
    expect(error.details?.['reason']).toBe('contribution-conflict');
    expect(runtime.getStatus('test.claimant')).toBe('stopped');
    expect(runtime.getStatus('test.owner')).toBe('active');
  });
});

describe('stop, cascade, and uninstall (INV-11)', () => {
  it('stop with active dependents → ACTIVE_DEPENDENTS with the dependent path; zero state change', async () => {
    const runtime = createRuntime();
    runtime.install(providerPlugin({}));
    await runtime.start('test.provider');
    runtime.install({
      id: 'test.consumer',
      version: '1.0.0',
      requires: [{ capability: storage, range: '^1.0.0' }],
      setup: () => undefined,
    });
    await runtime.start('test.consumer');
    const before: RuntimeInspection = runtime.inspect();

    const error = expectCode(await rejectionOf(runtime.stop('test.provider')), 'ACTIVE_DEPENDENTS');
    expect(error.path).toContain('test.consumer');
    expect(runtime.inspect()).toEqual(before);
  });

  it('cascade stop is recorded and restart stays explicit (no auto-restart)', async () => {
    const runtime = createRuntime();
    runtime.install(providerPlugin({}));
    runtime.install({
      id: 'test.consumer',
      version: '1.0.0',
      requires: [{ capability: storage, range: '^1.0.0' }],
      setup: () => undefined,
    });
    await runtime.start('test.consumer');

    const stopped: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'stopped') {
        stopped.push(event.pluginId ?? '');
      }
    });
    await runtime.stop('test.provider', { cascade: true });
    expect(stopped).toEqual(['test.consumer', 'test.provider']);
    expect(runtime.getStatus('test.provider')).toBe('stopped');
    expect(runtime.getStatus('test.consumer')).toBe('stopped');
    expect(runtime.inspect().capabilities).toEqual([]);

    await runtime.start('test.provider');
    expect(runtime.getStatus('test.provider')).toBe('active');
    expect(runtime.getStatus('test.consumer')).toBe('stopped'); // explicit restart only
  });

  it('uninstall rules: active → INVALID_STATE; stopped → removed; missing → INVALID_STATE', async () => {
    const runtime = createRuntime();
    runtime.install(providerPlugin({}));
    await runtime.start('test.provider');
    expectCode(await rejectionOf(runtime.uninstall('test.provider')), 'INVALID_STATE');

    await runtime.stop('test.provider');
    await runtime.uninstall('test.provider');
    expect(runtime.getStatus('test.provider')).toBeUndefined();
    expect(runtime.inspect().plugins).toEqual([]);

    expectCode(await rejectionOf(runtime.uninstall('test.provider')), 'INVALID_STATE');
    expectCode(await rejectionOf(runtime.start('test.provider')), 'INVALID_STATE');
    expectCode(await rejectionOf(runtime.replace(providerPlugin({}))), 'INVALID_STATE');
  });

  it('start of a never-installed id is INVALID_STATE (reason not-installed)', async () => {
    const runtime = createRuntime();
    const error = expectCode(await rejectionOf(runtime.start('test.ghost')), 'INVALID_STATE');
    expect(error.details?.['reason']).toBe('not-installed');
  });
});

describe('independent instances and observer safety (INV-13)', () => {
  it('two runtimes in one process share nothing', async () => {
    const a = createRuntime();
    const b = createRuntime();
    a.install(providerPlugin({}));
    await a.start('test.provider');
    expect(a.getStatus('test.provider')).toBe('active');
    expect(b.getStatus('test.provider')).toBeUndefined();
    expect(b.inspect().plugins).toEqual([]);
    expect(a.inspect().capabilities).toHaveLength(1);
    expect(b.inspect().capabilities).toHaveLength(0);
  });

  it('a throwing observer becomes a diagnostic; the lifecycle outcome is unchanged', async () => {
    const runtime = createRuntime();
    runtime.subscribe(() => {
      throw new Error('observer blew up');
    });
    runtime.install(providerPlugin({}));
    await runtime.start('test.provider');
    expect(runtime.getStatus('test.provider')).toBe('active');
  });

  it('synchronous re-entry from an observer for the same plugin is rejected (INVALID_STATE)', () => {
    const runtime = createRuntime();
    let syncError: unknown;
    runtime.subscribe((event) => {
      if (event.type === 'started' && event.pluginId === 'test.provider') {
        try {
          // Sync-throw expected; if it ever resolved instead, the assertions
          // below fail — the void operator documents the intent.
          void runtime.stop('test.provider');
        } catch (error) {
          syncError = error; // rejected at call time, synchronously
        }
      }
    });
    runtime.install(providerPlugin({}));
    // start() itself must not be corrupted by the rejected re-entrant stop.
    const outcome = runtime.start('test.provider').then(
      () => 'started' as const,
      (error: unknown) => error,
    );
    return outcome.then((result) => {
      expect(result).toBe('started');
      expectCode(syncError, 'INVALID_STATE');
      expect(runtime.getStatus('test.provider')).toBe('active');
    });
  });

  it('provider startup while the provider queue is busy waits on the tail', async () => {
    const runtime = createRuntime();
    const order: string[] = [];
    const gate = createDeferred<void>();
    runtime.install(
      providerPlugin({
        setup: async (ctx) => {
          await gate.promise;
          ctx.provide(storage, { read: () => 1 });
          order.push('provider-done');
        },
      }),
    );
    runtime.install({
      id: 'test.consumer',
      version: '1.0.0',
      requires: [{ capability: storage, range: '^1.0.0' }],
      setup: () => {
        order.push('consumer-done');
      },
    });
    const starting = Promise.all([runtime.start('test.provider'), runtime.start('test.consumer')]);
    gate.resolve();
    await starting;
    expect(order).toEqual(['provider-done', 'consumer-done']);
  });

  it('runtime.dispose stops generations in reverse activation order; second call is a no-op', async () => {
    const runtime = createRuntime();
    const disposed: string[] = [];
    runtime.install(
      providerPlugin({
        setup: (ctx) => {
          ctx.scope.onDispose(() => {
            disposed.push('provider');
          });
          ctx.provide(storage, { read: () => 1 });
        },
      }),
    );
    runtime.install({
      id: 'test.consumer',
      version: '1.0.0',
      requires: [{ capability: storage, range: '^1.0.0' }],
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          disposed.push('consumer');
        });
      },
    });
    await runtime.start('test.consumer');

    await runtime.dispose();
    await runtime.dispose();
    expect(disposed).toEqual(['consumer', 'provider']);
    expect(runtime.getStatus('test.provider')).toBe('stopped');

    expectCode(await rejectionOf(runtime.start('test.provider')), 'INVALID_STATE');
  });
});
