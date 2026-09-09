import type { PluginContext } from '@moult/runtime';
import { capability, createRuntime } from '@moult/runtime';
import { fakeResources } from '@moult/test';

const messageCapability = capability<{ readonly handle: (message: string) => string }>(
  'worker.message.handler',
  '1.0.0',
);

/** Runs the worker-host scenario and returns the final public resource counters. */
export async function runWorkerHostScenario(): Promise<Readonly<Record<string, number>>> {
  const resources = fakeResources();
  const runtime = createRuntime();
  const definition = (version: string) => ({
    id: 'worker.plugin',
    version,
    provides: [{ capability: messageCapability }],
    setup: async (context: PluginContext) => {
      const resource = resources.connectionHost();
      await context.scope.acquire(resource.create, resource.dispose);
      context.provide(messageCapability, { handle: (message) => `${version}:${message}` });
    },
  });
  runtime.install(definition('1.0.0'));
  await runtime.start('worker.plugin');
  for (let index = 0; index < 100; index += 1) {
    await runtime.replace(definition(`1.0.${index + 1}`));
  }
  await runtime.dispose();
  resources.expectNoLeaks();
  return resources.counters();
}
