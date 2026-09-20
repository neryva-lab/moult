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

  it('F22: guardGenerationCallback builds its liveness cache with one inspect() per runtime', async () => {
    const makeActive = async (id: string) => {
      const runtime = createRuntime();
      runtime.install({ id, version: '1.0.0', setup: () => {} });
      await runtime.start(id);
      const generation = runtime.inspect().plugins.find((entry) => entry.id === id)?.generation;
      if (generation === undefined) throw new Error(`expected an active generation for ${id}`);
      return { runtime, generation };
    };
    const first = await makeActive('guard.cache.first');
    const second = await makeActive('guard.cache.second');
    const firstSpy = vi.spyOn(first.runtime, 'inspect');
    const secondSpy = vi.spyOn(second.runtime, 'inspect');
    const calls: string[] = [];
    const firstGuard = guardGenerationCallback(first.runtime, first.generation, (value: string) => {
      calls.push(`first:${value}`);
    });
    const staleGuard = guardGenerationCallback(
      first.runtime,
      'guard.cache.unknown',
      (value: string) => {
        calls.push(`stale:${value}`);
      },
    );
    const secondGuard = guardGenerationCallback(
      second.runtime,
      second.generation,
      (value: string) => {
        calls.push(`second:${value}`);
      },
    );
    for (let i = 0; i < 10; i += 1) {
      firstGuard('a');
      staleGuard('b');
      secondGuard('c');
    }
    // One inspect() per runtime for the initial populate; every guarded
    // invocation after that is served from the event-kept cache.
    expect(firstSpy).toHaveBeenCalledTimes(1);
    expect(secondSpy).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.startsWith('first:'))).toHaveLength(10);
    expect(calls.filter((call) => call.startsWith('second:'))).toHaveLength(10);
    expect(calls.some((call) => call.startsWith('stale:'))).toBe(false);
    await first.runtime.dispose();
    await second.runtime.dispose();
  });

  it('F22: guarded callbacks follow replacement through events, without inspect()', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'guard.replace.plugin', version: '1.0.0', setup: () => {} });
    await runtime.start('guard.replace.plugin');
    const oldGeneration = runtime
      .inspect()
      .plugins.find((entry) => entry.id === 'guard.replace.plugin')?.generation;
    if (oldGeneration === undefined) throw new Error('expected an active generation');
    const calls: string[] = [];
    const stale: string[] = [];
    const oldGuard = guardGenerationCallback(
      runtime,
      oldGeneration,
      (value: string) => calls.push(`old:${value}`),
      () => stale.push('old'),
    );
    await runtime.replace({ id: 'guard.replace.plugin', version: '2.0.0', setup: () => {} });
    const newGeneration = runtime
      .inspect()
      .plugins.find((entry) => entry.id === 'guard.replace.plugin')?.generation;
    if (newGeneration === undefined) throw new Error('expected a replacement generation');
    expect(newGeneration).not.toBe(oldGeneration);
    const inspectSpy = vi.spyOn(runtime, 'inspect');
    const newGuard = guardGenerationCallback(runtime, newGeneration, (value: string) =>
      calls.push(`new:${value}`),
    );
    oldGuard('x');
    newGuard('y');
    oldGuard('z');
    // The old generation went stale and the new one is live purely from the
    // 'replaced' event stream — no inspect() snapshot was built.
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(calls).toEqual(['new:y']);
    expect(stale).toEqual(['old', 'old']);
    await runtime.dispose();
  });

  it('F22: useContributions returns a referentially stable array across re-renders', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'guard.stable.plugin',
      version: '1.0.0',
      setup: (context: PluginContext) => {
        context.contribute(reactWidget, {
          component: () => createElement('span', null, 'stable'),
        });
      },
    });
    await runtime.start('guard.stable.plugin');
    const seen: Array<readonly unknown[]> = [];
    function StableProbe(): ReactElement {
      const widgets = useContributions(reactWidget);
      seen.push(widgets);
      return createElement('output', null, String(widgets.length));
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(RuntimeProvider, { runtime }, createElement(StableProbe)));
    });
    act(() => {
      root.render(createElement(RuntimeProvider, { runtime }, createElement(StableProbe)));
    });
    expect(container.textContent).toBe('1');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const widgets of seen) {
      expect(widgets).toBe(seen[0]);
    }
    await act(async () => {
      await runtime.dispose();
    });
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });
});
