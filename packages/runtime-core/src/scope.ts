// Ownership scopes and the disposal engine: LIFO disposal,
// continue-on-error with collected failures, commit-at-most-once,
// idempotent disposal, and no resource left owned by a dead scope.

import type { DisposalReport } from './errors.js';
import { MoltError } from './errors.js';
import { idempotent } from './internal/async.js';

/**
 * The ownership scope every generation runs inside: disposal runs LIFO,
 * continues after an individual disposer fails with all failures collected,
 * and commits at most once. A resource whose `create` settles after abort
 * is disposed immediately and `acquire` rejects — nothing stays owned by a
 * dead scope.
 *
 * @public
 */
export interface Scope {
  /** Aborted before the disposers run; long-running setup watches this. */
  readonly signal: AbortSignal;
  /**
   * Registers a disposer to run at scope disposal.
   *
   * @throws `INVALID_STATE` when the scope is already disposed.
   */
  onDispose(disposer: () => void | Promise<void>): void;
  /**
   * Acquires a resource owned by this scope: the disposer runs LIFO at
   * disposal, exactly once.
   *
   * @throws `INVALID_STATE` when the scope is already disposed, or when the
   * scope aborts while `create` is pending (with the abort cause).
   */
  acquire<T>(create: () => T | Promise<T>, dispose: (value: T) => void | Promise<void>): Promise<T>;
  isDisposed(): boolean;
  [Symbol.asyncDispose](): Promise<void>;
}

interface Entry {
  run: () => Promise<void>;
}

function disposedError(reason: string, cause?: unknown): MoltError {
  return new MoltError(
    { code: 'INVALID_STATE', message: 'scope is disposed', details: { reason } },
    cause,
  );
}

export class ScopeImpl implements Scope {
  readonly #controller = new AbortController();
  #entries: Entry[] = [];
  #disposed = false;
  #disposePromise: Promise<DisposalReport> | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  isDisposed(): boolean {
    return this.#disposed;
  }

  onDispose(disposer: () => void | Promise<void>): void {
    if (this.#disposed) {
      // Late registration is a bug, not a no-op.
      throw disposedError('onDispose after dispose');
    }
    this.#entries.push({ run: idempotent(disposer) });
  }

  async acquire<T>(
    create: () => T | Promise<T>,
    dispose: (value: T) => void | Promise<void>,
  ): Promise<T> {
    if (this.#disposed) {
      throw disposedError('acquire on disposed scope');
    }
    // A creation error is the caller's error, not a core error: it propagates
    // untouched and nothing is registered — ownership never attaches to a
    // failed creation. The runtime wraps it with cause intact.
    const value = await create();
    // No await between this check and the push below: a scope cannot start
    // disposing between the two, so an acquired resource is always either
    // registered or immediately disposed — never orphaned.
    if (this.#disposed) {
      // The scope began disposing while `create` was in flight. The value
      // was resolved but must not outlive the dead scope: dispose it here,
      // then reject.
      let disposalCause: unknown;
      try {
        await dispose(value);
      } catch (error) {
        disposalCause = error;
      }
      throw disposedError('scope disposed during acquire', disposalCause);
    }
    this.#entries.push({ run: idempotent(() => dispose(value)) });
    return value;
  }

  dispose(): Promise<DisposalReport> {
    // Idempotent and concurrency-safe: every caller awaits the one
    // real disposal and receives the same frozen report.
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }
    this.#disposed = true;
    // The signal aborts BEFORE any disposer runs: in-flight work observes the
    // abort while cleanup is still ahead of it.
    this.#controller.abort();
    const entries = this.#entries;
    this.#entries = [];
    const errors: unknown[] = [];
    const run = async (): Promise<DisposalReport> => {
      // Reverse iteration over a copy: LIFO, no indexed access.
      for (const entry of [...entries].reverse()) {
        // A failing disposer never prevents later disposers; every failure is
        // collected. Async disposers are awaited in sequence, so
        // teardown order is deterministic.
        try {
          await entry.run();
        } catch (error) {
          errors.push(error);
        }
      }
      const report: DisposalReport = Object.freeze({ errors: Object.freeze([...errors]) });
      return report;
    };
    this.#disposePromise = run();
    return this.#disposePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
