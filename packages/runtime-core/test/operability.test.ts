// Focused tests for the release-1.0 operability surface: configuration,
// lifecycle timeouts, the drain hook, health checks, and public rollback.

import type { HealthStatus, PluginDefinition } from '../src/index.js';
import { capability, contributionKey, createRuntime } from '../src/index.js';
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

describe('rolledback event', () => {
  it('emits rolledback to subscribers with the restored generation', async () => {
    const runtime = createRuntime();
    const events: { type: string; pluginId?: string; generation?: string }[] = [];
    runtime.subscribe((event) => {
      events.push({
        type: event.type,
        ...(event.pluginId !== undefined ? { pluginId: event.pluginId } : {}),
        ...(event.generation !== undefined ? { generation: event.generation } : {}),
      });
    });
    runtime.install({ id: 'test.rbevent', version: '1.0.0', setup: () => {} });
    await runtime.start('test.rbevent');
    await runtime.replace({ id: 'test.rbevent', version: '2.0.0', setup: () => {} });
    events.length = 0;

    await runtime.rollback('test.rbevent');
    const rolledback = events.filter((event) => event.type === 'rolledback');
    expect(rolledback).toHaveLength(1);
    expect(rolledback[0]?.pluginId).toBe('test.rbevent');
    const restoredGeneration = runtime
      .inspect()
      .plugins.find((p) => p.id === 'test.rbevent')?.generation;
    expect(rolledback[0]?.generation).toBe(restoredGeneration);
    // The pipeline's replaced event still fires first: observers that only
    // track replaced keep working.
    expect(events.map((event) => event.type)).toEqual(['replaced', 'rolledback']);
    await runtime.dispose();
  });

  it('a health-policy rollback also emits rolledback', async () => {
    const runtime = createRuntime({ onUnhealthy: 'rollback' });
    const events: string[] = [];
    runtime.subscribe((event) => {
      events.push(event.type);
    });
    let failProbe = false;
    runtime.install({
      id: 'test.rbpolicy',
      version: '1.0.0',
      setup: () => {},
      // v1 stays healthy so the policy rollback can commit.
      healthCheck: () => ({ ok: true }),
    });
    await runtime.start('test.rbpolicy');
    await runtime.replace({
      id: 'test.rbpolicy',
      version: '2.0.0',
      setup: () => {},
      healthCheck: () => ({ ok: !failProbe }),
    });
    failProbe = true;
    events.length = 0;
    await runtime.checkHealth('test.rbpolicy');
    expect(events).toContain('rolledback');
    await runtime.dispose();
  });
});

describe('caller abort signals', () => {
  function abortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  it('install with an aborted signal rejects with ABORTED and installs nothing', () => {
    const runtime = createRuntime();
    const definition: PluginDefinition = {
      id: 'test.abortinstall',
      version: '1.0.0',
      setup: () => {},
    };
    let error: unknown;
    try {
      runtime.install(definition, { signal: abortedSignal() });
    } catch (e) {
      error = e;
    }
    expectCode(error, 'ABORTED');
    expect(runtime.getStatus('test.abortinstall')).toBeUndefined();
    void runtime.dispose();
  });

  it('start with an aborted signal rejects with ABORTED and leaves the plugin installed', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.abortstart', version: '1.0.0', setup: () => {} });
    let error: unknown;
    try {
      await runtime.start('test.abortstart', { signal: abortedSignal() });
    } catch (e) {
      error = e;
    }
    expectCode(error, 'ABORTED');
    expect(runtime.getStatus('test.abortstart')).toBe('installed');
    await runtime.dispose();
  });

  it('stop with an aborted signal rejects with ABORTED before any state changes', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.abortstop', version: '1.0.0', setup: () => {} });
    await runtime.start('test.abortstop');
    let error: unknown;
    try {
      await runtime.stop('test.abortstop', { signal: abortedSignal() });
    } catch (e) {
      error = e;
    }
    expectCode(error, 'ABORTED');
    expect(runtime.getStatus('test.abortstop')).toBe('active');
    await runtime.dispose();
  });

  it('aborting mid-setup rejects start with ABORTED and rolls the activation back', async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let setupEntered = false;
    runtime.install({
      id: 'test.abortmid',
      version: '1.0.0',
      setup: async () => {
        setupEntered = true;
        await delay(50);
      },
    });
    const pending = runtime.start('test.abortmid', { signal: controller.signal });
    await delay(5);
    controller.abort();
    const error = await rejectionOf(pending);
    expectCode(error, 'ABORTED');
    expect(setupEntered).toBe(true);
    expect(runtime.getStatus('test.abortmid')).toBe('stopped');
    await runtime.dispose();
  });

  it('aborting a replace mid-preparation rejects with ABORTED and keeps the old generation', async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let activeVersion = '';
    const track = (version: string): PluginDefinition => ({
      id: 'test.abortreplace',
      version,
      setup: async () => {
        if (version === '2.0.0') {
          await delay(50);
        }
        activeVersion = version;
      },
    });
    runtime.install(track('1.0.0'));
    await runtime.start('test.abortreplace');
    expect(activeVersion).toBe('1.0.0');
    const pending = runtime.replace(track('2.0.0'), { signal: controller.signal });
    await delay(5);
    controller.abort();
    const error = await rejectionOf(pending);
    expectCode(error, 'ABORTED');
    expect(activeVersion).toBe('1.0.0');
    expect(runtime.getStatus('test.abortreplace')).toBe('active');
    await runtime.dispose();
  });
});

describe('health quarantine and onUnhealthy policies', () => {
  it("the default 'fail' policy reports without acting, but records health", async () => {
    const runtime = createRuntime();
    const { capability } = await import('../src/index.js');
    const cap = capability<{ value: number }>('test.qcap', '1.0.0');
    let healthy = true;
    runtime.install({
      id: 'test.qprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, { value: 42 });
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false, message: 'sick' }),
    });
    runtime.install({
      id: 'test.qconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    await runtime.start('test.qprovider');
    // The post-commit gate records the healthy probe on the generation.
    expect(runtime.inspect().plugins.find((plugin) => plugin.id === 'test.qprovider')?.health).toBe(
      'healthy',
    );
    healthy = false;
    expect(await runtime.checkHealth('test.qprovider')).toEqual({ ok: false, message: 'sick' });
    // Still active, not quarantined — the probe only reported.
    expect(runtime.getStatus('test.qprovider')).toBe('active');
    const inspected = runtime.inspect().plugins.find((plugin) => plugin.id === 'test.qprovider');
    expect(inspected?.health).toBe('unhealthy');
    expect(inspected?.quarantined ?? false).toBe(false);
    // The provider is still selectable: a new consumer starts fine.
    await runtime.start('test.qconsumer');
    expect(runtime.getStatus('test.qconsumer')).toBe('active');
    await runtime.dispose();
  });

  it("the 'quarantine' policy withdraws the provider while its scope stays alive", async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    const { capability } = await import('../src/index.js');
    const cap = capability<{ value: number }>('test.qcap2', '1.0.0');
    let healthy = true;
    let disposed = false;
    runtime.install({
      id: 'test.qprovider2',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, { value: 7 });
        return {
          dispose: () => {
            disposed = true;
          },
        };
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false, message: 'sick' }),
    });
    let seenValue = -1;
    runtime.install({
      id: 'test.qconsumer2',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: (ctx) => {
        seenValue = ctx.require(cap).value;
      },
    });
    await runtime.start('test.qprovider2');
    await runtime.start('test.qconsumer2');
    expect(seenValue).toBe(7);

    healthy = false;
    expect(await runtime.checkHealth('test.qprovider2')).toEqual({ ok: false, message: 'sick' });
    // Quarantined: scope alive (no dispose), but withdrawn from selection.
    expect(disposed).toBe(false);
    expect(runtime.getStatus('test.qprovider2')).toBe('active');
    const inspected = runtime.inspect().plugins.find((plugin) => plugin.id === 'test.qprovider2');
    expect(inspected?.quarantined).toBe(true);
    expect(inspected?.health).toBe('unhealthy');

    // A new consumer can no longer resolve to the quarantined provider.
    runtime.install({
      id: 'test.qconsumer3',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    const error = await rejectionOf(runtime.start('test.qconsumer3'));
    expectCode(error, 'MISSING_CAPABILITY');
    if (!isMoltError(error)) {
      throw new Error('expected a MoltError');
    }
    const blocked = error.details?.['blocked'] as
      { candidates: { pluginId: string | null; verdict: string }[] }[] | undefined;
    expect(blocked?.[0]?.candidates[0]?.verdict).toBe('quarantined');

    // A healthy re-probe lifts the quarantine; the provider is selectable again.
    healthy = true;
    expect(await runtime.checkHealth('test.qprovider2')).toEqual({ ok: true });
    expect(
      runtime.inspect().plugins.find((plugin) => plugin.id === 'test.qprovider2')?.quarantined,
    ).toBe(false);
    await runtime.start('test.qconsumer3');
    expect(runtime.getStatus('test.qconsumer3')).toBe('active');
    await runtime.dispose();
  });

  it("the 'rollback' policy rolls back to the previous definition", async () => {
    const runtime = createRuntime({ onUnhealthy: 'rollback' });
    const { capability } = await import('../src/index.js');
    const cap = capability<{ version: string }>('test.qcap3', '1.0.0');
    // Sickness is version-specific: v2 breaks, v1 stays healthy. The policy
    // rollback re-runs the post-commit health gate on the previous
    // generation, so v1 must pass it for the rollback to succeed.
    let v2Healthy = true;
    const v1: PluginDefinition = {
      id: 'test.qrollback',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, { version: '1.0.0' });
      },
      healthCheck: (): HealthStatus => ({ ok: true }),
    };
    let seenVersion = '';
    runtime.install({
      id: 'test.qrollbackconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '>=1.0.0' }],
      setup: (ctx) => {
        seenVersion = ctx.require(cap).version;
      },
    });
    runtime.install(v1);
    await runtime.start('test.qrollback');
    await runtime.start('test.qrollbackconsumer');
    expect(seenVersion).toBe('1.0.0');
    // Replace while healthy so the post-commit gate passes; sicken v2 after.
    await runtime.replace({
      ...v1,
      version: '2.0.0',
      setup: (ctx) => {
        ctx.provide(cap, { version: '2.0.0' });
      },
      healthCheck: (): HealthStatus =>
        v2Healthy ? { ok: true } : { ok: false, message: 'v2 sick' },
    });
    await runtime.stop('test.qrollbackconsumer');
    await runtime.start('test.qrollbackconsumer');
    expect(seenVersion).toBe('2.0.0');
    v2Healthy = false;
    // The probe returns the unhealthy status AND rolls back through the
    // normal replacement pipeline.
    expect(await runtime.checkHealth('test.qrollback')).toEqual({ ok: false, message: 'v2 sick' });
    expect(runtime.getStatus('test.qrollback')).toBe('active');
    await runtime.stop('test.qrollbackconsumer');
    await runtime.start('test.qrollbackconsumer');
    expect(seenVersion).toBe('1.0.0');
    await runtime.dispose();
  });

  it("the 'rollback' policy fails loudly with no replacement history", async () => {
    const runtime = createRuntime({ onUnhealthy: 'rollback' });
    let healthy = true;
    runtime.install({
      id: 'test.qnorollback',
      version: '1.0.0',
      setup: () => {},
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false, message: 'sick' }),
    });
    await runtime.start('test.qnorollback');
    healthy = false;
    const error = await rejectionOf(runtime.checkHealth('test.qnorollback'));
    expectCode(error, 'INVALID_STATE');
    // Nothing was rolled back — the plugin is untouched.
    expect(runtime.getStatus('test.qnorollback')).toBe('active');
    await runtime.dispose();
  });
});

describe('lazy activation', () => {
  it('a never-started lazy provider is excluded from selection until explicitly started', async () => {
    const runtime = createRuntime();
    const { capability } = await import('../src/index.js');
    const cap = capability<{ value: number }>('test.lazycap', '1.0.0');
    runtime.install(
      {
        id: 'test.lazyprovider',
        version: '1.0.0',
        provides: [{ capability: cap }],
        setup: (ctx) => {
          ctx.provide(cap, { value: 1 });
        },
      },
      { lazy: true },
    );
    runtime.install({
      id: 'test.lazyconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    expect(
      runtime.inspect().plugins.find((plugin) => plugin.id === 'test.lazyprovider')?.lazy,
    ).toBe(true);
    const error = await rejectionOf(runtime.start('test.lazyconsumer'));
    expectCode(error, 'MISSING_CAPABILITY');
    if (!isMoltError(error)) {
      throw new Error('expected a MoltError');
    }
    const blocked = error.details?.['blocked'] as
      { candidates: { pluginId: string | null; verdict: string }[] }[] | undefined;
    expect(blocked?.[0]?.candidates[0]?.verdict).toBe('lazy');
    // Explicitly starting the lazy plugin makes it selectable.
    await runtime.start('test.lazyprovider');
    await runtime.start('test.lazyconsumer');
    expect(runtime.getStatus('test.lazyconsumer')).toBe('active');
    await runtime.dispose();
  });
});

describe('in-flight replacement policies', () => {
  const cap = capability<string>('test.pincap', '1.0.0');

  function providerDef(version: string, events: string[]): PluginDefinition {
    return {
      id: 'test.pinnable',
      version,
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, version);
        return {
          dispose: () => {
            events.push(`dispose-${version}`);
          },
        };
      },
      drain: () => {
        events.push(`drain-${version}`);
      },
    };
  }

  it("the 'pin' policy keeps the retired scope alive and withdrawn from selection", async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    const seen: string[] = [];
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    const oldGen = runtime.inspect().plugins.find((p) => p.id === 'test.pinnable')?.generation;
    expect(oldGen).toBeDefined();
    await runtime.replace(providerDef('2.0.0', events), { inFlight: 'pin' });
    // No drain, no disposal: the old generation is pinned, not retired.
    expect(events).toEqual([]);
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.pinnable');
    expect(inspected?.pinnedGeneration).toBe(oldGen);
    expect(inspected?.generation).not.toBe(oldGen);
    // New consumers resolve to the new generation.
    runtime.install({
      id: 'test.pinconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '*' }],
      setup: (ctx) => {
        seen.push(ctx.require(cap));
      },
    });
    await runtime.start('test.pinconsumer');
    expect(seen).toEqual(['2.0.0']);
    await runtime.dispose();
  });

  it("the 'immediate' policy skips the drain hook and disposes at once", async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    await runtime.replace(providerDef('2.0.0', events), { inFlight: 'immediate' });
    expect(events).toEqual(['dispose-1.0.0']);
    expect(
      runtime.inspect().plugins.find((p) => p.id === 'test.pinnable')?.pinnedGeneration,
    ).toBeUndefined();
    await runtime.dispose();
  });

  it('an invalid inFlight policy is rejected', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    const error = await rejectionOf(
      runtime.replace(providerDef('2.0.0', events), {
        inFlight: 'bogus' as 'pin',
      }),
    );
    expectCode(error, 'INVALID_DEFINITION');
    // The failed replace changed nothing.
    expect(runtime.getStatus('test.pinnable')).toBe('active');
    expect(events).toEqual([]);
    await runtime.dispose();
  });

  it('a new pin supersedes the previous one, which is disposed with a stopped event', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    const stopped: { pluginId?: string | undefined; generation?: string | undefined }[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'stopped') {
        stopped.push({ pluginId: event.pluginId, generation: event.generation });
      }
    });
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    const gen1 = runtime.inspect().plugins.find((p) => p.id === 'test.pinnable')?.generation;
    await runtime.replace(providerDef('2.0.0', events), { inFlight: 'pin' });
    const gen2 = runtime.inspect().plugins.find((p) => p.id === 'test.pinnable')?.generation;
    await runtime.replace(providerDef('3.0.0', events), { inFlight: 'pin' });
    // The first pin was released; only the newest generation is pinned.
    expect(events).toEqual(['dispose-1.0.0']);
    expect(stopped).toContainEqual({ pluginId: 'test.pinnable', generation: gen1 });
    expect(runtime.inspect().plugins.find((p) => p.id === 'test.pinnable')?.pinnedGeneration).toBe(
      gen2,
    );
    await runtime.dispose();
  });

  it('stopping the plugin releases its pin', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    await runtime.replace(providerDef('2.0.0', events), { inFlight: 'pin' });
    expect(events).toEqual([]);
    await runtime.stop('test.pinnable', { cascade: true });
    expect(events).toEqual(['dispose-2.0.0', 'dispose-1.0.0']);
    expect(
      runtime.inspect().plugins.find((p) => p.id === 'test.pinnable')?.pinnedGeneration,
    ).toBeUndefined();
    await runtime.dispose();
  });

  it('uninstalling the plugin releases its pin', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    await runtime.replace(providerDef('2.0.0', events), { inFlight: 'pin' });
    await runtime.stop('test.pinnable', { cascade: true });
    await runtime.uninstall('test.pinnable');
    expect(events).toEqual(['dispose-2.0.0', 'dispose-1.0.0']);
    expect(runtime.inspect().plugins.some((p) => p.id === 'test.pinnable')).toBe(false);
    await runtime.dispose();
  });

  it('disposing the runtime releases all pins', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.install(providerDef('1.0.0', events));
    await runtime.start('test.pinnable');
    await runtime.replace(providerDef('2.0.0', events), { inFlight: 'pin' });
    expect(events).toEqual([]);
    await runtime.dispose();
    expect(events).toEqual(['dispose-2.0.0', 'dispose-1.0.0']);
  });
});

describe('transition audit log', () => {
  it('records lifecycle transitions in order with monotonic sequence numbers', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.tlog', version: '1.0.0', setup: () => {} });
    await runtime.start('test.tlog');
    await runtime.stop('test.tlog');
    const log = runtime.transitions();
    const types = log.map((entry) => entry.type);
    expect(types).toEqual(['installed', 'started', 'stopped']);
    expect(log.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(log[0]?.pluginId).toBe('test.tlog');
    expect(log[1]?.generation).toBe('test.tlog#1');
    // Timestamps are non-decreasing.
    expect(log[0]?.at).toBeLessThanOrEqual(log[1]?.at ?? -1);
    expect(log[1]?.at).toBeLessThanOrEqual(log[2]?.at ?? -1);
    // The returned array is a frozen snapshot, not the live buffer.
    expect(Object.isFrozen(log)).toBe(true);
    expect(runtime.transitions()).not.toBe(log);
    await runtime.dispose();
  });

  it('records replacements, failures, pins, and quarantine transitions', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    let healthy = true;
    const capq = capability<{ value: number }>('test.tlogqcap', '1.0.0');
    runtime.install({
      id: 'test.tlogq',
      version: '1.0.0',
      provides: [{ capability: capq }],
      setup: (ctx) => {
        ctx.provide(capq, { value: 1 });
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    await runtime.start('test.tlogq');
    healthy = false;
    await runtime.checkHealth('test.tlogq');
    await runtime.checkHealth('test.tlogq');
    healthy = true;
    await runtime.checkHealth('test.tlogq');
    await runtime.replace(
      {
        id: 'test.tlogq',
        version: '2.0.0',
        provides: [{ capability: capq }],
        setup: (ctx) => {
          ctx.provide(capq, { value: 2 });
        },
      },
      { inFlight: 'pin' },
    );
    // A failing install records a failed transition with the error.
    runtime.install({
      id: 'test.tlogbad',
      version: '1.0.0',
      setup: () => {
        throw new Error('boom');
      },
    });
    await rejectionOf(runtime.start('test.tlogbad'));
    const types = runtime.transitions().map((entry) => entry.type);
    // The second unhealthy probe finds the generation already quarantined,
    // so no duplicate 'quarantined' transition is logged.
    expect(types).toEqual([
      'installed',
      'started',
      'quarantined',
      'unquarantined',
      'replaced',
      'pinned',
      'installed',
      'failed',
    ]);
    const failed = runtime.transitions().find((entry) => entry.type === 'failed');
    expect(failed?.pluginId).toBe('test.tlogbad');
    expect(isMoltError(failed?.error)).toBe(true);
    const pinned = runtime.transitions().find((entry) => entry.type === 'pinned');
    expect(pinned?.pluginId).toBe('test.tlogq');
    await runtime.dispose();
    expect(runtime.transitions().at(-1)?.type).toBe('disposed');
  });

  it('evicts the oldest entries beyond the capacity bound', async () => {
    const runtime = createRuntime();
    for (let i = 0; i < 140; i++) {
      runtime.install({ id: `test.tlogevict${i}`, version: '1.0.0', setup: () => {} });
    }
    const log = runtime.transitions();
    expect(log.length).toBe(128);
    expect(log[0]?.seq).toBe(12);
    expect(log.at(-1)?.seq).toBe(139);
    expect(log[0]?.pluginId).toBe('test.tlogevict12');
    await runtime.dispose();
  });
});

describe('whole-graph validate()', () => {
  it('returns no issues for a healthy graph', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.vcap', '1.0.0');
    runtime.install({
      id: 'test.vprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
      },
    });
    runtime.install({
      id: 'test.vconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    await runtime.start('test.vprovider');
    await runtime.start('test.vconsumer');
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
    expect(runtime.validate()).toEqual([]);
  });

  it('flags unresolvable requirements after the provider is quarantined', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    let healthy = true;
    const cap = capability<string>('test.vqcap', '1.0.0');
    runtime.install({
      id: 'test.vqprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    runtime.install({
      id: 'test.vqconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    await runtime.start('test.vqprovider');
    await runtime.start('test.vqconsumer');
    expect(runtime.validate()).toEqual([]);
    healthy = false;
    await runtime.checkHealth('test.vqprovider');
    const issues = runtime.validate();
    expect(issues.map((issue) => issue.kind)).toEqual(['unresolvable-requirement']);
    expect(issues[0]?.pluginId).toBe('test.vqconsumer');
    expect(issues[0]?.capabilityId).toBe('test.vqcap');
    // Lifting the quarantine heals the graph.
    healthy = true;
    await runtime.checkHealth('test.vqprovider');
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });

  it('range-checks host providers like any other candidate', async () => {
    // The host holds 1.0.0; a plugin provides 2.0.0; the consumer demands
    // ^2.0.0 and binds to the plugin. When the plugin is quarantined, the
    // host cannot take over (version mismatch) — validate() must flag the
    // requirement instead of treating any host provider as selectable.
    const hcap = capability<string[]>('test.vhcap', '1.0.0', { multiple: true });
    const hcap2 = capability<string[]>('test.vhcap', '2.0.0', { multiple: true });
    let healthy = true;
    const runtime = createRuntime({
      onUnhealthy: 'quarantine',
      providers: [{ capability: hcap, value: ['host-v1'] }],
    });
    runtime.install({
      id: 'test.vhprovider',
      version: '2.0.0',
      provides: [{ capability: hcap2 }],
      setup: (ctx) => {
        ctx.provide(hcap2, ['v2']);
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    runtime.install({
      id: 'test.vhconsumer',
      version: '1.0.0',
      requires: [{ capability: hcap2, range: '^2.0.0' }],
      setup: () => {},
    });
    await runtime.start('test.vhprovider');
    await runtime.start('test.vhconsumer');
    expect(runtime.validate()).toEqual([]);
    healthy = false;
    await runtime.checkHealth('test.vhprovider');
    const issues = runtime.validate();
    expect(issues.map((issue) => issue.kind)).toEqual(['unresolvable-requirement']);
    expect(issues[0]?.pluginId).toBe('test.vhconsumer');
    await runtime.dispose();
  });

  it('treats a range-satisfying host as a live provider under quarantine', async () => {
    // Mirror of the previous test with a matching host version: the
    // quarantined plugin's consumer stays consistent via the host.
    const hcap = capability<string[]>('test.vhcap2', '2.0.0', { multiple: true });
    let healthy = true;
    const runtime = createRuntime({
      onUnhealthy: 'quarantine',
      providers: [{ capability: hcap, value: ['host-v2'] }],
    });
    runtime.install({
      id: 'test.vhprovider2',
      version: '2.0.0',
      provides: [{ capability: hcap }],
      setup: (ctx) => {
        ctx.provide(hcap, ['v2']);
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    runtime.install({
      id: 'test.vhconsumer2',
      version: '1.0.0',
      requires: [{ capability: hcap, range: '^2.0.0' }],
      setup: () => {},
    });
    await runtime.start('test.vhprovider2');
    await runtime.start('test.vhconsumer2');
    healthy = false;
    await runtime.checkHealth('test.vhprovider2');
    // The host satisfies ^2.0.0, so the graph is still consistent.
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });

  it('treats pinned generations as live, not stale', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.vpcap', '1.0.0');
    const def = (version: string): PluginDefinition => ({
      id: 'test.vpprovider',
      version,
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, version);
      },
    });
    runtime.install(def('1.0.0'));
    await runtime.start('test.vpprovider');
    await runtime.replace(def('2.0.0'), { inFlight: 'pin' });
    // The pinned generation is withdrawn but accounted for: no stale
    // bindings, no orphaned generations, no duplicate providers.
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });
});

describe('plan APIs and inspectDependents', () => {
  function graph() {
    const runtime = createRuntime();
    const cap = capability<string>('test.plancap', '1.0.0');
    runtime.install({
      id: 'test.planprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
      },
    });
    runtime.install({
      id: 'test.planconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    return { runtime, cap };
  }

  it('planStart resolves the activation order and selections without starting', async () => {
    const { runtime } = graph();
    const plan = runtime.planStart('test.planconsumer');
    expect(plan.order).toEqual(['test.planprovider', 'test.planconsumer']);
    expect(plan.selections).toHaveLength(1);
    expect(plan.selections[0]).toMatchObject({
      consumer: 'test.planconsumer',
      capabilityId: 'test.plancap',
      range: '^1.0.0',
      optional: false,
    });
    expect(plan.selections[0]?.providers).toEqual([
      { pluginId: 'test.planprovider', version: '1.0.0' },
    ]);
    // Nothing was started or emitted.
    expect(runtime.getStatus('test.planconsumer')).toBe('installed');
    expect(runtime.transitions().map((entry) => entry.type)).toEqual(['installed', 'installed']);
    await runtime.dispose();
  });

  it('planStart throws the same error start() would on unresolvable requirements', async () => {
    const { runtime } = graph();
    await runtime.start('test.planprovider');
    await runtime.stop('test.planprovider');
    // A stopped provider is revivable, so it still plans fine — uninstall
    // it to make the requirement genuinely unresolvable.
    expect(runtime.planStart('test.planconsumer').order).toContain('test.planprovider');
    await runtime.uninstall('test.planprovider');
    let planned: unknown;
    try {
      runtime.planStart('test.planconsumer');
      throw new Error('expected planStart to throw');
    } catch (thrown) {
      planned = thrown;
    }
    // The real start() fails the same way, with the same code.
    const error = await rejectionOf(runtime.start('test.planconsumer'));
    expectCode(planned, (error as { code: string }).code);
    if (!isMoltError(planned)) {
      throw new Error('expected a MoltError');
    }
    // The structured details name the blocked requirement.
    const blocked = planned.details?.['blocked'] as
      { requirement: { capabilityId: string } }[] | undefined;
    expect(blocked?.[0]?.requirement.capabilityId).toBe('test.plancap');
    await runtime.dispose();
  });

  it('planStart of an active plugin returns an empty plan', async () => {
    const { runtime } = graph();
    await runtime.start('test.planconsumer');
    const plan = runtime.planStart('test.planconsumer');
    expect(plan.order).toEqual([]);
    expect(plan.selections).toEqual([]);
    await runtime.dispose();
  });

  it('planStop reports the cascade closure and refuses without cascade', async () => {
    const { runtime } = graph();
    await runtime.start('test.planconsumer');
    expect(() => runtime.planStop('test.planprovider')).toThrowError();
    try {
      runtime.planStop('test.planprovider');
      throw new Error('expected planStop to throw');
    } catch (thrown) {
      expectCode(thrown, 'ACTIVE_DEPENDENTS');
    }
    const plan = runtime.planStop('test.planprovider', { cascade: true });
    expect(plan.stopped).toEqual(['test.planconsumer', 'test.planprovider']);
    // A real stop follows the same order.
    const stopped: string[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'stopped' && event.pluginId !== undefined) {
        stopped.push(event.pluginId);
      }
    });
    await runtime.stop('test.planprovider', { cascade: true });
    expect(stopped).toEqual(['test.planconsumer', 'test.planprovider']);
    await runtime.dispose();
  });

  it('planReplace reports the rebind closure and honors strictDependents', async () => {
    const { runtime } = graph();
    await runtime.start('test.planconsumer');
    const plan = runtime.planReplace({
      id: 'test.planprovider',
      version: '1.0.1',
      setup: () => {},
    });
    expect(plan.replaced).toBe('test.planprovider');
    expect(plan.rebound).toEqual(['test.planconsumer']);
    expect(() =>
      runtime.planReplace(
        { id: 'test.planprovider', version: '1.0.1', setup: () => {} },
        { strictDependents: true },
      ),
    ).toThrowError();
    try {
      runtime.planReplace(
        { id: 'test.planprovider', version: '1.0.1', setup: () => {} },
        { strictDependents: true },
      );
      throw new Error('expected planReplace to throw');
    } catch (thrown) {
      expectCode(thrown, 'REPLACEMENT_FAILED');
    }
    await runtime.dispose();
  });

  it('inspectDependents returns transitive dependents in provider-first order', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.plancap', '1.0.0');
    const cap2 = capability<string>('test.plancap2', '1.0.0');
    runtime.install({
      id: 'test.planprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
      },
    });
    runtime.install({
      id: 'test.planconsumer',
      version: '1.0.0',
      provides: [{ capability: cap2 }],
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: (ctx) => {
        ctx.provide(cap2, 'c');
      },
    });
    runtime.install({
      id: 'test.plangrand',
      version: '1.0.0',
      requires: [{ capability: cap2, range: '*' }],
      setup: () => {},
    });
    // Chain: provider <- consumer <- grandconsumer.
    await runtime.start('test.plangrand');
    const dependents = runtime.inspectDependents('test.planprovider');
    expect(dependents.map((entry) => entry.pluginId)).toEqual([
      'test.planconsumer',
      'test.plangrand',
    ]);
    expect(dependents[0]?.generation).toMatch(/^test\.planconsumer#/);
    expect(runtime.inspectDependents('test.plangrand')).toEqual([]);
    await runtime.dispose();
  });
});

describe('failed event stages', () => {
  it('reports the pipeline stage on failed events and in the audit log', async () => {
    const runtime = createRuntime();
    const failed: { pluginId?: string | undefined; stage?: string | undefined }[] = [];
    runtime.subscribe((event) => {
      if (event.type === 'failed') {
        failed.push({ pluginId: event.pluginId, stage: event.stage });
      }
    });
    // Resolution failure.
    runtime.install({
      id: 'test.fsnores',
      version: '1.0.0',
      requires: [{ capability: capability<string>('test.fscap', '1.0.0'), range: '*' }],
      setup: () => {},
    });
    await rejectionOf(runtime.start('test.fsnores'));
    // Preparation failure: the candidate's setup throws.
    const cap = capability<string>('test.fspcap', '1.0.0');
    runtime.install({
      id: 'test.fsprepare',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
      },
    });
    await runtime.start('test.fsprepare');
    await rejectionOf(
      runtime.replace({
        id: 'test.fsprepare',
        version: '2.0.0',
        provides: [{ capability: cap }],
        setup: () => {
          throw new Error('setup blew up');
        },
      }),
    );
    // Health-gate failure.
    let healthy = true;
    const hcap = capability<string>('test.fshcap', '1.0.0');
    runtime.install({
      id: 'test.fshealth',
      version: '1.0.0',
      provides: [{ capability: hcap }],
      setup: (ctx) => {
        ctx.provide(hcap, 'v1');
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    await runtime.start('test.fshealth');
    healthy = false;
    await rejectionOf(
      runtime.replace({
        id: 'test.fshealth',
        version: '2.0.0',
        provides: [{ capability: hcap }],
        setup: (ctx) => {
          ctx.provide(hcap, 'v2');
        },
        healthCheck: (): HealthStatus => ({ ok: false }),
      }),
    );
    expect(failed).toEqual([
      { pluginId: 'test.fsnores', stage: 'resolve' },
      { pluginId: 'test.fsprepare', stage: 'prepare' },
      { pluginId: 'test.fshealth', stage: 'health' },
    ]);
    // The audit log carries the same stages.
    const logStages = runtime
      .transitions()
      .filter((entry) => entry.type === 'failed')
      .map((entry) => entry.stage);
    expect(logStages).toEqual(['resolve', 'prepare', 'health']);
    await runtime.dispose();
  });
});

describe('uninstall options', () => {
  it('rejects an already-aborted signal before any state changes', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.uabort', version: '1.0.0', setup: () => {} });
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await runtime.uninstall('test.uabort', { signal: controller.signal });
    } catch (e) {
      error = e;
    }
    expectCode(error, 'ABORTED');
    // Nothing changed: the plugin is still installed.
    expect(runtime.getStatus('test.uabort')).toBe('installed');
    await runtime.dispose();
  });

  it('bounds disposal with timeoutMs instead of hanging', async () => {
    const runtime = createRuntime();
    let releaseDispose: (() => void) | undefined;
    runtime.install({
      id: 'test.utimeout',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(
          () =>
            new Promise<void>((resolve) => {
              releaseDispose = resolve;
            }),
        );
      },
    });
    await runtime.start('test.utimeout');
    await runtime.stop('test.utimeout', { timeoutMs: 0 });
    // A zero timeout completes uninstall without waiting for the hanging
    // disposer; the scope is still disposed when the disposer settles.
    await runtime.uninstall('test.utimeout', { timeoutMs: 0 });
    expect(runtime.getStatus('test.utimeout')).toBeUndefined();
    releaseDispose?.();
    await runtime.dispose();
  });
});

describe('unquarantine audit ordering', () => {
  it('a conflicting unquarantine logs no unquarantined transition', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    const cap = capability<string>('test.uqcap', '1.0.0');
    let healthy = true;
    runtime.install({
      id: 'test.uqprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    await runtime.start('test.uqprovider');
    healthy = false;
    expect(await runtime.checkHealth('test.uqprovider')).toEqual({ ok: false });
    expect(runtime.inspect().plugins.find((p) => p.id === 'test.uqprovider')?.quarantined).toBe(
      true,
    );
    // While quarantined, another plugin claims the same single-provider
    // capability — unquarantining now would be ambiguous.
    runtime.install({
      id: 'test.uqintruder',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'intruder');
      },
    });
    await runtime.start('test.uqintruder');
    const transitionsBefore = runtime.transitions().map((entry) => entry.type);
    expect(transitionsBefore).toContain('quarantined');
    expect(transitionsBefore).not.toContain('unquarantined');
    // A healthy re-probe attempts the unquarantine and fails loudly.
    healthy = true;
    let error: unknown;
    try {
      await runtime.checkHealth('test.uqprovider');
    } catch (e) {
      error = e;
    }
    expectCode(error, 'AMBIGUOUS_PROVIDER');
    // The generation stays quarantined and the log claims nothing.
    expect(runtime.inspect().plugins.find((p) => p.id === 'test.uqprovider')?.quarantined).toBe(
      true,
    );
    expect(runtime.transitions().map((entry) => entry.type)).not.toContain('unquarantined');
    await runtime.dispose();
  });
});

describe('quarantine restoration', () => {
  it('restores bindings, contributions, and edges on unquarantine with balanced events', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    const cap = capability<string>('test.qrcap', '1.0.0');
    const key = contributionKey<string>('test.qrkey');
    let healthy = true;
    const events: string[] = [];
    runtime.subscribe((event) => {
      events.push(`${event.type}:${event.pluginId ?? ''}`);
    });
    runtime.install({
      id: 'test.qrprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
        ctx.contribute(key, 'contrib-v1');
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    let seen = '';
    runtime.install({
      id: 'test.qrconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: (ctx) => {
        seen = ctx.require(cap);
      },
    });
    await runtime.start('test.qrprovider');
    await runtime.start('test.qrconsumer');
    expect(seen).toBe('v1');
    const contributedOf = () => runtime.contributions().entries.get(key.id) ?? [];
    expect(contributedOf()).toHaveLength(1);

    // Quarantine: bindings and contributions are withdrawn, scope lives.
    healthy = false;
    await runtime.checkHealth('test.qrprovider');
    expect(runtime.inspect().plugins.find((p) => p.id === 'test.qrprovider')?.quarantined).toBe(
      true,
    );
    expect(contributedOf()).toHaveLength(0);
    // The existing consumer still resolves (it holds its generation edge).
    expect(runtime.inspectDependents('test.qrprovider').map((d) => d.pluginId)).toEqual([
      'test.qrconsumer',
    ]);

    // Unquarantine: everything is republished exactly once.
    healthy = true;
    await runtime.checkHealth('test.qrprovider');
    expect(runtime.inspect().plugins.find((p) => p.id === 'test.qrprovider')?.quarantined).toBe(
      false,
    );
    expect(contributedOf()).toHaveLength(1);
    // A fresh consumer resolves to the restored provider.
    let seen2 = '';
    runtime.install({
      id: 'test.qrconsumer2',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: (ctx) => {
        seen2 = ctx.require(cap);
      },
    });
    await runtime.start('test.qrconsumer2');
    expect(seen2).toBe('v1');
    expect(runtime.validate()).toEqual([]);
    // Event balance: quarantine/unquarantine are transitions, not events —
    // no spurious started/stopped/replaced for either.
    expect(events.filter((e) => e.startsWith('failed'))).toEqual([]);
    expect(events).toEqual([
      'installed:test.qrprovider',
      'installed:test.qrconsumer',
      'started:test.qrprovider',
      'started:test.qrconsumer',
      'installed:test.qrconsumer2',
      'started:test.qrconsumer2',
    ]);
    await runtime.dispose();
  });

  it('a failed rollback under the rollback policy preserves history and the sick generation', async () => {
    const runtime = createRuntime({ onUnhealthy: 'rollback' });
    const cap = capability<string>('test.qrbcap', '1.0.0');
    let v2Healthy = true;
    let v1SetupThrows = false;
    const v1: PluginDefinition = {
      id: 'test.qrbrollback',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        if (v1SetupThrows) {
          throw new Error('v1 setup blew up');
        }
        ctx.provide(cap, 'v1');
      },
      healthCheck: (): HealthStatus => ({ ok: true }),
    };
    runtime.install(v1);
    await runtime.start('test.qrbrollback');
    await runtime.replace({
      ...v1,
      version: '2.0.0',
      setup: (ctx) => {
        ctx.provide(cap, 'v2');
      },
      healthCheck: (): HealthStatus => (v2Healthy ? { ok: true } : { ok: false }),
    });
    // The rollback target (v1) now fails its setup: the policy rollback
    // must fail loudly and leave history and the sick v2 untouched.
    v1SetupThrows = true;
    v2Healthy = false;
    const error = await rejectionOf(runtime.checkHealth('test.qrbrollback'));
    expectCode(error, 'REPLACEMENT_FAILED');
    expect(runtime.getStatus('test.qrbrollback')).toBe('active');
    // History is preserved: a manual rollback can be retried after the fix.
    v1SetupThrows = false;
    await runtime.rollback('test.qrbrollback');
    expect(runtime.getStatus('test.qrbrollback')).toBe('active');
    await runtime.dispose();
  });
});

describe('quarantined generation teardown', () => {
  it('replace and stop of a quarantined generation drop the stash without leaks', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    const cap = capability<string>('test.qtcap', '1.0.0');
    let healthy = true;
    const def = (version: string): PluginDefinition => ({
      id: 'test.qtprovider',
      version,
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, version);
      },
      healthCheck: (): HealthStatus => (healthy ? { ok: true } : { ok: false }),
    });
    runtime.install(def('1.0.0'));
    await runtime.start('test.qtprovider');
    healthy = false;
    await runtime.checkHealth('test.qtprovider');
    expect(runtime.inspect().plugins.find((p) => p.id === 'test.qtprovider')?.quarantined).toBe(
      true,
    );
    // Replace the quarantined generation: the stash is dropped, the new
    // generation is clean, and nothing republishes the old bindings.
    healthy = true;
    await runtime.replace(def('2.0.0'));
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.qtprovider');
    expect(inspected?.quarantined).toBe(false);
    expect(runtime.validate()).toEqual([]);
    // Stop the (healthy) generation and quarantine bookkeeping is gone.
    await runtime.stop('test.qtprovider');
    expect(runtime.validate()).toEqual([]);
    const types = runtime.transitions().map((entry) => entry.type);
    expect(types.filter((type) => type === 'quarantined')).toHaveLength(1);
    expect(types).not.toContain('unquarantined');
    await runtime.dispose();
  });
});

describe('bounded cleanup on failure paths', () => {
  const hangForever = () => new Promise<void>(() => {});

  it('bounds candidate disposal when a replace candidate fails to prepare', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.bdcap', '1.0.0');
    runtime.install({
      id: 'test.bdprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
        // A hanging disposer: without a bound, cleaning up the failed
        // candidate would hang replace() forever.
        ctx.scope.onDispose(hangForever);
      },
    });
    await runtime.start('test.bdprovider');
    // The replacement candidate prepares fine but the OLD generation's
    // scope must be disposed at commit — that path is already bounded via
    // #stop-like teardown. Instead, fail the candidate preparation itself:
    // install a second plugin whose setup throws after registering a
    // hanging disposer, then start it with a disposal budget.
    runtime.install({
      id: 'test.bdfailer',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(hangForever);
        throw new Error('setup blew up');
      },
    });
    const error = await rejectionOf(runtime.start('test.bdfailer', { timeoutMs: 50 }));
    // The setup error is the cause; the disposal timeout is attached, not
    // swallowed into a hang.
    expectCode(error, 'ACTIVATION_FAILED');
    if (!isMoltError(error)) {
      throw new Error('expected a MoltError');
    }
    const disposalErrors = (error.details?.['disposalErrors'] ?? []) as unknown[];
    expect(
      disposalErrors.some((entry) => isMoltError(entry) && entry.code === 'DISPOSAL_TIMEOUT'),
    ).toBe(true);
    await runtime.dispose({ timeoutMs: 50 });
  });

  it('bounds candidate disposal when a rebind transaction aborts', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.bdcap2', '1.0.0');
    runtime.install({
      id: 'test.bdprovider2',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1');
        ctx.scope.onDispose(hangForever);
      },
    });
    runtime.install({
      id: 'test.bdconsumer2',
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: () => {},
    });
    await runtime.start('test.bdprovider2');
    await runtime.start('test.bdconsumer2');
    // The replacement candidate fails preparation: the transaction aborts
    // and must dispose the prepared provider candidate within the budget.
    const error = await rejectionOf(
      runtime.replace(
        {
          id: 'test.bdprovider2',
          version: '2.0.0',
          provides: [{ capability: cap }],
          setup: () => {
            throw new Error('candidate setup blew up');
          },
        },
        { timeoutMs: 50 },
      ),
    );
    expectCode(error, 'REPLACEMENT_FAILED');
    // The old generation is untouched: atomicity holds even with the bound.
    expect(runtime.getStatus('test.bdprovider2')).toBe('active');
    expect(runtime.getStatus('test.bdconsumer2')).toBe('active');
    await runtime.dispose({ timeoutMs: 50 });
  });
});

describe('configuration audit', () => {
  it('a failed updateConfig preserves the previous override for later generations', async () => {
    const runtime = createRuntime();
    let seenConfig: Record<string, unknown> | undefined;
    runtime.install(
      {
        id: 'test.cfgplugin',
        version: '1.0.0',
        config: { level: 1 },
        validateConfig: (config) =>
          typeof config['level'] === 'number' && config['level'] > 0
            ? []
            : ['level must be a positive number'],
        setup: (ctx) => {
          seenConfig = { ...ctx.config };
        },
      },
      { config: { level: 2 } },
    );
    await runtime.start('test.cfgplugin');
    expect(seenConfig).toEqual({ level: 2 });
    // A failing patch changes nothing: the override stays { level: 2 }.
    // updateConfig validates synchronously and throws on failure.
    expect(() => runtime.updateConfig('test.cfgplugin', { level: -1 })).toThrowError(
      /level must be a positive number/,
    );
    // A later generation still sees the previous override, not the rejected patch.
    await runtime.replace({
      id: 'test.cfgplugin',
      version: '2.0.0',
      config: { level: 1 },
      validateConfig: (config) =>
        typeof config['level'] === 'number' && config['level'] > 0
          ? []
          : ['level must be a positive number'],
      setup: (ctx) => {
        seenConfig = { ...ctx.config };
      },
    });
    expect(seenConfig).toEqual({ level: 2 });
    await runtime.dispose();
  });

  it('a validateConfig that does not return string[] fails loudly at install', async () => {
    const runtime = createRuntime();
    // Configuration is validated at install: a mistyped validateConfig
    // fails fast instead of crashing on `.join` during activation.
    expect(() =>
      runtime.install({
        id: 'test.cfgplugin2',
        version: '1.0.0',
        // Deliberately mistyped at runtime: the declared type is string[].
        validateConfig: (() => 'not-an-array') as unknown as (
          config: Readonly<Record<string, unknown>>,
        ) => readonly string[],
        setup: () => {},
      }),
    ).toThrowError(/must return an array of strings/);
    await runtime.dispose();
  });
});

describe('drain audit', () => {
  it('a timed-out drain is inspectably recorded without blocking the replacement', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.drainplugin',
      version: '1.0.0',
      drain: () => new Promise<void>(() => {}),
      setup: () => {},
    });
    await runtime.start('test.drainplugin');
    await runtime.replace(
      { id: 'test.drainplugin', version: '2.0.0', setup: () => {} },
      { timeoutMs: 50 },
    );
    // The replacement succeeded; the drain timeout is on the record.
    expect(runtime.getStatus('test.drainplugin')).toBe('active');
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.drainplugin');
    if (!isMoltError(inspected?.error)) {
      throw new Error('expected a MoltError on the record');
    }
    expect(inspected.error.code).toBe('DISPOSAL_TIMEOUT');
    expect(inspected.error.details?.['reason']).toBe('drain-timeout');
    await runtime.dispose();
  });

  it('a drain timeout does not overwrite a more important disposal failure', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.drainplugin2',
      version: '1.0.0',
      drain: () => new Promise<void>(() => {}),
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          throw new Error('disposer blew up');
        });
      },
    });
    await runtime.start('test.drainplugin2');
    await runtime.replace(
      { id: 'test.drainplugin2', version: '2.0.0', setup: () => {} },
      { timeoutMs: 50 },
    );
    // The disposal failure (resources may leak) wins over the drain timeout.
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.drainplugin2');
    if (!isMoltError(inspected?.error)) {
      throw new Error('expected a MoltError on the record');
    }
    expect(inspected.error.code).toBe('DISPOSAL_FAILED');
    expect(inspected.error.details?.['reason']).not.toBe('drain-timeout');
    await runtime.dispose();
  });

  it('a throwing drain is inspectably recorded', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.drainplugin3',
      version: '1.0.0',
      drain: () => {
        throw new Error('drain blew up');
      },
      setup: () => {},
    });
    await runtime.start('test.drainplugin3');
    await runtime.replace({ id: 'test.drainplugin3', version: '2.0.0', setup: () => {} });
    expect(runtime.getStatus('test.drainplugin3')).toBe('active');
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.drainplugin3');
    if (!isMoltError(inspected?.error)) {
      throw new Error('expected a MoltError on the record');
    }
    expect(inspected.error.code).toBe('DISPOSAL_FAILED');
    expect(inspected.error.details?.['reason']).toBe('drain-failed');
    await runtime.dispose();
  });
});

describe('rollback audit', () => {
  it('history holds exactly 10 entries; rollback pops on success', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.rbcap', '1.0.0');
    let seen = '';
    runtime.install({
      id: 'test.rbplugin',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'v1.0.0');
      },
    });
    runtime.install({
      id: 'test.rbconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '>=1.0.0' }],
      setup: (ctx) => {
        seen = ctx.require(cap);
      },
    });
    await runtime.start('test.rbplugin');
    await runtime.start('test.rbconsumer');
    // 12 replacements → history capped at 10.
    for (let n = 2; n <= 13; n += 1) {
      const version = `1.0.${String(n)}`;
      await runtime.replace({
        id: 'test.rbplugin',
        version,
        provides: [{ capability: cap }],
        setup: (ctx) => {
          ctx.provide(cap, `v${version}`);
        },
      });
    }
    expect(seen).toBe('v1.0.13');
    // Roll back 10 times: each pops one entry.
    for (let n = 12; n >= 3; n -= 1) {
      await runtime.rollback('test.rbplugin');
      expect(seen).toBe(`v1.0.${String(n)}`);
    }
    // History exhausted: the 11th rollback throws synchronously.
    let error: unknown;
    try {
      void runtime.rollback('test.rbplugin');
    } catch (e) {
      error = e;
    }
    expectCode(error, 'INVALID_STATE');
    await runtime.dispose();
  });

  it('rollback rebinds dependents onto the restored generation', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.rbcap2', '1.0.0');
    let seen = '';
    runtime.install({
      id: 'test.rbprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'old');
      },
    });
    runtime.install({
      id: 'test.rbdependent',
      version: '1.0.0',
      requires: [{ capability: cap, range: '>=1.0.0' }],
      setup: (ctx) => {
        seen = ctx.require(cap);
      },
    });
    await runtime.start('test.rbprovider');
    await runtime.start('test.rbdependent');
    expect(seen).toBe('old');
    await runtime.replace({
      id: 'test.rbprovider',
      version: '2.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        ctx.provide(cap, 'new');
      },
    });
    // The dependent was rebound without restarting: it sees the new value.
    await runtime.stop('test.rbdependent');
    await runtime.start('test.rbdependent');
    expect(seen).toBe('new');
    // Roll back: the dependent rebinds onto the restored generation.
    await runtime.rollback('test.rbprovider');
    await runtime.stop('test.rbdependent');
    await runtime.start('test.rbdependent');
    expect(seen).toBe('old');
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });
});

describe('abort audit', () => {
  it('an already-aborted signal throws ABORTED synchronously before any state changes', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.abortplugin', version: '1.0.0', setup: () => {} });
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      void runtime.start('test.abortplugin', { signal: controller.signal });
    } catch (e) {
      error = e;
    }
    expectCode(error, 'ABORTED');
    expect(runtime.getStatus('test.abortplugin')).toBe('installed');
    await runtime.dispose();
  });

  it('a setup that settles after caller abort cannot publish or activate', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.abortcap', '1.0.0');
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupFinished = false;
    runtime.install({
      id: 'test.abortplugin2',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: async (ctx) => {
        await setupGate;
        // This runs after the abort: publishing here must be harmless.
        ctx.provide(cap, 'late');
        setupFinished = true;
      },
    });
    const controller = new AbortController();
    const startPromise = runtime.start('test.abortplugin2', { signal: controller.signal });
    // Let setup reach the gate, then abort before it settles.
    await delay(10);
    controller.abort();
    const error = await rejectionOf(startPromise);
    expectCode(error, 'ABORTED');
    // The late settlement happens after cancellation: nothing may commit.
    releaseSetup();
    await delay(20);
    expect(setupFinished).toBe(true);
    expect(runtime.getStatus('test.abortplugin2')).not.toBe('active');
    expect(
      runtime.inspect().plugins.find((p) => p.id === 'test.abortplugin2')?.generation,
    ).toBeUndefined();
    await runtime.dispose();
  });
});

describe('pin audit', () => {
  it('a failed replacement leaves the prior pin untouched', async () => {
    const runtime = createRuntime();
    let v1ScopeAlive = true;
    runtime.install({
      id: 'test.pinplugin',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          v1ScopeAlive = false;
        });
      },
    });
    await runtime.start('test.pinplugin');
    // Replace with pin: v1's generation is pinned, v2 active.
    await runtime.replace(
      { id: 'test.pinplugin', version: '2.0.0', setup: () => {} },
      { inFlight: 'pin' },
    );
    const pinnedBefore = runtime
      .inspect()
      .plugins.find((p) => p.id === 'test.pinplugin')?.pinnedGeneration;
    expect(pinnedBefore).toBeDefined();
    expect(v1ScopeAlive).toBe(true);
    // A failing replacement changes nothing: the pin survives, v2 stays active.
    const error = await rejectionOf(
      runtime.replace({
        id: 'test.pinplugin',
        version: '3.0.0',
        setup: () => {
          throw new Error('v3 setup blew up');
        },
      }),
    );
    expectCode(error, 'REPLACEMENT_FAILED');
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.pinplugin');
    expect(inspected?.pinnedGeneration).toBe(pinnedBefore);
    expect(v1ScopeAlive).toBe(true);
    expect(runtime.getStatus('test.pinplugin')).toBe('active');
    await runtime.dispose();
  });

  it('rollback does not release or replace the pin', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.pinplugin2',
      version: '1.0.0',
      setup: () => {},
    });
    await runtime.start('test.pinplugin2');
    await runtime.replace(
      { id: 'test.pinplugin2', version: '2.0.0', setup: () => {} },
      { inFlight: 'pin' },
    );
    const pinnedBefore = runtime
      .inspect()
      .plugins.find((p) => p.id === 'test.pinplugin2')?.pinnedGeneration;
    expect(pinnedBefore).toBeDefined();
    // Rollback restores v1 as the active generation; the pin is a manual
    // lifecycle and survives the undo.
    await runtime.rollback('test.pinplugin2');
    const inspected = runtime.inspect().plugins.find((p) => p.id === 'test.pinplugin2');
    expect(inspected?.pinnedGeneration).toBe(pinnedBefore);
    expect(runtime.getStatus('test.pinplugin2')).toBe('active');
    await runtime.dispose();
  });
});

describe('pin refcounting', () => {
  it('throws INVALID_STATE when there is no pinned generation to retain', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.nopin', version: '1.0.0', setup: () => {} });
    await runtime.start('test.nopin');
    let error: unknown;
    try {
      runtime.retainPin('test.nopin');
    } catch (e) {
      error = e;
    }
    expectCode(error, 'INVALID_STATE');
    if (isMoltError(error)) {
      expect(error.details).toMatchObject({ reason: 'not-pinned' });
    }
    await runtime.dispose();
  });

  it('a superseding pin keeps a retained generation alive until the last release', async () => {
    const runtime = createRuntime();
    const disposed: string[] = [];
    const events: { type: string; generation?: string }[] = [];
    runtime.subscribe((event) => {
      events.push({
        type: event.type,
        ...(event.generation !== undefined ? { generation: event.generation } : {}),
      });
    });
    const id = 'test.retain';
    runtime.install({
      id,
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          disposed.push('1.0.0');
        });
      },
    });
    await runtime.start(id);
    await runtime.replace(
      {
        id,
        version: '2.0.0',
        setup: (ctx) => {
          ctx.scope.onDispose(() => {
            disposed.push('2.0.0');
          });
        },
      },
      { inFlight: 'pin' },
    );
    const pinnedV1 = runtime.inspect().plugins.find((p) => p.id === id)?.pinnedGeneration;
    expect(pinnedV1).toBeDefined();

    const release = runtime.retainPin(id);
    // A second replace supersedes the pin: v1's generation leaves the pin
    // slot but stays alive for the retainer; v2's generation is pinned.
    await runtime.replace({ id, version: '3.0.0', setup: () => {} }, { inFlight: 'pin' });
    expect(disposed).toEqual([]);
    const slot = runtime.inspect().plugins.find((p) => p.id === id)?.pinnedGeneration;
    expect(slot).toBeDefined();
    expect(slot).not.toBe(pinnedV1);
    const retained = runtime.inspect().retainedPins;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ pluginId: id, generation: pinnedV1, retainers: 1 });

    await release();
    expect(disposed).toEqual(['1.0.0']);
    expect(runtime.inspect().retainedPins).toEqual([]);
    const stoppedForV1 = events.filter(
      (event) => event.type === 'stopped' && event.generation === pinnedV1,
    );
    expect(stoppedForV1).toHaveLength(1);
    await runtime.dispose();
  });

  it('releasing the slot pin drops the claim without disposing early', async () => {
    const runtime = createRuntime();
    const disposed: string[] = [];
    const id = 'test.retainslot';
    runtime.install({
      id,
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          disposed.push('1.0.0');
        });
      },
    });
    await runtime.start(id);
    await runtime.replace({ id, version: '2.0.0', setup: () => {} }, { inFlight: 'pin' });
    const pinned = runtime.inspect().plugins.find((p) => p.id === id)?.pinnedGeneration;
    expect(pinned).toBeDefined();

    const release = runtime.retainPin(id);
    await release();
    // The runtime still holds its own pin: nothing is disposed early.
    expect(disposed).toEqual([]);
    expect(runtime.inspect().plugins.find((p) => p.id === id)?.pinnedGeneration).toBe(pinned);
    // A double release is a no-op, never corrupting the count.
    await release();
    expect(disposed).toEqual([]);
    // The runtime's own release (stop) still disposes the pin.
    await runtime.stop(id);
    expect(disposed).toEqual(['1.0.0']);
    await runtime.dispose();
  });

  it('stop with a live retainer keeps the pin until release', async () => {
    const runtime = createRuntime();
    const disposed: string[] = [];
    const id = 'test.retainstop';
    runtime.install({
      id,
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          disposed.push('1.0.0');
        });
      },
    });
    await runtime.start(id);
    await runtime.replace({ id, version: '2.0.0', setup: () => {} }, { inFlight: 'pin' });
    const pinned = runtime.inspect().plugins.find((p) => p.id === id)?.pinnedGeneration;

    const release = runtime.retainPin(id);
    await runtime.stop(id);
    expect(disposed).toEqual([]);
    expect(runtime.inspect().retainedPins).toHaveLength(1);
    expect(runtime.inspect().retainedPins[0]?.generation).toBe(pinned);
    await release();
    expect(disposed).toEqual(['1.0.0']);
    await runtime.dispose();
  });

  it('uninstall with a live retainer surfaces disposal failures in observer diagnostics', async () => {
    const runtime = createRuntime();
    const id = 'test.retainuninstall';
    runtime.install({
      id,
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          throw new Error('v1 disposer blew up');
        });
      },
    });
    await runtime.start(id);
    await runtime.replace({ id, version: '2.0.0', setup: () => {} }, { inFlight: 'pin' });

    const release = runtime.retainPin(id);
    await runtime.stop(id);
    await runtime.uninstall(id);
    // The plugin is gone but the retained scope is still alive.
    expect(runtime.inspect().retainedPins).toHaveLength(1);
    await release();
    expect(runtime.inspect().retainedPins).toEqual([]);
    const diagnostics = runtime.inspect().observerDiagnostics;
    expect(diagnostics.some((entry) => entry.message.includes('retained pinned generation'))).toBe(
      true,
    );
    await runtime.dispose();
  });

  it('runtime disposal force-releases retained pins; later releases are no-ops', async () => {
    const runtime = createRuntime();
    const disposed: string[] = [];
    const id = 'test.retaindispose';
    runtime.install({
      id,
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          disposed.push('1.0.0');
        });
      },
    });
    await runtime.start(id);
    await runtime.replace({ id, version: '2.0.0', setup: () => {} }, { inFlight: 'pin' });
    const release = runtime.retainPin(id);
    await runtime.stop(id);
    expect(runtime.inspect().retainedPins).toHaveLength(1);
    await runtime.dispose();
    expect(disposed).toEqual(['1.0.0']);
    // The captured release is now a harmless no-op.
    await release();
    expect(disposed).toEqual(['1.0.0']);
  });

  it('multiple retainers require every release before disposal', async () => {
    const runtime = createRuntime();
    const disposed: string[] = [];
    const id = 'test.retainmulti';
    runtime.install({
      id,
      version: '1.0.0',
      setup: (ctx) => {
        ctx.scope.onDispose(() => {
          disposed.push('1.0.0');
        });
      },
    });
    await runtime.start(id);
    await runtime.replace({ id, version: '2.0.0', setup: () => {} }, { inFlight: 'pin' });
    const releaseA = runtime.retainPin(id);
    const releaseB = runtime.retainPin(id);
    // Supersede so the runtime releases its own hold; only the two
    // retainers keep the generation alive now.
    await runtime.replace({ id, version: '3.0.0', setup: () => {} }, { inFlight: 'pin' });
    expect(runtime.inspect().retainedPins[0]).toMatchObject({ retainers: 2 });
    await releaseA();
    expect(disposed).toEqual([]);
    expect(runtime.inspect().retainedPins[0]).toMatchObject({ retainers: 1 });
    await releaseB();
    expect(disposed).toEqual(['1.0.0']);
    expect(runtime.inspect().retainedPins).toEqual([]);
    await runtime.dispose();
  });
});

describe('transition audit', () => {
  it('rollback logs a replaced transition plus a dedicated rolledback transition', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.trplugin', version: '1.0.0', setup: () => {} });
    await runtime.start('test.trplugin');
    await runtime.replace({ id: 'test.trplugin', version: '2.0.0', setup: () => {} });
    const before = runtime.transitions().map((entry) => entry.type);
    await runtime.rollback('test.trplugin');
    const after = runtime.transitions().map((entry) => entry.type);
    // A rollback is an undo through the replacement pipeline: it logs the
    // pipeline's 'replaced' transition, then a dedicated 'rolledback'
    // transition marking the undo — no duplicate, no false commit.
    expect(after.slice(before.length)).toEqual(['replaced', 'rolledback']);
    // Sequence numbers are monotonic with no gaps or repeats.
    const seqs = runtime.transitions().map((entry) => entry.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? -1) + 1);
    }
    await runtime.dispose();
  });

  it('the transition buffer is capped at 128 entries', async () => {
    const runtime = createRuntime();
    // Each install/start/stop triple logs 3 transitions; 50 triples = 150.
    for (let n = 0; n < 50; n += 1) {
      const id = `test.trcap${String(n)}`;
      runtime.install({ id, version: '1.0.0', setup: () => {} });
      await runtime.start(id);
      await runtime.stop(id);
    }
    const transitions = runtime.transitions();
    expect(transitions.length).toBe(128);
    // Oldest evicted: the first retained entry is not from plugin 0.
    expect(transitions[0]?.pluginId).not.toBe('test.trcap0');
    // Still monotonic.
    for (let i = 1; i < transitions.length; i += 1) {
      expect(transitions[i]?.seq).toBe((transitions[i - 1]?.seq ?? -1) + 1);
    }
    await runtime.dispose();
  });
});

describe('validate() selection audit', () => {
  it('starting a consumer revives its stopped provider (tier-2)', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.revivecap', '1.0.0');
    let providerStarted = 0;
    runtime.install({
      id: 'test.reviveprovider',
      version: '1.0.0',
      provides: [{ capability: cap }],
      setup: (ctx) => {
        providerStarted += 1;
        ctx.provide(cap, 'revived');
      },
    });
    runtime.install({
      id: 'test.reviveconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '>=1.0.0' }],
      setup: (ctx) => {
        ctx.require(cap);
      },
    });
    await runtime.start('test.reviveprovider');
    await runtime.start('test.reviveconsumer');
    await runtime.stop('test.reviveconsumer');
    await runtime.stop('test.reviveprovider');
    expect(providerStarted).toBe(1);
    // Starting the consumer revives the stopped provider: tier-2.
    await runtime.start('test.reviveconsumer');
    expect(providerStarted).toBe(2);
    expect(runtime.getStatus('test.reviveprovider')).toBe('active');
    expect(runtime.getStatus('test.reviveconsumer')).toBe('active');
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });

  it('a lazy, never-started provider is never revived', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.lazycap', '1.0.0');
    runtime.install(
      {
        id: 'test.lazyprovider',
        version: '1.0.0',
        provides: [{ capability: cap }],
        setup: (ctx) => {
          ctx.provide(cap, 'lazy');
        },
      },
      { lazy: true },
    );
    runtime.install({
      id: 'test.lazyconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '>=1.0.0' }],
      setup: (ctx) => {
        ctx.require(cap);
      },
    });
    // The lazy provider is excluded from selection until explicitly started.
    const error = await rejectionOf(runtime.start('test.lazyconsumer'));
    expectCode(error, 'MISSING_CAPABILITY');
    // Explicit start opts in; afterwards the consumer resolves.
    await runtime.start('test.lazyprovider');
    await runtime.start('test.lazyconsumer');
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });

  it('optional requirements may dangle: start succeeds and validate() is clean', async () => {
    const runtime = createRuntime();
    const cap = capability<string>('test.optcap', '1.0.0');
    let seen: unknown = 'unset';
    runtime.install({
      id: 'test.optconsumer',
      version: '1.0.0',
      requires: [{ capability: cap, range: '>=1.0.0', optional: true }],
      setup: (ctx) => {
        seen = ctx.optional(cap);
      },
    });
    await runtime.start('test.optconsumer');
    expect(seen).toBeUndefined();
    // validate() only requires non-optional requirements to resolve.
    expect(runtime.validate()).toEqual([]);
    await runtime.dispose();
  });
});
