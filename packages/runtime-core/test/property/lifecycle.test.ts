// Model-based property suite: random worlds and random valid
// operation sequences drive the runtime; a minimal reference model
// (model.ts) predicts every observable outcome, and the public guarantees
// are asserted after every operation:
//
//   active plugin        → exactly one active generation
//   visible capability   → belongs to an active generation or host
//   visible contribution → belongs to an active generation
//   disposed generation  → owns zero live runtime resources
//   observer event log   → matches the model's predicted sequence
//   diagnostic logs      → bounded by capacity
//
// Seeds: CI pins FC_SEED for stability; unset means a fresh random seed each
// run (fast-check reports the seed on failure for exact replay).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { MoltError, Runtime } from '../../src/index.js';
import { capability, createRuntime, isMoltError } from '../../src/index.js';
import type { MintedWorld, Operation, PluginBehaviors, World } from './generators.js';
import { arbOperations, arbWorld, buildDefinition, mintTokens } from './generators.js';
import type { ModelEvent, ModelOutcome } from './model.js';
import { ModelRuntime } from './model.js';

const FIXED_SEED =
  process.env['FC_SEED'] !== undefined ? Number(process.env['FC_SEED']) : undefined;
const NUM_RUNS =
  process.env['FC_NUM_RUNS'] !== undefined ? Number(process.env['FC_NUM_RUNS']) : 100;

interface Harness {
  readonly runtime: Runtime;
  readonly model: ModelRuntime;
  readonly behaviors: PluginBehaviors;
  readonly minted: MintedWorld;
  readonly world: World;
  readonly engineEvents: ModelEvent[];
}

function compareOutcome(modelOutcome: ModelOutcome, engineError: unknown): void {
  if (modelOutcome.ok) {
    expect(engineError).toBeUndefined();
    return;
  }
  expect(isMoltError(engineError)).toBe(true);
  expect((engineError as MoltError).code).toBe(modelOutcome.code);
}

/**
 * The mechanized note-06 invariant list, evaluated through the public API
 * only (molt-testing rule: no private state). Called after every executed
 * operation, so any divergence pinpoints the operation that broke it.
 */
function assertInvariants(harness: Harness): void {
  const { runtime, model, behaviors, engineEvents, world } = harness;
  const inspection = runtime.inspect();
  expect(Object.isFrozen(inspection)).toBe(true);
  expect(Object.isFrozen(inspection.plugins)).toBe(true);

  // Plugin identity set and per-plugin status/generation/error projection.
  const engineIds = inspection.plugins.map((plugin) => plugin.id).sort();
  const modelIds = [...model.plugins.keys()].sort();
  expect(engineIds).toEqual(modelIds);
  for (const plugin of inspection.plugins) {
    const expected = model.plugins.get(plugin.id);
    expect(expected).toBeDefined();
    expect(plugin.status).toBe(expected?.status);
    expect(plugin.generation !== undefined).toBe(expected?.status === 'active');
    expect(plugin.generation).toBe(expected?.generation);
    expect('error' in plugin).toBe(expected?.hasError === true);
  }

  // Visible capabilities = committed bindings + host providers (INV-06).
  const engineCapabilities = inspection.capabilities
    .map((entry) => `${entry.id}|${entry.provider}|${entry.version}`)
    .sort();
  const modelCapabilities: string[] = [];
  for (const cap of world.capabilities) {
    if (cap.host) {
      modelCapabilities.push(`${cap.id}|(host)|${cap.hostVersion}`);
    }
  }
  for (const [capabilityId, byGeneration] of model.published) {
    for (const binding of byGeneration.values()) {
      modelCapabilities.push(`${capabilityId}|${binding.pluginId}|${binding.capabilityVersion}`);
    }
  }
  modelCapabilities.sort();
  expect(engineCapabilities).toEqual(modelCapabilities);
  // Every visible provider is an active generation or the host.
  for (const entry of inspection.capabilities) {
    if (entry.provider === '(host)') {
      continue;
    }
    expect(model.plugins.get(entry.provider)?.status).toBe('active');
  }

  // Contributions: committed owners only, exact values by identity.
  const snapshot = runtime.contributions();
  expect([...snapshot.entries.keys()].sort()).toEqual([...model.contributions.keys()].sort());
  for (const [keyId, entries] of snapshot.entries) {
    const expected = model.contributions.get(keyId);
    expect(expected?.size).toBe(entries.length);
    for (const entry of entries) {
      const expectedEntry = expected?.get(entry.generationId);
      expect(expectedEntry).toBeDefined();
      expect(entry.pluginId).toBe(expectedEntry?.pluginId);
      expect(entry.value).toBe(behaviors.contributionValues.get(expectedEntry?.valueRef ?? ''));
      expect(model.plugins.get(entry.pluginId)?.status).toBe('active');
    }
  }

  // Live resources are exactly the ones owned by active generations.
  const liveExpected = [...model.activationOrder].reduce(
    (sum, generationId) => sum + (model.genResources.get(generationId) ?? 0),
    0,
  );
  expect(behaviors.counters.acquired - behaviors.counters.released).toBe(liveExpected);

  // Observer events match the model, including generation ids and cascades.
  expect(engineEvents).toEqual(model.events);
  expect(behaviors.serveLog).toEqual(model.serves);

  // Diagnostic logs are bounded by capacity, never by history.
  for (const plugin of inspection.plugins) {
    if (plugin.diagnostics !== undefined) {
      expect(plugin.diagnostics.length).toBeLessThanOrEqual(100);
    }
  }
  expect(inspection.observerDiagnostics.length).toBeLessThanOrEqual(100);
}

/** Runs one operation against the model and the engine in lockstep. */
async function runOperation(
  harness: Harness,
  operation: Operation,
  opIndex: number,
): Promise<boolean> {
  const { runtime, model, behaviors, minted, world } = harness;
  const statusOf = (id: string): string | undefined => model.plugins.get(id)?.status;
  const worldPlugin = (id: string) => world.plugins.find((entry) => entry.id === id);
  const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  switch (operation.type) {
    case 'install': {
      if (model.plugins.has(operation.id)) {
        return false; // invalid op — dedicated unit tests cover the rejection
      }
      const plugin = worldPlugin(operation.id);
      if (plugin === undefined) {
        return false;
      }
      const definition = buildDefinition(plugin, world, minted, behaviors, opIndex);
      let engineError: unknown;
      try {
        runtime.install(definition);
      } catch (error) {
        engineError = error;
      }
      compareOutcome(model.install(plugin, opIndex), engineError);
      return true;
    }
    case 'start': {
      // The engine re-runs the definition it holds; the model holds the same
      // world content, so both sides replay identical setup behavior.
      const status = statusOf(operation.id);
      if (status !== 'installed' && status !== 'stopped') {
        return false;
      }
      const engineError = await rejectionOf(runtime.start(operation.id));
      compareOutcome(model.start(operation.id), engineError);
      return true;
    }
    case 'stop': {
      if (statusOf(operation.id) !== 'active') {
        return false;
      }
      const engineError = await rejectionOf(
        runtime.stop(operation.id, operation.cascade ? { cascade: true } : undefined),
      );
      compareOutcome(model.stop(operation.id, operation.cascade), engineError);
      return true;
    }
    case 'replace': {
      if (!model.plugins.has(operation.id)) {
        return false;
      }
      const plugin = worldPlugin(operation.id);
      if (plugin === undefined) {
        return false;
      }
      const definition = buildDefinition(plugin, world, minted, behaviors, opIndex);
      const engineError = await rejectionOf(runtime.replace(definition));
      compareOutcome(model.replace(plugin, opIndex), engineError);
      return true;
    }
    case 'uninstall': {
      const status = statusOf(operation.id);
      if (status !== 'installed' && status !== 'stopped') {
        return false;
      }
      const engineError = await rejectionOf(runtime.uninstall(operation.id));
      compareOutcome(model.uninstall(operation.id), engineError);
      return true;
    }
    case 'dispose': {
      if (model.disposed) {
        return false;
      }
      const engineError = await rejectionOf(runtime.dispose());
      compareOutcome(model.dispose(), engineError);
      return true;
    }
  }
}

describe('INV-01/05/06/07/11/12: model-based lifecycle properties', () => {
  it(
    'the runtime matches the reference model through every operation, and the invariants hold after each one',
    { timeout: 300_000 },
    async () => {
      const property = fc.asyncProperty(
        arbWorld().chain((world) =>
          arbOperations(world).map((operations) => ({ world, operations })),
        ),
        async ({ world, operations }) => {
          const minted = mintTokens(world);
          const behaviors: PluginBehaviors = {
            serveLog: [],
            counters: { acquired: 0, released: 0 },
            contributionValues: new Map(),
          };
          const runtime = createRuntime({
            providers: world.capabilities
              .filter((cap) => cap.host)
              .map((cap) => ({
                capability: capability(cap.id, cap.hostVersion, { multiple: cap.multiple }),
                value: cap.multiple
                  ? [{ from: '(host)', cap: cap.id }]
                  : { from: '(host)', cap: cap.id },
              })),
          });
          const engineEvents: ModelEvent[] = [];
          runtime.subscribe((event) => {
            engineEvents.push({
              type: event.type,
              ...(event.pluginId !== undefined ? { pluginId: event.pluginId } : {}),
              ...(event.generation !== undefined ? { generation: event.generation } : {}),
              ...(event.cascade !== undefined ? { cascade: [...event.cascade] } : {}),
            });
          });
          const harness: Harness = {
            runtime,
            model: new ModelRuntime(world),
            behaviors,
            minted,
            world,
            engineEvents,
          };

          for (const [index, operation] of operations.entries()) {
            await runOperation(harness, operation, index);
            assertInvariants(harness);
          }

          // Terminal dispose: every counter returns to baseline.
          if (!harness.model.disposed) {
            const engineError = await runtime.dispose().then(
              () => undefined,
              (error: unknown) => error,
            );
            compareOutcome(harness.model.dispose(), engineError);
            assertInvariants(harness);
          }
          expect(behaviors.counters.acquired).toBe(behaviors.counters.released);
        },
      );
      await fc.assert(property, {
        ...(FIXED_SEED !== undefined ? { seed: FIXED_SEED } : {}),
        numRuns: NUM_RUNS,
      });
    },
  );
});
