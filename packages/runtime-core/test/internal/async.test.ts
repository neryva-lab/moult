// Unit tests for internal/async.ts. These primitives compose
// the correctness of scope.ts and runtime.ts, so each behavior is pinned
// in isolation.

import {
  abortable,
  BoundedLog,
  createDeferred,
  idempotent,
  OperationQueue,
} from '../../src/internal/async.js';

describe('createDeferred', () => {
  it('resolves with the given value', async () => {
    const deferred = createDeferred<number>();
    deferred.resolve(7);
    await expect(deferred.promise).resolves.toBe(7);
  });

  it('rejects with the given reason', async () => {
    const deferred = createDeferred<number>();
    const failure = new Error('boom');
    deferred.reject(failure);
    await expect(deferred.promise).rejects.toBe(failure);
  });
});

describe('OperationQueue', () => {
  it('runs operations per key strictly in call order', async () => {
    const queue = new OperationQueue();
    const order: number[] = [];
    const operations = [1, 2, 3].map((n) =>
      queue.run('a', async () => {
        await Promise.resolve();
        order.push(n);
      }),
    );
    await Promise.all(operations);
    expect(order).toEqual([1, 2, 3]);
  });

  it('different keys do not block each other', async () => {
    const queue = new OperationQueue();
    const order: string[] = [];
    const slowA = queue.run('a', async () => {
      await Promise.resolve();
      order.push('a-done');
    });
    const fastB = queue.run('b', () => {
      order.push('b-done');
    });
    await Promise.all([slowA, fastB]);
    expect(order).toEqual(['b-done', 'a-done']);
  });

  it('a failing operation does not block the next queued one', async () => {
    const queue = new OperationQueue();
    const order: string[] = [];
    const failing = queue.run('a', () => {
      throw new Error('op failed');
    });
    const next = queue.run('a', () => {
      order.push('next-ran');
    });
    await expect(failing).rejects.toThrow('op failed');
    await next;
    expect(order).toEqual(['next-ran']);
  });

  it('tail resolves after every queued operation for the key has settled', async () => {
    const queue = new OperationQueue();
    let settled = false;
    const first = queue.run('a', async () => {
      await Promise.resolve();
      settled = true;
    });
    const waiting = queue.tail('a');
    await first;
    await waiting;
    expect(settled).toBe(true);
  });

  it('drops the tail entry when the queue drains (F11 — no per-id leak)', async () => {
    const queue = new OperationQueue();
    await queue.run('a', () => undefined);
    await queue.run('b', () => undefined);
    // Let the drain-cleanup microtasks run after the tails settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });

  it('keeps the tail while a newer operation is still queued', async () => {
    const queue = new OperationQueue();
    const gate = createDeferred<void>();
    const first = queue.run('a', () => gate.promise);
    const second = queue.run('a', () => undefined);
    await Promise.resolve();
    // The first tail settled-replaced: only the live tail is tracked.
    expect(queue.size).toBe(1);
    gate.resolve();
    await first;
    await second;
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.size).toBe(0);
  });
});

describe('idempotent', () => {
  it('runs a sync disposer once and memoizes the result', async () => {
    let calls = 0;
    const disposer = idempotent(() => {
      calls += 1;
    });
    await disposer();
    await disposer();
    expect(calls).toBe(1);
  });

  it('runs an async disposer once and awaits it', async () => {
    let calls = 0;
    const disposer = idempotent(async () => {
      await Promise.resolve();
      calls += 1;
    });
    await disposer();
    await disposer();
    expect(calls).toBe(1);
  });

  it('memoizes a throwing disposer — the second call rejects without re-running (INV-05)', async () => {
    let calls = 0;
    const disposer = idempotent(() => {
      calls += 1;
      throw new Error('disposer failed');
    });
    await expect(disposer()).rejects.toThrow('disposer failed');
    await expect(disposer()).rejects.toThrow('disposer failed');
    expect(calls).toBe(1);
  });

  it('memoizes a rejecting async disposer without re-running it', async () => {
    let calls = 0;
    const failure = new Error('async disposer failed');
    const disposer = idempotent(() => {
      calls += 1;
      return Promise.reject(failure);
    });
    await expect(disposer()).rejects.toBe(failure);
    await expect(disposer()).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

describe('BoundedLog', () => {
  it('keeps insertion order up to the capacity', () => {
    const log = new BoundedLog<number>(3);
    for (const value of [1, 2, 3]) {
      log.push(value);
    }
    expect(log.entries()).toEqual([1, 2, 3]);
    expect(log.size).toBe(3);
  });

  it('evicts oldest first beyond the capacity', () => {
    const log = new BoundedLog<number>(2);
    log.push(1);
    log.push(2);
    log.push(3);
    expect(log.entries()).toEqual([2, 3]);
    expect(log.size).toBe(2);
  });

  it('entries() returns a copy — mutating it cannot affect the log', () => {
    const log = new BoundedLog<number>(2);
    log.push(1);
    const copy = log.entries() as number[];
    copy.push(99);
    expect(log.entries()).toEqual([1]);
  });

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new BoundedLog<number>(0)).toThrow(RangeError);
    expect(() => new BoundedLog<number>(1.5)).toThrow(RangeError);
  });
});

describe('abortable', () => {
  it('passes the promise through untouched without a signal', async () => {
    await expect(abortable(Promise.resolve(42), undefined, () => new Error('nope'))).resolves.toBe(
      42,
    );
  });

  it('rejects with makeError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new Error('aborted');
    await expect(abortable(new Promise(() => {}), controller.signal, () => failure)).rejects.toBe(
      failure,
    );
  });

  it('rejects when the signal aborts mid-flight and ignores the late settlement', async () => {
    const controller = new AbortController();
    const failure = new Error('aborted');
    let settled = false;
    const pending = abortable(
      new Promise<string>((resolve) =>
        setTimeout(() => {
          settled = true;
          resolve('late');
        }, 20),
      ),
      controller.signal,
      () => failure,
    );
    controller.abort();
    await expect(pending).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(true);
  });
});
