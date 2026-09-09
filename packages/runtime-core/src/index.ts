/**
 * A general plugin runtime for safe replacement. A plugin is a versioned
 * capability provider running inside an owned resource scope; replacement is
 * prepared in isolation and committed only after successful preparation.
 *
 * @packageDocumentation
 */

// Public export surface of @moult/runtime. Every change here is reviewed
// against the checked-in API report before release.
// Scope and PluginContext are types consumers receive; core is their only
// constructor. Nothing from internal/ is exported.

import { capability } from './capability.js';
import { contributionKey } from './contributions.js';
import { isMoltError, MoltError } from './errors.js';
import { createRuntime } from './runtime.js';

export { capability, contributionKey, createRuntime, isMoltError, MoltError };

export type { Capability } from './capability.js';
export type { ContributionEntry, ContributionKey, ContributionSnapshot } from './contributions.js';
export type {
  DiagnosticInput,
  DisposableLike,
  PluginContext,
  PluginDefinition,
  PluginStatus,
  ProvidedCapability,
  Requirement,
} from './definition.js';
export type { DisposalReport, MoltErrorInit, RuntimeErrorCode } from './errors.js';
export type { BlockedDiagnostic } from './resolver.js';
export type { Runtime, RuntimeInspection, RuntimeListener, RuntimeOptions } from './runtime.js';
export type { Scope } from './scope.js';
