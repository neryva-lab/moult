/**
 * Static contract linter for Moult plugin definitions and plugin graphs.
 *
 * This package is intentionally dependency-free with respect to the rest of
 * Moult: it never imports `@moult/runtime` (or any other `@moult/*`
 * package), so it can run in editors, CI, and code-generation pipelines
 * without pulling in the lifecycle engine. The few rules that mirror
 * runtime validation (the id grammar, the single-provider claim rule) are
 * duplicated here with a comment citing the runtime source they mirror.
 *
 * @packageDocumentation
 */

import { valid, validRange } from 'semver';

/**
 * One contract violation or advisory found by the linter.
 *
 * `code` is a stable machine-readable string (for example `'invalid-id'`,
 * `'duplicate-capability'`, `'ambiguous-provider'`). Codes are additive:
 * new linter versions may add codes but never change the meaning of an
 * existing one. `path` locates the offending value with a JSON-path-like
 * string (`'provides[0].capability.id'`); it is omitted for issues about
 * the definition as a whole.
 *
 * @public
 */
export interface VerifyIssue {
  /** Stable machine-readable code, e.g. `'invalid-id'` or `'ambiguous-provider'`. */
  readonly code: string;
  /** Human-readable description of the violation. */
  readonly message: string;
  /**
   * JSON-path-like location of the offending value, e.g.
   * `'provides[0].capability.id'`. Omitted for issues about the
   * definition as a whole.
   */
  readonly path?: string | undefined;
}

/**
 * Top-level fields the runtime reads. Anything else is reported as an
 * `'unknown-field'` advisory — never an error — because the runtime
 * ignores fields it does not know.
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'version',
  'setup',
  'provides',
  'requires',
  'config',
  'stateVersion',
  'validateConfig',
  'migrate',
  'drain',
  'healthCheck',
]);

/**
 * Hooks that must be functions when present. `setup` is handled
 * separately because the runtime requires it.
 */
const OPTIONAL_HOOKS: readonly string[] = ['validateConfig', 'migrate', 'drain', 'healthCheck'];

// Mirrors `isValidRuntimeId` in packages/runtime-core/src/capability.ts.
// Duplicated (not imported) so this package never depends on @moult/runtime:
// lowercase segments separated by dots; each segment starts with a letter
// and continues with letters, digits, or hyphens.
const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

interface IssueSink {
  (code: string, message: string, path?: string): void;
}

const ID_GRAMMAR_HELP =
  'ids are dot-separated segments; each segment starts with a lowercase letter followed by lowercase letters, digits, or hyphens';

function checkProvides(provides: unknown, push: IssueSink): Set<string> {
  const ids = new Set<string>();
  if (provides === undefined) {
    return ids;
  }
  if (!Array.isArray(provides)) {
    push('invalid-provides', '"provides" must be an array when present', 'provides');
    return ids;
  }
  provides.forEach((entry, index) => {
    const base = `provides[${index}]`;
    if (!isRecord(entry)) {
      push('invalid-provide', `"${base}" must be an object`, base);
      return;
    }
    const capability = entry['capability'];
    if (!isRecord(capability)) {
      push('invalid-provide', `"${base}.capability" must be an object`, `${base}.capability`);
      return;
    }
    const capabilityId = capability['id'];
    if (!isValidId(capabilityId)) {
      push(
        'invalid-capability-id',
        `invalid capability id ${JSON.stringify(capabilityId)} in "${base}": ${ID_GRAMMAR_HELP}`,
        `${base}.capability.id`,
      );
    } else if (ids.has(capabilityId)) {
      push(
        'duplicate-capability',
        `duplicate provided capability "${capabilityId}"`,
        `${base}.capability.id`,
      );
    } else {
      ids.add(capabilityId);
    }
    const capabilityVersion = capability['version'];
    if (typeof capabilityVersion !== 'string' || valid(capabilityVersion) === null) {
      push(
        'invalid-capability-version',
        `invalid capability version ${JSON.stringify(capabilityVersion)} for "${base}"`,
        `${base}.capability.version`,
      );
    }
    const multiple = entry['multiple'];
    if (multiple !== undefined && typeof multiple !== 'boolean') {
      push(
        'invalid-multiple',
        `"${base}.multiple" must be a boolean when present`,
        `${base}.multiple`,
      );
    }
  });
  return ids;
}

function checkRequires(requires: unknown, push: IssueSink): Set<string> {
  const ids = new Set<string>();
  if (requires === undefined) {
    return ids;
  }
  if (!Array.isArray(requires)) {
    push('invalid-requires', '"requires" must be an array when present', 'requires');
    return ids;
  }
  requires.forEach((entry, index) => {
    const base = `requires[${index}]`;
    if (!isRecord(entry)) {
      push('invalid-require', `"${base}" must be an object`, base);
      return;
    }
    const capability = entry['capability'];
    if (!isRecord(capability)) {
      push('invalid-require', `"${base}.capability" must be an object`, `${base}.capability`);
      return;
    }
    const capabilityId = capability['id'];
    if (!isValidId(capabilityId)) {
      push(
        'invalid-capability-id',
        `invalid capability id ${JSON.stringify(capabilityId)} in "${base}": ${ID_GRAMMAR_HELP}`,
        `${base}.capability.id`,
      );
    } else if (ids.has(capabilityId)) {
      push(
        'duplicate-requirement',
        `duplicate requirement for capability "${capabilityId}"`,
        `${base}.capability.id`,
      );
    } else {
      ids.add(capabilityId);
    }
    const range = entry['range'];
    if (range !== undefined && (typeof range !== 'string' || validRange(range) === null)) {
      push(
        'invalid-range',
        `invalid semver range ${JSON.stringify(range)} in "${base}"`,
        `${base}.range`,
      );
    }
    const optional = entry['optional'];
    if (optional !== undefined && typeof optional !== 'boolean') {
      push(
        'invalid-optional',
        `"${base}.optional" must be a boolean when present`,
        `${base}.optional`,
      );
    }
  });
  return ids;
}

/**
 * Lints a single plugin definition against the static subset of the
 * replaceable-plugin contract (see `CONTRACT.md`).
 *
 * Pure and side-effect free: it never executes hooks, never touches the
 * network, and never imports the runtime. Issues are returned in a
 * deterministic order (field order, then array order); an empty array
 * means the definition is statically clean.
 *
 * @param definition - The candidate definition; `unknown` on purpose, so
 * untrusted input (parsed JSON, code-generated objects) can be checked.
 * @public
 */
export function verifyDefinition(definition: unknown): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const push: IssueSink = (code, message, path) => {
    issues.push(path === undefined ? { code, message } : { code, message, path });
  };
  if (!isRecord(definition)) {
    push('not-an-object', 'plugin definition must be a plain object');
    return issues;
  }

  const id = definition['id'];
  if (id === undefined) {
    push('missing-id', 'plugin definition is missing the required "id" field', 'id');
  } else if (!isValidId(id)) {
    push('invalid-id', `invalid plugin id ${JSON.stringify(id)}: ${ID_GRAMMAR_HELP}`, 'id');
  }

  const version = definition['version'];
  if (version === undefined) {
    push('missing-version', 'plugin definition is missing the required "version" field', 'version');
  } else if (typeof version !== 'string' || valid(version) === null) {
    push(
      'invalid-version',
      `invalid plugin version ${JSON.stringify(version)}: expected semver`,
      'version',
    );
  }

  const setup = definition['setup'];
  if (setup === undefined) {
    push('missing-setup', 'plugin definition is missing the required "setup" hook', 'setup');
  } else if (typeof setup !== 'function') {
    push('invalid-hook', '"setup" must be a function', 'setup');
  }

  const providedIds = checkProvides(definition['provides'], push);
  const requiredIds = checkRequires(definition['requires'], push);
  for (const capabilityId of providedIds) {
    if (requiredIds.has(capabilityId)) {
      push(
        'require-provide-overlap',
        `plugin cannot both require and provide capability "${capabilityId}"`,
        'requires',
      );
    }
  }

  const config = definition['config'];
  if (config !== undefined && !isRecord(config)) {
    push('invalid-config', '"config" must be a plain record when present', 'config');
  }

  const stateVersion = definition['stateVersion'];
  if (
    stateVersion !== undefined &&
    typeof stateVersion !== 'string' &&
    typeof stateVersion !== 'number'
  ) {
    push(
      'invalid-state-version',
      '"stateVersion" must be a string or number when present',
      'stateVersion',
    );
  }

  for (const field of OPTIONAL_HOOKS) {
    const hook = definition[field];
    if (hook !== undefined && typeof hook !== 'function') {
      push('invalid-hook', `"${field}" must be a function when present`, field);
    }
  }

  // Unknown fields are advisories, never errors: the runtime ignores them,
  // and failing closed here would reject forward-compatible definitions.
  // Sorted so output is deterministic regardless of key insertion order.
  for (const key of Object.keys(definition).sort()) {
    if (!KNOWN_FIELDS.has(key)) {
      push('unknown-field', `unknown top-level field "${key}"; the runtime ignores it`, key);
    }
  }

  return issues;
}

interface GraphClaim {
  readonly capabilityId: string;
  readonly multiple: boolean;
  readonly provideIndex: number;
}

interface GraphSummary {
  readonly index: number;
  readonly id: string;
  readonly claims: readonly GraphClaim[];
}

/**
 * Lints a set of plugin definitions together. Runs {@link verifyDefinition}
 * on each entry (in order) and then applies cross-definition checks that a
 * single definition cannot answer:
 *
 * - `duplicate-plugin-id`: two definitions share a plugin id (the runtime
 *   rejects the second install with `DUPLICATE_PLUGIN`).
 * - `ambiguous-provider`: the same capability id is claimed by two
 *   definitions where either claim is not `multiple: true` (the runtime
 *   rejects this with `AMBIGUOUS_PROVIDER`). Claims where both sides are
 *   `multiple: true` are exempt — multi-provider tokens are designed to
 *   coexist.
 *
 * Definitions that are not objects, or whose id is missing or invalid,
 * are skipped by the cross-definition checks: without a trustworthy
 * identity there is nothing sound to compare.
 *
 * @param definitions - The candidate graph; `readonly unknown[]` on
 * purpose, so untrusted input can be checked.
 * @public
 */
export function verifyGraph(definitions: readonly unknown[]): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  if (!Array.isArray(definitions)) {
    issues.push({ code: 'invalid-graph', message: 'definitions must be an array' });
    return issues;
  }
  for (const definition of definitions) {
    issues.push(...verifyDefinition(definition));
  }

  const summaries: GraphSummary[] = [];
  definitions.forEach((definition, index) => {
    if (!isRecord(definition)) {
      return;
    }
    const id = definition['id'];
    if (!isValidId(id)) {
      return;
    }
    const claims: GraphClaim[] = [];
    const provides = definition['provides'];
    if (Array.isArray(provides)) {
      provides.forEach((entry, provideIndex) => {
        if (!isRecord(entry)) {
          return;
        }
        const capability = entry['capability'];
        if (!isRecord(capability)) {
          return;
        }
        const capabilityId = capability['id'];
        if (!isValidId(capabilityId)) {
          return;
        }
        claims.push({
          capabilityId,
          multiple: entry['multiple'] === true || capability['multiple'] === true,
          provideIndex,
        });
      });
    }
    summaries.push({ index, id, claims });
  });

  const firstIndexById = new Map<string, number>();
  for (const summary of summaries) {
    const first = firstIndexById.get(summary.id);
    if (first !== undefined) {
      issues.push({
        code: 'duplicate-plugin-id',
        message: `duplicate plugin id "${summary.id}" (first defined at index ${first})`,
        path: `[${summary.index}].id`,
      });
    } else {
      firstIndexById.set(summary.id, summary.index);
    }
  }

  // Pairwise, earlier-first: the later definition is reported, mirroring
  // the runtime, which rejects the newcomer rather than the incumbent.
  for (const [laterPosition, later] of summaries.entries()) {
    for (const [earlierPosition, earlier] of summaries.entries()) {
      if (earlierPosition >= laterPosition) {
        break;
      }
      for (const claim of later.claims) {
        const clash = earlier.claims.find(
          (candidate) => candidate.capabilityId === claim.capabilityId,
        );
        if (clash !== undefined && !(claim.multiple && clash.multiple)) {
          issues.push({
            code: 'ambiguous-provider',
            message:
              `capability "${claim.capabilityId}" is claimed as a single provider by both ` +
              `"${earlier.id}" and "${later.id}"; declare the token multiple:true to allow coexistence`,
            path: `[${later.index}].provides[${claim.provideIndex}].capability.id`,
          });
        }
      }
    }
  }

  return issues;
}
