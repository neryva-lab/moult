// Reference model for the property suite.
//
// The model is intentionally minimal: it tracks plugin statuses, published
// bindings, contribution owners, and the activation order, and it re-derives
// resolution with the same rules as the engine. Any divergence
// between model and runtime pinpoints the operation that broke it. The model
// is written from the spec documents, not from runtime.ts, so a shared
// misunderstanding is caught by the unit inventory rather than replicated
// here.

import type { RuntimeErrorCode } from '../../src/index.js';
import type { PluginStatus } from '../../src/index.js';
import { satisfiesRange } from '../../src/internal/semver.js';
import type { World, WorldPlugin } from './generators.js';

export interface ModelEvent {
  readonly type: 'installed' | 'started' | 'stopped' | 'replaced' | 'failed' | 'disposed';
  readonly pluginId?: string | undefined;
  readonly generation?: string | undefined;
  readonly cascade?: readonly string[] | undefined;
}

export type ModelOutcome =
  | { readonly ok: true; readonly generationId?: undefined }
  | { readonly ok: false; readonly code: RuntimeErrorCode };

/** Model statuses include the transient engine statuses; walkers never observe them. */
type ModelStatus = PluginStatus;

interface ModelPlugin {
  status: ModelStatus;
  definition: WorldPlugin;
  /** runTag of the definition currently installed (op index of its install/replace). */
  runTag: number;
  generation: string | undefined;
  hasError: boolean;
}

interface ModelSelection {
  readonly pluginId: string | null;
  readonly capabilityVersion: string;
}

type ModelProviderSelections = ReadonlyMap<string, readonly ModelSelection[]>;

export class ModelRuntime {
  readonly world: World;
  readonly plugins = new Map<string, ModelPlugin>();
  /** capabilityId → generationId → binding; insertion order = commit order. */
  readonly published = new Map<string, Map<string, ModelSelection>>();
  /** contribution keyId → generationId → { pluginId, valueRef }. */
  readonly contributions = new Map<string, Map<string, { pluginId: string; valueRef: string }>>();
  /** Live generations, in activation order. */
  readonly activationOrder: string[] = [];
  /** generationId → resources acquired by its setup (live generations only). */
  readonly genResources = new Map<string, number>();
  /** generationId → provider generationIds consumed (recorded at commit). */
  readonly genConsumes = new Map<string, Set<string>>();
  /** generationId → the definition's failDisposerThrow flag. */
  readonly genDisposeThrows = new Map<string, boolean>();
  readonly events: ModelEvent[] = [];
  /** Predicted serve log — must equal the setup-recorded log exactly. */
  readonly serves: { pluginId: string; capabilityId: string; servedBy: string }[] = [];
  counter = 0;
  disposed = false;

  constructor(world: World) {
    this.world = world;
  }

  private policyMultiple(capabilityId: string): boolean {
    const cap = this.world.capabilities.find((entry) => entry.id === capabilityId);
    if (cap === undefined) {
      throw new Error(`world has no capability ${capabilityId}`);
    }
    return cap.multiple;
  }

  // -- operations ---------------------------------------------------------------

  install(definition: WorldPlugin, runTag: number): ModelOutcome {
    if (this.disposed) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (this.plugins.has(definition.id)) {
      return { ok: false, code: 'DUPLICATE_PLUGIN' };
    }
    this.plugins.set(definition.id, {
      status: 'installed',
      definition,
      runTag,
      generation: undefined,
      hasError: false,
    });
    this.events.push({ type: 'installed', pluginId: definition.id });
    return { ok: true };
  }

  start(id: string): ModelOutcome {
    if (this.disposed) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    const record = this.plugins.get(id);
    if (record === undefined) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (record.status === 'active') {
      return { ok: false, code: 'INVALID_STATE' };
    }
    return this.#startDefinition(id, record);
  }

  /**
   * Shared start semantics for `start(id)` and for `replace` of a plugin with
   * no active generation (the engine swaps the definition, then delegates).
   */
  #startDefinition(id: string, record: ModelPlugin): ModelOutcome {
    // Engine: status 'preparing' is set before resolution — a stopped root is
    // selectable as a provider of its own closure (resolver reads statuses).
    record.status = 'preparing';
    const resolution = this.#resolve(id);
    if (!resolution.ok) {
      record.status = 'stopped';
      record.hasError = true;
      this.events.push({ type: 'failed', pluginId: id });
      return { ok: false, code: resolution.code };
    }

    const committed: string[] = [];
    let failure: ModelOutcome | undefined;
    for (const pluginId of resolution.order) {
      if (pluginId === id) {
        continue; // the root activates last
      }
      const target = this.plugins.get(pluginId);
      if (target === undefined) {
        failure = { ok: false, code: 'INVALID_STATE' };
        break;
      }
      if (target.status === 'active') {
        continue; // live providers are reused
      }
      const activated = this.#activate(target, resolution);
      if (!activated.ok) {
        failure = activated;
        break;
      }
      committed.push(activated.generationId);
    }
    if (failure === undefined) {
      const activated = this.#activate(record, resolution);
      if (!activated.ok) {
        failure = activated;
      } else {
        committed.push(activated.generationId);
      }
    }
    if (failure !== undefined) {
      // INV-01: every generation committed by this attempt is disposed —
      // resources released, publications withdrawn, records stopped, no
      // stopped events emitted.
      for (const generationId of [...committed].reverse()) {
        const { record: genRecord } = this.#ownerOf(generationId);
        genRecord.status = 'stopped';
        genRecord.generation = undefined;
        this.#withdrawGeneration(generationId);
      }
      record.status = 'stopped';
      record.hasError = true;
      this.events.push({ type: 'failed', pluginId: id });
      return failure;
    }
    return { ok: true };
  }

  stop(id: string, cascade: boolean): ModelOutcome {
    if (this.disposed) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    const record = this.plugins.get(id);
    if (record === undefined) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (record.status === 'stopped') {
      return { ok: true }; // no-op
    }
    if (record.status !== 'active' || record.generation === undefined) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    const dependents = this.#dependentsOfGeneration(record.generation);
    if (dependents.length > 0 && !cascade) {
      return { ok: false, code: 'ACTIVE_DEPENDENTS' }; // zero state change (INV-11)
    }

    // Reverse dependency order — the engine's recursive DFS over dependents,
    // iterating in activation order.
    const closure: string[] = [];
    const visited = new Set<string>([record.generation]);
    const visit = (generationId: string): void => {
      for (const dependent of this.#dependentsOfGeneration(generationId)) {
        if (!visited.has(dependent)) {
          visited.add(dependent);
          visit(dependent);
          closure.push(dependent);
        }
      }
    };
    visit(record.generation);
    closure.push(record.generation);

    const stoppedIds: string[] = [];
    for (const generationId of closure) {
      const { record: target, id: targetId } = this.#ownerOf(generationId);
      if (this.genDisposeThrows.get(generationId) === true) {
        target.hasError = true; // DISPOSAL_FAILED recorded, teardown continued (INV-03)
      }
      target.status = 'stopped';
      target.generation = undefined;
      this.#withdrawGeneration(generationId);
      stoppedIds.push(targetId);
      this.events.push({
        type: 'stopped',
        pluginId: targetId,
        generation: generationId,
        cascade: cascade && closure.length > 1 ? Object.freeze([...stoppedIds]) : undefined,
      });
    }
    return { ok: true };
  }

  replace(definition: WorldPlugin, runTag: number): ModelOutcome {
    if (this.disposed) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    const record = this.plugins.get(definition.id);
    if (record === undefined) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (record.status !== 'active') {
      // No active generation to protect — swap the definition, delegate to
      // activation.
      record.definition = definition;
      record.runTag = runTag;
      return this.#startDefinition(definition.id, record);
    }

    const oldGenerationId = record.generation;
    if (oldGenerationId === undefined) {
      throw new Error('model: active plugin without a generation');
    }
    // Any active dependent rejects the replacement before
    // a candidate scope exists — no events, zero state change.
    const dependents = this.#dependentsOfGeneration(oldGenerationId);
    if (dependents.length > 0) {
      return { ok: false, code: 'REPLACEMENT_FAILED' };
    }

    // Candidate preparation — the old generation keeps serving (INV-07).
    this.counter += 1;
    const candidateId = `${definition.id}#${String(this.counter)}`;
    const candidateProviders = this.#candidateSelections(definition);
    const candidateFailure = this.#prepareCandidate(
      definition,
      oldGenerationId,
      candidateProviders,
    );
    if (candidateFailure !== undefined) {
      record.hasError = true;
      this.events.push({ type: 'failed', pluginId: definition.id });
      return { ok: false, code: 'REPLACEMENT_FAILED' };
    }

    // Commit — engine order: candidate consumes recorded from current bindings
    // (the old generation is still published), then withdraw old, then publish
    // the candidate, then swap the record.
    const consumes = this.#candidateConsumes(definition, candidateProviders);
    const oldDisposeThrows = this.genDisposeThrows.get(oldGenerationId) === true;
    this.#withdrawGeneration(oldGenerationId);
    this.#publishCandidate(definition, runTag, candidateId, consumes);
    record.definition = definition;
    record.runTag = runTag;
    record.generation = candidateId;
    record.hasError = false;
    record.status = 'active';
    this.events.push({ type: 'replaced', pluginId: definition.id, generation: candidateId });
    if (oldDisposeThrows) {
      // INV-14: the replacement succeeded; the failure is inspectable and the
      // old generation is never restored (INV-08).
      record.hasError = true;
    }
    return { ok: true };
  }

  uninstall(id: string): ModelOutcome {
    if (this.disposed) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    const record = this.plugins.get(id);
    if (record === undefined) {
      return { ok: false, code: 'INVALID_STATE' };
    }
    if (record.status !== 'installed' && record.status !== 'stopped') {
      return { ok: false, code: 'INVALID_STATE' };
    }
    this.plugins.delete(id);
    return { ok: true };
  }

  dispose(): ModelOutcome {
    if (this.disposed) {
      return { ok: true }; // idempotent (INV-05)
    }
    this.disposed = true;
    // Reverse activation order. Runtime disposal emits ONE
    // terminal event — no per-plugin stopped events; statuses
    // change, the aggregate 'disposed' event is the notification.
    for (const generationId of [...this.activationOrder].reverse()) {
      const { record: target } = this.#ownerOf(generationId);
      if (this.genDisposeThrows.get(generationId) === true) {
        target.hasError = true;
      }
      target.status = 'stopped';
      target.generation = undefined;
      this.#withdrawGeneration(generationId);
    }
    this.events.push({ type: 'disposed' });
    return { ok: true };
  }

  // -- activation internals -------------------------------------------------------

  /**
   * Mirrors engine activation: setup effects (serves,
   * resources, staged state) happen first, then the declared-publish check,
   * then commit-time conflicts, then the atomic commit.
   */
  #activate(
    record: ModelPlugin,
    resolution: {
      readonly ok: true;
      readonly order: readonly string[];
      readonly providers: ReadonlyMap<string, ModelProviderSelections>;
    },
  ):
    | { readonly ok: true; readonly generationId: string }
    | { readonly ok: false; readonly code: RuntimeErrorCode } {
    const definition = record.definition;
    const pluginId = definition.id;
    this.counter += 1;
    const generationId = `${pluginId}#${String(this.counter)}`;

    // Setup effects, in engine order: acquire → require/optional (serve log) →
    // contribute → provide.
    this.#predictServes(definition, resolution.providers.get(definition.id) ?? new Map());

    const fails: ModelOutcome | undefined = (() => {
      if (definition.failSetupThrow) {
        return { ok: false, code: 'ACTIVATION_FAILED' as const };
      }
      if (definition.failPublish && definition.provides.length > 0) {
        return { ok: false, code: 'ACTIVATION_FAILED' as const };
      }
      for (const provide of definition.provides) {
        if (!this.policyMultiple(provide.capabilityId)) {
          const byGeneration = this.published.get(provide.capabilityId);
          if (byGeneration !== undefined && byGeneration.size > 0) {
            return { ok: false, code: 'AMBIGUOUS_PROVIDER' as const };
          }
        }
      }
      for (const keyId of definition.contributions) {
        const byGeneration = this.contributions.get(keyId);
        if (byGeneration !== undefined && byGeneration.size > 0) {
          return { ok: false, code: 'ACTIVATION_FAILED' as const };
        }
      }
      return undefined;
    })();
    if (fails !== undefined) {
      // Engine: the failing activation's record exits as stopped, errorless
      // (the root record carries the failure).
      record.status = 'stopped';
      record.generation = undefined;
      return fails;
    }

    // Commit.
    for (const provide of definition.provides) {
      let byGeneration = this.published.get(provide.capabilityId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, ModelSelection>();
        this.published.set(provide.capabilityId, byGeneration);
      }
      byGeneration.set(generationId, {
        pluginId,
        capabilityVersion: provide.version,
      });
    }
    for (const keyId of definition.contributions) {
      let byGeneration = this.contributions.get(keyId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, { pluginId: string; valueRef: string }>();
        this.contributions.set(keyId, byGeneration);
      }
      byGeneration.set(generationId, {
        pluginId,
        valueRef: `${pluginId}|${keyId}|${record.runTag}`,
      });
    }
    // Dependency edges recorded at commit from the resolution plan.
    const consumes = new Set<string>();
    for (const requirement of definition.requires) {
      const selections =
        resolution.providers.get(definition.id)?.get(requirement.capabilityId) ?? [];
      for (const selection of selections) {
        if (selection.pluginId === null) {
          continue; // host providers are never stop/replace targets
        }
        const byGeneration = this.published.get(requirement.capabilityId);
        if (byGeneration === undefined) {
          continue;
        }
        for (const [providerGenerationId, binding] of byGeneration) {
          if (binding.pluginId === selection.pluginId) {
            consumes.add(providerGenerationId);
            break;
          }
        }
      }
    }
    this.genConsumes.set(generationId, consumes);
    this.genResources.set(generationId, definition.resources);
    this.genDisposeThrows.set(generationId, definition.failDisposerThrow);
    record.status = 'active';
    record.generation = generationId;
    record.hasError = false;
    this.activationOrder.push(generationId);
    this.events.push({ type: 'started', pluginId, generation: generationId });
    return { ok: true, generationId };
  }

  /**
   * Mirrors the engine's candidate preparation: serves resolve
   * against current published bindings (the old generation serves), conflicts
   * are checked against every generation except the one being replaced.
   */
  #candidateSelections(definition: WorldPlugin): ModelProviderSelections {
    const currentProviders = new Map<string, readonly ModelSelection[]>();
    for (const requirement of definition.requires) {
      const pool: ModelSelection[] = [];
      const cap = this.world.capabilities.find((entry) => entry.id === requirement.capabilityId);
      if (cap?.host === true) {
        pool.push({ pluginId: null, capabilityVersion: cap.hostVersion });
      }
      const byGeneration = this.published.get(requirement.capabilityId);
      if (byGeneration !== undefined) {
        for (const binding of byGeneration.values()) {
          if (binding.pluginId === definition.id) {
            // Candidate resolution cannot depend on the old generation it is
            // replacing; the old binding is withdrawn at commit.
            continue;
          }
          pool.push({
            pluginId: binding.pluginId,
            capabilityVersion: binding.capabilityVersion,
          });
        }
      }
      const compatible = pool.filter((candidate) =>
        satisfiesRange(candidate.capabilityVersion, requirement.range),
      );
      const ordered = compatible.sort((a, b) => {
        if (a.pluginId === null) {
          return b.pluginId === null ? 0 : -1;
        }
        if (b.pluginId === null) {
          return 1;
        }
        return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
      });
      currentProviders.set(requirement.capabilityId, ordered);
    }
    return currentProviders;
  }

  #prepareCandidate(
    definition: WorldPlugin,
    oldGenerationId: string,
    currentProviders: ModelProviderSelections,
  ): ModelOutcome | undefined {
    // Serves resolve against current compatible bindings — host first, then
    // plugin id lexicographic (the old generation remains authoritative).
    this.#predictServes(definition, currentProviders);

    if (definition.failSetupThrow) {
      return { ok: false, code: 'ACTIVATION_FAILED' };
    }

    for (const requirement of definition.requires) {
      const selections = currentProviders.get(requirement.capabilityId) ?? [];
      if (selections.length === 0 && !requirement.optional) {
        const pool = this.#providerPool(requirement.capabilityId);
        if (pool.length === 0) {
          return { ok: false, code: 'MISSING_CAPABILITY' };
        }
        return {
          ok: false,
          code: pool.some((candidate) =>
            satisfiesRange(candidate.capabilityVersion, requirement.range),
          )
            ? 'MISSING_CAPABILITY'
            : 'INCOMPATIBLE_CAPABILITY',
        };
      }
      if (selections.length > 1 && !this.policyMultiple(requirement.capabilityId)) {
        return { ok: false, code: 'AMBIGUOUS_PROVIDER' };
      }
    }

    if (definition.failPublish && definition.provides.length > 0) {
      return { ok: false, code: 'ACTIVATION_FAILED' };
    }
    for (const provide of definition.provides) {
      if (this.policyMultiple(provide.capabilityId)) {
        continue;
      }
      const byGeneration = this.published.get(provide.capabilityId);
      if (byGeneration === undefined) {
        continue;
      }
      for (const otherGeneration of byGeneration.keys()) {
        if (otherGeneration !== oldGenerationId) {
          return { ok: false, code: 'AMBIGUOUS_PROVIDER' };
        }
      }
    }
    for (const keyId of definition.contributions) {
      const byGeneration = this.contributions.get(keyId);
      if (byGeneration === undefined) {
        continue;
      }
      for (const otherGeneration of byGeneration.keys()) {
        if (otherGeneration !== oldGenerationId) {
          return { ok: false, code: 'ACTIVATION_FAILED' };
        }
      }
    }
    return undefined;
  }

  /**
   * Candidate consumes, computed from current bindings (engine order: the old
   * generation is still published when its successor records its edges).
   */
  #candidateConsumes(
    definition: WorldPlugin,
    currentProviders: ModelProviderSelections,
  ): Set<string> {
    const consumes = new Set<string>();
    for (const requirement of definition.requires) {
      const selections = currentProviders.get(requirement.capabilityId) ?? [];
      const byGeneration = this.published.get(requirement.capabilityId);
      if (byGeneration === undefined) {
        continue;
      }
      for (const selection of selections) {
        if (selection.pluginId === null) {
          continue;
        }
        for (const [providerGenerationId, binding] of byGeneration) {
          if (binding.pluginId === selection.pluginId) {
            consumes.add(providerGenerationId);
            break;
          }
        }
      }
    }
    return consumes;
  }

  #providerPool(capabilityId: string): readonly ModelSelection[] {
    const pool: ModelSelection[] = [];
    const cap = this.world.capabilities.find((entry) => entry.id === capabilityId);
    if (cap?.host === true) {
      pool.push({ pluginId: null, capabilityVersion: cap.hostVersion });
    }
    for (const binding of this.published.get(capabilityId)?.values() ?? []) {
      pool.push({ pluginId: binding.pluginId, capabilityVersion: binding.capabilityVersion });
    }
    return pool;
  }

  #publishCandidate(
    definition: WorldPlugin,
    runTag: number,
    candidateId: string,
    consumes: Set<string>,
  ): void {
    this.genConsumes.set(candidateId, consumes);
    this.genResources.set(candidateId, definition.resources);
    this.genDisposeThrows.set(candidateId, definition.failDisposerThrow);
    for (const provide of definition.provides) {
      let byGeneration = this.published.get(provide.capabilityId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, ModelSelection>();
        this.published.set(provide.capabilityId, byGeneration);
      }
      byGeneration.set(candidateId, {
        pluginId: definition.id,
        capabilityVersion: provide.version,
      });
    }
    for (const keyId of definition.contributions) {
      let byGeneration = this.contributions.get(keyId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, { pluginId: string; valueRef: string }>();
        this.contributions.set(keyId, byGeneration);
      }
      byGeneration.set(candidateId, {
        pluginId: definition.id,
        valueRef: `${definition.id}|${keyId}|${runTag}`,
      });
    }
    this.activationOrder.push(candidateId);
  }

  // -- resolution (mirrored) ------------------------------------------

  #resolve(root: string):
    | {
        readonly ok: true;
        readonly order: readonly string[];
        readonly providers: ReadonlyMap<string, ModelProviderSelections>;
      }
    | { readonly ok: false; readonly code: RuntimeErrorCode } {
    const byId = new Map<string, WorldPlugin>();
    for (const [id, record] of this.plugins) {
      byId.set(id, record.definition);
    }
    const statuses = new Map<string, ModelStatus>();
    for (const [id, record] of this.plugins) {
      statuses.set(id, record.status);
    }

    // Candidate pool: host providers plus every definition declaring the token.
    const candidates = new Map<string, ModelSelection[]>();
    for (const cap of this.world.capabilities) {
      if (cap.host) {
        const list = candidates.get(cap.id) ?? [];
        list.push({ pluginId: null, capabilityVersion: cap.hostVersion });
        candidates.set(cap.id, list);
      }
    }
    for (const definition of byId.values()) {
      for (const provide of definition.provides) {
        const list = candidates.get(provide.capabilityId) ?? [];
        list.push({
          pluginId: definition.id,
          capabilityVersion: provide.version,
        });
        candidates.set(provide.capabilityId, list);
      }
    }

    const selection = new Map<string, Map<string, readonly ModelSelection[]>>();
    for (const definition of [...byId.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      for (const requirement of definition.requires) {
        const capabilityId = requirement.capabilityId;
        const range = requirement.range;
        const pool = candidates.get(capabilityId) ?? [];
        const compatible = pool.filter((candidate) =>
          satisfiesRange(candidate.capabilityVersion, range),
        );
        const selectable = compatible.filter((candidate) => {
          if (candidate.pluginId === null) {
            return true;
          }
          return statuses.get(candidate.pluginId) !== 'stopped';
        });
        if (selectable.length === 0) {
          if (requirement.optional) {
            continue; // visibility without failure; the model keeps no diagnostics
          }
          if (pool.length === 0) {
            return { ok: false, code: 'MISSING_CAPABILITY' };
          }
          if (compatible.length === 0) {
            return { ok: false, code: 'INCOMPATIBLE_CAPABILITY' };
          }
          return { ok: false, code: 'MISSING_CAPABILITY' }; // every provider stopped
        }
        if (selectable.length > 1 && !this.policyMultiple(capabilityId)) {
          return { ok: false, code: 'AMBIGUOUS_PROVIDER' };
        }
        const ordered = [...selectable].sort((a, b) => {
          if (a.pluginId === null) {
            return b.pluginId === null ? 0 : -1;
          }
          if (b.pluginId === null) {
            return 1;
          }
          return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
        });
        let consumerSelection = selection.get(definition.id);
        if (consumerSelection === undefined) {
          consumerSelection = new Map<string, readonly ModelSelection[]>();
          selection.set(definition.id, consumerSelection);
        }
        consumerSelection.set(capabilityId, ordered);
      }
    }

    // Selected edges only; a global cycle check in sorted-start order.
    const adjacency = new Map<string, string[]>();
    for (const [from, consumerSelections] of selection) {
      for (const selections of consumerSelections.values()) {
        for (const candidate of selections) {
          const to = candidate.pluginId ?? '(host)';
          const list = adjacency.get(from) ?? [];
          list.push(to);
          adjacency.set(from, list);
        }
      }
    }
    const UNVISITED = 0;
    const VISITING = 1;
    const DONE = 2;
    const marks = new Map<string, number>();
    for (const id of byId.keys()) {
      marks.set(id, UNVISITED);
    }
    let cycle = false;
    const visit = (node: string): void => {
      const mark = marks.get(node);
      if (mark === VISITING) {
        cycle = true;
        return;
      }
      if (mark === DONE || cycle) {
        return;
      }
      marks.set(node, VISITING);
      for (const next of adjacency.get(node) ?? []) {
        if (next === '(host)') {
          continue;
        }
        visit(next);
        if (cycle) {
          return;
        }
      }
      marks.set(node, DONE);
    };
    for (const id of [...byId.keys()].sort()) {
      visit(id);
      if (cycle) {
        return { ok: false, code: 'DEPENDENCY_CYCLE' };
      }
    }

    // Closure of the root over requirement edges, then Kahn with a sorted
    // ready set.
    const closure = new Set<string>([root]);
    const collect = (node: string): void => {
      for (const next of adjacency.get(node) ?? []) {
        if (next === '(host)' || closure.has(next)) {
          continue;
        }
        closure.add(next);
        collect(next);
      }
    };
    collect(root);

    const inDegree = new Map<string, number>();
    const dependentsOf = new Map<string, string[]>();
    for (const node of closure) {
      const deps = new Set<string>();
      for (const next of adjacency.get(node) ?? []) {
        if (closure.has(next) && next !== node) {
          deps.add(next);
        }
      }
      inDegree.set(node, deps.size);
      for (const dep of deps) {
        const list = dependentsOf.get(dep) ?? [];
        list.push(node);
        dependentsOf.set(dep, list);
      }
    }
    const ready = [...closure].filter((node) => (inDegree.get(node) ?? 0) === 0).sort();
    const order: string[] = [];
    while (ready.length > 0) {
      const node = ready.shift();
      if (node === undefined) {
        break;
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
    return { ok: true, order, providers: selection };
  }

  // -- helpers -----------------------------------------------------------------------

  /** Active dependents of a generation, in activation order (engine #activeDependentsOf). */
  #dependentsOfGeneration(providerGenerationId: string): string[] {
    const hash = providerGenerationId.indexOf('#');
    const providerPluginId = hash >= 0 ? providerGenerationId.slice(0, hash) : providerGenerationId;
    const dependents: string[] = [];
    for (const generationId of this.activationOrder) {
      const owner = this.#ownerOf(generationId);
      if (owner.id === providerPluginId) {
        continue;
      }
      if (this.genConsumes.get(generationId)?.has(providerGenerationId) === true) {
        dependents.push(generationId);
      }
    }
    return dependents;
  }

  /** The plugin record owning a generation id (`pluginId#counter`). */
  #ownerOf(generationId: string): { readonly record: ModelPlugin; readonly id: string } {
    const hash = generationId.indexOf('#');
    const pluginId = hash >= 0 ? generationId.slice(0, hash) : generationId;
    const record = this.plugins.get(pluginId);
    if (record === undefined) {
      throw new Error(`model: no plugin for generation ${generationId}`);
    }
    return { record, id: pluginId };
  }

  /** Pure state cleanup — publications, contributions, ordering, resources. */
  #withdrawGeneration(generationId: string): void {
    for (const [capabilityId, byGeneration] of this.published) {
      if (byGeneration.delete(generationId) && byGeneration.size === 0) {
        this.published.delete(capabilityId);
      }
    }
    for (const [keyId, byGeneration] of this.contributions) {
      if (byGeneration.delete(generationId) && byGeneration.size === 0) {
        this.contributions.delete(keyId);
      }
    }
    const orderIndex = this.activationOrder.indexOf(generationId);
    if (orderIndex >= 0) {
      this.activationOrder.splice(orderIndex, 1);
    }
    this.genResources.delete(generationId);
    this.genDisposeThrows.delete(generationId);
  }

  /**
   * Predicts the serve log of one setup: every declared requirement resolved
   * in declared order, tagged with who served it (host or provider plugin id,
   * comma-joined for multi tokens). `providers` is the plan selection for the
   * start path and the current-binding list for the candidate path — both are
   * read the same way.
   */
  #predictServes(definition: WorldPlugin, providers: ModelProviderSelections): void {
    if (!definition.doRequire) {
      return;
    }
    for (const requirement of definition.requires) {
      const selections = providers.get(requirement.capabilityId) ?? [];
      if (selections.length === 0) {
        continue; // optional with nothing selected — nothing served, nothing logged
      }
      const servedBy = selections.map((selection) => selection.pluginId ?? '(host)').join(',');
      this.serves.push({
        pluginId: definition.id,
        capabilityId: requirement.capabilityId,
        servedBy,
      });
    }
  }
}
