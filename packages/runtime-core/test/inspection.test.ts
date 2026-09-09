// Inspection tests: frozen, sorted snapshots and the
// blocked-plugin tree rendered from BlockedDiagnostic data.

import { buildInspection, formatBlockedPlugin } from '../src/inspection.js';
import type { BlockedDiagnostic } from '../src/resolver.js';

const sampleDiagnostic: BlockedDiagnostic = {
  pluginId: 'test.consumer',
  requirement: { capabilityId: 'test.storage', range: '>=2.0.0', optional: false },
  candidates: [
    { pluginId: 'test.local', version: '1.4.0', verdict: 'incompatible' },
    { pluginId: 'test.remote', version: '2.1.0', verdict: 'stopped' },
  ],
};

describe('buildInspection', () => {
  it('returns a frozen snapshot; mutating it cannot affect the runtime', () => {
    const input: {
      plugins: {
        id: string;
        status: 'active' | 'installed';
        generationId?: string | undefined;
      }[];
      capabilities: { id: string; provider: string; version: string }[];
    } = {
      plugins: [{ id: 'test.p', status: 'active', generationId: 'test.p#1' }],
      capabilities: [{ id: 'test.storage', provider: 'test.p', version: '1.0.0' }],
    };
    const inspection = buildInspection(input);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.plugins)).toBe(true);
    expect(Object.isFrozen(inspection.plugins[0])).toBe(true);
    // Boundary: the snapshot is Readonly-frozen; the cast only enables the
    // mutation attempt this test performs.
    const mutable = inspection as unknown as { plugins: unknown[] };
    expect(() => {
      mutable.plugins.push({});
    }).toThrow(TypeError);
    // The input arrays are copied — later mutation of the source is invisible.
    input.plugins.push({ id: 'test.late', status: 'installed', generationId: undefined });
    expect(inspection.plugins).toHaveLength(1);
  });

  it('sorts capabilities deterministically by id then provider', () => {
    const inspection = buildInspection({
      plugins: [],
      capabilities: [
        { id: 'test.b', provider: 'z', version: '1.0.0' },
        { id: 'test.a', provider: 'm', version: '1.0.0' },
        { id: 'test.a', provider: 'a', version: '1.0.0' },
      ],
    });
    expect(
      inspection.capabilities.map((capability) => `${capability.id}/${capability.provider}`),
    ).toEqual(['test.a/a', 'test.a/m', 'test.b/z']);
  });

  it('omits absent optional fields entirely (exactOptionalPropertyTypes contract)', () => {
    const inspection = buildInspection({
      plugins: [{ id: 'test.p', status: 'installed', generationId: undefined }],
      capabilities: [],
    });
    const record = inspection.plugins[0] as Record<string, unknown>;
    expect('generation' in record).toBe(false);
    expect('error' in record).toBe(false);
    expect('blockedBy' in record).toBe(false);
  });
});

describe('formatBlockedPlugin', () => {
  it('renders the documented diagnostic tree from data', () => {
    expect(formatBlockedPlugin(sampleDiagnostic)).toBe(
      [
        'test.consumer cannot start',
        '└─ requires test.storage >=2.0.0',
        '   ├─ test.local provides 1.4.0 (incompatible)',
        '   └─ test.remote provides 2.1.0 but is stopped',
      ].join('\n'),
    );
  });

  it('renders host providers and optional requirements', () => {
    const diagnostic: BlockedDiagnostic = {
      pluginId: 'test.c',
      requirement: { capabilityId: 'test.storage', range: '*', optional: true },
      candidates: [{ pluginId: null, version: '1.0.0', verdict: 'ok' }],
    };
    const rendered = formatBlockedPlugin(diagnostic);
    expect(rendered).toContain('└─ requires test.storage * (optional)');
    expect(rendered).toContain('   └─ (host) provides 1.0.0');
  });
});
