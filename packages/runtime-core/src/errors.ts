// Structured error model. MoltError is the only error type core throws
// across its public API; foreign throwables enter the cause chain via
// MoltError.from — a log line is not an API.

/**
 * The fixed set of structured error codes: resolution failures
 * (`MISSING_CAPABILITY`, `INCOMPATIBLE_CAPABILITY`, `AMBIGUOUS_PROVIDER`,
 * `DEPENDENCY_CYCLE`), identity and definition failures (`DUPLICATE_PLUGIN`,
 * `INVALID_DEFINITION`), lifecycle failures (`ACTIVE_DEPENDENTS`,
 * `ACTIVATION_FAILED`, `DISPOSAL_FAILED`, `REPLACEMENT_FAILED`), and state
 * misuse (`INVALID_STATE`). Codes are part of the API contract — tests and
 * hosts match on them, never on message text.
 *
 * @public
 */
export type RuntimeErrorCode =
  | 'DUPLICATE_PLUGIN'
  | 'INVALID_DEFINITION'
  | 'MISSING_CAPABILITY'
  | 'INCOMPATIBLE_CAPABILITY'
  | 'AMBIGUOUS_PROVIDER'
  | 'DEPENDENCY_CYCLE'
  | 'ACTIVE_DEPENDENTS'
  | 'ACTIVATION_FAILED'
  | 'DISPOSAL_FAILED'
  | 'REPLACEMENT_FAILED'
  | 'INVALID_STATE';

/**
 * The result of one scope disposal: disposal continues after an individual
 * disposer fails, and every failure is collected here in the order
 * it was encountered.
 *
 * @public
 */
export interface DisposalReport {
  /** Errors raised by disposers, in the order they were encountered. */
  readonly errors: readonly unknown[];
}

/**
 * The structured identity fields of a `MoltError`. All fields are optional;
 * whatever the runtime knows about the failing item is filled in
 * deterministically.
 *
 * @public
 */
export interface MoltErrorInit {
  /** Structured runtime error code. */
  readonly code: RuntimeErrorCode;
  /** Human-readable summary; callers should branch on `code` instead. */
  readonly message: string;
  /** Plugin identity associated with the failure, when known. */
  readonly pluginId?: string | undefined;
  /** Generation identity associated with the failure, when known. */
  readonly generation?: string | undefined;
  /** Capability identity associated with the failure, when known. */
  readonly capabilityId?: string | undefined;
  /** Dependency or cascade path associated with the failure, when known. */
  readonly path?: readonly string[] | undefined;
  /** Additional structured metadata for the failure. */
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

// Symbol.for, not Symbol: the brand must classify errors across realm and VM
// boundaries (worker hosts), which fresh symbols do not.
const BRAND: unique symbol = Symbol.for('molt.error.brand');

function buildMessage(init: MoltErrorInit): string {
  const context: string[] = [];
  if (init.pluginId !== undefined) {
    context.push(`pluginId: ${init.pluginId}`);
  }
  if (init.generation !== undefined) {
    context.push(`generation: ${init.generation}`);
  }
  if (init.capabilityId !== undefined) {
    context.push(`capabilityId: ${init.capabilityId}`);
  }
  const suffix = context.length > 0 ? ` (${context.join(', ')})` : '';
  return `[${init.code}] ${init.message}${suffix}`;
}

function cloneAndFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry)));
  }
  if (typeof value === 'object' && value !== null) {
    if (Object.prototype.toString.call(value) === '[object Object]') {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        // Validated boundary: the object tag above limits this copy to record-like data.
        const entry = (value as Readonly<Record<string, unknown>>)[key];
        copy[key] = cloneAndFreeze(entry);
      }
      return Object.freeze(copy);
    }
  }
  return value;
}

function immutableDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const cloned = cloneAndFreeze(details);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw new TypeError('error details must be a record');
  }
  return cloned as Readonly<Record<string, unknown>>;
}

/**
 * The only error type core throws across its public API. The message format
 * is deterministic — `[CODE] summary (pluginId: …, …)` — because hosts match
 * on `code` and `details`, never on text. The brand is installed via
 * `Symbol.for` so classification holds across realm and VM boundaries.
 *
 * @public
 */
export class MoltError extends Error {
  readonly code: RuntimeErrorCode;
  readonly pluginId: string | undefined;
  readonly generation: string | undefined;
  readonly capabilityId: string | undefined;
  readonly path: readonly string[] | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(init: MoltErrorInit, cause?: unknown) {
    super(buildMessage(init), cause === undefined ? undefined : { cause });
    this.name = 'MoltError';
    this.code = init.code;
    this.pluginId = init.pluginId;
    this.generation = init.generation;
    this.capabilityId = init.capabilityId;
    this.path = init.path === undefined ? undefined : Object.freeze([...init.path]);
    this.details = init.details === undefined ? undefined : immutableDetails(init.details);
    Object.defineProperty(this, BRAND, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.freeze(this);
  }

  /**
   * Wraps an arbitrary thrown value into a `MoltError`, preserving the
   * original as the `cause`. A `MoltError` passes through unchanged —
   * structured errors are never re-wrapped.
   *
   * @param value - The caught throwable.
   * @param code - The code to assign when wrapping; defaults to
   * `ACTIVATION_FAILED`.
   */
  static from(value: unknown, code: RuntimeErrorCode = 'ACTIVATION_FAILED'): MoltError {
    if (isMoltError(value)) {
      return value;
    }
    if (value === undefined) {
      return new MoltError({
        code,
        message: 'undefined thrown',
        details: { reason: 'undefined thrown' },
      });
    }
    if (value instanceof Error) {
      return new MoltError({ code, message: value.message }, value);
    }
    return new MoltError({ code, message: renderThrowable(value) }, value);
  }
}

/**
 * Classifies a value as a `MoltError` via the `Symbol.for` brand — reliable
 * across realms and VM contexts where `instanceof` fails.
 *
 * @public
 */
export function isMoltError(value: unknown): value is MoltError {
  return typeof value === 'object' && value !== null && BRAND in value;
}

/** Renders a non-Error throwable without ever producing "[object Object]". */
function renderThrowable(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? 'null';
    } catch {
      return '[unserializable throwable]';
    }
  }
  return String(value);
}
