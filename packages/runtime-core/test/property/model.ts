// Reference model for the property suite.
//
// The model is intentionally minimal: it tracks plugin statuses, published
// bindings, contribution owners, and the activation order, and it re-derives
// resolution with the same rules as the engine. Any divergence
// between model and runtime pinpoints the operation that broke it. The model
// is written from the spec documents, not from runtime.ts, so a shared
// misunderstanding is caught by the unit inventory rather than replicated
// here.
//
// Engine semantics mirrored here (v2):
// - Resolution walks only the selected closure from the root (a broken
//   requirement on an unselected definition cannot poison an activation).
// - Provider selection is tiered: active/host/root providers (tier 1) win;
//   stopped providers (tier 2) are revived only when no tier-1 candidate
//   satisfies the requirement.
// - `replace` rebinds the transitive active dependent closure
//   transactionally by default; every rebound dependent emits `replaced`
//   and gets a fresh generation id.
// - A failed start rolls back committed generations with balancing
//   `stopped` events (F8), in reverse commit order.

import type { RuntimeErrorCode } from '../../src/index.js';
import type { PluginStatus } from '../../src/index.js';
import { satisfiesRange } from '../../src/internal/semver.js';
import type { World, WorldPlugin } from './generators.js';

export interface ModelEvent {
  readonly type:
    'installed' | 'started' | 'stopped' | 'replaced' | 'rolledback' | 'failed' | 'disposed';
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

interface ModelCandidate {
  readonly pluginId: string | null;
  readonly capabilityVersion: string;
  /** 1 = preferred (active, host, or the root); 2 = stopped fallback. */
  readonly tier: 1 | 2;
}

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
  /** generationId → capabilityId → provider generationIds (resolved edges). */
  readonly genEdges = new Map<string, Map<string, Set<string>>>();
  /** generationId → declared requirement ranges, snapshotted from the definition. */
  readonly genRanges = new Map<string, ReadonlyArray<{ capabilityId: string; range: string }>>();
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
        continue; // live providers are reused, never restarted
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
      // F8: every generation committed by this attempt is disposed — each
      // committed generation emitted 'started', so each disposal emits the
      // balancing 'stopped', in reverse commit order. Records end stopped
      // and errorless (the root record carries the failure).
      for (const generationId of [...committed].reverse()) {
        const { record: genRecord, id: genPluginId } = this.#ownerOf(generationId);
        genRecord.status = 'stopped';
        genRecord.generation = undefined;
        this.#withdrawGeneration(generationId);
        this.events.push({ type: 'stopped', pluginId: genPluginId, generation: generationId });
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

  replace(definition: WorldPlugin, runTag: number, strict = false): ModelOutcome {
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

    // The transitive active dependent closure (provider-first), shared by
    // both policies.
    const closure = this.#rebindClosure(oldGenerationId);
    if (strict && closure.length > 0) {
      // `strictDependents` opts back into the v1 rejection: rejected before
      // any candidate scope exists — no events, no record error, zero state
      // change. Reports direct dependents, as v1 did.
      return { ok: false, code: 'REPLACEMENT_FAILED' };
    }

    // Claim check, before any candidate scope exists: a single-provider
    // token may collide with no host and no unrelated active generation.
    for (const provide of definition.provides) {
      if (this.policyMultiple(provide.capabilityId)) {
        continue;
      }
      const cap = this.world.capabilities.find((entry) => entry.id === provide.capabilityId);
      if (cap?.host === true) {
        return this.#replacementFailed(record, definition.id);
      }
      const byGeneration = this.published.get(provide.capabilityId);
      if (byGeneration !== undefined) {
        for (const otherGeneration of byGeneration.keys()) {
          if (otherGeneration !== oldGenerationId) {
            return this.#replacementFailed(record, definition.id);
          }
        }
      }
    }

    // The candidate resolves against the currently published view — the old
    // generation keeps serving until commit, but the candidate cannot bind
    // the generation it replaces.
    const candidate = this.#resolveCandidate(definition);
    if (!candidate.ok) {
      return this.#replacementFailed(record, definition.id);
    }

    // Every dependent's declared range must still be satisfied by the
    // rebound providers' versions. Optional requirements the candidate no
    // longer satisfies bind nothing instead of failing the transaction.
    const rangeCheck = this.#checkDependentRanges(definition, oldGenerationId, closure);
    if (!rangeCheck.ok) {
      return this.#replacementFailed(record, definition.id);
    }

    // Prepare candidates provider-first. The engine mints the generation id
    // before setup runs, so even a failing candidate consumes a counter —
    // and its setup effects (serves, acquisitions) really happened before
    // the abort disposed its scope.
    const oldsInOrder = [oldGenerationId, ...closure];
    const stagedVersions = new Map<string, Map<string, string>>();
    const prepared: { oldId: string; newId: string; pluginId: string; runTag: number }[] = [];
    const providerPluginIds = new Map<string, Map<string, ReadonlyArray<string | null>>>();
    for (const oldId of oldsInOrder) {
      const pluginId = this.#pluginIdOf(oldId);
      const itemRecord = this.plugins.get(pluginId);
      if (itemRecord === undefined) {
        throw new Error(`model: no plugin for generation ${oldId}`);
      }
      const itemDefinition = pluginId === definition.id ? definition : itemRecord.definition;
      const itemRunTag = pluginId === definition.id ? runTag : itemRecord.runTag;
      this.counter += 1;
      const newId = `${pluginId}#${String(this.counter)}`;

      const selections =
        pluginId === definition.id
          ? candidate.selections
          : this.#rebindSelections(
              itemDefinition,
              oldId,
              rangeCheck.dropped.get(oldId) ?? new Set<string>(),
              stagedVersions,
            );
      providerPluginIds.set(
        oldId,
        new Map(
          [...selections].map(([capabilityId, list]) => [
            capabilityId,
            list.map((selection) => selection.pluginId),
          ]),
        ),
      );
      // Setup effects, in engine order: acquire → require/optional (serve
      // log) → contribute → provide. Serves resolve against the
      // candidate's own selections.
      this.#predictServes(itemDefinition, selections);

      const failure = this.#preparationFailure(itemDefinition, oldId);
      if (failure !== undefined) {
        // Abort: candidates prepared so far are disposed; the olds were
        // never withdrawn, so there is nothing to restore. The failing
        // candidate kept its counter and its serve log entries.
        return this.#replacementFailed(record, definition.id);
      }
      const staged = new Map<string, string>();
      for (const provide of itemDefinition.provides) {
        staged.set(provide.capabilityId, provide.version);
      }
      stagedVersions.set(pluginId, staged);
      prepared.push({ oldId, newId, pluginId, runTag: itemRunTag });
    }

    // Synchronous commit. Capture the retired disposers' flags before the
    // olds are withdrawn: a throwing disposer is inspectable on the retired
    // plugin's record, but the replacement already succeeded and is never
    // rolled back (INV-08/INV-14).
    const oldDisposeThrows = new Map<string, boolean>();
    for (const item of prepared) {
      oldDisposeThrows.set(item.pluginId, this.genDisposeThrows.get(item.oldId) === true);
    }
    for (const item of prepared) {
      this.#withdrawGeneration(item.oldId);
    }
    // Publish every candidate and re-record dependency edges before any
    // event is emitted — provider-first, mirroring the engine.
    for (const item of prepared) {
      const itemRecord = this.plugins.get(item.pluginId);
      if (itemRecord === undefined) {
        throw new Error(`model: no plugin ${item.pluginId}`);
      }
      const itemDefinition = item.pluginId === definition.id ? definition : itemRecord.definition;
      this.#publishRebindCandidate(
        itemDefinition,
        item,
        providerPluginIds.get(item.oldId) ?? new Map(),
      );
    }
    for (const item of prepared) {
      this.events.push({ type: 'replaced', pluginId: item.pluginId, generation: item.newId });
    }
    // Only after a successful commit: retire the old scopes, dependents
    // first (reverse provider-first order, mirroring cascade stop).
    for (const item of [...prepared].reverse()) {
      if (oldDisposeThrows.get(item.pluginId) === true) {
        const itemRecord = this.plugins.get(item.pluginId);
        if (itemRecord !== undefined) {
          itemRecord.hasError = true;
        }
      }
    }
    return { ok: true };
  }

  /**
   * A failed replacement: the replaced plugin's record carries the error,
   * one `failed` event is emitted, and the old graph is untouched.
   */
  #replacementFailed(record: ModelPlugin, pluginId: string): ModelOutcome {
    record.hasError = true;
    this.events.push({ type: 'failed', pluginId });
    return { ok: false, code: 'REPLACEMENT_FAILED' };
  }

  /**
   * Mirrors `resolveCandidate`: the replacement candidate's requirements
   * resolved against the currently published view. The old generation is
   * intentionally present (it keeps serving), but the candidate cannot bind
   * its own plugin id — that binding is withdrawn at commit.
   */
  #resolveCandidate(
    definition: WorldPlugin,
  ):
    | { readonly ok: true; readonly selections: ModelProviderSelections }
    | { readonly ok: false; readonly code: RuntimeErrorCode } {
    const selections = new Map<string, readonly ModelSelection[]>();
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
            continue;
          }
          pool.push({
            pluginId: binding.pluginId,
            capabilityVersion: binding.capabilityVersion,
          });
        }
      }
      const compatible = pool.filter((selection) =>
        satisfiesRange(selection.capabilityVersion, requirement.range),
      );
      if (compatible.length === 0) {
        if (requirement.optional) {
          continue;
        }
        return {
          ok: false,
          code: pool.length === 0 ? 'MISSING_CAPABILITY' : 'INCOMPATIBLE_CAPABILITY',
        };
      }
      if (compatible.length > 1 && !this.policyMultiple(requirement.capabilityId)) {
        return { ok: false, code: 'AMBIGUOUS_PROVIDER' };
      }
      selections.set(requirement.capabilityId, sortSelections(compatible));
    }
    return { ok: true, selections };
  }

  /**
   * The transitive active dependent closure of a generation, provider-first:
   * BFS over dependents, then filtered through the activation order (which
   * is topological — providers commit before their dependents).
   */
  #rebindClosure(oldGenerationId: string): string[] {
    const seen = new Set<string>([oldGenerationId]);
    const frontier = [oldGenerationId];
    for (let index = 0; index < frontier.length; index += 1) {
      const current = frontier[index];
      if (current === undefined) {
        break;
      }
      for (const dependent of this.#dependentsOfGeneration(current)) {
        if (!seen.has(dependent)) {
          seen.add(dependent);
          frontier.push(dependent);
        }
      }
    }
    seen.delete(oldGenerationId);
    return this.activationOrder.filter((generationId) => seen.has(generationId));
  }

  /**
   * Mirrors `#checkDependentRanges`: every dependent's declared range
   * against the rebound providers' versions — the candidate's staged
   * versions for the replaced plugin, the published versions for rebound
   * dependents. Returns, per old dependent generation id, the rebound
   * provider generation ids whose binding is gone for it (dropped
   * capability or unsatisfied optional range).
   */
  #checkDependentRanges(
    definition: WorldPlugin,
    oldGenerationId: string,
    closure: readonly string[],
  ):
    | { readonly ok: true; readonly dropped: ReadonlyMap<string, ReadonlySet<string>> }
    | { readonly ok: false } {
    const versions = new Map<string, Map<string, string>>();
    const staged = new Map<string, string>();
    for (const provide of definition.provides) {
      staged.set(provide.capabilityId, provide.version);
    }
    versions.set(oldGenerationId, staged);
    for (const oldId of closure) {
      const published = new Map<string, string>();
      for (const [capabilityId, byGeneration] of this.published) {
        const binding = byGeneration.get(oldId);
        if (binding !== undefined) {
          published.set(capabilityId, binding.capabilityVersion);
        }
      }
      versions.set(oldId, published);
    }
    const reboundIds = new Set<string>([oldGenerationId, ...closure]);
    const dropped = new Map<string, ReadonlySet<string>>();
    for (const dependentOldId of closure) {
      const dependentDropped = new Set<string>();
      const { record: dependentRecord } = this.#ownerOf(dependentOldId);
      const edges = this.genEdges.get(dependentOldId) ?? new Map<string, Set<string>>();
      const ranges = this.genRanges.get(dependentOldId) ?? [];
      for (const [capabilityId, providerIds] of edges) {
        for (const providerId of providerIds) {
          if (!reboundIds.has(providerId)) {
            continue;
          }
          const version = versions.get(providerId)?.get(capabilityId);
          const declared = ranges.find((entry) => entry.capabilityId === capabilityId);
          const optional =
            dependentRecord.definition.requires.find(
              (requirement) => requirement.capabilityId === capabilityId,
            )?.optional === true;
          const mismatch =
            version !== undefined &&
            declared !== undefined &&
            !satisfiesRange(version, declared.range);
          if (version === undefined || mismatch) {
            if (optional) {
              dependentDropped.add(providerId);
              continue;
            }
            return { ok: false }; // INCOMPATIBLE_CAPABILITY → REPLACEMENT_FAILED
          }
        }
      }
      dropped.set(dependentOldId, dependentDropped);
    }
    return { ok: true, dropped };
  }

  /**
   * Mirrors `#rebindPlan`: the dependent's current provider topology,
   * preserved selection-for-selection. A rebound provider whose binding is
   * gone for this dependent contributes no selection, so `optional()`
   * resolves `undefined`. Versions come from the transaction's staged
   * provides first (candidates prepared earlier, provider-first), then the
   * published view.
   */
  #rebindSelections(
    definition: WorldPlugin,
    oldId: string,
    droppedProviders: ReadonlySet<string>,
    stagedVersions: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ): ModelProviderSelections {
    const selections = new Map<string, readonly ModelSelection[]>();
    const edges = this.genEdges.get(oldId) ?? new Map<string, Set<string>>();
    for (const requirement of definition.requires) {
      const capabilityId = requirement.capabilityId;
      const list: ModelSelection[] = [];
      for (const providerGenerationId of edges.get(capabilityId) ?? []) {
        if (droppedProviders.has(providerGenerationId)) {
          continue;
        }
        const providerPluginId = this.#pluginIdOf(providerGenerationId);
        const version =
          stagedVersions.get(providerPluginId)?.get(capabilityId) ??
          this.published.get(capabilityId)?.get(providerGenerationId)?.capabilityVersion;
        if (version === undefined) {
          continue; // the provider went away mid-transaction; require() fails loudly
        }
        list.push({ pluginId: providerPluginId, capabilityVersion: version });
      }
      selections.set(capabilityId, list);
    }
    return selections;
  }

  /**
   * Mirrors the failure half of `#prepareGeneration` for one rebind
   * candidate: setup effects already ran (serves logged above); the
   * declared-publish check and the staged-conflict check (shadowing the
   * generation being replaced) decide success. Returns the failure code,
   * or undefined when preparation succeeds.
   */
  #preparationFailure(definition: WorldPlugin, shadowedId: string): RuntimeErrorCode | undefined {
    if (definition.failSetupThrow) {
      return 'ACTIVATION_FAILED';
    }
    if (definition.failPublish && definition.provides.length > 0) {
      return 'ACTIVATION_FAILED';
    }
    for (const provide of definition.provides) {
      if (this.policyMultiple(provide.capabilityId)) {
        continue;
      }
      const byGeneration = this.published.get(provide.capabilityId);
      if (byGeneration !== undefined) {
        for (const otherGeneration of byGeneration.keys()) {
          if (otherGeneration !== shadowedId) {
            return 'AMBIGUOUS_PROVIDER';
          }
        }
      }
    }
    for (const keyId of definition.contributions) {
      const byGeneration = this.contributions.get(keyId);
      if (byGeneration !== undefined) {
        for (const otherGeneration of byGeneration.keys()) {
          if (otherGeneration !== shadowedId) {
            return 'ACTIVATION_FAILED';
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Publishes one committed rebind candidate: staged provides, staged
   * contributions, dependency edges (resolved against the current published
   * view, exactly like the engine's `#recordResolvedProviders`), and the
   * record swap. The caller withdraws every old generation first, so the
   * swap is atomic.
   */
  #publishRebindCandidate(
    definition: WorldPlugin,
    item: { oldId: string; newId: string; pluginId: string; runTag: number },
    providerPluginIds: ReadonlyMap<string, ReadonlyArray<string | null>>,
  ): void {
    const record = this.plugins.get(item.pluginId);
    if (record === undefined) {
      throw new Error(`model: no plugin ${item.pluginId}`);
    }
    for (const provide of definition.provides) {
      let byGeneration = this.published.get(provide.capabilityId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, ModelSelection>();
        this.published.set(provide.capabilityId, byGeneration);
      }
      byGeneration.set(item.newId, {
        pluginId: item.pluginId,
        capabilityVersion: provide.version,
      });
    }
    for (const keyId of definition.contributions) {
      let byGeneration = this.contributions.get(keyId);
      if (byGeneration === undefined) {
        byGeneration = new Map<string, { pluginId: string; valueRef: string }>();
        this.contributions.set(keyId, byGeneration);
      }
      byGeneration.set(item.newId, {
        pluginId: item.pluginId,
        valueRef: `${item.pluginId}|${keyId}|${item.runTag}`,
      });
    }
    const edges = new Map<string, Set<string>>();
    for (const requirement of definition.requires) {
      const capabilityId = requirement.capabilityId;
      const providers = new Set<string>();
      for (const providerPluginId of providerPluginIds.get(capabilityId) ?? []) {
        if (providerPluginId === null) {
          continue; // host providers are never stop/replace targets
        }
        const byGeneration = this.published.get(capabilityId);
        if (byGeneration === undefined) {
          continue;
        }
        for (const [providerGenerationId, binding] of byGeneration) {
          if (binding.pluginId === providerPluginId) {
            providers.add(providerGenerationId);
            break;
          }
        }
      }
      edges.set(capabilityId, providers);
    }
    this.genEdges.set(item.newId, edges);
    this.genRanges.set(
      item.newId,
      definition.requires.map((requirement) => ({
        capabilityId: requirement.capabilityId,
        range: requirement.range,
      })),
    );
    this.genResources.set(item.newId, definition.resources);
    this.genDisposeThrows.set(item.newId, definition.failDisposerThrow);
    this.activationOrder.push(item.newId);
    record.definition = definition;
    record.runTag = item.runTag;
    record.generation = item.newId;
    record.hasError = false;
    record.status = 'active';
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
    const edges = new Map<string, Set<string>>();
    for (const requirement of definition.requires) {
      const selections =
        resolution.providers.get(definition.id)?.get(requirement.capabilityId) ?? [];
      const providers = new Set<string>();
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
            providers.add(providerGenerationId);
            break;
          }
        }
      }
      edges.set(requirement.capabilityId, providers);
    }
    this.genEdges.set(generationId, edges);
    this.genRanges.set(
      generationId,
      definition.requires.map((requirement) => ({
        capabilityId: requirement.capabilityId,
        range: requirement.range,
      })),
    );
    this.genResources.set(generationId, definition.resources);
    this.genDisposeThrows.set(generationId, definition.failDisposerThrow);
    record.status = 'active';
    record.generation = generationId;
    record.hasError = false;
    this.activationOrder.push(generationId);
    this.events.push({ type: 'started', pluginId, generation: generationId });
    return { ok: true, generationId };
  }

  // -- resolution (mirrored) ------------------------------------------

  /**
   * Mirrors `resolve`: the requirement fixpoint walks only the selected
   * closure from the root (a broken requirement on a definition nobody
   * selects cannot poison this activation), and provider selection is
   * tiered — active providers win, stopped providers are revived only when
   * no tier-1 candidate satisfies the requirement. The topological order
   * comes from Kahn over the selected closure with a lexicographic ready
   * set; a cycle leaves nodes unconsumed.
   */
  #resolve(root: string):
    | {
        readonly ok: true;
        readonly order: readonly string[];
        readonly providers: ReadonlyMap<string, ModelProviderSelections>;
      }
    | { readonly ok: false; readonly code: RuntimeErrorCode } {
    const byId = new Map<string, WorldPlugin>();
    const statuses = new Map<string, ModelStatus>();
    for (const [id, record] of this.plugins) {
      byId.set(id, record.definition);
      statuses.set(id, record.status);
    }

    // Candidate pool: host providers plus every installed definition
    // declaring the token, each tagged with its selection tier. The root is
    // always tier 1; stopped definitions are tier 2.
    const candidates = new Map<string, ModelCandidate[]>();
    const addCandidate = (capabilityId: string, candidate: ModelCandidate): void => {
      const list = candidates.get(capabilityId);
      if (list === undefined) {
        candidates.set(capabilityId, [candidate]);
      } else {
        list.push(candidate);
      }
    };
    for (const cap of this.world.capabilities) {
      if (cap.host) {
        addCandidate(cap.id, { pluginId: null, capabilityVersion: cap.hostVersion, tier: 1 });
      }
    }
    for (const definition of byId.values()) {
      const tier: 1 | 2 =
        definition.id === root || statuses.get(definition.id) !== 'stopped' ? 1 : 2;
      for (const provide of definition.provides) {
        addCandidate(provide.capabilityId, {
          pluginId: definition.id,
          capabilityVersion: provide.version,
          tier,
        });
      }
    }

    // Requirement fixpoint over the selected closure, lexicographic
    // worklist — starting from the root, select providers for every
    // requirement in declared order.
    const selection = new Map<string, Map<string, readonly ModelSelection[]>>();
    const selected = new Set<string>([root]);
    const worklist: string[] = [root];
    let node = worklist.shift();
    while (node !== undefined) {
      const definition = byId.get(node);
      if (definition === undefined) {
        throw new Error(`model: worklist referenced unknown plugin ${node}`);
      }
      for (const requirement of definition.requires) {
        const capabilityId = requirement.capabilityId;
        const pool = candidates.get(capabilityId) ?? [];
        const compatible = pool.filter((candidate) =>
          satisfiesRange(candidate.capabilityVersion, requirement.range),
        );
        // Tiered selection: active providers win; stopped providers are
        // revived only when no tier-1 candidate satisfies the requirement.
        const tier1 = compatible.filter((candidate) => candidate.tier === 1);
        const tier2 = compatible.filter((candidate) => candidate.tier === 2);
        const selectable = tier1.length > 0 ? tier1 : tier2;
        if (selectable.length === 0) {
          if (requirement.optional) {
            continue; // visibility without failure
          }
          if (pool.length === 0) {
            return { ok: false, code: 'MISSING_CAPABILITY' };
          }
          if (compatible.length === 0) {
            return { ok: false, code: 'INCOMPATIBLE_CAPABILITY' };
          }
          // Selectable is empty while compatible is not: every compatible
          // candidate is stopped and tier-1 already lost — unreachable when
          // tier-1 exists, so this is a defensive fallback.
          return { ok: false, code: 'MISSING_CAPABILITY' };
        }
        if (selectable.length > 1 && !this.policyMultiple(capabilityId)) {
          return { ok: false, code: 'AMBIGUOUS_PROVIDER' };
        }
        const ordered = sortSelections(selectable);
        let consumerSelection = selection.get(definition.id);
        if (consumerSelection === undefined) {
          consumerSelection = new Map<string, readonly ModelSelection[]>();
          selection.set(definition.id, consumerSelection);
        }
        consumerSelection.set(
          capabilityId,
          ordered.map((candidate) => ({
            pluginId: candidate.pluginId,
            capabilityVersion: candidate.capabilityVersion,
          })),
        );
        for (const candidate of ordered) {
          if (candidate.pluginId !== null && !selected.has(candidate.pluginId)) {
            selected.add(candidate.pluginId);
            worklist.push(candidate.pluginId);
            worklist.sort();
          }
        }
      }
      node = worklist.shift();
    }

    // Kahn topological order over the selected closure with a
    // lexicographic ready set — providers before consumers. A dependency
    // cycle leaves nodes unconsumed.
    const inDegree = new Map<string, number>();
    const dependentsOf = new Map<string, string[]>();
    for (const id of selected) {
      const deps = new Set<string>();
      for (const selections of selection.get(id)?.values() ?? []) {
        for (const candidate of selections) {
          if (
            candidate.pluginId !== null &&
            candidate.pluginId !== id &&
            selected.has(candidate.pluginId)
          ) {
            deps.add(candidate.pluginId);
          }
        }
      }
      inDegree.set(id, deps.size);
      for (const dep of deps) {
        const list = dependentsOf.get(dep);
        if (list === undefined) {
          dependentsOf.set(dep, [id]);
        } else {
          list.push(id);
        }
      }
    }
    const ready = [...selected].filter((id) => (inDegree.get(id) ?? 0) === 0).sort();
    const order: string[] = [];
    while (ready.length > 0) {
      const next = ready.shift();
      if (next === undefined) {
        break;
      }
      order.push(next);
      for (const dependent of dependentsOf.get(next) ?? []) {
        const remaining = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, remaining);
        if (remaining === 0) {
          ready.push(dependent);
          ready.sort();
        }
      }
    }
    if (order.length !== selected.size) {
      return { ok: false, code: 'DEPENDENCY_CYCLE' };
    }
    return { ok: true, order, providers: selection };
  }

  // -- helpers -----------------------------------------------------------------------

  /** Active dependents of a generation, in activation order (engine #activeDependentsOf). */
  #dependentsOfGeneration(providerGenerationId: string): string[] {
    const providerPluginId = this.#pluginIdOf(providerGenerationId);
    const dependents: string[] = [];
    for (const generationId of this.activationOrder) {
      if (this.#pluginIdOf(generationId) === providerPluginId) {
        continue;
      }
      const edges = this.genEdges.get(generationId);
      if (edges === undefined) {
        continue;
      }
      for (const providers of edges.values()) {
        if (providers.has(providerGenerationId)) {
          dependents.push(generationId);
          break;
        }
      }
    }
    return dependents;
  }

  /** The plugin id owning a generation id (`pluginId#counter`). */
  #pluginIdOf(generationId: string): string {
    const hash = generationId.indexOf('#');
    return hash >= 0 ? generationId.slice(0, hash) : generationId;
  }

  /** The plugin record owning a generation id (`pluginId#counter`). */
  #ownerOf(generationId: string): { readonly record: ModelPlugin; readonly id: string } {
    const pluginId = this.#pluginIdOf(generationId);
    const record = this.plugins.get(pluginId);
    if (record === undefined) {
      throw new Error(`model: no plugin for generation ${generationId}`);
    }
    return { record, id: pluginId };
  }

  /** Pure state cleanup — publications, contributions, ordering, resources, edges. */
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
    this.genEdges.delete(generationId);
    this.genRanges.delete(generationId);
    this.genDisposeThrows.delete(generationId);
  }

  /**
   * Predicts the serve log of one setup: every declared requirement resolved
   * in declared order, tagged with who served it (host or provider plugin id,
   * comma-joined for multi tokens). `providers` is the plan selection for the
   * start path, the candidate selections for the replace path, and the
   * preserved topology for rebound dependents — all read the same way.
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

/**
 * Documented selection order: host providers first, then plugin id
 * lexicographic. Shared by the start path, the candidate path, and the
 * serve-log prediction.
 */
function sortSelections<T extends ModelSelection>(selections: readonly T[]): T[] {
  return [...selections].sort((a, b) => {
    if (a.pluginId === null) {
      return b.pluginId === null ? 0 : -1;
    }
    if (b.pluginId === null) {
      return 1;
    }
    return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
  });
}
