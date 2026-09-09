import { createEventBus, eventBusFactory } from '@moult/events';
import { reactRoute, reactWidget } from '@moult/react';
import type { PluginContext, PluginDefinition } from '@moult/runtime';
import { contributionKey } from '@moult/runtime';
import { capability } from '@moult/runtime';
import { createElement } from 'react';

import {
  analyticsCapability,
  cascadeRootCapability,
  hostConfigCapability,
  notificationCapability,
  optionalLoggerCapability,
  storageCapability,
  versionedCapability,
} from './storage.js';

export type DemoEvents = {
  readonly tick: { readonly seq: number };
  readonly alert: { readonly msg: string };
};

export const eventBusCapability = capability<ReturnType<typeof eventBusFactory<DemoEvents>>>(
  'demo.events',
  '1.0.0',
);

export const demoBannerKey = contributionKey<{ text: string }>('demo.banner');

export const demoToastKey = contributionKey<{ message: string }>('demo.toast');

/** Host-provided event bus factory; the host owns the delivery mode. */
export function hostEventFactory() {
  return eventBusFactory<DemoEvents>('sync');
}

/** Direct synchronous bus for generation-scoped subscription coverage. */
function directBus() {
  return createEventBus<DemoEvents>('sync');
}

/**
 * Single-provider storage plugin: owns a Map, observes the abort signal,
 * and returns a disposer adopted before commit.
 */
export function storagePlugin(version = '1.0.0'): PluginDefinition {
  return {
    id: 'demo.storage',
    version,
    provides: [{ capability: storageCapability }],
    setup: (ctx: PluginContext) => {
      const map = new Map<string, string>();
      ctx.diagnose({ message: `storage ${version} setup`, details: { version }, severity: 'info' });
      // Registered before the acquire below; scope disposal runs LIFO.
      const order: string[] = [];
      ctx.scope.onDispose(() => {
        order.push('onDispose-outer');
      });
      // Owned resource: the disposer runs at scope disposal.
      void ctx.scope.acquire(
        () => {
          return { map, order };
        },
        (res) => {
          res.order.push('acquire-dispose');
          res.map.clear();
        },
      );
      ctx.scope.onDispose(() => {
        order.push('onDispose-inner');
      });

      // Long-running work observes the abort signal.
      ctx.signal.addEventListener(
        'abort',
        () => {
          order.push('aborted');
        },
        { once: true },
      );

      ctx.provide(storageCapability, {
        get: (k) => map.get(k),
        set: (k, v) => map.set(k, v),
      });

      // Returned disposers are adopted before commit, so validation failure
      // still runs cleanup.
      return {
        dispose: () => {
          order.push('returned-dispose');
        },
      };
    },
  };
}

/** First multi-provider analytics publisher (array value). */
export function analyticsPluginA(): PluginDefinition {
  return {
    id: 'demo.analytics-a',
    version: '1.0.0',
    provides: [{ capability: analyticsCapability, multiple: true }],
    setup: (ctx) => {
      // Multi-provider tokens publish arrays.
      ctx.provide(analyticsCapability, ['a:pageview']);
    },
  };
}

export function analyticsPluginB(): PluginDefinition {
  return {
    id: 'demo.analytics-b',
    version: '1.0.0',
    provides: [{ capability: analyticsCapability, multiple: true }],
    setup: (ctx) => {
      ctx.provide(analyticsCapability, ['b:click']);
    },
  };
}

export function consumerMultiPlugin(): PluginDefinition {
  return {
    id: 'demo.consumer-multi',
    version: '1.0.0',
    requires: [{ capability: analyticsCapability, range: '^1.0.0' }],
    setup: (ctx) => {
      const all = ctx.require(analyticsCapability);
      // The frozen concatenation of every selected provider, host first.
      ctx.diagnose({ message: `multi got ${all.join(',')}` });
      if (!Array.isArray(all)) throw new Error('multi not array');
      if (!Object.isFrozen(all)) throw new Error('multi should be frozen');
    },
  };
}

/** Consumer of an optional dependency; absence resolves to undefined without blocking activation. */
export function optionalConsumerPlugin(): PluginDefinition {
  return {
    id: 'demo.optional-consumer',
    version: '1.0.0',
    requires: [{ capability: optionalLoggerCapability, range: '^1.0.0', optional: true }],
    setup: (ctx) => {
      const logger = ctx.optional(optionalLoggerCapability);
      // Absent optional requirements resolve to undefined without throwing.
      ctx.diagnose({ message: logger === undefined ? 'optional absent' : 'optional present' });
    },
  };
}

/**
 * Widget plugin: requires storage, contributes React and demo contributions,
 * and holds a generation-scoped event subscription.
 */
export function widgetPlugin(version = '1.0.0'): PluginDefinition {
  return {
    id: 'demo.widget',
    version,
    requires: [{ capability: storageCapability, range: '^1.0.0' }],
    setup: (ctx: PluginContext) => {
      const storage = ctx.require(storageCapability);
      storage.set('mounted', version);
      // Contributions stay staged until commit and are invisible before it.
      ctx.contribute(reactWidget, {
        label: `demo-widget-${version}`,
        component: () => createElement('span', null, `widget:${version}:${storage.get('mounted')}`),
      });
      ctx.contribute(reactRoute, {
        path: `/widget-${version}`,
        component: () => createElement('div', null, `route:${version}`),
      });
      ctx.contribute(demoBannerKey, { text: `banner:${version}` });

      // Subscription owned by the generation scope.
      const bus = directBus();
      bus.on(ctx.scope, 'tick', (p) => {
        storage.set('tick', String(p.seq));
      });
      void bus.emit('tick', { seq: 1 });
    },
  };
}

/** Consumer of the host configuration provider, with an optional logger. */
export function configConsumerPlugin(): PluginDefinition {
  return {
    id: 'demo.config-consumer',
    version: '1.0.0',
    requires: [
      { capability: hostConfigCapability, range: '^1.0.0' },
      { capability: optionalLoggerCapability, range: '^1.0.0', optional: true },
    ],
    setup: (ctx) => {
      const cfg = ctx.require(hostConfigCapability);
      ctx.diagnose({ message: `config env=${cfg.env}` });
      // The optional host logger resolves when present; its absence is valid.
      const maybeLogger = ctx.optional(optionalLoggerCapability);
      void maybeLogger;
    },
  };
}

/**
 * Dashboard plugin: consumes storage, host configuration, and the host event
 * bus factory, and provides the notification capability.
 */
export function dashboardPlugin(): PluginDefinition {
  return {
    id: 'demo.dashboard',
    version: '1.0.0',
    requires: [
      { capability: storageCapability, range: '^1.0.0' },
      { capability: hostConfigCapability, range: '^1.0.0' },
    ],
    provides: [{ capability: notificationCapability }],
    setup: (ctx) => {
      const storage = ctx.require(storageCapability);
      const config = ctx.require(hostConfigCapability);
      ctx.diagnose({ message: `dashboard env=${config.env}`, severity: 'info' });
      storage.set('dashboard:ready', 'true');

      ctx.provide(notificationCapability, {
        notify: (msg: string) => {
          // Generation-scoped delivery: hosts guard stale callbacks with
          // guardGenerationCallback.
          ctx.diagnose({ message: `notify:${msg}`, severity: 'info' });
        },
      });

      // Only the toast is contributed; the widget and route keys are owned by
      // the widget plugin, and one key has exactly one owner.
      ctx.contribute(demoToastKey, { message: `welcome ${config.env}` });

      // Event bus from the host factory (host-provider pattern). The
      // subscription below is generation-scoped.
      const bus = createEventBus<DemoEvents>('sync');
      bus.on(ctx.scope, 'alert', (p) => {
        storage.set('last-alert', p.msg);
      });
    },
  };
}

/** Consumer of the dashboard notification capability. */
export function notificationConsumerPlugin(): PluginDefinition {
  return {
    id: 'demo.notification-consumer',
    version: '1.0.0',
    requires: [{ capability: notificationCapability, range: '^1.0.0' }],
    setup: (ctx) => {
      const svc = ctx.require(notificationCapability);
      svc.notify('consumer-mounted');
      ctx.diagnose({ message: 'notification consumer active' });
    },
  };
}

/** Cascade root: stopping it with cascade stops its dependents. */
export function cascadeRootPlugin(): PluginDefinition {
  return {
    id: 'demo.cascade-root',
    version: '1.0.0',
    provides: [{ capability: cascadeRootCapability }],
    setup: (ctx) => {
      ctx.provide(cascadeRootCapability, { id: 'root' });
    },
  };
}

export function cascadeDependentPlugin(): PluginDefinition {
  return {
    id: 'demo.cascade-dependent',
    version: '1.0.0',
    requires: [{ capability: cascadeRootCapability, range: '^1.0.0' }],
    setup: (ctx) => {
      void ctx.require(cascadeRootCapability);
      ctx.diagnose({ message: 'cascade dependent active' });
    },
  };
}

/** Floods the diagnostic log; the capped log retains the newest 100 entries. */
export function diagnosticsSpamPlugin(): PluginDefinition {
  return {
    id: 'demo.diagnostics-spam',
    version: '1.0.0',
    setup: (ctx) => {
      for (let i = 0; i < 150; i += 1) {
        ctx.diagnose({ message: `spam-${i}`, details: { index: i }, severity: 'info' });
      }
    },
  };
}

/** Disposal coverage: LIFO order with continue-on-error. */
export function disposalStressPlugin(): PluginDefinition {
  return {
    id: 'demo.disposal-stress',
    version: '1.0.0',

    setup: async (ctx) => {
      const order: string[] = [];
      await ctx.scope.acquire(
        () => ({ id: 1 }),
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => {
          order.push('dispose-1');
          throw new Error('disposer-1 fail');
        },
      );
      await ctx.scope.acquire(
        () => ({ id: 2 }),
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => {
          order.push('dispose-2');
        },
      );
      ctx.scope.onDispose(() => {
        order.push('onDispose-3');
      });
      ctx.diagnose({ message: 'disposal stress setup', details: { order: order.join(',') } });
    },
  };
}

/** Failing storage candidate; replacement keeps the old generation. */
export function brokenStoragePlugin(version = '2.0.0'): PluginDefinition {
  return {
    id: 'demo.storage',
    version,
    provides: [{ capability: storageCapability }],
    setup: () => {
      throw new Error(`broken storage ${version}`);
    },
  };
}

/** Healthy storage candidate used after a failed replacement. */
export function fixedStoragePlugin(version = '2.0.0'): PluginDefinition {
  return storagePlugin(version);
}

/** Versioned provider for INCOMPATIBLE_CAPABILITY resolution coverage. */
export function versionedProviderPlugin(version: string): PluginDefinition {
  return {
    id: 'demo.versioned-provider',
    version,
    provides: [{ capability: versionedCapability }],
    setup: (ctx) => ctx.provide(versionedCapability, { v: Number.parseInt(version, 10) }),
  };
}

/** First half of the dependency-cycle pair (DEPENDENCY_CYCLE coverage). */
export function cycleAPlugin(): PluginDefinition {
  const capA = capability<{ v: string }>('demo.cycle-a', '1.0.0');
  const capB = capability<{ v: string }>('demo.cycle-b', '1.0.0');
  return {
    id: 'demo.cycle-a',
    version: '1.0.0',
    provides: [{ capability: capA }],
    requires: [{ capability: capB, range: '^1.0.0' }],
    setup: (ctx) => ctx.provide(capA, { v: 'a' }),
  };
}
export function cycleBPlugin(): PluginDefinition {
  const capA = capability<{ v: string }>('demo.cycle-a', '1.0.0');
  const capB = capability<{ v: string }>('demo.cycle-b', '1.0.0');
  return {
    id: 'demo.cycle-b',
    version: '1.0.0',
    provides: [{ capability: capB }],
    requires: [{ capability: capA, range: '^1.0.0' }],
    setup: (ctx) => ctx.provide(capB, { v: 'b' }),
  };
}
