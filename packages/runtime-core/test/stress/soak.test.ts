// 10k-operation soak: one runtime, observers attached (one of
// them throwing on every event), thousands of install/start/stop/replace/
// uninstall cycles across a rotating plugin pool that includes multi-provider
// aggregation and a dependent consumer. The assertions are the bounded-memory
// statement — diagnostic ring buffers stay at capacity no matter
// how much history the run produces — plus the global baseline after
// final disposal. Deterministic via a seeded LCG; no real timers, no sleeps.

import { describe, expect, it } from 'vitest';

import type { PluginContext, PluginDefinition } from '../../src/definition.js';
import { capability, createRuntime } from '../../src/index.js';

const PLUGIN_SLOTS = 50;
const MULTI_PROVIDERS = 3;
const OPERATIONS = 10_000;
const LCG_SEED = 0x2f6e2b1;
const DIAGNOSTIC_CAPACITY = 100;

// Deterministic LCG — the soak must replay identically everywhere.
let lcgState = LCG_SEED >>> 0;
function nextRandom(modulus: number): number {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
  return lcgState % modulus;
}

const counters = { acquired: 0, released: 0 };

function soakDefinition(index: number): PluginDefinition {
  const id = `soak.p${String(index).padStart(2, '0')}`;
  const cap = capability<{ readonly index: number }>(`soak.cap.p${String(index)}`, '1.0.0');
  return {
    id,
    version: '1.0.0',
    provides: [{ capability: cap }],
    setup: async (context: PluginContext) => {
      counters.acquired += 1;
      await context.scope.acquire(
        () => ({ id }),
        () => {
          counters.released += 1;
        },
      );
      for (let entry = 0; entry < 3; entry += 1) {
        context.diagnose({ message: `${id} diagnostic ${String(entry)}`, severity: 'info' });
      }
      context.provide(cap, { index });
    },
  };
}

/** The resident multi-provider trio and their dependent consumer. */
function specialDefinition(id: string): PluginDefinition {
  const acquire = async (context: PluginContext): Promise<void> => {
    counters.acquired += 1;
    await context.scope.acquire(
      () => ({ id }),
      () => {
        counters.released += 1;
      },
    );
  };
  if (id === 'soak.consumer') {
    const cap = capability<readonly number[]>('soak.multi', '1.0.0', { multiple: true });
    return {
      id,
      version: '1.0.0',
      requires: [{ capability: cap, range: '^1.0.0' }],
      setup: async (context: PluginContext) => {
        await acquire(context);
        void context.require(cap);
      },
    };
  }
  const index = Number(id.slice('soak.m'.length));
  const cap = capability<readonly number[]>('soak.multi', '1.0.0', { multiple: true });
  return {
    id,
    version: '1.0.0',
    provides: [{ capability: cap }],
    setup: async (context: PluginContext) => {
      await acquire(context);
      context.provide(cap, [index]);
    },
  };
}

describe('INV-12: 10k-operation soak with bounded diagnostics', () => {
  it(
    'diagnostic logs stay bounded through 10,000 operations and resources return to baseline',
    { timeout: 600_000 },
    async () => {
      const runtime = createRuntime();
      runtime.subscribe(() => undefined); // silent observer
      runtime.subscribe(() => {
        throw new Error('injected observer failure'); // never breaks outcomes
      });

      const factories = new Map<string, () => PluginDefinition>();
      for (let index = 0; index < PLUGIN_SLOTS; index += 1) {
        const id = `soak.p${String(index).padStart(2, '0')}`;
        factories.set(id, () => soakDefinition(index));
      }
      for (let index = 0; index < MULTI_PROVIDERS; index += 1) {
        const id = `soak.m${String(index)}`;
        factories.set(id, () => specialDefinition(id));
      }
      factories.set('soak.consumer', () => specialDefinition('soak.consumer'));
      const targets = [...factories.keys()];

      // Lightweight validity gating — the soak asserts boundedness and leaks;
      // the model-based suite owns semantics. Refreshed from engine truth
      // after every mutation that can touch more than one plugin (cascade).
      const states = new Map<string, 'installed' | 'active' | 'stopped'>();
      const syncStates = (): void => {
        for (const [id] of states) {
          const status = runtime.getStatus(id);
          states.set(
            id,
            status === 'active' ? 'active' : status === 'installed' ? 'installed' : 'stopped',
          );
        }
      };

      // The multi providers and their consumer stay resident so aggregation
      // paths run under load; the plugin pool churns around them.
      for (const id of targets) {
        if (id.startsWith('soak.p')) {
          continue;
        }
        const factory = factories.get(id);
        if (factory === undefined) {
          throw new Error(`soak factory missing for ${id}`);
        }
        runtime.install(factory());
        states.set(id, 'installed');
      }

      for (let step = 0; step < OPERATIONS; step += 1) {
        const kind = nextRandom(100);
        const id = targets[nextRandom(targets.length)];
        if (id === undefined) {
          throw new Error('soak target pool lost an id');
        }
        const factory = factories.get(id);
        if (factory === undefined) {
          throw new Error(`soak factory missing for ${id}`);
        }
        const status = states.get(id);

        if (kind < 25) {
          if (status === undefined) {
            runtime.install(factory());
            states.set(id, 'installed');
          }
        } else if (kind < 55) {
          if (status === 'installed' || status === 'stopped') {
            await runtime
              .start(id)
              .then(() => {
                states.set(id, 'active');
              })
              .catch(() => {
                syncStates();
              });
          }
        } else if (kind < 75) {
          if (status === 'active') {
            const cascade = nextRandom(2) === 0;
            // A non-cascade stop over dependents rejects structurally — a
            // valid soak outcome. Rejections are swallowed deliberately:
            // the state map is refreshed from engine truth either way.
            await runtime.stop(id, cascade ? { cascade: true } : undefined).catch(() => undefined);
            syncStates();
          }
        } else if (kind < 90) {
          if (status !== undefined) {
            await runtime.replace(factory()).catch(() => undefined);
            syncStates();
          }
        } else {
          if (status === 'installed' || status === 'stopped') {
            await runtime.uninstall(id);
            states.delete(id);
          }
        }

        if ((step + 1) % 1000 === 0) {
          const inspection = runtime.inspect();
          expect(inspection.observerDiagnostics.length).toBeLessThanOrEqual(DIAGNOSTIC_CAPACITY);
          for (const plugin of inspection.plugins) {
            if (plugin.diagnostics !== undefined) {
              expect(plugin.diagnostics.length).toBeLessThanOrEqual(DIAGNOSTIC_CAPACITY);
            }
          }
        }
      }

      await runtime.dispose();
      expect(counters.acquired).toBe(counters.released); // INV-12 global baseline
      expect(
        runtime
          .inspect()
          .plugins.every((plugin) => plugin.status === 'stopped' || plugin.status === 'installed'),
      ).toBe(true);
    },
  );
});
