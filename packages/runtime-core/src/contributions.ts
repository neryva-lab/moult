// Contribution keys and per-generation staging. Values are opaque to core;
// core only enforces key uniqueness and the commit boundary — staged
// entries are invisible until commit.

import { isValidRuntimeId } from './capability.js';
import { MoltError } from './errors.js';

/**
 * A contribution key: the named channel plugins contribute values to. Keys
 * resolve by id; two keys sharing an id collide inside one generation.
 *
 * @public
 */
export interface ContributionKey<T> {
  readonly id: string;
  /** Type phantom — never present at runtime, never read. */
  readonly __type?: T;
}

/**
 * Mints a frozen contribution key.
 *
 * @param id - Contribution key id, e.g. `ui.toolbar`.
 * @throws `INVALID_DEFINITION` when the id fails the runtime id grammar.
 * @public
 */
export function contributionKey<T>(id: string): ContributionKey<T> {
  if (!isValidRuntimeId(id)) {
    throw new MoltError({
      code: 'INVALID_DEFINITION',
      message: `invalid contribution key id: ${String(id)}`,
      details: { contributionKeyId: String(id) },
    });
  }
  return Object.freeze<ContributionKey<T>>({ id });
}

/**
 * One committed contribution: who owns it (generation and plugin) and the
 * opaque value the plugin staged. Values are never inspected by core.
 *
 * @public
 */
export interface ContributionEntry {
  readonly generationId: string;
  readonly pluginId: string;
  readonly value: unknown;
}

/**
 * The committed contribution snapshot read side (`Runtime.contributions()`).
 * Only committed generations appear; entries are frozen and sorted
 * by generation commit order.
 *
 * @public
 */
export interface ContributionSnapshot {
  readonly entries: ReadonlyMap<string, readonly ContributionEntry[]>;
}

/**
 * One generation's staged contribution set. The runtime owns the global
 * committed snapshot; this class owns the candidate-private side.
 */
export class StagedContributions {
  readonly #pluginId: string;
  readonly #generationId: string;
  readonly #staged = new Map<string, unknown>();
  #committed = false;

  constructor(pluginId: string, generationId: string) {
    this.#pluginId = pluginId;
    this.#generationId = generationId;
  }

  get generationId(): string {
    return this.#generationId;
  }

  stage(key: ContributionKey<unknown>, value: unknown): void {
    if (this.#committed) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: 'contribution staged after commit',
        pluginId: this.#pluginId,
        generation: this.#generationId,
        details: { reason: 'staged-after-commit' },
      });
    }
    if (this.#staged.has(key.id)) {
      // Ids, not key objects, are the namespace — two different keys sharing
      // an id collide inside one generation.
      throw new MoltError({
        code: 'INVALID_DEFINITION',
        message: `duplicate contribution id ${key.id} in one generation`,
        pluginId: this.#pluginId,
        generation: this.#generationId,
        details: { contributionKeyId: key.id },
      });
    }
    this.#staged.set(key.id, value);
  }

  /** Staged contribution ids, pre-commit — the runtime checks conflicts against them. */
  stagedIds(): readonly string[] {
    return [...this.#staged.keys()];
  }

  /**
   * Freezes this generation's set exactly once at contribution
   * granularity and returns the entries the runtime may publish, keyed by
   * contribution id — the id is what the runtime publishes under.
   */
  commit(): ReadonlyMap<string, ContributionEntry> {
    if (this.#committed) {
      throw new MoltError({
        code: 'INVALID_STATE',
        message: 'contribution set committed twice',
        pluginId: this.#pluginId,
        generation: this.#generationId,
        details: { reason: 'double-commit' },
      });
    }
    this.#committed = true;
    const entries = new Map<string, ContributionEntry>();
    for (const [id, value] of this.#staged) {
      entries.set(
        id,
        Object.freeze({ generationId: this.#generationId, pluginId: this.#pluginId, value }),
      );
    }
    return entries;
  }
}
