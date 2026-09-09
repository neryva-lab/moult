import type { PluginContext } from '@moult/runtime';
import { capability, createRuntime, isMoltError } from '@moult/runtime';
import { expectGenerationDisposed, fakeResources } from '@moult/test';

const command = capability<{ readonly run: () => string }>('command.test.handler', '1.0.0');

describe('command host (INV-07/12)', () => {
  it('INV-07: failed replacement leaves the command generation active', async () => {
    const resources = fakeResources();
    const runtime = createRuntime();
    const definition = (version: string, fail = false) => ({
      id: 'command.test.plugin',
      version,
      provides: [{ capability: command }],
      setup: async (context: PluginContext) => {
        const resource = resources.listenerHost();
        await context.scope.acquire(resource.create, resource.dispose);
        context.provide(command, { run: () => version });
        if (fail) throw new Error('intentional command failure');
      },
    });
    runtime.install(definition('1.0.0'));
    await runtime.start('command.test.plugin');
    await expect(runtime.replace(definition('2.0.0', true))).rejects.toSatisfy((error: unknown) => {
      return isMoltError(error) && error.code === 'REPLACEMENT_FAILED';
    });
    expect(runtime.getStatus('command.test.plugin')).toBe('active');
    await runtime.stop('command.test.plugin');
    await expectGenerationDisposed(runtime, 'command.test.plugin');
    await runtime.dispose();
    resources.expectNoLeaks();
  });
});
