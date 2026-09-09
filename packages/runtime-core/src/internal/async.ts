// Shared async primitives. No domain types live here; the scope and the
// runtime compose their correctness from these pieces, so each one is
// unit-tested in isolation.

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Serializes async sections. Sections run in call order; a failing section
 * never blocks the next one.
 */
export class AsyncMutex {
  // The tail never rejects: failures settle into it via the two-callback
  // assignment below, so `.then(section)` alone is safe.
  #tail: Promise<void> = Promise.resolve();

  runExclusive<T>(section: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(section);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Per-key operation tails (queue-and-wait busy policy): operations for a
 * key run strictly in call order regardless of earlier outcomes, and re-read
 * state when they run because state may have changed while they waited.
 */
export class OperationQueue {
  #tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const settled = this.#tails.get(key) ?? Promise.resolve();
    const result = settled.then(operation);
    this.#tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /** Resolves when every operation ever queued for the key has settled. */
  async tail(key: string): Promise<void> {
    await this.#tails.get(key);
  }
}

/**
 * Wraps a disposer so it runs exactly once at resource granularity.
 * The first call runs synchronously and memoizes the outcome, including a
 * rejection; later calls return the memoized outcome without re-running.
 */
export function idempotent(disposer: () => void | Promise<void>): () => Promise<void> {
  let called = false;
  let memoized: Promise<void>;
  return () => {
    if (called) {
      return memoized;
    }
    called = true;
    try {
      memoized = Promise.resolve(disposer());
    } catch (error) {
      // The report collects the thrown value as-is, whatever its
      // type — wrapping here would corrupt what the disposal engine records.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      memoized = Promise.reject(error);
    }
    return memoized;
  };
}

/**
 * Ring buffer with a hard capacity: a chatty plugin cannot grow the
 * runtime unboundedly. `entries()` returns a copy — mutating it cannot affect
 * the log.
 */
export class BoundedLog<T> {
  #items: T[] = [];
  readonly #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.#capacity) {
      this.#items.shift();
    }
  }

  entries(): readonly T[] {
    return [...this.#items];
  }

  get size(): number {
    return this.#items.length;
  }
}
