// World and operation generators for the property suite.
//
// Every generated world is structurally valid: ids satisfy the runtime
// grammar, ranges satisfy `validRange`, requirements and provides are
// disjoint and duplicate-free, and no plugin provides a single-provider
// token a host already claims (that install-time conflict is unit-tested,
// not generated — "valid operations only"). Failure injection
// stays inside valid ops: a failing setup is a legitimate start that the
// runtime must reject with a structured, predictable code.

import fc from 'fast-check';

import type {
  Capability,
  ContributionKey,
  PluginContext,
  PluginDefinition,
} from '../../src/index.js';
import { capability, contributionKey } from '../../src/index.js';

// -- pools ----------------------------------------------------------------------

const CAPABILITY_IDS = ['cap.a', 'cap.b', 'cap.c', 'cap.d', 'cap.e'] as const;
const CONTRIBUTION_KEY_IDS = ['contribution.a', 'contribution.b'] as const;
const VERSIONS = ['0.9.0', '1.0.0', '1.1.0', '1.2.3', '2.0.0'] as const;
// Mix of always-true ('*'), near-miss, overlapping, and unsatisfiable ('>=3.0.0').
const RANGES = ['*', '^1.0.0', '^2.0.0', '>=1.0.0 <2.0.0', '^0.9.0', '>=3.0.0'] as const;

interface WorldCapability {
  readonly id: string;
  /** Canonical provider policy — every token minted for this id carries it. */
  readonly multiple: boolean;
  readonly host: boolean;
  readonly hostVersion: string;
}

interface WorldRequirement {
  readonly capabilityId: string;
  readonly range: string;
  readonly optional: boolean;
}

interface WorldProvide {
  readonly capabilityId: string;
  /** The per-definition token version — the resolver reads the token's version. */
  readonly version: string;
}

export interface WorldPlugin {
  readonly id: string;
  readonly version: string;
  readonly requires: readonly WorldRequirement[];
  readonly provides: readonly WorldProvide[];
  readonly contributions: readonly string[];
  /** Failure injection points. */
  readonly failSetupThrow: boolean;
  /** Forces an async setup; the rejection exits through the awaited path. */
  readonly failSetupReject: boolean;
  readonly failDisposerThrow: boolean;
  readonly failPublish: boolean;
  /** Scope acquisitions performed by setup (0–2). */
  readonly resources: number;
  /** Whether setup resolves every declared requirement via require/optional. */
  readonly doRequire: boolean;
}

export interface World {
  readonly capabilities: readonly WorldCapability[];
  readonly plugins: readonly WorldPlugin[];
}

export interface PluginBehaviors {
  /** Recorded per require/optional call: what the context served. */
  readonly serveLog: { pluginId: string; capabilityId: string; servedBy: string }[];
  readonly counters: { acquired: number; released: number };
  /** contribution value objects by ref (`pluginId|keyId|runTag`) for identity checks. */
  readonly contributionValues: Map<string, unknown>;
}

const weighted = (hits: number, of: number): fc.Arbitrary<boolean> =>
  fc.nat(of - 1).map((n) => n < hits);

const arbRange: fc.Arbitrary<string> = fc.constantFrom(...RANGES);
const arbVersion: fc.Arbitrary<string> = fc.constantFrom(...VERSIONS);

const capabilityIdAt = (index: number): string => {
  const id = CAPABILITY_IDS[index];
  if (id === undefined) {
    throw new Error('capability index outside the pool');
  }
  return id;
};

function policyOf(world: World, capabilityId: string): boolean {
  const cap = world.capabilities.find((entry) => entry.id === capabilityId);
  if (cap === undefined) {
    throw new Error(`world has no capability ${capabilityId}`);
  }
  return cap.multiple;
}

interface PluginRecord {
  readonly version: string;
  readonly requires: readonly WorldRequirement[];
  readonly provides: readonly WorldProvide[];
  readonly contributions: readonly string[];
  readonly failSetupThrow: boolean;
  readonly failSetupReject: boolean;
  readonly failDisposerThrow: boolean;
  readonly failPublish: boolean;
  readonly resources: number;
  readonly doRequire: boolean;
}

export function arbWorld(): fc.Arbitrary<World> {
  // One policy/host row per pool id, in pool order — canonical.
  const arbCapabilities = fc
    .array(
      fc.record({
        multiple: fc.boolean(),
        host: weighted(1, 4),
        hostVersion: arbVersion,
      }),
      { minLength: CAPABILITY_IDS.length, maxLength: CAPABILITY_IDS.length },
    )
    .map((rows) =>
      CAPABILITY_IDS.map((id, index) => {
        const row = rows[index];
        if (row === undefined) {
          throw new Error('capability row missing for the fixed-size pool');
        }
        return { id, ...row };
      }),
    );

  return arbCapabilities.chain((capabilities) => {
    const canProvide = (capabilityId: string): boolean => {
      const cap = capabilities.find((entry) => entry.id === capabilityId);
      // A host-owned single-provider token can never accept a second
      // publisher — install would reject the definition.
      return cap !== undefined && (cap.multiple || !cap.host);
    };

    const arbRequirements = fc
      .array(
        fc.record({
          capIndex: fc.nat(CAPABILITY_IDS.length - 1),
          range: arbRange,
          optional: weighted(1, 5),
        }),
        { maxLength: 3 },
      )
      .map((rows) => {
        const seen = new Set<string>();
        const unique: WorldRequirement[] = [];
        for (const row of rows) {
          const capabilityId = capabilityIdAt(row.capIndex);
          if (!seen.has(capabilityId)) {
            seen.add(capabilityId);
            unique.push({ capabilityId, range: row.range, optional: row.optional });
          }
        }
        return unique;
      });

    const arbProvides = fc
      .array(fc.record({ capIndex: fc.nat(CAPABILITY_IDS.length - 1), version: arbVersion }), {
        maxLength: 2,
      })
      .map((rows) => {
        const seen = new Set<string>();
        const unique: WorldProvide[] = [];
        for (const row of rows) {
          const capabilityId = capabilityIdAt(row.capIndex);
          if (!seen.has(capabilityId) && canProvide(capabilityId)) {
            seen.add(capabilityId);
            unique.push({ capabilityId, version: row.version });
          }
        }
        return unique;
      });

    const arbPluginRecord: fc.Arbitrary<PluginRecord> = fc.record({
      version: arbVersion,
      requires: arbRequirements,
      provides: arbProvides,
      contributions: fc.subarray([...CONTRIBUTION_KEY_IDS], { maxLength: 2 }),
      failSetupThrow: weighted(1, 6),
      failSetupReject: weighted(1, 6),
      failDisposerThrow: weighted(1, 5),
      failPublish: weighted(1, 8),
      resources: fc.nat(2),
      doRequire: weighted(4, 5),
    });

    return fc
      .uniqueArray(fc.nat(39), { minLength: 1, maxLength: 40 })
      .map((indices) => indices.sort((a, b) => a - b))
      .chain((indices) => {
        const ids = indices.map((index) => `p${String(index)}`);
        return fc.tuple(...ids.map(() => arbPluginRecord)).map((records) =>
          records.map((record, index) => {
            const id = ids[index];
            if (id === undefined) {
              throw new Error('world generation lost an id');
            }
            // Requires and provides are chosen independently — overlap is
            // removed here (validateDefinition rejects require+provide of
            // one id, so the world never generates it).
            const providedIds = new Set(record.provides.map((provide) => provide.capabilityId));
            const plugin: WorldPlugin = {
              ...record,
              id,
              requires: record.requires.filter(
                (requirement) => !providedIds.has(requirement.capabilityId),
              ),
            };
            return plugin;
          }),
        );
      })
      .map((plugins) => ({ capabilities, plugins }));
  });
}

// -- minted runtime objects -------------------------------------------------------

export interface MintedWorld {
  readonly world: World;
  /** capabilityId → canonical token (requirement side, version '1.0.0'). */
  readonly tokens: ReadonlyMap<string, Capability<unknown>>;
  /** contribution key id → key (per world; keys resolve by id). */
  readonly keys: ReadonlyMap<string, ContributionKey<unknown>>;
}

/**
 * Mints the runtime objects the world's setups need. Requirement-side tokens
 * are canonical per capability id (resolution is keyed by id);
 * provide-side tokens carry the per-definition version from the world.
 */
export function mintTokens(world: World): MintedWorld {
  const tokens = new Map<string, Capability<unknown>>();
  for (const cap of world.capabilities) {
    tokens.set(cap.id, capability(cap.id, '1.0.0', { multiple: cap.multiple }));
  }
  const keys = new Map<string, ContributionKey<unknown>>();
  for (const keyId of CONTRIBUTION_KEY_IDS) {
    keys.set(keyId, contributionKey(keyId));
  }
  return { world, tokens, keys };
}

function mintProvideToken(
  world: World,
  pluginId: string,
  capabilityId: string,
): Capability<unknown> {
  const provide = world.plugins
    .find((plugin) => plugin.id === pluginId)
    ?.provides.find((entry) => entry.capabilityId === capabilityId);
  if (provide === undefined) {
    throw new Error(`plugin ${pluginId} does not provide ${capabilityId}`);
  }
  return capability(capabilityId, provide.version, { multiple: policyOf(world, capabilityId) });
}

// -- definitions --------------------------------------------------------------------

/**
 * Builds the PluginDefinition for a world plugin. The setup is deterministic
 * given the world: acquire `resources` counted resources, resolve declared
 * requirements (recording who served them), stage contributions, publish
 * provides (unless failPublish), and return a disposable that throws on
 * disposal when failDisposerThrow. `runTag` distinguishes generations of the
 * same plugin in recorded values.
 */
export function buildDefinition(
  plugin: WorldPlugin,
  world: World,
  minted: MintedWorld,
  behaviors: PluginBehaviors,
  runTag: number,
): PluginDefinition {
  const asyncSetup = plugin.failSetupReject || plugin.resources > 0;

  const publish = (context: PluginContext): void => {
    if (plugin.failPublish) {
      return; // declared-but-never-published — structured failure
    }
    for (const provide of plugin.provides) {
      const token = capability(provide.capabilityId, provide.version, {
        multiple: policyOf(world, provide.capabilityId),
      });
      const value = token.multiple
        ? [{ from: plugin.id, cap: provide.capabilityId, run: runTag }]
        : { from: plugin.id, cap: provide.capabilityId, run: runTag };
      context.provide(token, value);
    }
  };

  const resolveRequirements = (context: PluginContext): void => {
    if (!plugin.doRequire) {
      return;
    }
    for (const requirement of plugin.requires) {
      const token = minted.tokens.get(requirement.capabilityId);
      if (token === undefined) {
        throw new Error(`world minted no token for ${requirement.capabilityId}`);
      }
      if (requirement.optional) {
        const value = context.optional(token);
        if (value !== undefined) {
          behaviors.serveLog.push({
            pluginId: plugin.id,
            capabilityId: requirement.capabilityId,
            servedBy: servedByOf(value),
          });
        }
      } else {
        const value = context.require(token);
        behaviors.serveLog.push({
          pluginId: plugin.id,
          capabilityId: requirement.capabilityId,
          servedBy: servedByOf(value),
        });
      }
    }
  };

  const stageContributions = (context: PluginContext): void => {
    for (const keyId of plugin.contributions) {
      const key = minted.keys.get(keyId);
      if (key === undefined) {
        throw new Error(`world minted no key for ${keyId}`);
      }
      const value = { from: plugin.id, key: keyId, run: runTag };
      behaviors.contributionValues.set(`${plugin.id}|${keyId}|${runTag}`, value);
      context.contribute(key, value);
    }
  };

  const acquireResources = async (context: PluginContext): Promise<void> => {
    for (let index = 0; index < plugin.resources; index += 1) {
      behaviors.counters.acquired += 1;
      await context.scope.acquire(
        () => ({ plugin: plugin.id, resource: index, run: runTag }),
        () => {
          behaviors.counters.released += 1;
        },
      );
    }
  };

  const disposer = plugin.failDisposerThrow
    ? {
        dispose: (): void => {
          throw new Error(`injected disposer failure (${plugin.id})`);
        },
      }
    : undefined;

  const requirementTokens = plugin.requires.map((requirement) => {
    const token = minted.tokens.get(requirement.capabilityId);
    if (token === undefined) {
      throw new Error(`world minted no token for ${requirement.capabilityId}`);
    }
    return {
      capability: token,
      range: requirement.range,
      ...(requirement.optional ? { optional: true } : {}),
    };
  });
  const providedTokens = plugin.provides.map((provide) => ({
    capability: mintProvideToken(world, plugin.id, provide.capabilityId),
  }));

  if (asyncSetup) {
    return {
      id: plugin.id,
      version: plugin.version,
      requires: requirementTokens,
      provides: providedTokens,
      setup: async (context) => {
        await acquireResources(context);
        resolveRequirements(context);
        stageContributions(context);
        publish(context);
        if (plugin.failSetupThrow) {
          // Inside an async setup a throw is a rejection — the awaited path.
          throw new Error(`injected setup failure (${plugin.id})`);
        }
        return disposer;
      },
    };
  }
  return {
    id: plugin.id,
    version: plugin.version,
    requires: requirementTokens,
    provides: providedTokens,
    setup: (context) => {
      resolveRequirements(context);
      stageContributions(context);
      publish(context);
      if (plugin.failSetupThrow) {
        throw new Error(`injected setup failure (${plugin.id})`);
      }
      return disposer;
    },
  };
}

// -- operations ---------------------------------------------------------------------

export type Operation =
  | { readonly type: 'install'; readonly id: string }
  | { readonly type: 'start'; readonly id: string }
  | { readonly type: 'stop'; readonly id: string; readonly cascade: boolean }
  | { readonly type: 'replace'; readonly id: string }
  | { readonly type: 'uninstall'; readonly id: string }
  | { readonly type: 'dispose' };

/**
 * Operation sequences over a world's plugin ids. Sequence elements are not
 * individually valid — the runner consults the model for precondition
 * validity ("valid operations only"; the invalid ones have
 * dedicated unit tests) and skips what the model rejects as inapplicable.
 */
export function arbOperations(world: World): fc.Arbitrary<readonly Operation[]> {
  const ids = world.plugins.map((plugin) => plugin.id);
  const arbOp: fc.Arbitrary<Operation> = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({ type: fc.constant('start' as const), id: fc.constantFrom(...ids) }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constant('stop' as const),
        id: fc.constantFrom(...ids),
        cascade: fc.boolean(),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ type: fc.constant('replace' as const), id: fc.constantFrom(...ids) }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ type: fc.constant('install' as const), id: fc.constantFrom(...ids) }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('uninstall' as const),
        id: fc.constantFrom(...ids),
      }),
    },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('dispose' as const) }) },
  );
  return fc.array(arbOp, { minLength: 1, maxLength: 24 });
}

function isTagged(value: unknown): value is { readonly from: string } {
  return value !== null && typeof value === 'object' && 'from' in value;
}

/**
 * Who served a resolved value: the tagged plugin id, the comma-joined ids of
 * a multi-token aggregation, or '(host)' for a host binding. The model
 * computes the identical string from its selections — the comparison is the
 * ordering check.
 */
function servedByOf(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((element) => (isTagged(element) ? element.from : '(host)')).join(',');
  }
  if (isTagged(value)) {
    return value.from;
  }
  return '(host)';
}
