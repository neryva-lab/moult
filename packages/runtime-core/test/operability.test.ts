// Focused tests for the release-1.0 operability surface: configuration,
// lifecycle timeouts, the drain hook, health checks, and public rollback.

import type { HealthStatus, PluginDefinition } from '../src/index.js';
import { createRuntime } from '../src/index.js';
import { isMoltError } from '../src/index.js';

function expectCode(error: unknown, code: string): void {
  if (!isMoltError(error)) {
    throw new Error(`expected MoltError(${code}), got: ${String(error)}`);
  }
  expect(error.code).toBe(code);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('configuration', () => {
  it('merges install overrides over definition defaults and freezes the result', async () => {
    const runtime = createRuntime();
    let seen: unknown;
    const definition: PluginDefinition = {
      id: 'test.configured',
      version: '1.0.0',
      config: { retries: 1, mode: 'fast' },
      setup: (ctx) => {
        seen = ctx.config;
      },
    };
    runtime.install(definition, { config: { retries: 5 } });
    await runtime.start('test.configured');
    expect(seen).toEqual({ retries: 5, mode: 'fast' });
    expect(Object.isFrozen(seen)).toBe(true);
    await runtime.dispose();
  });

  it('rejects install when validateConfig fails, installing nothing', () => {
    const runtime = createRuntime();
    const definition: PluginDefinition = {
      id: 'test.badconfig',
      version: '1.0.0',
      config: { retries: 1 },
      validateConfig: (config) => {
        if ((config['retries'] as number) > 3) {
          return ['retries must be at most 3'];
        }
        return [];
      },
      setup: () => {},
    };
    expect(() => runtime.install(definition, { config: { retries: 99 } })).toThrowError(
      /retries must be at most 3/,
    );
    expect(runtime.getStatus('test.badconfig')).toBeUndefined();
  });

  it('updateConfig affects only later generations; the active one keeps its frozen config', async () => {
    const runtime = createRuntime();
    const seen: unknown[] = [];
    const definition: PluginDefinition = {
      id: 'test.reconfig',
      version: '1.0.0',
      config: { level: 1 },
      setup: (ctx) => {
        seen.push(ctx.config);
      },
    };
    runtime.install(definition);
    await runtime.start('test.reconfig');
    expect(seen[0]).toEqual({ level: 1 });

    runtime.updateConfig('test.reconfig', { level: 2 });
    // Active generation is untouched.
    expect(seen).toHaveLength(1);

    await runtime.replace({ ...definition, version: '1.0.1' });
    expect(seen[1]).toEqual({ level: 2 });
    await runtime.dispose();
  });

  it('replace carries user overrides onto the new definition defaults', async () => {
    const runtime = createRuntime();
    const seen: unknown[] = [];
    const v1: PluginDefinition = {
      id: 'test.carry',
      version: '1.0.0',
      config: { a: 1, b: 1 },
      setup: (ctx) => {
        seen.push(ctx.config);
      },
    };
    runtime.install(v1, { config: { b: 2 } });
    await runtime.start('test.carry');
    expect(seen[0]).toEqual({ a: 1, b: 2 });

    const v2: PluginDefinition = { ...v1, version: '2.0.0', config: { a: 10, b: 10, c: 10 } };
    await runtime.replace(v2);
    // New defaults merged with the retained user override for b.
    expect(seen[1]).toEqual({ a: 10, b: 2, c: 10 });
    await runtime.dispose();
  });

  it('rejects a non-record install config', () => {
    const runtime = createRuntime();
    const definition: PluginDefinition = {
      id: 'test.configshape',
      version: '1.0.0',
      setup: () => {},
    };
    for (const bad of ['nope', 42, ['a'], null]) {
      expect(() =>
        runtime.install(definition, { config: bad as unknown as Record<string, unknown> }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_DEFINITION' }));
    }
    expect(runtime.getStatus('test.configshape')).toBeUndefined();
  });

  it('hands validateConfig a frozen merged config', () => {
    const runtime = createRuntime();
    const seen: boolean[] = [];
    const definition: PluginDefinition = {
      id: 'test.frozenvalidate',
      version: '1.0.0',
      config: { a: 1 },
      validateConfig: (config) => {
        seen.push(Object.isFrozen(config));
        return [];
      },
      setup: () => {},
    };
    runtime.install(definition, { config: { b: 2 } });
    expect(seen).toEqual([true]);
    // A failed updateConfig also validates the frozen merge and changes nothing.
    const seen2: boolean[] = [];
    const strict: PluginDefinition = {
      id: 'test.frozenvalidate2',
      version: '1.0.0',
      validateConfig: (config) => {
        seen2.push(Object.isFrozen(config));
        return (config['n'] as number) > 1 ? ['too big'] : [];
      },
      setup: () => {},
    };
    runtime.install(strict, { config: { n: 1 } });
    expect(() => runtime.updateConfig('test.frozenvalidate2', { n: 2 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
    expect(seen2).toEqual([true, true]);
  });
});

describe('lifecycle timeouts', () => {
  it('setup timeout fails start with SETUP_TIMEOUT and aborts the candidate', async () => {
    const runtime = createRuntime({ timeouts: { setupMs: 30 } });
    let aborted = false;
    runtime.install({
      id: 'test.slowsetup',
      version: '1.0.0',
      setup: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await delay(500);
      },
    });
    const error = await rejectionOf(runtime.start('test.slowsetup'));
    expectCode(error, 'SETUP_TIMEOUT');
    expect(runtime.getStatus('test.slowsetup')).toBe('stopped');
    // The timed-out candidate scope is disposed, aborting its signal.
    expect(aborted).toBe(true);
    await runtime.dispose();
  });

  it('per-operation timeoutMs overrides the runtime default', async () => {
    const runtime = createRuntime({ timeouts: { setupMs: 5000 } });
    runtime.install({
      id: 'test.slowop',
      version: '1.0.0',
      setup: async () => {
        await delay(200);
      },
    });
    const error = await rejectionOf(runtime.start('test.slowop', { timeoutMs: 30 }));
    expectCode(error, 'SETUP_TIMEOUT');
    await runtime.dispose();
  });

  it('disposal timeout records DISPOSAL_TIMEOUT on the plugin record', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.slowdispose',
      version: '1.0.0',
      setup: () => ({
        dispose: async () => {
          await delay(500);
        },
      }),
    });
    await runtime.start('test.slowdispose');
    // Stop with a tight disposal budget; the plugin still stops.
    await runtime.stop('test.slowdispose', { timeoutMs: 30 });
    expect(runtime.getStatus('test.slowdispose')).toBe('stopped');
    const plugin = runtime.inspect().plugins.find((p) => p.id === 'test.slowdispose');
    expect(plugin?.error).toBeDefined();
    if (isMoltError(plugin?.error)) {
      expect(plugin.error.code).toBe('DISPOSAL_TIMEOUT');
    } else {
      throw new Error('expected a MoltError on the record');
    }
    await runtime.dispose();
  });
});

describe('drain hook', () => {
  it('runs drain before disposal when its generation is retired', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    const v1: PluginDefinition = {
      id: 'test.drainable',
      version: '1.0.0',
      setup: () => ({
        dispose: () => {
          events.push('dispose-v1');
        },
      }),
      drain: () => {
        events.push('drain-v1');
      },
    };
    runtime.install(v1);
    await runtime.start('test.drainable');
    await runtime.replace({ ...v1, version: '1.0.1' });
    expect(events).toEqual(['drain-v1', 'dispose-v1']);
    await runtime.dispose();
  });

  it('drain timeout aborts the drain but the replacement still commits', async () => {
    const runtime = createRuntime({ timeouts: { drainMs: 30 } });
    let drained = false;
    let activeVersion = '';
    const v1: PluginDefinition = {
      id: 'test.draintimeout',
      version: '1.0.0',
      setup: () => {
        activeVersion = '1.0.0';
      },
      drain: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        drained = true;
      },
    };
    runtime.install(v1);
    await runtime.start('test.draintimeout');
    await runtime.replace({
      ...v1,
      version: '1.0.1',
      setup: () => {
        activeVersion = '1.0.1';
      },
    });
    // Replacement succeeded despite the drain overrunning its budget.
    expect(activeVersion).toBe('1.0.1');
    expect(drained).toBe(true); // the abort signal fired
    await runtime.dispose();
  });
});

describe('health checks', () => {
  it('an unhealthy start rolls back with ACTIVATION_FAILED', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.subscribe((event) => events.push(event.type));
    runtime.install({
      id: 'test.unhealthy',
      version: '1.0.0',
      setup: () => {},
      healthCheck: (): HealthStatus => ({ ok: false, message: 'not ready' }),
    });
    const error = await rejectionOf(runtime.start('test.unhealthy'));
    expectCode(error, 'ACTIVATION_FAILED');
    expect(runtime.getStatus('test.unhealthy')).toBe('stopped');
    // started was emitted at commit, stopped balances it on rollback.
    expect(events).toEqual(['installed', 'started', 'stopped', 'failed']);
    await runtime.dispose();
  });

  it('an unhealthy replacement rolls back to the old generation', async () => {
    const runtime = createRuntime();
    const { capability } = await import('../src/index.js');
    const versionCap = capability<{ version: string }>('test.vercap', '1.0.0');
    const v1: PluginDefinition = {
      id: 'test.healthreplace',
      version: '1.0.0',
      provides: [{ capability: versionCap }],
      setup: (ctx) => {
        ctx.provide(versionCap, { version: '1.0.0' });
      },
      healthCheck: (): HealthStatus => ({ ok: true }),
    };
    let seenVersion = '';
    const consumer: PluginDefinition = {
      id: 'test.healthconsumer',
      version: '1.0.0',
      requires: [{ capability: versionCap, range: '^1.0.0' }],
      setup: (ctx) => {
        seenVersion = ctx.require(versionCap).version;
      },
    };
    runtime.install(v1);
    runtime.install(consumer);
    await runtime.start('test.healthreplace');
    await runtime.start('test.healthconsumer');
    expect(seenVersion).toBe('1.0.0');
    const error = await rejectionOf(
      runtime.replace({
        ...v1,
        version: '2.0.0',
        setup: (ctx) => {
          ctx.provide(versionCap, { version: '2.0.0' });
        },
        healthCheck: (): HealthStatus => ({ ok: false, message: 'v2 broken' }),
      }),
    );
    expectCode(error, 'REPLACEMENT_FAILED');
    // The old generation is still active and serving v1.
    expect(runtime.getStatus('test.healthreplace')).toBe('active');
    // Rebind the consumer to observe the restored provider.
    await runtime.stop('test.healthconsumer');
    await runtime.start('test.healthconsumer');
    expect(seenVersion).toBe('1.0.0');
    await runtime.dispose();
  });

  it('checkHealth reports the on-demand status without acting on it', async () => {
    const runtime = createRuntime();
    let healthy = true;
    runtime.install({
      id: 'test.probe',
      version: '1.0.0',
      setup: () => {},
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false, message: 'sick' }),
    });
    await runtime.start('test.probe');
    expect(await runtime.checkHealth('test.probe')).toEqual({ ok: true });
    healthy = false;
    expect(await runtime.checkHealth('test.probe')).toEqual({ ok: false, message: 'sick' });
    // Still active — the probe never acts.
    expect(runtime.getStatus('test.probe')).toBe('active');
    await runtime.dispose();
  });

  it('a health check timeout counts as unhealthy', async () => {
    const runtime = createRuntime({ timeouts: { healthMs: 30 } });
    runtime.install({
      id: 'test.healthtimeout',
      version: '1.0.0',
      setup: () => {},
      healthCheck: async () => {
        await delay(500);
        return { ok: true };
      },
    });
    const error = await rejectionOf(runtime.start('test.healthtimeout'));
    expectCode(error, 'ACTIVATION_FAILED');
    await runtime.dispose();
  });
});

describe('public rollback', () => {
  it('rolls back to the previous definition through the replacement pipeline', async () => {
    const runtime = createRuntime();
    const versions: string[] = [];
    const v1: PluginDefinition = {
      id: 'test.rollback',
      version: '1.0.0',
      setup: () => {
        versions.push('1.0.0');
      },
    };
    runtime.install(v1);
    await runtime.start('test.rollback');
    await runtime.replace({
      ...v1,
      version: '2.0.0',
      setup: () => {
        versions.push('2.0.0');
      },
    });
    expect(versions).toEqual(['1.0.0', '2.0.0']);

    await runtime.rollback('test.rollback');
    expect(versions).toEqual(['1.0.0', '2.0.0', '1.0.0']);
    await runtime.dispose();
  });

  it('throws when there is no replacement history', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.norollback', version: '1.0.0', setup: () => {} });
    await runtime.start('test.norollback');
    let error: unknown;
    try {
      void runtime.rollback('test.norollback');
    } catch (e) {
      error = e;
    }
    expectCode(error, 'INVALID_STATE');
    await runtime.dispose();
  });

  it('a rollback pops history, so consecutive rollbacks walk back through versions', async () => {
    const runtime = createRuntime();
    let activeVersion = '';
    const track = (version: string): PluginDefinition => ({
      id: 'test.walkback',
      version,
      setup: () => {
        activeVersion = version;
      },
    });
    runtime.install(track('1.0.0'));
    await runtime.start('test.walkback');
    await runtime.replace(track('2.0.0'));
    await runtime.replace(track('3.0.0'));
    expect(activeVersion).toBe('3.0.0');

    await runtime.rollback('test.walkback');
    expect(activeVersion).toBe('2.0.0');
    await runtime.rollback('test.walkback');
    expect(activeVersion).toBe('1.0.0');

    let error: unknown;
    try {
      void runtime.rollback('test.walkback');
    } catch (e) {
      error = e;
    }
    expectCode(error, 'INVALID_STATE');
    await runtime.dispose();
  });
});
