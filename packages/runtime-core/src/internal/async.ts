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
 * Per-key operation tails (queue-and-wait busy policy): operations for a
 * key run strictly in call order regardless of earlier outcomes, and re-read
 * state when they run because state may have changed while they waited.
 */
export class OperationQueue {
  #tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const settled = this.#tails.get(key) ?? Promise.resolve();
    const result = settled.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    // F11: a settled tail for a key with no newer operation is dead weight.
    // Drop the entry when the queue drains so id churn in long-running
    // hosts cannot grow memory unboundedly. The identity check keeps a
    // newer queued operation's tail intact.
    void tail.then(() => {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    });
    return result;
  }

  /** Resolves when every operation ever queued for the key has settled. */
  async tail(key: string): Promise<void> {
    await this.#tails.get(key);
  }

  /** Number of keys with a live queued tail. Diagnostic surface only. */
  get size(): number {
    return this.#tails.size;
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

/**
 * Races a promise against a timeout. When `ms` is undefined the promise is
 * awaited directly — no timer is created. On timeout `onTimeout` runs (to
 * abort a signal, for example) and `makeError`'s error is thrown; the
 * underlying promise keeps running to its own settlement, which the race
 * already observes, so a late rejection is never unhandled.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | undefined,
  makeError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === undefined) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } finally {
            reject(makeError());
          }
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Races a promise against an AbortSignal. When the signal is already
 * aborted — or aborts while the promise is pending — the returned promise
 * rejects with `makeError()` and the source promise's late settlement is
 * ignored by the caller (the source itself keeps running; only the wait
 * is abandoned). With no signal, the promise passes through untouched.
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeError: () => Error,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(makeError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(makeError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
