// Plugin definitions. Validation runs at install and replace, before any
// scope exists; definitions are then frozen so that the rule "setup must not
// mutate the definition object" becomes an immediate error instead of a
// silent bug.

import type { Capability } from './capability.js';
import { isValidRuntimeId } from './capability.js';
import type { ContributionKey } from './contributions.js';
import { MoltError } from './errors.js';
import { isValidRange, isValidVersion } from './internal/semver.js';
import type { Scope } from './scope.js';

/**
 * The cleanup contract a plugin may return from setup: adopted by the
 * generation's scope and run exactly once during disposal.
 * dispose never throws into the lifecycle — a throw is collected in the
 * disposal report.
 *
 * @public
 */
export interface DisposableLike {
  /** Releases the owned resource; failures are collected by the scope. */
  readonly dispose: () => void | Promise<void>;
}

/**
 * Plugin lifecycle status. The sequence is
 * installed → preparing → active → disposing → stopped; a failed preparation exits
 * to stopped. Observed through Runtime.getStatus and Runtime.inspect.
 *
 * @public
 */
export type PluginStatus = 'installed' | 'preparing' | 'active' | 'disposing' | 'stopped';

/**
 * One declared dependency: a capability token plus the semver range the
 * consumer accepts. Optional requirements resolve to undefined
 * when nothing selectable exists instead of failing the start.
 *
 * @public
 */
export interface Requirement {
  readonly capability: Capability<unknown>;
  readonly range: string;
  readonly optional?: boolean | undefined;
}

/**
 * One declared provision: a capability token this plugin publishes during
 * setup. multiple must agree with the token's own provider policy —
 * the token is the authority.
 *
 * @public
 */
export interface ProvidedCapability {
  readonly capability: Capability<unknown>;
  readonly multiple?: boolean | undefined;
}

/**
 * The per-activation object handed to setup. Everything a plugin touches
 * flows through here — there are no globals. The context is live
 * only for this generation; its scope is disposed when the generation
 * stops, is replaced, or fails.
 *
 * @throws Methods throw structured MoltError values. require and optional use
 * INVALID_STATE with details.reason = undeclared-requirement for undeclared
 * tokens; provide uses ACTIVATION_FAILED for undeclared or duplicated
 * tokens; contribute uses INVALID_DEFINITION for duplicate ids and
 * INVALID_STATE for post-commit staging.
 * @public
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly generation: string;
  /** Aborted before the generation's disposers run. */
  readonly signal: AbortSignal;
  readonly scope: Scope;
  require<T>(capability: Capability<T>): T;
  optional<T>(capability: Capability<T>): T | undefined;
  provide<T>(capability: Capability<T>, value: T): void;
  contribute<T>(key: ContributionKey<T>, value: T): void;
  diagnose(message: DiagnosticInput): void;
}

/**
 * One diagnostic entry. Diagnostics are recorded in the generation's
 * capped log and are visible through inspect — they never replace
 * structured errors.
 *
 * @public
 */
export interface DiagnosticInput {
  readonly message: string;
  readonly severity?: 'info' | 'warning' | 'error' | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The immutable description of a plugin. Validated at install/replace and
 * frozen — setup must never mutate it.
 *
 * @public
 */
export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly Requirement[] | undefined;
  readonly provides?: readonly ProvidedCapability[] | undefined;
  readonly setup: (
    context: PluginContext,
  ) => void | DisposableLike | Promise<void | DisposableLike>;
}

function invalid(message: string, details?: Record<string, unknown>): MoltError {
  return new MoltError({ code: 'INVALID_DEFINITION', message, details });
}

// Both accessors below are validated boundaries: their argument has already
// passed validateRequirement/validateProvided, so the cast is sound. JS
// callers bypass the type system — that is exactly why validation treats
// definition contents as unknown first.

function requirementCapabilityId(requirement: unknown): string {
  return (requirement as Requirement).capability.id;
}

function providedParts(provided: unknown): ProvidedCapability {
  return provided as ProvidedCapability;
}

function validateRequirement(
  requirement: unknown,
  owner: string,
  index: number,
): MoltError | undefined {
  if (typeof requirement !== 'object' || requirement === null) {
    return invalid(`requirement ${index} of ${owner} is not an object`);
  }
  // Validated boundary: object shape is asserted above, contents below.
  const req = requirement as Requirement;
  if (typeof req.capability !== 'object' || req.capability === null) {
    return invalid(`requirement ${index} of ${owner} has no capability token`);
  }
  if (!isValidRuntimeId(req.capability.id) || !isValidVersion(req.capability.version)) {
    return invalid(`requirement ${index} of ${owner} has an invalid capability token`, {
      capabilityId: String(req.capability.id),
    });
  }
  if (typeof req.capability.multiple !== 'boolean') {
    return invalid(`requirement ${index} of ${owner} has an invalid provider policy`, {
      capabilityId: String(req.capability.id),
    });
  }
  if (typeof req.range !== 'string' || !isValidRange(req.range)) {
    return invalid(`requirement ${index} of ${owner} has an invalid semver range`, {
      capabilityId: req.capability.id,
    });
  }
  if (req.optional !== undefined && typeof req.optional !== 'boolean') {
    return invalid(`requirement ${index} of ${owner} has a non-boolean optional flag`, {
      capabilityId: req.capability.id,
    });
  }
  return undefined;
}

function validateProvided(provided: unknown, owner: string, index: number): MoltError | undefined {
  if (typeof provided !== 'object' || provided === null) {
    return invalid(`provided capability ${index} of ${owner} is not an object`);
  }
  // Validated boundary: object shape is asserted above, contents below.
  const prov = provided as ProvidedCapability;
  if (typeof prov.capability !== 'object' || prov.capability === null) {
    return invalid(`provided capability ${index} of ${owner} has no capability token`);
  }
  if (!isValidRuntimeId(prov.capability.id) || !isValidVersion(prov.capability.version)) {
    return invalid(`provided capability ${index} of ${owner} has an invalid capability token`, {
      capabilityId: String(prov.capability.id),
    });
  }
  if (typeof prov.capability.multiple !== 'boolean') {
    return invalid(`provided capability ${index} of ${owner} has an invalid provider policy`, {
      capabilityId: String(prov.capability.id),
    });
  }
  if (prov.multiple !== undefined && typeof prov.multiple !== 'boolean') {
    return invalid(`provided capability ${index} of ${owner} has a non-boolean multiple`, {
      capabilityId: prov.capability.id,
    });
  }
  return undefined;
}

/** Returns the first validation failure, or undefined when the definition is well-formed. */
export function validateDefinition(definition: PluginDefinition): MoltError | undefined {
  if (typeof definition !== 'object' || definition === null) {
    return invalid('plugin definition is not an object');
  }
  if (!isValidRuntimeId(definition.id)) {
    return invalid(`invalid plugin id: ${String(definition.id)}`);
  }
  const owner = definition.id;
  if (!isValidVersion(definition.version)) {
    return invalid(`invalid plugin version: ${String(definition.version)}`, { pluginId: owner });
  }
  if (typeof definition.setup !== 'function') {
    return invalid('setup must be a function', { pluginId: owner });
  }
  if (definition.requires !== undefined && !Array.isArray(definition.requires)) {
    return invalid('requires must be an array', { pluginId: owner });
  }
  if (definition.provides !== undefined && !Array.isArray(definition.provides)) {
    return invalid('provides must be an array', { pluginId: owner });
  }
  const requires: readonly unknown[] = definition.requires ?? [];
  const provides: readonly unknown[] = definition.provides ?? [];

  const requiredIds = new Set<string>();
  let index = 0;
  for (const requirement of requires) {
    const failure = validateRequirement(requirement, owner, index);
    if (failure !== undefined) {
      return failure;
    }
    const capabilityId = requirementCapabilityId(requirement);
    if (requiredIds.has(capabilityId)) {
      return invalid(`duplicate requirement for capability ${capabilityId}`, {
        pluginId: owner,
        capabilityId,
      });
    }
    requiredIds.add(capabilityId);
    index += 1;
  }

  const providedIds = new Set<string>();
  index = 0;
  for (const provided of provides) {
    const failure = validateProvided(provided, owner, index);
    if (failure !== undefined) {
      return failure;
    }
    const parts = providedParts(provided);
    const capabilityId = parts.capability.id;
    if (providedIds.has(capabilityId)) {
      return invalid(`duplicate provide for capability ${capabilityId}`, {
        pluginId: owner,
        capabilityId,
      });
    }
    providedIds.add(capabilityId);
    // The token is the authority on provider policy; a declaration that
    // disagrees with it is a definition error.
    if (parts.multiple !== undefined && parts.multiple !== parts.capability.multiple) {
      return invalid(
        `provide declaration for ${capabilityId} disagrees with the token's provider policy`,
        { pluginId: owner, capabilityId },
      );
    }
    index += 1;
  }

  for (const capabilityId of providedIds) {
    if (requiredIds.has(capabilityId)) {
      return invalid(`plugin ${owner} cannot require and provide ${capabilityId}`, {
        pluginId: owner,
        capabilityId,
      });
    }
  }
  return undefined;
}

/**
 * Shallow-freezes the definition, its arrays, and their entries.
 * Returns the same object, frozen.
 */
export function freezeDefinition<T extends PluginDefinition>(definition: T): T {
  Object.freeze(definition);
  if (definition.requires !== undefined) {
    Object.freeze(definition.requires);
    for (const requirement of definition.requires) {
      Object.freeze(requirement.capability);
      Object.freeze(requirement);
    }
  }
  if (definition.provides !== undefined) {
    Object.freeze(definition.provides);
    for (const provided of definition.provides) {
      Object.freeze(provided.capability);
      Object.freeze(provided);
    }
  }
  return definition;
}
