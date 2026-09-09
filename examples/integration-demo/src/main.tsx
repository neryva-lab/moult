/**
 * Production-style host: Vite and React wired to every Moult public export —
 * typed capabilities, host providers (logger, configuration, event bus
 * factory), generation-scoped React contributions, the HMR bridge, the
 * observer bus with failure isolation, cascade stops, a diagnostics viewer,
 * and generation-guarded callbacks. Covered end to end by
 * `test/integration.test.tsx`.
 */
import { createEventBus } from '@moult/events';
import {
  ContributionErrorBoundary,
  guardGenerationCallback,
  reactRoute,
  reactWidget,
  RuntimeProvider,
  useContributions,
  useContributionEntries,
} from '@moult/react';
import { createRuntime } from '@moult/runtime';
import { createViteBridge } from '@moult/vite';
import type { ViteHotSource, VitePluginUpdate } from '@moult/vite';
import { createElement, StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import type { DemoEvents } from './plugins/definitions.js';
import {
  analyticsPluginA,
  analyticsPluginB,
  cascadeDependentPlugin,
  cascadeRootPlugin,
  configConsumerPlugin,
  consumerMultiPlugin,
  dashboardPlugin,
  demoBannerKey,
  demoToastKey,
  eventBusCapability,
  hostEventFactory,
  notificationConsumerPlugin,
  optionalConsumerPlugin,
  storagePlugin,
  widgetPlugin,
} from './plugins/definitions.js';
import {
  cascadeRootCapability,
  hostConfigCapability,
  hostLoggerCapability,
  storageCapability,
} from './plugins/storage.js';

// Runtime with host providers. Runtimes share nothing; this
// instance owns its providers and event bus.
export const runtime = createRuntime({
  providers: [
    { capability: hostLoggerCapability, value: { log: (m: string) => console.log('[host]', m) } },
    { capability: hostConfigCapability, value: { env: 'production' } },
    // Single-provider host factory; plugins consume it by id.
    { capability: eventBusCapability, value: hostEventFactory() },
  ],
});

// Independent bus for host-level events outside the capability graph.
export const demoBus = createEventBus<DemoEvents>('sync');

// Observer pair: the primary records lifecycle events, the secondary records
// failures and stops. Observer failures are isolated and surface through
// inspect().observerDiagnostics.
export const observerLog: string[] = [];
export const observerDiagnosticsLog: string[] = [];
export const unsubscribePrimary = runtime.subscribe((event) => {
  observerLog.push(`${event.type}:${event.pluginId ?? ''}:${event.generation ?? ''}`);
  if (event.type === 'started' && event.pluginId === 'demo.widget') {
    // Thrown once so the log stays readable; confirms the secondary observer
    // still runs after the primary throws.
    if (observerLog.filter((l) => l.startsWith('started:demo.widget')).length === 1) {
      throw new Error('intentional observer failure');
    }
  }
});
export const unsubscribeSecondary = runtime.subscribe((event) => {
  if (event.type === 'failed' || event.type === 'stopped' || event.type === 'replaced') {
    observerDiagnosticsLog.push(`${event.type}:${event.pluginId ?? ''}`);
  }
});

// Vite HMR bridge: update events delegate to runtime install and replace,
// so failed updates keep the old generation.
type Hot = {
  on: (e: string, cb: (m: unknown) => void) => void;
  off: (e: string, cb: (m: unknown) => void) => void;
};
const viteHot = (import.meta as unknown as { hot?: Hot }).hot;
const hotSource: ViteHotSource = {
  on: (event, listener) => {
    if (viteHot === undefined) return () => undefined;
    // The bridge normalizes to added, changed, and removed; Vite's native
    // event names differ.
    const viteEvent = event === 'changed' ? 'vite:beforeUpdate' : event;
    const wrapped = (payload: unknown) => void listener(payload as VitePluginUpdate);
    viteHot.on(viteEvent, wrapped);
    return () => viteHot.off(viteEvent, wrapped);
  },
};

export const viteDiagnostics: unknown[] = [];
export const bridge = createViteBridge({
  runtime,
  hot: hotSource,
  diagnose: (err) => {
    viteDiagnostics.push(err);
    // eslint-disable-next-line no-console
    console.error('[vite diagnose]', err.code, err.pluginId, err.cause);
  },
});

// Install phase: the host installs the full graph before starting.
// Install order is insignificant; the resolver orders at start.
runtime.install(storagePlugin('1.0.0'));
runtime.install(analyticsPluginA());
runtime.install(analyticsPluginB());
runtime.install(consumerMultiPlugin());
runtime.install(optionalConsumerPlugin());
runtime.install(configConsumerPlugin());
runtime.install(widgetPlugin('1.0.0'));
runtime.install(cascadeRootPlugin());
runtime.install(cascadeDependentPlugin());
runtime.install(dashboardPlugin());
runtime.install(notificationConsumerPlugin());

// Activation: sequential start; per-plugin queueing prevents deadlock.
void (async () => {
  await runtime.start('demo.storage');
  await runtime.start('demo.analytics-a');
  await runtime.start('demo.analytics-b');
  await runtime.start('demo.consumer-multi');
  await runtime.start('demo.optional-consumer');
  await runtime.start('demo.config-consumer');
  await runtime.start('demo.cascade-root');
  await runtime.start('demo.cascade-dependent');
  await runtime.start('demo.widget');
  await runtime.start('demo.dashboard');
  await runtime.start('demo.notification-consumer');
  // contributions() exposes committed entries only, never staged ones.
  // eslint-disable-next-line no-console
  console.log('[contributions banner]', runtime.contributions().entries.get(demoBannerKey.id));
  // eslint-disable-next-line no-console
  console.log('[contributions toast]', runtime.contributions().entries.get(demoToastKey.id));
  // eslint-disable-next-line no-console
  console.log(
    '[inspect blockedBy]',
    runtime.inspect().plugins.map((p) => [p.id, p.blockedBy]),
  );
  // eslint-disable-next-line no-console
  console.log('[observerDiagnostics]', runtime.inspect().observerDiagnostics);
  // eslint-disable-next-line no-console
  console.log('[capabilities]', runtime.inspect().capabilities);
})();

// Helpers used by the React shell.
function useRuntimeSnapshot() {
  // Subscribes without the React adapter, against the public subscribe API.
  const subscribe = (cb: () => void) => runtime.subscribe(() => cb());
  const getSnapshot = () => runtime.inspect();
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// React shell covering every React export, with per-slot error isolation.
function WidgetList() {
  const widgets = useContributions(reactWidget);
  const entries = useContributionEntries(reactWidget);
  return createElement(
    'div',
    { 'data-testid': 'widgets' },
    `entries:${entries.length} `,
    widgets.map((w, i) =>
      createElement(
        ContributionErrorBoundary,
        {
          key: entries[i]?.generationId ?? String(i),
          fallback: createElement('span', { 'data-testid': `widget-fallback-${i}` }, 'fallback'),
          onError: (e) => {
            // eslint-disable-next-line no-console
            console.error('[boundary widget]', e);
            observerDiagnosticsLog.push(`boundary:${String((e as Error).message)}`);
          },
        },
        createElement(w.component),
      ),
    ),
  );
}

function RouteList() {
  const routes = useContributions(reactRoute);
  const toasts = useContributions(demoToastKey);
  return createElement(
    'div',
    { 'data-testid': 'routes' },
    routes.map((r) => r.path).join(','),
    toasts.length > 0
      ? createElement('span', { 'data-testid': 'toast' }, toasts[0]?.message)
      : null,
  );
}

function DiagnosticsPanel() {
  const snap = useRuntimeSnapshot();
  const overflow = snap.plugins.find((p) => p.id === 'demo.diagnostics-spam')?.diagnostics;
  return createElement(
    'details',
    { 'data-testid': 'diagnostics' },
    createElement('summary', null, `diagnostics ${snap.plugins.length} plugins`),
    overflow !== undefined
      ? createElement('span', null, `diagnostics:${String(overflow.length)}`)
      : null,
    createElement(
      'ul',
      null,
      snap.plugins.map((p) =>
        createElement('li', { key: p.id }, `${p.id}:${p.status}:${p.generation ?? '-'}`),
      ),
    ),
    createElement(
      'ul',
      { 'data-testid': 'capabilities-list' },
      snap.capabilities.map((c) =>
        createElement(
          'li',
          { key: `${c.id}:${c.provider}` },
          `${c.id}@${c.version} via ${c.provider}`,
        ),
      ),
    ),
  );
}

function App() {
  const storageProvider =
    runtime.inspect().capabilities.find((c) => c.id === storageCapability.id)?.provider ??
    'unknown';
  const widgetEntries = useContributionEntries(reactWidget);
  const firstGen = widgetEntries[0]?.generationId ?? '';
  // Stale generation callbacks become no-ops after replace or dispose; the
  // stale path reports instead of running.
  const onStaleLog: string[] = [];
  const onClick = guardGenerationCallback(
    runtime,
    firstGen,
    () => {
      // eslint-disable-next-line no-console
      console.log('click ok');
      return 'ok';
    },
    () => {
      // eslint-disable-next-line no-console
      console.warn('stale generation click ignored');
      onStaleLog.push('stale');
      observerDiagnosticsLog.push('stale');
    },
  );

  return createElement(
    'div',
    null,
    createElement(
      'h1',
      null,
      `Moult demo — storage: ${storageProvider} cascade: ${cascadeRootCapability.id}`,
    ),
    createElement(
      'button',
      { onClick: () => onClick?.(), 'data-testid': 'guarded-btn' },
      'guarded click',
    ),
    createElement(WidgetList),
    createElement(RouteList),
    createElement(DiagnosticsPanel),
    createElement('pre', { 'data-testid': 'observer-log' }, observerLog.join('\n')),
  );
}

const rootEl = document.getElementById('root');
if (rootEl !== null) {
  createRoot(rootEl).render(
    createElement(
      StrictMode,
      null,
      createElement(RuntimeProvider, { runtime }, createElement(App)),
    ),
  );
}

// Host cascade control: stopping a provider with dependents requires the
// explicit cascade flag.
export async function stopCascadeRoot(): Promise<void> {
  await runtime.stop('demo.cascade-root', { cascade: true });
}
