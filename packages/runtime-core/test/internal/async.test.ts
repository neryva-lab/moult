// Unit tests for internal/async.ts. These primitives compose
// the correctness of scope.ts and runtime.ts, so each behavior is pinned
// in isolation.

import {
  AsyncMutex,
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

describe('AsyncMutex', () => {
  it('runs sections in call order', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const first = mutex.runExclusive(async () => {
      await Promise.resolve();
      order.push('first');
    });
    const second = mutex.runExclusive(() => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('a failing section never blocks the next one', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const failing = mutex.runExclusive(() => {
      throw new Error('section failed');
    });
    const next = mutex.runExclusive(() => {
      order.push('next-ran');
    });
    await expect(failing).rejects.toThrow('section failed');
    await next;
    expect(order).toEqual(['next-ran']);
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
