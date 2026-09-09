// Resolution budget stress: 1,000+ definitions resolve within a
// loose ceiling — the resolver is O(V+E) and a quadratic regression trips
// this. The plan construction is measured directly on the resolver (it is a
// pure function), and the resolved graph is then activated end-to-end to
// prove the plan is executable, not merely fast. Deterministic construction: a
// layered DAG where every capability has exactly one provider, so no
// ambiguity can distort the measurement.

import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { capability } from '../../src/capability.js';
import type { PluginDefinition, PluginStatus } from '../../src/definition.js';
import { createRuntime } from '../../src/index.js';
import type { HostProvider } from '../../src/resolver.js';
import { resolve } from '../../src/resolver.js';

const LAYERS = 50;
const PER_LAYER = 20;
const TOTAL = LAYERS * PER_LAYER + 1; // + the root

interface LayerPlugin {
  readonly id: string;
  readonly capabilityId: string;
  readonly requires: readonly string[]; // capability ids from the previous layer
}

/** Deterministic layered DAG: layer k requires 1–2 capabilities from layer k−1. */
function buildGraph(): LayerPlugin[] {
  const plugins: LayerPlugin[] = [];
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let slot = 0; slot < PER_LAYER; slot += 1) {
      const id = `stress.l${String(layer).padStart(2, '0')}p${String(slot).padStart(2, '0')}`;
      const capabilityId = `cap.${id}`;
      const requires: string[] = [];
      if (layer > 0) {
        // Deterministic 1–2 requirements into the previous layer.
        const first = (slot * 7 + layer * 3) % PER_LAYER;
        requires.push(
          `cap.stress.l${String(layer - 1).padStart(2, '0')}p${String(first).padStart(2, '0')}`,
        );
        if (slot % 3 === 0) {
          const second = (first + 5) % PER_LAYER;
          requires.push(
            `cap.stress.l${String(layer - 1).padStart(2, '0')}p${String(second).padStart(2, '0')}`,
          );
        }
      }
      plugins.push({ id, capabilityId, requires });
    }
  }
  return plugins;
}

function toDefinition(plugin: LayerPlugin): PluginDefinition {
  const providedCapability = capability(plugin.capabilityId, '1.0.0');
  const requires = plugin.requires.map((capabilityId) => ({
    capability: capability(capabilityId, '1.0.0'),
    range: '^1.0.0',
  }));
  return {
    id: plugin.id,
    version: '1.0.0',
    ...(requires.length > 0 ? { requires } : {}),
    provides: [{ capability: providedCapability }],
    setup: (context) => {
      context.provide(providedCapability, { pluginId: plugin.id });
    },
  };
}

describe('resolution budget', () => {
  it(
    'INV-10: 1,000+ definitions resolve under the 100 ms ceiling, deterministically',
    { timeout: 120_000 },
    () => {
      const graph = buildGraph();
      const definitions = graph.map(toDefinition);
      expect(definitions.length).toBeGreaterThanOrEqual(1000);

      const statuses = new Map<string, PluginStatus>();
      for (const definition of definitions) {
        statuses.set(definition.id, 'installed');
      }
      const hostProviders = new Map<string, HostProvider>();
      // The root requires every capability of the last layer, so its closure
      // spans the whole graph — the walk cannot be shortcut.
      const root: PluginDefinition = {
        id: 'stress.root',
        version: '1.0.0',
        requires: graph
          .filter((plugin) => plugin.id.startsWith('stress.l49'))
          .map((plugin) => ({
            capability: capability(plugin.capabilityId, '1.0.0'),
            range: '^1.0.0',
          })),
        setup: () => undefined,
      };
      const allDefinitions = [...definitions, root];
      statuses.set(root.id, 'installed');

      const input = { definitions: allDefinitions, statuses, hostProviders, root: root.id };
      // Warm the pure resolver once so the budget measures steady-state plan
      // construction rather than one-time module/JIT initialization.
      resolve(input);
      const firstStart = performance.now();
      const plan = resolve(input);
      const elapsed = performance.now() - firstStart;

      expect(elapsed).toBeLessThan(100); // loose ceiling — a quadratic regression trips it
      expect(plan.order.length).toBe(TOTAL);
      expect(plan.order[plan.order.length - 1]).toBe(root.id); // root activates last

      // Determinism: the identical input produces the identical plan.
      const second = resolve(input);
      expect(second.order).toEqual(plan.order);
      expect(second.edges).toEqual(plan.edges);
    },
  );

  it(
    'INV-01/12: the resolved 1,000-plugin graph activates end-to-end and disposes to baseline',
    { timeout: 300_000 },
    async () => {
      const graph = buildGraph();
      const runtime = createRuntime();
      let activated = 0;
      let released = 0;
      for (const plugin of graph) {
        runtime.install({
          ...toDefinition(plugin),
          setup: (context) => {
            activated += 1;
            return context.scope
              .acquire(
                () => ({ plugin: plugin.id }),
                () => {
                  released += 1;
                },
              )
              .then(() => {
                context.provide(capability(plugin.capabilityId, '1.0.0'), {
                  pluginId: plugin.id,
                });
              });
          },
        });
      }
      runtime.install({
        id: 'stress.root',
        version: '1.0.0',
        requires: graph
          .filter((plugin) => plugin.id.startsWith('stress.l49'))
          .map((plugin) => ({
            capability: capability(plugin.capabilityId, '1.0.0'),
            range: '^1.0.0',
          })),
        setup: (context) => {
          activated += 1;
          void context;
        },
      });

      await runtime.start('stress.root');
      expect(activated).toBe(TOTAL);

      const inspection = runtime.inspect();
      const activeCount = inspection.plugins.filter((plugin) => plugin.status === 'active').length;
      expect(activeCount).toBe(TOTAL);

      await runtime.dispose();
      expect(released).toBe(graph.length); // root acquires no resource (INV-12)
      expect(runtime.inspect().plugins.every((plugin) => plugin.status === 'stopped')).toBe(true);
    },
  );
});
