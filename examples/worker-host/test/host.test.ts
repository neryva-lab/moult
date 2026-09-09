import type { PluginContext } from '@moult/runtime';
import { capability, createRuntime } from '@moult/runtime';
import { expectGenerationDisposed, fakeResources } from '@moult/test';

const message = capability<{ readonly handle: (value: string) => string }>(
  'worker.test.message',
  '1.0.0',
);

describe('worker host (INV-05/12)', () => {
  it('INV-12: repeated worker replacement releases every old connection', async () => {
    const resources = fakeResources();
    const runtime = createRuntime();
    const definition = (version: string) => ({
      id: 'worker.test.plugin',
      version,
      provides: [{ capability: message }],
      setup: async (context: PluginContext) => {
        const resource = resources.connectionHost();
        await context.scope.acquire(resource.create, resource.dispose);
        context.provide(message, { handle: (value) => `${version}:${value}` });
      },
    });
    runtime.install(definition('1.0.0'));
    await runtime.start('worker.test.plugin');
    for (let index = 0; index < 100; index += 1) {
      await runtime.replace(definition(`1.0.${index + 1}`));
    }
    await runtime.stop('worker.test.plugin');
    await expectGenerationDisposed(runtime, 'worker.test.plugin');
    await runtime.dispose();
    expect(resources.counters()['connection.live']).toBe(0);
    resources.expectNoLeaks();
  });
});
