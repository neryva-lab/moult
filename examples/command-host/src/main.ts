import type { PluginContext } from '@moult/runtime';
import { capability, createRuntime } from '@moult/runtime';
import { fakeResources } from '@moult/test';

const commandCapability = capability<{ readonly execute: () => string }>(
  'command.handler',
  '1.0.0',
);

/** Runs the command-host replacement scenario and returns its observable counters. */
export async function runCommandHostScenario(): Promise<Readonly<Record<string, number>>> {
  const resources = fakeResources();
  const runtime = createRuntime();
  const definition = (version: string, fail = false) => ({
    id: 'command.plugin',
    version,
    provides: [{ capability: commandCapability }],
    setup: async (context: PluginContext) => {
      const resource = resources.listenerHost();
      await context.scope.acquire(resource.create, resource.dispose);
      context.provide(commandCapability, { execute: () => version });
      if (fail) throw new Error('command update rejected');
    },
  });
  runtime.install(definition('1.0.0'));
  await runtime.start('command.plugin');
  try {
    await runtime.replace(definition('2.0.0', true));
  } catch {
    // The scenario deliberately proves that failed replacement is observable
    // without taking down the old command generation.
  }
  await runtime.replace(definition('2.0.0'));
  await runtime.dispose();
  resources.expectNoLeaks();
  return resources.counters();
}
