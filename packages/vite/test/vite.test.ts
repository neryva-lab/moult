import type { PluginContext, PluginDefinition, Runtime } from '@moult/runtime';
import { capability, createRuntime, isMoltError } from '@moult/runtime';
import { expectGenerationDisposed, fakeResources } from '@moult/test';

import type { VitePluginUpdate } from '../src/index.js';
import { createViteBridge } from '../src/index.js';

const capabilityUnderTest = capability<{ readonly value: string }>('vite.test.value', '1.0.0');

function definition(version: string, fail = false): PluginDefinition {
  return {
    id: 'vite.test.plugin',
    version,
    provides: [{ capability: capabilityUnderTest }],
    setup: (context: PluginContext) => {
      context.provide(capabilityUnderTest, { value: version });
      if (fail) throw new Error('HMR setup failure');
    },
  };
}

function source(): {
  hot: {
    on: (
      event: 'added' | 'changed' | 'removed',
      listener: (update: VitePluginUpdate) => void | Promise<void>,
    ) => () => void;
  };
  emit: (event: 'added' | 'changed' | 'removed', update: VitePluginUpdate) => Promise<void>;
} {
  const listeners = new Map<string, Set<(update: VitePluginUpdate) => void | Promise<void>>>();
  return {
    hot: {
      on: (event, listener) => {
        const current = listeners.get(event) ?? new Set();
        current.add(listener);
        listeners.set(event, current);
        return () => current.delete(listener);
      },
    },
    emit: async (event, update) => {
      for (const listener of [...(listeners.get(event) ?? [])]) await listener(update);
    },
  };
}

function consumerDefinition(): PluginDefinition {
  return {
    id: 'vite.test.consumer',
    version: '1.0.0',
    requires: [{ capability: capabilityUnderTest, range: '^1.0.0' }],
    setup: () => undefined,
  };
}

describe('Vite adapter handleRemoved (F12)', () => {
  it('F12: removing an active plugin stops then uninstalls it', async () => {
    const runtime: Runtime = createRuntime();
    runtime.install(definition('1.0.0'));
    await runtime.start('vite.test.plugin');
    const events = source();
    const bridge = createViteBridge({ runtime, hot: events.hot });
    // Before the F12 fix this threw INVALID_STATE('not-stopped') because
    // uninstall rejects active plugins; the plugin stayed active.
    await bridge.handleRemoved({ pluginId: 'vite.test.plugin' });
    expect(runtime.getStatus('vite.test.plugin')).toBeUndefined();
    expect(runtime.inspect().plugins).toHaveLength(0);
    bridge.close();
    await runtime.dispose();
  });

  it('F12: removing an already-stopped plugin still uninstalls it', async () => {
    const runtime: Runtime = createRuntime();
    runtime.install(definition('1.0.0'));
    await runtime.start('vite.test.plugin');
    await runtime.stop('vite.test.plugin');
    const events = source();
    const bridge = createViteBridge({ runtime, hot: events.hot });
    await bridge.handleRemoved({ pluginId: 'vite.test.plugin' });
    expect(runtime.getStatus('vite.test.plugin')).toBeUndefined();
    bridge.close();
    await runtime.dispose();
  });

  it('F12: removing an installed-but-never-started plugin uninstalls it', async () => {
    const runtime: Runtime = createRuntime();
    runtime.install(definition('1.0.0'));
    const events = source();
    const bridge = createViteBridge({ runtime, hot: events.hot });
    // stop() reports INVALID_STATE/not-active here; removal must fall
    // through to uninstall rather than fail.
    await bridge.handleRemoved({ pluginId: 'vite.test.plugin' });
    expect(runtime.getStatus('vite.test.plugin')).toBeUndefined();
    bridge.close();
    await runtime.dispose();
  });

  it('F12: a failing stop preserves its code through bridgeError', async () => {
    const runtime: Runtime = createRuntime();
    runtime.install(definition('1.0.0'));
    runtime.install(consumerDefinition());
    await runtime.start('vite.test.plugin');
    await runtime.start('vite.test.consumer');
    const events = source();
    const diagnostics: unknown[] = [];
    const bridge = createViteBridge({
      runtime,
      hot: events.hot,
      diagnose: (error) => diagnostics.push(error),
    });
    // stop() without cascade rejects with ACTIVE_DEPENDENTS; the bridge
    // must not mask that code.
    let thrown: unknown;
    try {
      await bridge.handleRemoved({ pluginId: 'vite.test.plugin' });
    } catch (error) {
      thrown = error;
    }
    expect(isMoltError(thrown) && thrown.code).toBe('REPLACEMENT_FAILED');
    expect(isMoltError(thrown) && isMoltError(thrown.cause) && thrown.cause.code).toBe(
      'ACTIVE_DEPENDENTS',
    );
    expect(diagnostics).toHaveLength(1);
    expect(isMoltError(diagnostics[0]) && diagnostics[0].code).toBe('REPLACEMENT_FAILED');
    // The failed removal leaves the provider active and serving.
    expect(runtime.getStatus('vite.test.plugin')).toBe('active');
    expect(runtime.inspect().capabilities[0]?.version).toBe('1.0.0');
    bridge.close();
    await runtime.dispose();
  });
});

describe('Vite adapter (INV-07)', () => {
  it('INV-07: import and setup failures preserve the old generation', async () => {
    const resources = fakeResources();
    const runtime: Runtime = createRuntime();
    runtime.install({
      ...definition('1.0.0'),
      setup: async (context) => {
        const resource = resources.listenerHost();
        await context.scope.acquire(resource.create, resource.dispose);
        await definition('1.0.0').setup(context);
      },
    });
    await runtime.start('vite.test.plugin');
    const events = source();
    const diagnostics: unknown[] = [];
    const bridge = createViteBridge({
      runtime,
      hot: events.hot,
      diagnose: (error) => diagnostics.push(error),
    });
    await expect(
      bridge.handleChanged({
        pluginId: 'vite.test.plugin',
        loadDefinition: () => {
          throw new Error('import failed');
        },
      }),
    ).rejects.toThrow();
    let setupError: unknown;
    try {
      await bridge.handleChanged({
        pluginId: 'vite.test.plugin',
        loadDefinition: () => definition('2.0.0', true),
      });
    } catch (error) {
      setupError = error;
    }
    expect(isMoltError(setupError) && setupError.code).toBe('REPLACEMENT_FAILED');
    expect(runtime.getStatus('vite.test.plugin')).toBe('active');
    expect(runtime.inspect().capabilities[0]?.version).toBe('1.0.0');
    expect(diagnostics).toHaveLength(2);
    bridge.close();
    await runtime.dispose();
    await expectGenerationDisposed(runtime, 'vite.test.plugin');
    resources.expectNoLeaks();
  });
});
