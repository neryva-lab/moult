// Inspection: frozen snapshots over runtime state. The blocked-plugin tree
// renders from BlockedDiagnostic data — the diagnostic contract is data,
// not text, so hosts can build their own views.

import type { DiagnosticInput, PluginStatus } from './definition.js';
import type { BlockedDiagnostic } from './resolver.js';
import type { RuntimeInspection } from './runtime.js';

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

function snapshotDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  // The input has already crossed the typed DiagnosticInput boundary; this
  // runtime copy preserves the record shape while isolating nested metadata.
  return cloneAndFreeze(details) as Readonly<Record<string, unknown>>;
}

function snapshotDiagnostic(input: DiagnosticInput): DiagnosticInput {
  return Object.freeze({
    message: input.message,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.details !== undefined ? { details: snapshotDetails(input.details) } : {}),
  });
}

function snapshotBlocked(blocked: BlockedDiagnostic): BlockedDiagnostic {
  return Object.freeze({
    pluginId: blocked.pluginId,
    requirement: Object.freeze({ ...blocked.requirement }),
    candidates: Object.freeze(
      blocked.candidates.map((candidate) => Object.freeze({ ...candidate })),
    ),
  });
}

export interface InspectionPluginInput {
  readonly id: string;
  readonly status: PluginStatus;
  readonly generationId?: string | undefined;
  readonly error?: unknown;
  /** Pre-extracted from a resolution failure's structured details, if any. */
  readonly blocked?: readonly BlockedDiagnostic[] | undefined;
  /** The generation's capped diagnostic log, when one is committed. */
  readonly diagnostics?: readonly DiagnosticInput[] | undefined;
}

export interface InspectionCapabilityInput {
  readonly id: string;
  readonly provider: string;
  readonly version: string;
}

export function buildInspection(input: {
  readonly plugins: readonly InspectionPluginInput[];
  readonly capabilities: readonly InspectionCapabilityInput[];
  readonly observerDiagnostics?: readonly {
    readonly message: string;
    readonly cause: unknown;
  }[];
}): RuntimeInspection {
  const capabilities = [...input.capabilities].sort((a, b) =>
    a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : a.provider < b.provider
          ? -1
          : a.provider > b.provider
            ? 1
            : 0,
  );
  return Object.freeze({
    plugins: Object.freeze(
      input.plugins.map((plugin) =>
        Object.freeze({
          id: plugin.id,
          status: plugin.status,
          // exactOptionalPropertyTypes: absent fields stay absent.
          ...(plugin.generationId !== undefined ? { generation: plugin.generationId } : {}),
          ...(plugin.error !== undefined ? { error: plugin.error } : {}),
          ...(plugin.blocked !== undefined
            ? { blockedBy: Object.freeze(plugin.blocked.map(snapshotBlocked)) }
            : {}),
          ...(plugin.diagnostics !== undefined
            ? { diagnostics: Object.freeze(plugin.diagnostics.map(snapshotDiagnostic)) }
            : {}),
        }),
      ),
    ),
    capabilities: Object.freeze(capabilities.map((capability) => Object.freeze({ ...capability }))),
    observerDiagnostics: Object.freeze(
      (input.observerDiagnostics ?? []).map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

/** Renders the blocked-plugin tree for one diagnostic entry. */
export function formatBlockedPlugin(blocked: BlockedDiagnostic): string {
  const lines: string[] = [`${blocked.pluginId} cannot start`];
  lines.push(
    `└─ requires ${blocked.requirement.capabilityId} ${blocked.requirement.range}${
      blocked.requirement.optional ? ' (optional)' : ''
    }`,
  );
  blocked.candidates.forEach((candidate, index) => {
    const name = candidate.pluginId ?? '(host)';
    const branch = index === blocked.candidates.length - 1 ? '└─' : '├─';
    if (candidate.verdict === 'incompatible') {
      lines.push(`   ${branch} ${name} provides ${candidate.version} (incompatible)`);
    } else if (candidate.verdict === 'stopped') {
      lines.push(`   ${branch} ${name} provides ${candidate.version} but is stopped`);
    } else {
      lines.push(`   ${branch} ${name} provides ${candidate.version}`);
    }
  });
  return lines.join('\n');
}
