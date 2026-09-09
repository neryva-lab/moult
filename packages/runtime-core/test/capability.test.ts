// Capability token tests: grammar, policy field, freezing, and
// structural (not identity) equality across factory copies.

import { capability } from '../src/capability.js';
import { isMoltError, MoltError } from '../src/errors.js';

function expectInvalidDefinition(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isMoltError(thrown) && thrown.code).toBe('INVALID_DEFINITION');
  if (!(thrown instanceof MoltError)) {
    throw new Error('expected MoltError');
  }
}

describe('capability factory', () => {
  it('creates a frozen token with the declared policy (multiple defaults to false)', () => {
    const single = capability<{ read(): number }>('test.storage', '1.0.0');
    expect(single).toEqual({ id: 'test.storage', version: '1.0.0', multiple: false });
    expect(Object.isFrozen(single)).toBe(true);

    const multi = capability('test.events', '1.0.0', { multiple: true });
    expect(multi.multiple).toBe(true);
  });

  it('rejects ids that violate the grammar', () => {
    expectInvalidDefinition(() => capability('Test.Upper', '1.0.0'));
    expectInvalidDefinition(() => capability('1leading.digit', '1.0.0'));
    expectInvalidDefinition(() => capability('a..b', '1.0.0'));
    expectInvalidDefinition(() => capability('.leading.dot', '1.0.0'));
    expectInvalidDefinition(() => capability('', '1.0.0'));
    expectInvalidDefinition(() => capability('a-b.c', '1.0.0')); // hyphens only in non-first segments
  });

  it('accepts the documented id shapes', () => {
    expect(capability('a', '1.0.0').id).toBe('a');
    expect(capability('example.clock', '1.0.0').id).toBe('example.clock');
    expect(capability('a1.b2-c3', '1.0.0').id).toBe('a1.b2-c3');
    expect(capability('a.b-c', '1.0.0').id).toBe('a.b-c'); // hyphens allowed in non-first segments
  });

  it('rejects versions that are not valid semver', () => {
    expectInvalidDefinition(() => capability('test.thing', 'not-semver'));
    expectInvalidDefinition(() => capability('test.thing', ''));
  });

  it('rejects a non-boolean multiple option', () => {
    // JS callers can bypass the type system; the runtime must not.
    expectInvalidDefinition(() =>
      capability('test.thing', '1.0.0', { multiple: 'yes' as unknown as boolean }),
    );
  });

  it('structurally equal tokens from separate factory calls are equal but not identical', () => {
    const a = capability<{ read(): number }>('test.storage', '1.0.0');
    const b = capability<{ read(): number }>('test.storage', '1.0.0');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(a.id).toBe(b.id);
  });
});
