// Plugin definition validation and freezing.

import { capability } from '../src/capability.js';
import type { PluginDefinition } from '../src/definition.js';
import { freezeDefinition, validateDefinition } from '../src/definition.js';

const storage = capability<{ read(): number }>('test.storage', '1.0.0');

function validDefinition(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'test.plugin',
    version: '1.0.0',
    setup: () => undefined,
    ...overrides,
  };
}

describe('validateDefinition', () => {
  it('accepts a well-formed definition', () => {
    expect(validateDefinition(validDefinition())).toBeUndefined();
  });

  it('accepts empty requires/provides arrays as distinct from undefined', () => {
    expect(validateDefinition(validDefinition({ requires: [], provides: [] }))).toBeUndefined();
  });

  it('rejects invalid plugin ids and versions', () => {
    expect(validateDefinition(validDefinition({ id: 'Bad.Id' }))?.code).toBe('INVALID_DEFINITION');
    expect(validateDefinition(validDefinition({ version: 'nope' }))?.code).toBe(
      'INVALID_DEFINITION',
    );
  });

  it('rejects a non-function setup', () => {
    const broken = {
      id: 'test.plugin',
      version: '1.0.0',
      setup: 'not-a-function',
    } as unknown as PluginDefinition;
    expect(validateDefinition(broken)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects requirements with invalid ranges or tokens', () => {
    const badRange = validDefinition({ requires: [{ capability: storage, range: 'not-a-range' }] });
    expect(validateDefinition(badRange)?.code).toBe('INVALID_DEFINITION');

    const broken = validDefinition({
      requires: [{ capability: { id: 'BAD', version: '1.0.0', multiple: false }, range: '^1.0.0' }],
    });
    expect(validateDefinition(broken)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects duplicate requirement tokens within one definition', () => {
    const duplicate = validDefinition({
      requires: [
        { capability: storage, range: '^1.0.0' },
        { capability: storage, range: '^1.0.0' },
      ],
    });
    const error = validateDefinition(duplicate);
    expect(error?.code).toBe('INVALID_DEFINITION');
    expect(error?.details?.['capabilityId']).toBe('test.storage');
  });

  it('rejects duplicate provide tokens within one definition', () => {
    const duplicate = validDefinition({
      provides: [{ capability: storage }, { capability: storage }],
    });
    expect(validateDefinition(duplicate)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects a provide declaration that disagrees with the token policy', () => {
    const disagrees = validDefinition({
      provides: [{ capability: storage, multiple: true }], // token says single
    });
    expect(validateDefinition(disagrees)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects non-array requires/provides from JS callers', () => {
    const badRequires = {
      id: 'test.j',
      version: '1.0.0',
      setup: () => undefined,
      requires: 'nope',
    } as unknown as PluginDefinition;
    expect(validateDefinition(badRequires)?.code).toBe('INVALID_DEFINITION');
    const badProvides = {
      id: 'test.j',
      version: '1.0.0',
      setup: () => undefined,
      provides: 'nope',
    } as unknown as PluginDefinition;
    expect(validateDefinition(badProvides)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects non-object requirement and provided entries from JS callers', () => {
    const badRequirement = validDefinition({
      requires: [
        'storage' as unknown as PluginDefinition extends never ? never : ReturnType<typeof Object>,
      ],
    });
    expect(validateDefinition(badRequirement)?.code).toBe('INVALID_DEFINITION');
    const badProvided = validDefinition({
      provides: [
        null as unknown as PluginDefinition['provides'] extends never
          ? never
          : NonNullable<PluginDefinition['provides']>[number],
      ],
    });
    expect(validateDefinition(badProvided)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects a non-boolean multiple on a provided entry from JS callers', () => {
    const bad = validDefinition({
      provides: [
        { capability: storage, multiple: 'yes' } as unknown as NonNullable<
          PluginDefinition['provides']
        >[number],
      ],
    });
    expect(validateDefinition(bad)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects malformed token policy, optional flags, and null collections', () => {
    const missingPolicy = validDefinition({
      requires: [
        {
          capability: { id: 'test.storage', version: '1.0.0' },
          range: '^1.0.0',
        } as unknown as NonNullable<PluginDefinition['requires']>[number],
      ],
    });
    expect(validateDefinition(missingPolicy)?.code).toBe('INVALID_DEFINITION');

    const badOptional = validDefinition({
      requires: [
        {
          capability: storage,
          range: '^1.0.0',
          optional: 'yes',
        } as unknown as NonNullable<PluginDefinition['requires']>[number],
      ],
    });
    expect(validateDefinition(badOptional)?.code).toBe('INVALID_DEFINITION');

    const nullCollections = validDefinition({
      requires: null as unknown as PluginDefinition['requires'],
    });
    expect(validateDefinition(nullCollections)?.code).toBe('INVALID_DEFINITION');
  });

  it('rejects a plugin that requires what it provides', () => {
    const selfReferential = validDefinition({
      requires: [{ capability: storage, range: '^1.0.0' }],
      provides: [{ capability: storage }],
    });
    const error = validateDefinition(selfReferential);
    expect(error?.code).toBe('INVALID_DEFINITION');
    expect(error?.details?.['capabilityId']).toBe('test.storage');
  });
});

describe('freezeDefinition', () => {
  it('freezes the definition, its arrays, and their entries', () => {
    const definition = freezeDefinition(
      validDefinition({
        requires: [{ capability: storage, range: '^1.0.0' }],
        provides: [{ capability: storage }],
      }),
    );
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.requires)).toBe(true);
    expect(Object.isFrozen(definition.requires?.[0])).toBe(true);
    expect(Object.isFrozen(definition.provides)).toBe(true);
    expect(Object.isFrozen(definition.provides?.[0])).toBe(true);
  });

  it('makes setup-time mutation attempts fail loudly', () => {
    const definition = freezeDefinition(validDefinition());
    expect(() => {
      (definition as { version: string }).version = '2.0.0';
    }).toThrow(TypeError);
  });
});
