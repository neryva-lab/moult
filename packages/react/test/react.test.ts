import type { PluginContext } from '@moult/runtime';
import { createRuntime } from '@moult/runtime';
import { expectGenerationDisposed, fakeResources } from '@moult/test';
import type { ErrorInfo, ReactElement } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ContributionErrorBoundary,
  guardGenerationCallback,
  reactWidget,
  RuntimeProvider,
  useContributions,
} from '../src/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function WidgetView(): ReactElement {
  const widgets = useContributions(reactWidget);
  return createElement(
    'output',
    null,
    widgets.map((widget, index) => createElement(widget.component, { key: index })),
  );
}

describe('React adapter (INV-06)', () => {
  it('INV-06: callbacks from a disposed generation become no-ops', async () => {
    const resources = fakeResources();
    const runtime = createRuntime();
    runtime.install({
      id: 'react.test.plugin',
      version: '1.0.0',
      setup: async (context) => {
        const resource = resources.listenerHost();
        await context.scope.acquire(resource.create, resource.dispose);
      },
    });
    await runtime.start('react.test.plugin');
    const generation = runtime
      .inspect()
      .plugins.find((entry) => entry.id === 'react.test.plugin')?.generation;
    if (generation === undefined) throw new Error('expected an active generation');
    const calls: string[] = [];
    const guarded = guardGenerationCallback(runtime, generation, (value: string) =>
      calls.push(value),
    );
    guarded('before');
    await runtime.stop('react.test.plugin');
    guarded('after');
    expect(calls).toEqual(['before']);
    await runtime.dispose();
    await expectGenerationDisposed(runtime, 'react.test.plugin');
    resources.expectNoLeaks();
  });

  it('contribution render errors are isolated and reported', () => {
    const errors: unknown[] = [];
    const boundary = new ContributionErrorBoundary({
      children: 'content',
      fallback: 'fallback',
      onError: (error) => errors.push(error),
    });
    const failure = new Error('component failure');
    const info = { componentStack: 'Contribution' } satisfies ErrorInfo;
    boundary.state = ContributionErrorBoundary.getDerivedStateFromError(failure);
    boundary.componentDidCatch(failure, info);
    expect(boundary.render()).toBe('fallback');
    expect(errors).toEqual([failure]);
  });

  it('INV-06/07: committed contribution output updates only after a successful replacement', async () => {
    const runtime = createRuntime();
    const definition = (version: string, fail = false) => ({
      id: 'react.render.plugin',
      version,
      setup: (context: PluginContext) => {
        context.contribute(reactWidget, {
          component: () => createElement('span', null, version),
        });
        if (fail) throw new Error('render candidate failed');
      },
    });
    runtime.install(definition('1.0.0'));
    await runtime.start('react.render.plugin');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(RuntimeProvider, { runtime }, createElement(WidgetView)));
    });
    expect(container.textContent).toBe('1.0.0');
    await act(async () => {
      try {
        await runtime.replace(definition('2.0.0', true));
      } catch {
        // The failed candidate must not alter the committed snapshot.
      }
    });
    expect(container.textContent).toBe('1.0.0');
    await act(async () => {
      await runtime.replace(definition('2.0.0'));
    });
    expect(container.textContent).toBe('2.0.0');
    await act(async () => {
      await runtime.dispose();
    });
    expect(container.textContent).toBe('');
    root.unmount();
    document.body.removeChild(container);
  });
});
