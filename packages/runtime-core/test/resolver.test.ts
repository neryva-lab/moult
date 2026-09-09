// Resolver tests. The resolver is pure: every test constructs definitions,
// statuses, and host providers directly.

import { capability } from '../src/capability.js';
import type { PluginDefinition, PluginStatus } from '../src/definition.js';
import { isMoltError, MoltError } from '../src/errors.js';
import type { HostProvider, ResolutionPlan } from '../src/resolver.js';
import { resolve, resolveCandidate } from '../src/resolver.js';

function expectCode(run: () => unknown, code: MoltError['code']): MoltError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  if (!isMoltError(thrown)) {
    throw new Error(`expected MoltError(${code}), got: ${String(thrown)}`);
  }
  expect(thrown.code).toBe(code);
  return thrown;
}

function definition(overrides: {
  id: string;
  version?: string;
  requires?: PluginDefinition['requires'];
  provides?: PluginDefinition['provides'];
}): PluginDefinition {
  return {
    version: '1.0.0',
    setup: () => undefined,
    ...overrides,
  };
}

const storage = capability<{ read(): number }>('test.storage', '1.0.0');
const storageV2 = capability<{ read(): number }>('test.storage', '2.0.0');
const multi = capability<{ name: string }>('test.multi', '1.0.0', { multiple: true });

function noStatuses(definitions: readonly PluginDefinition[]): Map<string, PluginStatus> {
  const statuses = new Map<string, PluginStatus>();
  for (const definition of definitions) {
    statuses.set(definition.id, 'installed');
  }
  return statuses;
}

describe('deterministic resolution', () => {
  const provider = definition({ id: 'test.provider', provides: [{ capability: storage }] });
  const consumer = definition({
    id: 'test.consumer',
    requires: [{ capability: storage, range: '^1.0.0' }],
  });

  it('produces identical plans under shuffled input permutation', () => {
    const hostProviders = new Map<string, HostProvider>();
    const a = resolve({
      definitions: [provider, consumer],
      statuses: noStatuses([provider, consumer]),
      hostProviders,
      root: 'test.consumer',
    });
    const b = resolve({
      definitions: [consumer, provider],
      statuses: noStatuses([consumer, provider]),
      hostProviders,
      root: 'test.consumer',
    });
    expect(a).toEqual(b);
    expect(a.order).toEqual(['test.provider', 'test.consumer']);
  });

  it('breaks independent-provider ties lexicographically', () => {
    const multiToken = capability('test.multi2', '1.0.0', { multiple: true });
    const alpha = definition({ id: 'test.alpha', provides: [{ capability: multiToken }] });
    const beta = definition({ id: 'test.beta', provides: [{ capability: multiToken }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: multiToken, range: '*' }],
    });
    const definitions = [beta, alpha, consumer];
    const plan = resolve({
      definitions,
      statuses: noStatuses(definitions),
      hostProviders: new Map(),
      root: 'test.consumer',
    });
    expect(plan.order).toEqual(['test.alpha', 'test.beta', 'test.consumer']);
    const selected = plan.providers.get('test.consumer')?.get('test.multi2');
    expect(selected?.map((selection) => selection.pluginId)).toEqual(['test.alpha', 'test.beta']);
  });
});

describe('missing, incompatible, ambiguous, and multi providers', () => {
  it('required capability with zero candidates → MISSING_CAPABILITY', () => {
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '^1.0.0' }],
    });
    const error = expectCode(
      () =>
        resolve({
          definitions: [consumer],
          statuses: noStatuses([consumer]),
          hostProviders: new Map(),
          root: 'test.consumer',
        }),
      'MISSING_CAPABILITY',
    );
    expect(error.capabilityId).toBe('test.storage');
    expect(error.details?.['blocked']).toBeDefined();
  });

  it('incompatible-only candidates → INCOMPATIBLE_CAPABILITY with near-miss diagnostics', () => {
    const provider = definition({ id: 'test.provider', provides: [{ capability: storageV2 }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '^1.0.0' }],
    });
    const error = expectCode(
      () =>
        resolve({
          definitions: [provider, consumer],
          statuses: noStatuses([provider, consumer]),
          hostProviders: new Map(),
          root: 'test.consumer',
        }),
      'INCOMPATIBLE_CAPABILITY',
    );
    const blocked = (
      error.details?.['blocked'] as { candidates: { verdict: string; version: string }[] }[]
    )?.[0];
    expect(blocked?.candidates).toEqual([
      { pluginId: 'test.provider', version: '2.0.0', verdict: 'incompatible' },
    ]);
  });

  it('two compatible providers on a single token → AMBIGUOUS_PROVIDER', () => {
    const alpha = definition({ id: 'test.alpha', provides: [{ capability: storage }] });
    const beta = definition({ id: 'test.beta', provides: [{ capability: storage }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '*' }],
    });
    const definitions = [alpha, beta, consumer];
    expectCode(
      () =>
        resolve({
          definitions,
          statuses: noStatuses(definitions),
          hostProviders: new Map(),
          root: 'test.consumer',
        }),
      'AMBIGUOUS_PROVIDER',
    );
  });

  it('a multi-provider token selects all compatible providers, host first', () => {
    const pluginProvider = definition({ id: 'test.plugin', provides: [{ capability: multi }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: multi, range: '*' }],
    });
    const hostProviders = new Map<string, HostProvider>([
      ['test.multi', { capability: multi, value: { name: 'host' } }],
    ]);
    const plan = resolve({
      definitions: [pluginProvider, consumer],
      statuses: noStatuses([pluginProvider, consumer]),
      hostProviders,
      root: 'test.consumer',
    });
    expect(
      plan.providers
        .get('test.consumer')
        ?.get('test.multi')
        ?.map((selection) => selection.pluginId),
    ).toEqual([null, 'test.plugin']);
  });

  it('a compatible-but-stopped provider is never selected and shows verdict stopped', () => {
    const provider = definition({ id: 'test.provider', provides: [{ capability: storage }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '*' }],
    });
    const statuses = new Map<string, PluginStatus>([
      ['test.provider', 'stopped'],
      ['test.consumer', 'installed'],
    ]);
    const error = expectCode(
      () =>
        resolve({
          definitions: [provider, consumer],
          statuses,
          hostProviders: new Map(),
          root: 'test.consumer',
        }),
      'MISSING_CAPABILITY',
    );
    const blocked = (error.details?.['blocked'] as { candidates: { verdict: string }[] }[])?.[0];
    expect(blocked?.candidates[0]?.verdict).toBe('stopped');
  });

  it('optional requirement: absent → no edge; incompatible → diagnostic without failure', () => {
    const absent = definition({
      id: 'test.absent-consumer',
      requires: [{ capability: storage, range: '*', optional: true }],
    });
    const planAbsent = resolve({
      definitions: [absent],
      statuses: noStatuses([absent]),
      hostProviders: new Map(),
      root: 'test.absent-consumer',
    });
    expect(planAbsent.edges).toEqual([]);

    const incompatibleProvider = definition({
      id: 'test.provider',
      provides: [{ capability: storageV2 }],
    });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '^1.0.0', optional: true }],
    });
    const planIncompatible = resolve({
      definitions: [incompatibleProvider, consumer],
      statuses: noStatuses([incompatibleProvider, consumer]),
      hostProviders: new Map(),
      root: 'test.consumer',
    });
    expect(planIncompatible.edges).toEqual([]);
    expect(planIncompatible.diagnostics).toHaveLength(1);
    expect(planIncompatible.diagnostics[0]?.candidates[0]?.verdict).toBe('incompatible');
  });
});

describe('version ranges and host providers', () => {
  it('INV-10: keeps separate selections for consumers with different ranges', () => {
    const v1 = capability('test.shared', '1.0.0');
    const v2 = capability('test.shared', '2.0.0');
    const providerV1 = definition({ id: 'test.provider-v1', provides: [{ capability: v1 }] });
    const providerV2 = definition({ id: 'test.provider-v2', provides: [{ capability: v2 }] });
    const consumerV1 = definition({
      id: 'test.consumer-v1',
      requires: [{ capability: v1, range: '^1.0.0' }],
    });
    const consumerV2 = definition({
      id: 'test.consumer-v2',
      requires: [{ capability: v2, range: '^2.0.0' }],
    });
    const definitions = [providerV1, providerV2, consumerV1, consumerV2];
    const plan = resolve({
      definitions,
      statuses: noStatuses(definitions),
      hostProviders: new Map(),
      root: consumerV1.id,
    });

    expect(plan.providers.get(consumerV1.id)?.get(v1.id)?.[0]?.pluginId).toBe(providerV1.id);
    expect(plan.providers.get(consumerV2.id)?.get(v2.id)?.[0]?.pluginId).toBe(providerV2.id);
  });

  it('INV-10: candidate resolution preserves optional diagnostics and multi ordering', () => {
    const optional = definition({
      id: 'test.optional-candidate',
      requires: [{ capability: storage, range: '^2.0.0', optional: true }],
    });
    const optionalPlan = resolveCandidate({
      definition: optional,
      providers: [{ pluginId: 'test.v1', capability: storage }],
    });
    expect(optionalPlan.providers.size).toBe(0);
    expect(optionalPlan.diagnostics[0]?.candidates[0]?.verdict).toBe('incompatible');

    const required = definition({
      id: 'test.required-candidate',
      requires: [{ capability: storage, range: '*' }],
    });
    expectCode(
      () => resolveCandidate({ definition: required, providers: [] }),
      'MISSING_CAPABILITY',
    );

    const multiConsumer = definition({
      id: 'test.multi-candidate',
      requires: [{ capability: multi, range: '*' }],
    });
    const multiPlan = resolveCandidate({
      definition: multiConsumer,
      providers: [
        { pluginId: 'test.plugin.z', capability: multi },
        { pluginId: 'test.plugin.a', capability: multi },
        { pluginId: null, capability: multi },
      ],
    });
    expect(multiPlan.providers.get(multiConsumer.id)?.get(multi.id)).toEqual([
      { pluginId: null, capabilityVersion: multi.version },
      { pluginId: 'test.plugin.a', capabilityVersion: multi.version },
      { pluginId: 'test.plugin.z', capabilityVersion: multi.version },
    ]);
  });

  it('ranges select by capability version via semver — never lexical comparison', () => {
    const v9 = definition({
      id: 'test.v9',
      provides: [{ capability: capability('test.r', '9.0.0') }],
    });
    const v10 = definition({
      id: 'test.v10',
      provides: [{ capability: capability('test.r', '10.0.0') }],
    });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: capability('test.r', '1.0.0'), range: '>=10 <11' }],
    });
    const definitions = [v9, v10, consumer];
    const plan = resolve({
      definitions,
      statuses: noStatuses(definitions),
      hostProviders: new Map(),
      root: 'test.consumer',
    });
    // Lexical comparison would pick '9.0.0'; semver picks 10.0.0.
    expect(plan.providers.get('test.consumer')?.get('test.r')?.[0]?.capabilityVersion).toBe(
      '10.0.0',
    );
  });

  it('stopped providers never win over active ones; active ones are reused', () => {
    const stoppedProvider = definition({ id: 'test.stopped', provides: [{ capability: storage }] });
    const activeProvider = definition({ id: 'test.active', provides: [{ capability: storage }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '*' }],
    });
    const statuses = new Map<string, PluginStatus>([
      ['test.stopped', 'stopped'],
      ['test.active', 'active'],
      ['test.consumer', 'installed'],
    ]);
    const plan = resolve({
      definitions: [stoppedProvider, activeProvider, consumer],
      statuses,
      hostProviders: new Map(),
      root: 'test.consumer',
    });
    expect(
      plan.providers
        .get('test.consumer')
        ?.get('test.storage')
        ?.map((selection) => selection.pluginId),
    ).toEqual(['test.active']);
  });

  it('host providers join the candidate pool - a second single claim is ambiguous', () => {
    const pluginProvider = definition({ id: 'test.plugin', provides: [{ capability: storage }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '*' }],
    });
    const hostProviders = new Map<string, HostProvider>([
      ['test.storage', { capability: storage, value: { read: () => 0 } }],
    ]);
    // The runtime rejects this at install; the resolver
    // defends the same rule for its own inputs.
    expectCode(
      () =>
        resolve({
          definitions: [pluginProvider, consumer],
          statuses: noStatuses([pluginProvider, consumer]),
          hostProviders,
          root: 'test.consumer',
        }),
      'AMBIGUOUS_PROVIDER',
    );
  });
});

describe('cycle detection with full paths', () => {
  it('detects a two-node cycle and reports the full path', () => {
    const aCap = capability('test.a', '1.0.0');
    const bCap = capability('test.b', '1.0.0');
    const a = definition({
      id: 'test.a',
      requires: [{ capability: bCap, range: '*' }],
      provides: [{ capability: aCap }],
    });
    const b = definition({
      id: 'test.b',
      requires: [{ capability: aCap, range: '*' }],
      provides: [{ capability: bCap }],
    });
    const error = expectCode(
      () =>
        resolve({
          definitions: [a, b],
          statuses: noStatuses([a, b]),
          hostProviders: new Map(),
          root: 'test.a',
        }),
      'DEPENDENCY_CYCLE',
    );
    expect(error.path).toEqual(['test.a', 'test.b', 'test.a']);
  });

  it('rejects self-resolution at the definition boundary', () => {
    const token = capability('test.self', '1.0.0');
    const self = definition({
      id: 'test.self',
      requires: [{ capability: token, range: '*' }],
      provides: [{ capability: token }],
    });
    const error = expectCode(
      () =>
        resolve({
          definitions: [self],
          statuses: noStatuses([self]),
          hostProviders: new Map(),
          root: 'test.self',
        }),
      'INVALID_DEFINITION',
    );
    expect(error.details?.['capabilityId']).toBe('test.self');
  });

  it('a provider excluded by version selection cannot create a cycle', () => {
    // x <-> other form a cycle, but other's requirement selects only y
    // (x's binding is incompatible), so the selected graph is acyclic.
    const multiToken = capability('test.m', '1.0.0', { multiple: false });
    const xCap = capability('test.x.cap', '1.0.0');
    const other = definition({
      id: 'test.other',
      requires: [{ capability: multiToken, range: '^1.0.0' }],
      provides: [{ capability: xCap }],
    });
    const x = definition({
      id: 'test.x',
      requires: [{ capability: xCap, range: '*' }],
      provides: [{ capability: capability('test.m', '2.0.0') }],
    });
    const y = definition({ id: 'test.y', provides: [{ capability: multiToken }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: multiToken, range: '^1.0.0' }],
    });
    const definitions = [other, x, y, consumer];
    const plan: ResolutionPlan = resolve({
      definitions,
      statuses: noStatuses(definitions),
      hostProviders: new Map(),
      root: 'test.consumer',
    });
    // test.x is selected by nothing: the cycle between x and other is not
    // part of the selected graph; other is not in
    // the consumer's closure either.
    expect(plan.order).toEqual(['test.y', 'test.consumer']);
    expect(plan.order).not.toContain('test.x');
  });
});

describe('reverse edges and defensive checks', () => {
  it('retains reverse-reachable edges for every selected dependency', () => {
    const provider = definition({ id: 'test.provider', provides: [{ capability: storage }] });
    const consumer = definition({
      id: 'test.consumer',
      requires: [{ capability: storage, range: '^1.0.0' }],
    });
    const plan = resolve({
      definitions: [provider, consumer],
      statuses: noStatuses([provider, consumer]),
      hostProviders: new Map(),
      root: 'test.consumer',
    });
    expect(plan.edges).toEqual([
      {
        from: 'test.consumer',
        to: 'test.provider',
        capabilityId: 'test.storage',
        range: '^1.0.0',
        optional: false,
      },
    ]);
  });

  it('rejects duplicate plugin ids defensively', () => {
    const a = definition({ id: 'test.dup', provides: [{ capability: storage }] });
    const b = definition({ id: 'test.dup' });
    expectCode(
      () =>
        resolve({
          definitions: [a, b],
          statuses: noStatuses([a, b]),
          hostProviders: new Map(),
          root: 'test.dup',
        }),
      'DUPLICATE_PLUGIN',
    );
  });

  it('rejects a root that is not installed', () => {
    expectCode(
      () =>
        resolve({
          definitions: [],
          statuses: new Map(),
          hostProviders: new Map(),
          root: 'test.ghost',
        }),
      'INVALID_STATE',
    );
  });

  it('resolves an empty closure with host providers only', () => {
    const standalone = definition({ id: 'test.standalone' });
    const hostProviders = new Map<string, HostProvider>([
      ['test.storage', { capability: storage, value: { read: () => 0 } }],
    ]);
    const plan = resolve({
      definitions: [standalone],
      statuses: noStatuses([standalone]),
      hostProviders,
      root: 'test.standalone',
    });
    expect(plan.order).toEqual(['test.standalone']);
    expect(plan.edges).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });
});
