// Scope and disposal-engine tests.
// The engine is the product: 100% line coverage is enforced for scope.ts.

import { isMoltError, MoltError } from '../src/errors.js';
import { createDeferred } from '../src/internal/async.js';
import { ScopeImpl } from '../src/scope.js';

async function expectCode(promise: Promise<unknown>, code: MoltError['code']): Promise<MoltError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!isMoltError(caught)) {
    throw new Error(`expected MoltError(${code}), got: ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
  return caught;
}

// The tests drive the concrete engine: the public Scope interface deliberately
// has no dispose() — disposal is the runtime's job — so the
// engine-level tests use ScopeImpl directly.
function makeScope(): ScopeImpl {
  return new ScopeImpl();
}

describe('scope disposal order and failure isolation (INV-02, INV-03)', () => {
  it('runs mixed sync/async disposers in LIFO order and awaits each', async () => {
    const scope = makeScope();
    const order: string[] = [];
    scope.onDispose(() => {
      order.push('first');
    });
    scope.onDispose(async () => {
      await Promise.resolve();
      order.push('second');
    });
    await scope.acquire(
      () => ({ id: 'resource' }),
      () => {
        order.push('third');
      },
    );

    const report = await scope.dispose();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(report.errors).toEqual([]);
  });

  it('a failing disposer never prevents later disposers; every failure is collected (INV-03)', async () => {
    const scope = makeScope();
    const ran: string[] = [];
    const failure = new Error('disposer 1 failed');
    scope.onDispose(() => {
      ran.push('one');
      throw failure;
    });
    scope.onDispose(() => {
      ran.push('two');
    });
    scope.onDispose(() => {
      ran.push('three');
    });

    const report = await scope.dispose();
    expect(ran).toEqual(['three', 'two', 'one']);
    expect(report.errors).toEqual([failure]);
  });

  it('a rejecting async disposer is collected the same way', async () => {
    const scope = makeScope();
    const failure = new Error('async disposer failed');
    scope.onDispose(() => Promise.reject(failure));

    const report = await scope.dispose();
    expect(report.errors).toEqual([failure]);
  });
});

describe('disposal idempotency (INV-04, INV-05)', () => {
  it('dispose() runs disposers exactly once; the second call returns the same report', async () => {
    const scope = makeScope();
    let calls = 0;
    scope.onDispose(() => {
      calls += 1;
    });

    const first = await scope.dispose();
    const second = await scope.dispose();
    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it('concurrent dispose calls await one disposal and share the report (INV-05)', async () => {
    const scope = makeScope();
    let calls = 0;
    scope.onDispose(async () => {
      calls += 1;
      await Promise.resolve();
    });

    const [a, b] = await Promise.all([scope.dispose(), scope.dispose()]);
    expect(calls).toBe(1);
    expect(b).toBe(a);
  });

  it('a throwing onDispose disposer is memoized — a second dispose does not re-run it (INV-05)', async () => {
    const scope = makeScope();
    let calls = 0;
    scope.onDispose(() => {
      calls += 1;
      throw new Error('faulty');
    });

    const first = await scope.dispose();
    expect(first.errors).toHaveLength(1);
    const second = await scope.dispose();
    expect(calls).toBe(1);
    expect(second.errors).toHaveLength(1);
  });
});

describe('acquisition boundaries (INV-01, INV-12)', () => {
  it('acquire on a disposed scope rejects with INVALID_STATE (INV-04)', async () => {
    const scope = makeScope();
    await scope.dispose();
    await expectCode(
      scope.acquire(
        () => ({}),
        () => undefined,
      ),
      'INVALID_STATE',
    );
  });

  it('a failing create registers nothing and propagates the original error', async () => {
    const scope = makeScope();
    const failure = new Error('create failed');
    let disposed = false;
    const pending = scope.acquire(
      () => {
        throw failure;
      },
      () => {
        disposed = true;
      },
    );

    await expect(pending).rejects.toBe(failure);
    const report = await scope.dispose();
    expect(disposed).toBe(false);
    expect(report.errors).toEqual([]);
  });

  it('abort during a pending create disposes the resolved value immediately and rejects (INV-01/12)', async () => {
    const scope = makeScope();
    const created = createDeferred<{ id: number }>();
    let disposedWith: { id: number } | undefined;
    const pending = scope.acquire(
      () => created.promise,
      (value) => {
        disposedWith = value;
      },
    );

    await scope.dispose(); // aborts the signal; no entries registered yet
    created.resolve({ id: 1 });

    const error = await expectCode(pending, 'INVALID_STATE');
    expect(error.details?.['reason']).toBe('scope disposed during acquire');
    expect(disposedWith).toEqual({ id: 1 });
  });

  it('abort during a pending create attaches the disposal failure as cause', async () => {
    const scope = makeScope();
    const created = createDeferred<{ id: number }>();
    const disposalFailure = new Error('dispose raced too');
    const pending = scope.acquire(
      () => created.promise,
      () => {
        throw disposalFailure;
      },
    );

    await scope.dispose();
    created.resolve({ id: 1 });

    const error = await expectCode(pending, 'INVALID_STATE');
    expect(error.cause).toBe(disposalFailure);
  });

  it('abort during a pending create that rejects propagates the original error and disposes nothing', async () => {
    const scope = makeScope();
    const created = createDeferred<never>();
    const failure = new Error('create failed late');
    let disposeCalls = 0;
    const pending = scope.acquire(
      () => created.promise,
      () => {
        disposeCalls += 1;
      },
    );

    await scope.dispose();
    created.reject(failure);

    await expect(pending).rejects.toBe(failure);
    expect(disposeCalls).toBe(0);
  });

  it('onDispose after dispose throws INVALID_STATE (late registration is a bug)', async () => {
    const scope = makeScope();
    await scope.dispose();
    let thrown: unknown;
    try {
      scope.onDispose(() => undefined);
    } catch (error) {
      thrown = error;
    }
    expect(isMoltError(thrown) && thrown.code).toBe('INVALID_STATE');
  });
});

describe('abort and protocol integration', () => {
  it('the signal is aborted before any disposer runs', async () => {
    const scope = makeScope();
    let abortedAtDisposal: boolean | undefined;
    scope.onDispose(() => {
      abortedAtDisposal = scope.signal.aborted;
    });

    await scope.dispose();
    expect(abortedAtDisposal).toBe(true);
  });

  it('disposing an empty scope yields a zero-error report and an aborted signal', async () => {
    const scope = makeScope();
    const report = await scope.dispose();
    expect(report.errors).toEqual([]);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.isDisposed()).toBe(true);
  });

  it('Symbol.asyncDispose matches dispose()', async () => {
    const scope = makeScope();
    let calls = 0;
    scope.onDispose(() => {
      calls += 1;
    });
    await scope[Symbol.asyncDispose]();
    await scope[Symbol.asyncDispose]();
    expect(calls).toBe(1);
    expect(scope.isDisposed()).toBe(true);
  });
});
