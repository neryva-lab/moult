// Capability tokens. The token declares the provider policy:
// single-provider by default, multi only when the factory says so.
// Tokens resolve by id, never by object identity — type identity is
// a compile-time concern only.

import { MoltError } from './errors.js';
import { isValidVersion } from './internal/semver.js';

// ID grammar: dotted namespaces, lowercase, no empty segments, no leading
// digits or hyphens. Shared with plugin ids.
const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)*$/;

export function isValidRuntimeId(id: string): boolean {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * A capability token: the named, versioned unit of provision that plugins
 * declare and resolve. Tokens resolve by id — never by object identity —
 * and carry the provider policy: `multiple: true` tokens aggregate every
 * selected provider's array; `multiple: false` tokens accept exactly one
 * publisher.
 *
 * @public
 */
export interface Capability<T> {
  readonly id: string;
  readonly version: string;
  readonly multiple: boolean;
  /** Type phantom — never present at runtime, never read. */
  readonly __type?: T;
}

/**
 * Mints a frozen capability token. The id must satisfy the runtime id
 * grammar (dotted, lowercase); the version must be a valid semver version.
 *
 * @param id - Capability id, e.g. `storage.connection`.
 * @param version - Semver version of the capability contract.
 * @param options - `multiple: true` declares a multi-provider token.
 * @throws `INVALID_DEFINITION` when the id or version fails its grammar, or
 * when `multiple` is present but not a boolean.
 * @public
 */
export function capability<T>(
  id: string,
  version: string,
  options?: { readonly multiple?: boolean },
): Capability<T> {
  if (!isValidRuntimeId(id)) {
    throw new MoltError({
      code: 'INVALID_DEFINITION',
      message: `invalid capability id: ${String(id)}`,
      details: { capabilityId: String(id) },
    });
  }
  if (!isValidVersion(version)) {
    throw new MoltError({
      code: 'INVALID_DEFINITION',
      message: `invalid capability version: ${String(version)}`,
      details: { capabilityId: id },
    });
  }
  // JS callers bypass the type system; the policy must still be a boolean.
  const multiple = options?.multiple;
  if (multiple !== undefined && typeof multiple !== 'boolean') {
    throw new MoltError({
      code: 'INVALID_DEFINITION',
      message: 'multiple must be a boolean',
      details: { capabilityId: id },
    });
  }
  return Object.freeze<Capability<T>>({
    id,
    version,
    multiple: multiple ?? false,
  });
}
