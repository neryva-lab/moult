import { capability } from '@moult/runtime';

import { expectGenerationDisposed, fakeResources, pluginHarness } from '../src/index.js';

describe('@moult/test (INV-01/05/12)', () => {
  it('INV-12: counters observe real scope ownership and detect no leaks after disposal', async () => {
    const resources = fakeResources();
    const harness = pluginHarness({
      id: 'test.kit.plugin',
      version: '1.0.0',
      setup: async (context) => {
        const listener = resources.listenerHost();
        await context.scope.acquire(listener.create, listener.dispose);
      },
    });
    await harness.run();
    expect(resources.counters()['listener.live']).toBe(1);
    await harness.dispose();
    await expectGenerationDisposed(harness.runtime, 'test.kit.plugin');
    resources.expectNoLeaks();
  });

  it('INV-03: disposal cues are deterministic and count the attempted release', async () => {
    const resources = fakeResources();
    const regular = resources.connectionHost();
    const failing = resources.failing('connection');
    expect(resources.connectionHost()).toBe(regular);
    failing.failOn({ operation: 'dispose', occurrence: 1 });
    const harness = pluginHarness({
      id: 'test.kit.failure',
      version: '1.0.0',
      setup: async (context) => {
        await context.scope.acquire(failing.create, failing.dispose);
      },
    });
    await harness.run();
    await harness.dispose();
    expect(resources.counters()['connection.released']).toBe(1);
    expect(resources.counters()['connection.live']).toBe(0);
  });

  it('INV-10: the harness accepts ordinary typed plugin definitions', async () => {
    const token = capability<{ readonly ok: true }>('test.kit.capability', '1.0.0');
    const harness = pluginHarness({
      id: 'test.kit.typed',
      version: '1.0.0',
      provides: [{ capability: token }],
      setup: (context) => {
        context.provide(token, { ok: true });
      },
    });
    await harness.run();
    expect(harness.runtime.inspect().capabilities[0]?.id).toBe('test.kit.capability');
    await harness.dispose();
  });
});
