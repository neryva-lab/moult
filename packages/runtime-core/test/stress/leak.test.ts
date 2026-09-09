// Replace-100× leak zeroing — the user-visible statement of
// resource ownership with three resource kinds (event-like, timer-like, connection-like).
// Every tenth candidate fails after acquiring its resources (failed candidates
// are disposed, the old generation keeps serving); every twenty-fifth successful
// generation carries a throwing disposer, so the NEXT replacement commits and
// then records DISPOSAL_FAILED. The live count must return
// to exactly three resources after every operation and to zero after final
// disposal. Deterministic: acquisitions are awaited, no floating promises.

import { describe, expect, it } from 'vitest';

import type { PluginContext, PluginStatus } from '../../src/definition.js';
import { capability, createRuntime } from '../../src/index.js';

const CAP = capability<{ readonly generation: number }>('stress.storage', '1.0.0');
const REPLACEMENTS = 100;
const PROVIDER = 'stress.provider';
// One resource per kind, owned by the active generation at any time.
const LIVE_PER_GENERATION = 3;

const counters = {
  event: { acquired: 0, released: 0 },
  timer: { acquired: 0, released: 0 },
  connection: { acquired: 0, released: 0 },
};

function liveCount(): number {
  return (
    counters.event.acquired -
    counters.event.released +
    (counters.timer.acquired - counters.timer.released) +
    (counters.connection.acquired - counters.connection.released)
  );
}

async function acquireAll(context: PluginContext): Promise<void> {
  const acquireOne = async (
    kind: keyof typeof counters,
    create: () => Record<string, unknown>,
  ): Promise<void> => {
    counters[kind].acquired += 1;
    await context.scope.acquire(create, () => {
      counters[kind].released += 1;
    });
  };
  await acquireOne('event', () => ({ listeners: [], generation: context.generation }));
  await acquireOne('timer', () => ({ active: true, generation: context.generation }));
  await acquireOne('connection', () => ({ open: true, generation: context.generation }));
}

function providerDefinition(
  generation: number,
  options?: { readonly failSetup?: boolean; readonly failDispose?: boolean },
) {
  return {
    id: PROVIDER,
    version: `1.0.${String(generation)}`,
    provides: [{ capability: CAP }],
    setup: async (context: PluginContext) => {
      await acquireAll(context);
      if (options?.failSetup === true) {
        throw new Error(`injected candidate failure (generation ${generation})`);
      }
      context.provide(CAP, { generation });
      return options?.failDispose === true
        ? {
            dispose: () => {
              throw new Error(`injected disposer failure (generation ${generation})`);
            },
          }
        : undefined;
    },
  };
}

describe('INV-12: replace-100× leak zeroing with three resource kinds', () => {
  it(
    'counters return to baseline after every replacement, including injected failures and disposal failures',
    { timeout: 300_000 },
    async () => {
      const runtime = createRuntime();

      runtime.install(providerDefinition(0));
      await runtime.start(PROVIDER);
      expect(liveCount()).toBe(LIVE_PER_GENERATION);

      // Generation g is installed by successful iteration g (start installs
      // #1 for g = 0). The engine's counter advances once per candidate
      // preparation, successful or not, but a FAILED candidate leaves the old
      // generation in place — hence tracking the last successful generation.
      let lastSuccess = 0;
      for (let generation = 1; generation <= REPLACEMENTS; generation += 1) {
        const failCandidate = generation % 10 === 0;
        // The generation being replaced throws on disposal when its own
        // generation number % 25 === 0 — the replacement still commits and
        // records the DISPOSAL_FAILED diagnostic (INV-14).
        const expectDisposalFailure = lastSuccess % 25 === 0 && lastSuccess >= 1;
        const candidate = providerDefinition(generation, {
          failSetup: failCandidate,
          failDispose: generation % 25 === 0,
        });

        const inspection = (): {
          status: PluginStatus | undefined;
          generation: string | undefined;
          hasError: boolean;
        } => {
          const plugin = runtime.inspect().plugins.find((entry) => entry.id === PROVIDER);
          return {
            status: plugin?.status,
            generation: plugin?.generation,
            hasError: plugin !== undefined && 'error' in plugin,
          };
        };

        if (failCandidate) {
          // All candidate failures surface as REPLACEMENT_FAILED.
          await expect(runtime.replace(candidate)).rejects.toMatchObject({
            code: 'REPLACEMENT_FAILED',
          });
          const state = inspection();
          expect(liveCount()).toBe(LIVE_PER_GENERATION); // candidate disposed; old owning
          expect(state.status).toBe('active');
          expect(state.generation).toBe(`${PROVIDER}#${String(lastSuccess + 1)}`); // unchanged — the old one
          expect(state.hasError).toBe(true); // the failure is inspectable
          continue;
        }

        await runtime.replace(candidate);
        const state = inspection();
        expect(liveCount()).toBe(LIVE_PER_GENERATION); // old disposed, candidate owning
        expect(state.status).toBe('active');
        expect(state.generation).toBe(`${PROVIDER}#${String(generation + 1)}`);
        if (expectDisposalFailure) {
          expect(state.hasError).toBe(true); // committed anyway, failure inspectable
        } else {
          expect(state.hasError).toBe(false);
        }
        lastSuccess = generation;
      }

      // The binding stayed visible through every failed window — the old
      // generation served continuously.
      const lastInspection = runtime.inspect();
      expect(lastInspection.capabilities.some((entry) => entry.id === CAP.id)).toBe(true);

      await runtime.dispose();
      expect(liveCount()).toBe(0);
      expect(counters.event.acquired).toBe(counters.event.released);
      expect(counters.timer.acquired).toBe(counters.timer.released);
      expect(counters.connection.acquired).toBe(counters.connection.released);
    },
  );
});
