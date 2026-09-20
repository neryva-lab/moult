import { verifyDefinition, verifyGraph } from '../src/index.js';

function codesOf(definition: unknown): string[] {
  return verifyDefinition(definition).map((issue) => issue.code);
}

function cleanDefinition(): Record<string, unknown> {
  return {
    id: 'acme.storage',
    version: '1.2.3',
    setup: () => undefined,
    provides: [{ capability: { id: 'acme.db', version: '2.0.0' } }],
    requires: [{ capability: { id: 'acme.log' }, range: '^1.0.0', optional: true }],
    config: { poolSize: 4 },
    stateVersion: 'v3',
    validateConfig: () => [],
    migrate: () => undefined,
    drain: () => undefined,
    healthCheck: () => ({ ok: true }),
  };
}

describe('verifyDefinition', () => {
  it('a clean definition yields no issues', () => {
    expect(verifyDefinition(cleanDefinition())).toEqual([]);
  });

  it('a minimal definition (id, version, setup) yields no issues', () => {
    expect(verifyDefinition({ id: 'a', version: '0.0.1', setup: () => undefined })).toEqual([]);
  });

  it('rejects non-object input', () => {
    for (const bad of [undefined, null, 42, 'x', []]) {
      expect(codesOf(bad)).toEqual(['not-an-object']);
    }
  });

  it('flags missing and invalid ids', () => {
    const { id: _omitted, ...missing } = cleanDefinition();
    expect(codesOf(missing)).toContain('missing-id');
    for (const bad of ['memory_storage', '1abc', '.a', 'a..b', 'A.b', '']) {
      expect(codesOf({ ...cleanDefinition(), id: bad })).toContain('invalid-id');
    }
    // Hyphens are allowed (v1 grammar fix), dots separate segments.
    // Note: the runtime grammar also accepts a trailing hyphen ('a-');
    // the linter mirrors the runtime exactly rather than second-guessing it.
    expect(codesOf({ ...cleanDefinition(), id: 'my-plugin.store-2' })).toEqual([]);
  });

  it('flags missing and invalid versions', () => {
    const { version: _omitted, ...missing } = cleanDefinition();
    expect(codesOf(missing)).toContain('missing-version');
    for (const bad of ['1.2', '1.2.3.4', 'not-a-version', '']) {
      expect(codesOf({ ...cleanDefinition(), version: bad })).toContain('invalid-version');
    }
    // semver (and therefore the runtime) accepts a 'v' prefix; the linter mirrors it.
    expect(codesOf({ ...cleanDefinition(), version: 'v1.2.3' })).toEqual([]);
    expect(codesOf({ ...cleanDefinition(), version: '2.0.0-beta.1+build.5' })).toEqual([]);
  });

  it('requires setup to be a function', () => {
    const { setup: _omitted, ...missing } = cleanDefinition();
    expect(codesOf(missing)).toContain('missing-setup');
    expect(codesOf({ ...cleanDefinition(), setup: 'nope' })).toContain('invalid-hook');
  });

  it('validates provides entries', () => {
    expect(codesOf({ ...cleanDefinition(), provides: 'nope' })).toContain('invalid-provides');
    expect(codesOf({ ...cleanDefinition(), provides: [42] })).toContain('invalid-provide');
    expect(codesOf({ ...cleanDefinition(), provides: [{}] })).toContain('invalid-provide');
    expect(
      codesOf({
        ...cleanDefinition(),
        provides: [{ capability: { id: 'Bad_Id', version: '1.0.0' } }],
      }),
    ).toContain('invalid-capability-id');
    expect(
      codesOf({
        ...cleanDefinition(),
        provides: [{ capability: { id: 'acme.db', version: 'nope' } }],
      }),
    ).toContain('invalid-capability-version');
    expect(
      codesOf({
        ...cleanDefinition(),
        provides: [{ capability: { id: 'acme.db', version: '1.0.0' }, multiple: 'yes' }],
      }),
    ).toContain('invalid-multiple');
    expect(
      codesOf({
        ...cleanDefinition(),
        provides: [
          { capability: { id: 'acme.db', version: '1.0.0' } },
          { capability: { id: 'acme.db', version: '2.0.0' } },
        ],
      }),
    ).toContain('duplicate-capability');
  });

  it('validates requires entries', () => {
    expect(codesOf({ ...cleanDefinition(), requires: 'nope' })).toContain('invalid-requires');
    expect(codesOf({ ...cleanDefinition(), requires: [null] })).toContain('invalid-require');
    expect(codesOf({ ...cleanDefinition(), requires: [{ range: '^1.0.0' }] })).toContain(
      'invalid-require',
    );
    expect(
      codesOf({ ...cleanDefinition(), requires: [{ capability: { id: 'Bad' }, range: '^1.0.0' }] }),
    ).toContain('invalid-capability-id');
    expect(
      codesOf({
        ...cleanDefinition(),
        requires: [{ capability: { id: 'acme.log' }, range: 'not a range!!!' }],
      }),
    ).toContain('invalid-range');
    expect(
      codesOf({
        ...cleanDefinition(),
        requires: [{ capability: { id: 'acme.log' }, range: '^1.0.0', optional: 1 }],
      }),
    ).toContain('invalid-optional');
    expect(
      codesOf({
        ...cleanDefinition(),
        requires: [
          { capability: { id: 'acme.log' }, range: '^1.0.0' },
          { capability: { id: 'acme.log' }, range: '^2.0.0' },
        ],
      }),
    ).toContain('duplicate-requirement');
    // Range is optional per the linter contract.
    expect(
      codesOf({ ...cleanDefinition(), requires: [{ capability: { id: 'acme.log' } }] }),
    ).toEqual([]);
  });

  it('flags require/provide overlap on the same capability', () => {
    const definition = cleanDefinition();
    definition['requires'] = [{ capability: { id: 'acme.db' }, range: '*' }];
    expect(codesOf(definition)).toContain('require-provide-overlap');
  });

  it('validates config, stateVersion, and hooks', () => {
    expect(codesOf({ ...cleanDefinition(), config: 'nope' })).toContain('invalid-config');
    expect(codesOf({ ...cleanDefinition(), config: ['array'] })).toContain('invalid-config');
    expect(codesOf({ ...cleanDefinition(), stateVersion: true })).toContain(
      'invalid-state-version',
    );
    expect(codesOf({ ...cleanDefinition(), stateVersion: 3 })).toEqual([]);
    for (const hook of ['validateConfig', 'migrate', 'drain', 'healthCheck']) {
      expect(codesOf({ ...cleanDefinition(), [hook]: 42 })).toContain('invalid-hook');
    }
  });

  it('warns (not errors) on unknown top-level fields', () => {
    const issues = verifyDefinition({ ...cleanDefinition(), frobnicate: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unknown-field');
    expect(issues[0]?.path).toBe('frobnicate');
  });

  it('reports deterministic, well-formed issues', () => {
    const issues = verifyDefinition({ id: 'Bad', provides: 'nope', zeta: 1, alpha: 2 });
    const paths = issues.map((issue) => issue.path ?? '');
    expect(issues.length).toBeGreaterThan(0);
    // Unknown fields are sorted: alpha before zeta, regardless of insertion order.
    expect(paths.filter((p) => p === 'alpha' || p === 'zeta')).toEqual(['alpha', 'zeta']);
    for (const issue of issues) {
      expect(typeof issue.code).toBe('string');
      expect(issue.code.length).toBeGreaterThan(0);
      expect(typeof issue.message).toBe('string');
    }
    // Stable across runs.
    expect(verifyDefinition({ id: 'Bad', provides: 'nope', zeta: 1, alpha: 2 })).toEqual(issues);
  });
});

describe('verifyGraph', () => {
  function graphDefinition(
    id: string,
    provides: string[],
    multiple = false,
  ): Record<string, unknown> {
    return {
      id,
      version: '1.0.0',
      setup: () => undefined,
      provides: provides.map((capabilityId) => ({
        capability: { id: capabilityId, version: '1.0.0' },
        ...(multiple ? { multiple: true } : {}),
      })),
    };
  }

  it('a clean graph yields no issues', () => {
    expect(
      verifyGraph([graphDefinition('a', ['cap.one']), graphDefinition('b', ['cap.two'])]),
    ).toEqual([]);
  });

  it('rejects a non-array graph', () => {
    expect(verifyGraph('nope' as unknown as readonly unknown[]).map((issue) => issue.code)).toEqual(
      ['invalid-graph'],
    );
  });

  it('includes per-definition issues', () => {
    const issues = verifyGraph([
      graphDefinition('a', ['cap.one']),
      { id: 'Bad Id', version: '1.0.0' },
    ]);
    expect(issues.map((issue) => issue.code)).toContain('invalid-id');
    expect(issues.map((issue) => issue.code)).toContain('missing-setup');
  });

  it('flags duplicate plugin ids', () => {
    const issues = verifyGraph([
      graphDefinition('a', ['cap.one']),
      graphDefinition('a', ['cap.two']),
    ]);
    const duplicates = issues.filter((issue) => issue.code === 'duplicate-plugin-id');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.path).toBe('[1].id');
    expect(duplicates[0]?.message).toContain('"a"');
  });

  it('flags ambiguous single-provider claims across definitions', () => {
    const issues = verifyGraph([
      graphDefinition('a', ['cap.db']),
      graphDefinition('b', ['cap.db']),
    ]);
    const ambiguous = issues.filter((issue) => issue.code === 'ambiguous-provider');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.path).toBe('[1].provides[0].capability.id');
    expect(ambiguous[0]?.message).toContain('cap.db');
  });

  it('exempts multiple:true claims on both sides', () => {
    const issues = verifyGraph([
      graphDefinition('a', ['cap.events'], true),
      graphDefinition('b', ['cap.events'], true),
    ]);
    expect(issues.filter((issue) => issue.code === 'ambiguous-provider')).toHaveLength(0);
  });

  it('flags ambiguity when only one side is multiple', () => {
    const issues = verifyGraph([
      graphDefinition('a', ['cap.events'], true),
      graphDefinition('b', ['cap.events']),
    ]);
    expect(issues.filter((issue) => issue.code === 'ambiguous-provider')).toHaveLength(1);
  });

  it('skips cross-definition checks for definitions without a valid id', () => {
    const issues = verifyGraph([
      graphDefinition('a', ['cap.db']),
      { version: '1.0.0', setup: () => undefined },
    ]);
    expect(issues.filter((issue) => issue.code === 'ambiguous-provider')).toHaveLength(0);
    expect(issues.filter((issue) => issue.code === 'duplicate-plugin-id')).toHaveLength(0);
  });

  it('is deterministic across runs', () => {
    const graph = [
      graphDefinition('b', ['cap.db']),
      graphDefinition('a', ['cap.db', 'cap.x']),
      graphDefinition('a', ['cap.y']),
    ];
    expect(verifyGraph(graph)).toEqual(verifyGraph(graph));
  });
});
