// Capability resolution. Selection — not manifest order — drives the graph.
// The resolver is pure: no I/O, no timing, no lifecycle; the runtime feeds
// it state and consumes the plan. Determinism contract: identical inputs in
// any order produce identical plans (candidates sorted, ready sets
// lexicographic).

import type { Capability } from './capability.js';
import type { PluginDefinition, PluginStatus } from './definition.js';
import { validateDefinition } from './definition.js';
import { MoltError } from './errors.js';
import { satisfiesRange } from './internal/semver.js';

export interface HostProvider {
  readonly capability: Capability<unknown>;
  readonly value: unknown;
}

/** The published capability view supplied to isolated replacement resolution. @internal */
export interface CandidateProvider {
  readonly pluginId: string | null;
  readonly capability: Capability<unknown>;
}

interface ProviderSelection {
  /** null = host provider. */
  readonly pluginId: string | null;
  readonly capabilityVersion: string;
}

export interface ResolutionPlan {
  /** Activation order for the closure: providers first, root last. */
  readonly order: readonly string[];
  /**
   * consumer plugin id → capability id → selected providers in documented
   * order (host first, then id lexicographic). A selection belongs to the
   * consumer requirement that produced it; capability id alone is not a
   * sufficient key when consumers request different ranges.
   */
  readonly providers: ReadonlyMap<string, ReadonlyMap<string, readonly ProviderSelection[]>>;
  readonly edges: readonly ResolutionEdge[];
  /** Informational diagnostics (e.g. optional requirements with incompatible candidates). */
  readonly diagnostics: readonly BlockedDiagnostic[];
}

interface ResolutionEdge {
  readonly from: string;
  readonly to: string;
  readonly capabilityId: string;
  readonly range: string;
  readonly optional: boolean;
}

/**
 * Diagnostic explaining why a requirement had no selectable provider.
 *
 * @public
 */
export interface BlockedDiagnostic {
  /** Plugin that could not satisfy the requirement. */
  readonly pluginId: string;
  /** Requirement that produced the diagnostic. */
  readonly requirement: {
    /** Capability identifier requested by the plugin. */
    readonly capabilityId: string;
    /** Semver range accepted by the plugin. */
    readonly range: string;
    /** Whether the requirement was optional. */
    readonly optional: boolean;
  };
  /** Providers considered by resolution and their verdicts. */
  readonly candidates: readonly {
    /** Provider plugin id, or `null` for a host provider. */
    readonly pluginId: string | null;
    /** Capability version offered by the provider. */
    readonly version: string;
    /** Why the provider was or was not selectable. */
    readonly verdict: 'incompatible' | 'stopped' | 'ok';
  }[];
}

export interface ResolutionInput {
  readonly definitions: readonly PluginDefinition[];
  /** Selection needs statuses: stopped providers are visible, never selectable. */
  readonly statuses: ReadonlyMap<string, PluginStatus>;
  readonly hostProviders: ReadonlyMap<string, HostProvider>;
  /** The resolver produces the provider closure of this plugin, root last. */
  readonly root: string;
}

interface Candidate {
  readonly pluginId: string | null;
  readonly capabilityVersion: string;
  readonly selectable: boolean;
}

const HOST_EDGE_TARGET = '(host)';

function validateResolverDefinition(definition: PluginDefinition): MoltError | undefined {
  return validateDefinition(definition);
}

function blockedDiagnostic(
  pluginId: string,
  capabilityId: string,
  range: string,
  optional: boolean,
  candidates: readonly Candidate[],
  compatible: readonly Candidate[],
): BlockedDiagnostic {
  return {
    pluginId,
    requirement: { capabilityId, range, optional },
    candidates: candidates.map((candidate) => ({
      pluginId: candidate.pluginId,
      version: candidate.capabilityVersion,
      verdict: compatible.includes(candidate)
        ? candidate.selectable
          ? 'ok'
          : 'stopped'
        : 'incompatible',
    })),
  };
}

export function resolve(input: ResolutionInput): ResolutionPlan {
  const { definitions, statuses, hostProviders, root } = input;

  // 1–2: defensive re-validation and duplicate rejection (install validates
  // already; the resolver never trusts its input).
  const byId = new Map<string, PluginDefinition>();
  for (const definition of definitions) {
    const failure = validateResolverDefinition(definition);
    if (failure !== undefined) {
      throw failure;
    }
    if (byId.has(definition.id)) {
      throw new MoltError({
        code: 'DUPLICATE_PLUGIN',
        message: `duplicate plugin id ${definition.id}`,
        pluginId: definition.id,
      });
    }
    byId.set(definition.id, definition);
  }
  if (!byId.has(root)) {
    throw new MoltError({
      code: 'INVALID_STATE',
      message: `root plugin ${root} is not installed`,
      pluginId: root,
      details: { reason: 'not-installed' },
    });
  }

  // 3: candidate pool — host providers plus every definition declaring the
  // token. Stopped definitions stay visible for diagnostics but are never
  // selectable (a host must not have a user-disabled plugin silently
  // restarted).
  const candidates = new Map<string, Candidate[]>();
  const addCandidate = (capabilityId: string, candidate: Candidate): void => {
    const list = candidates.get(capabilityId);
    if (list === undefined) {
      candidates.set(capabilityId, [candidate]);
    } else {
      list.push(candidate);
    }
  };
  for (const [capabilityId, host] of hostProviders) {
    addCandidate(capabilityId, {
      pluginId: null,
      capabilityVersion: host.capability.version,
      selectable: true,
    });
  }
  for (const definition of definitions) {
    for (const provided of definition.provides ?? []) {
      addCandidate(provided.capability.id, {
        pluginId: definition.id,
        capabilityVersion: provided.capability.version,
        selectable: statuses.get(definition.id) !== 'stopped',
      });
    }
  }

  const selection = new Map<string, Map<string, ProviderSelection[]>>();
  const edges: ResolutionEdge[] = [];
  const diagnostics: BlockedDiagnostic[] = [];

  // 4: requirement walk — definitions sorted by id, requirements in declared
  // order, so diagnostics and edges are deterministic under input permutation.
  const sortedDefinitions = [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const definition of sortedDefinitions) {
    for (const requirement of definition.requires ?? []) {
      const capabilityId = requirement.capability.id;
      const range = requirement.range;
      const pool = candidates.get(capabilityId) ?? [];
      const compatible = pool.filter((candidate) =>
        satisfiesRange(candidate.capabilityVersion, range),
      );
      const selectable = compatible.filter((candidate) => candidate.selectable);
      const diagnostic = blockedDiagnostic(
        definition.id,
        capabilityId,
        range,
        requirement.optional === true,
        pool,
        compatible,
      );

      if (selectable.length === 0) {
        if (requirement.optional === true) {
          // Visibility without failure: no edge, diagnostic kept.
          if (pool.length > 0) {
            diagnostics.push(diagnostic);
          }
          continue;
        }
        if (pool.length === 0) {
          throw new MoltError({
            code: 'MISSING_CAPABILITY',
            message: `no provider for capability ${capabilityId}`,
            pluginId: definition.id,
            capabilityId,
            details: { blocked: [diagnostic] },
          });
        }
        if (compatible.length === 0) {
          throw new MoltError({
            code: 'INCOMPATIBLE_CAPABILITY',
            message: `no provider of ${capabilityId} satisfies ${range}`,
            pluginId: definition.id,
            capabilityId,
            details: { blocked: [diagnostic] },
          });
        }
        // Compatible but stopped: real providers exist, none usable.
        throw new MoltError({
          code: 'MISSING_CAPABILITY',
          message: `every provider of ${capabilityId} is stopped`,
          pluginId: definition.id,
          capabilityId,
          details: { blocked: [diagnostic] },
        });
      }

      if (selectable.length > 1 && requirement.capability.multiple !== true) {
        throw new MoltError({
          code: 'AMBIGUOUS_PROVIDER',
          message: `${selectable.length} providers satisfy ${capabilityId}@${range}`,
          pluginId: definition.id,
          capabilityId,
          details: { blocked: [diagnostic] },
        });
      }

      // Documented order: host providers first, then plugin id lexicographic.
      const ordered = [...selectable].sort((a, b) => {
        if (a.pluginId === null) {
          return b.pluginId === null ? 0 : -1;
        }
        if (b.pluginId === null) {
          return 1;
        }
        return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
      });
      let consumerSelections = selection.get(definition.id);
      if (consumerSelections === undefined) {
        consumerSelections = new Map<string, ProviderSelection[]>();
        selection.set(definition.id, consumerSelections);
      }
      consumerSelections.set(
        capabilityId,
        ordered.map((candidate) => ({
          pluginId: candidate.pluginId,
          capabilityVersion: candidate.capabilityVersion,
        })),
      );
      for (const candidate of ordered) {
        edges.push({
          from: definition.id,
          to: candidate.pluginId ?? HOST_EDGE_TARGET,
          capabilityId,
          range,
          optional: requirement.optional === true,
        });
      }
    }
  }

  // 5–6: cycle detection over selected edges — a provider ignored by
  // selection cannot create a cycle. Full traversal path is reported.
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list === undefined) {
      adjacency.set(edge.from, [edge.to]);
    } else {
      list.push(edge.to);
    }
  }
  const UNVISITED = 0;
  const VISITING = 1;
  const DONE = 2;
  const marks = new Map<string, number>();
  for (const definition of byId.values()) {
    marks.set(definition.id, UNVISITED);
  }
  const detectCycle = (node: string, stack: string[]): void => {
    const mark = marks.get(node);
    if (mark === VISITING) {
      const start = stack.indexOf(node);
      const path = start >= 0 ? [...stack.slice(start), node] : [node, node];
      throw new MoltError({
        code: 'DEPENDENCY_CYCLE',
        message: `dependency cycle: ${path.join(' -> ')}`,
        pluginId: root,
        path,
      });
    }
    if (mark === DONE) {
      return;
    }
    marks.set(node, VISITING);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      detectCycle(next, stack);
    }
    stack.pop();
    marks.set(node, DONE);
  };
  for (const nodeId of [...byId.keys()].sort()) {
    detectCycle(nodeId, []);
  }

  // 7: closure of the root over requirement edges, then Kahn topological
  // order with a lexicographic ready set — providers before consumers.
  const closure = new Set<string>([root]);
  const collect = (node: string): void => {
    for (const next of adjacency.get(node) ?? []) {
      if (next === HOST_EDGE_TARGET || closure.has(next)) {
        continue;
      }
      closure.add(next);
      collect(next);
    }
  };
  collect(root);

  const dependenciesWithinClosure = new Map<string, Set<string>>();
  for (const node of closure) {
    const deps = new Set<string>();
    for (const next of adjacency.get(node) ?? []) {
      if (closure.has(next) && next !== node) {
        deps.add(next);
      }
    }
    dependenciesWithinClosure.set(node, deps);
  }

  // Kahn's algorithm; the ready set is kept sorted so the order is a pure
  // function of the graph.
  const inDegree = new Map<string, number>();
  const dependentsOf = new Map<string, string[]>();
  for (const [node, deps] of dependenciesWithinClosure) {
    inDegree.set(node, deps.size);
    for (const dep of deps) {
      const list = dependentsOf.get(dep);
      if (list === undefined) {
        dependentsOf.set(dep, [node]);
      } else {
        list.push(node);
      }
    }
  }
  const ready = [...closure].filter((node) => (inDegree.get(node) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (node === undefined) {
      break; // unreachable: loop condition guarantees a value
    }
    order.push(node);
    for (const dependent of dependentsOf.get(node) ?? []) {
      const current = inDegree.get(dependent);
      if (current === undefined) {
        continue;
      }
      const remaining = current - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
    ready.sort();
  }

  return {
    order,
    providers: selection,
    edges,
    diagnostics,
  };
}

/**
 * Resolves one replacement candidate against the currently published view.
 * The old generation is intentionally present in this view because it remains
 * authoritative until candidate commit.
 */
export function resolveCandidate(input: {
  readonly definition: PluginDefinition;
  readonly providers: readonly CandidateProvider[];
}): ResolutionPlan {
  const { definition, providers } = input;
  const selected = new Map<string, Map<string, readonly ProviderSelection[]>>();
  const edges: ResolutionEdge[] = [];
  const diagnostics: BlockedDiagnostic[] = [];

  for (const requirement of definition.requires ?? []) {
    const pool = providers
      .filter(
        (provider) =>
          provider.capability.id === requirement.capability.id &&
          // A candidate cannot bind to its own old generation: that binding is
          // withdrawn at commit, and self-resolution is rejected.
          provider.pluginId !== definition.id,
      )
      .map((provider) => ({
        pluginId: provider.pluginId,
        capabilityVersion: provider.capability.version,
        selectable: true,
      }));
    const compatible = pool.filter((candidate) =>
      satisfiesRange(candidate.capabilityVersion, requirement.range),
    );
    const selectable = compatible;
    const diagnostic = blockedDiagnostic(
      definition.id,
      requirement.capability.id,
      requirement.range,
      requirement.optional === true,
      pool,
      compatible,
    );

    if (selectable.length === 0) {
      if (requirement.optional === true) {
        if (pool.length > 0) {
          diagnostics.push(diagnostic);
        }
        continue;
      }
      if (pool.length === 0) {
        throw new MoltError({
          code: 'MISSING_CAPABILITY',
          message: `no active provider for capability ${requirement.capability.id}`,
          pluginId: definition.id,
          capabilityId: requirement.capability.id,
          details: { blocked: [diagnostic] },
        });
      }
      throw new MoltError({
        code: 'INCOMPATIBLE_CAPABILITY',
        message: `no active provider of ${requirement.capability.id} satisfies ${requirement.range}`,
        pluginId: definition.id,
        capabilityId: requirement.capability.id,
        details: { blocked: [diagnostic] },
      });
    }

    if (selectable.length > 1 && requirement.capability.multiple !== true) {
      throw new MoltError({
        code: 'AMBIGUOUS_PROVIDER',
        message: `${selectable.length} active providers satisfy ${requirement.capability.id}@${requirement.range}`,
        pluginId: definition.id,
        capabilityId: requirement.capability.id,
        details: { blocked: [diagnostic] },
      });
    }

    const ordered = [...selectable].sort(compareCandidates);
    let consumerSelections: Map<string, readonly ProviderSelection[]> | undefined = selected.get(
      definition.id,
    );
    if (consumerSelections === undefined) {
      consumerSelections = new Map<string, readonly ProviderSelection[]>();
      selected.set(definition.id, consumerSelections);
    }
    consumerSelections.set(
      requirement.capability.id,
      ordered.map((candidate) => ({
        pluginId: candidate.pluginId,
        capabilityVersion: candidate.capabilityVersion,
      })),
    );
    for (const candidate of ordered) {
      edges.push({
        from: definition.id,
        to: candidate.pluginId ?? HOST_EDGE_TARGET,
        capabilityId: requirement.capability.id,
        range: requirement.range,
        optional: requirement.optional === true,
      });
    }
  }

  return {
    order: [definition.id],
    providers: selected,
    edges,
    diagnostics,
  };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.pluginId === null) {
    return b.pluginId === null ? 0 : -1;
  }
  if (b.pluginId === null) {
    return 1;
  }
  return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
}
