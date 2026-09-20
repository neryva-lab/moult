// Capability resolution. Selection — not manifest order — drives the graph.
// The resolver is pure: no I/O, no timing, no lifecycle; the runtime feeds
// it state and consumes the plan. Determinism contract: identical inputs in
// any order produce identical plans (candidates sorted, ready sets
// lexicographic). All traversals are iterative: deep dependency graphs must
// not overflow the call stack.

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
  /**
   * Selection needs statuses. Selectability is tiered: active providers
   * (tier 1) always win; stopped providers (tier 2) are revived only when
   * no tier-1 candidate satisfies the requirement — starting a root is
   * explicit consent to revive its provider closure (F1 restart), but a
   * stopped provider never silently beats an active one. The root itself
   * is always tier 1.
   */
  readonly statuses: ReadonlyMap<string, PluginStatus>;
  readonly hostProviders: ReadonlyMap<string, HostProvider>;
  /** The resolver produces the provider closure of this plugin, root last. */
  readonly root: string;
  /**
   * Treat every definition as selectable regardless of status. Static
   * validation (`runtime.validate`) asks "could this graph ever activate?"
   * rather than "can it activate right now?".
   */
  readonly ignoreStopped?: boolean | undefined;
}

interface Candidate {
  readonly pluginId: string | null;
  readonly capabilityVersion: string;
  /**
   * Selection tier: 1 = preferred (active, host, or the root itself);
   * 2 = stopped fallback, revived only when no tier-1 candidate exists.
   */
  readonly tier: 1 | 2;
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
  selected: readonly Candidate[],
): BlockedDiagnostic {
  return {
    pluginId,
    requirement: { capabilityId, range, optional },
    candidates: candidates.map((candidate) => ({
      pluginId: candidate.pluginId,
      version: candidate.capabilityVersion,
      verdict: !compatible.includes(candidate)
        ? 'incompatible'
        : selected.includes(candidate)
          ? 'ok'
          : 'stopped',
    })),
  };
}

/** A minimal binary heap ordered lexicographically. */
class StringHeap {
  #items: string[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(value: string): void {
    const items = this.#items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      // Indexed access is guarded: noUncheckedIndexedAccess reports
      // undefined for every index, so the comparisons below are total.
      const parentValue = items[parent];
      const currentValue = items[index];
      if (parentValue === undefined || currentValue === undefined || parentValue <= currentValue) {
        break;
      }
      items[parent] = currentValue;
      items[index] = parentValue;
      index = parent;
    }
  }

  pop(): string | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        const smallestValue = items[smallest];
        const leftValue = items[left];
        if (leftValue !== undefined && (smallestValue === undefined || leftValue < smallestValue)) {
          smallest = left;
        }
        const nextSmallestValue = items[smallest];
        const rightValue = items[right];
        if (
          rightValue !== undefined &&
          (nextSmallestValue === undefined || rightValue < nextSmallestValue)
        ) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        const indexValue = items[index];
        const swapValue = items[smallest];
        if (indexValue === undefined || swapValue === undefined) {
          break;
        }
        items[index] = swapValue;
        items[smallest] = indexValue;
        index = smallest;
      }
    }
    return top;
  }
}

export function resolve(input: ResolutionInput): ResolutionPlan {
  const { definitions, statuses, hostProviders, root } = input;
  const ignoreStopped = input.ignoreStopped === true;

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
  // token, each tagged with its selection tier (see ResolutionInput).
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
      tier: 1,
    });
  }
  for (const definition of definitions) {
    const id = definition.id;
    const isRoot = id === root;
    const status = statuses.get(id);
    const tier: 1 | 2 = isRoot || ignoreStopped || status !== 'stopped' ? 1 : 2;
    for (const provided of definition.provides ?? []) {
      addCandidate(provided.capability.id, {
        pluginId: id,
        capabilityVersion: provided.capability.version,
        tier,
      });
    }
  }

  const selection = new Map<string, Map<string, ProviderSelection[]>>();
  const edges: ResolutionEdge[] = [];
  const diagnostics: BlockedDiagnostic[] = [];

  // 4: requirement fixpoint — starting from the root, select providers for
  // every requirement in lexicographic definition order. Only the selected
  // closure is walked: a broken requirement on a definition nobody selects
  // cannot poison this activation. Selection is order-independent (the pool
  // is static), so the lexicographic worklist keeps diagnostics and edges
  // deterministic.
  const selected = new Set<string>([root]);
  const worklist = new StringHeap();
  worklist.push(root);
  let node = worklist.pop();
  while (node !== undefined) {
    const definition = byId.get(node);
    if (definition === undefined) {
      // Internal invariant: the worklist only holds ids taken from byId.
      throw new MoltError({
        code: 'INVALID_STATE',
        message: `resolution worklist referenced unknown plugin ${node}`,
        pluginId: root,
        details: { reason: 'resolver-invariant' },
      });
    }
    for (const requirement of definition.requires ?? []) {
      const capabilityId = requirement.capability.id;
      const range = requirement.range;
      const pool = candidates.get(capabilityId) ?? [];
      const compatible = pool.filter((candidate) =>
        satisfiesRange(candidate.capabilityVersion, range),
      );
      // Tiered selection: active providers win; stopped providers are
      // revived only when no tier-1 candidate satisfies the requirement;
      // lazy providers never win implicitly.
      const tier1 = compatible.filter((candidate) => candidate.tier === 1);
      const tier2 = compatible.filter((candidate) => candidate.tier === 2);
      const selectable = tier1.length > 0 ? tier1 : tier2;
      // Diagnostics are built lazily: the happy path records none.
      const diagnostic = (): BlockedDiagnostic =>
        blockedDiagnostic(
          definition.id,
          capabilityId,
          range,
          requirement.optional === true,
          pool,
          compatible,
          selectable,
        );

      if (selectable.length === 0) {
        if (requirement.optional === true) {
          // Visibility without failure: no edge, diagnostic kept.
          if (pool.length > 0) {
            diagnostics.push(diagnostic());
          }
          continue;
        }
        if (pool.length === 0) {
          throw new MoltError({
            code: 'MISSING_CAPABILITY',
            message: `no provider for capability ${capabilityId}`,
            pluginId: definition.id,
            capabilityId,
            details: { blocked: [diagnostic()] },
          });
        }
        if (compatible.length === 0) {
          throw new MoltError({
            code: 'INCOMPATIBLE_CAPABILITY',
            message: `no provider of ${capabilityId} satisfies ${range}`,
            pluginId: definition.id,
            capabilityId,
            details: { blocked: [diagnostic()] },
          });
        }
        // Selectable is empty while compatible is not: every compatible
        // candidate is lazy, so nothing can be chosen implicitly.
        throw new MoltError({
          code: 'MISSING_CAPABILITY',
          message: `every provider of ${capabilityId} is lazy; start one explicitly`,
          pluginId: definition.id,
          capabilityId,
          details: { blocked: [diagnostic()] },
        });
      }

      if (selectable.length > 1 && requirement.capability.multiple !== true) {
        throw new MoltError({
          code: 'AMBIGUOUS_PROVIDER',
          message: `${selectable.length} providers satisfy ${capabilityId}@${range}`,
          pluginId: definition.id,
          capabilityId,
          details: { blocked: [diagnostic()] },
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
        if (candidate.pluginId !== null && !selected.has(candidate.pluginId)) {
          selected.add(candidate.pluginId);
          worklist.push(candidate.pluginId);
        }
      }
    }
    node = worklist.pop();
  }

  // 5: Kahn topological order over the selected closure with a
  // lexicographic ready heap — providers before consumers, root last. A
  // dependency cycle leaves nodes unconsumed; the reported path is found by
  // walking the remainder until a node repeats. Iterative throughout.
  const dependencies = new Map<string, Set<string>>();
  const dependentsOf = new Map<string, Set<string>>();
  for (const id of selected) {
    dependencies.set(id, new Set<string>());
  }
  for (const edge of edges) {
    if (edge.to === HOST_EDGE_TARGET || !selected.has(edge.to) || edge.to === edge.from) {
      continue;
    }
    const deps = dependencies.get(edge.from);
    if (deps !== undefined) {
      deps.add(edge.to);
    }
    // A distinct set: in-degree counts distinct providers, so each dependent
    // must be decremented exactly once per provider. A plain list would
    // decrement one consumer twice when two capabilities select the same
    // (consumer, provider) pair, emitting the consumer before its other
    // provider and breaking the topological order.
    let dependents = dependentsOf.get(edge.to);
    if (dependents === undefined) {
      dependents = new Set<string>();
      dependentsOf.set(edge.to, dependents);
    }
    dependents.add(edge.from);
  }

  const inDegree = new Map<string, number>();
  for (const [id, deps] of dependencies) {
    inDegree.set(id, deps.size);
  }
  const ready = new StringHeap();
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      ready.push(id);
    }
  }
  const order: string[] = [];
  const consumed = new Set<string>();
  let next = ready.pop();
  while (next !== undefined) {
    order.push(next);
    consumed.add(next);
    for (const dependent of dependentsOf.get(next) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
    next = ready.pop();
  }

  if (order.length !== selected.size) {
    // Cycle: every remaining node still has a dependency inside the
    // remainder, so following requirement edges from any of them must
    // eventually repeat a node.
    const remaining = new Set<string>();
    for (const id of selected) {
      if (!consumed.has(id)) {
        remaining.add(id);
      }
    }
    let start: string | undefined;
    for (const id of [...remaining].sort()) {
      start = id;
      break;
    }
    const trail: string[] = [];
    const seenAt = new Map<string, number>();
    let cursor = start;
    while (cursor !== undefined && !seenAt.has(cursor)) {
      seenAt.set(cursor, trail.length);
      trail.push(cursor);
      let following: string | undefined;
      const outs = [...(dependencies.get(cursor) ?? [])].filter((id) => remaining.has(id)).sort();
      for (const id of outs) {
        following = id;
        break;
      }
      cursor = following;
    }
    const cycleStart = cursor === undefined ? 0 : (seenAt.get(cursor) ?? 0);
    const path = [...trail.slice(cycleStart), ...(cursor === undefined ? [] : [cursor])];
    throw new MoltError({
      code: 'DEPENDENCY_CYCLE',
      message: `dependency cycle: ${path.join(' -> ')}`,
      pluginId: root,
      path,
    });
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
    const pool: Candidate[] = providers
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
        tier: 1,
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
      selectable,
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
