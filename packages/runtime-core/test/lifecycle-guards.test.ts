// Lifecycle-guard tests: restart semantics (F1), binding-time semver
// revalidation (F2), setup self-operation guard (F3), rollback event
// balance (F8), nested observer reentrancy (F9), concurrent-start
// coalescing (F10).

import type { PluginDefinition } from '../src/index.js';
import { capability } from '../src/index.js';
import { createRuntime } from '../src/index.js';
import { isMoltError, MoltError } from '../src/index.js';
import { createDeferred } from '../src/internal/async.js';

const storage = capability<{ read(): number }>('test.storage', '1.0.0');
const mid = capability<{ v: string }>('test.mid', '1.0.0');

function expectCode(error: unknown, code: MoltError['code']): MoltError {
  if (!isMoltError(error)) {
    throw new Error(`expected MoltError(${code}), got: ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}

function def(
  overrides: Partial<PluginDefinition> & { id: string; setup: PluginDefinition['setup'] },
): PluginDefinition {
  return { version: '1.0.0', ...overrides };
}

describe('F1: restart revives stopped provider chains', () => {
  it('start on a stopped leaf activates providers first, in dependency order', async () => {
    const runtime = createRuntime();
    const order: string[] = [];
    runtime.install(
      def({
        id: 'test.a',
        provides: [{ capability: storage }],
        setup: (ctx) => {
          order.push('a');
          ctx.provide(storage, { read: () => 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.b',
        requires: [{ capability: storage, range: '^1.0.0' }],
        provides: [{ capability: mid }],
        setup: (ctx) => {
          order.push('b');
          void ctx.require(storage);
          ctx.provide(mid, { v: 'b' });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.c',
        requires: [{ capability: mid, range: '^1.0.0' }],
        setup: (ctx) => {
          order.push('c');
          void ctx.require(mid);
        },
      }),
    );

    await runtime.start('test.c');
    expect(order).toEqual(['a', 'b', 'c']);

    // Stop the whole chain leaf-first, then restart from the leaf.
    await runtime.stop('test.c');
    await runtime.stop('test.b');
    await runtime.stop('test.a');
    expect(runtime.getStatus('test.a')).toBe('stopped');
    order.length = 0;

    await runtime.start('test.c');
    expect(order).toEqual(['a', 'b', 'c']);
    expect(runtime.getStatus('test.a')).toBe('active');
    expect(runtime.getStatus('test.b')).toBe('active');
    expect(runtime.getStatus('test.c')).toBe('active');
  });

  it('start reuses active providers instead of restarting them', async () => {
    const runtime = createRuntime();
    let providerSetups = 0;
    runtime.install(
      def({
        id: 'test.provider',
        provides: [{ capability: storage }],
        setup: (ctx) => {
          providerSetups += 1;
          ctx.provide(storage, { read: () => 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.consumer',
        requires: [{ capability: storage, range: '^1.0.0' }],
        setup: (ctx) => {
          void ctx.require(storage);
        },
      }),
    );

    await runtime.start('test.provider');
    await runtime.start('test.consumer');
    expect(providerSetups).toBe(1);
    expect(runtime.getStatus('test.consumer')).toBe('active');
  });
});

describe('F2: binding-time semver revalidation', () => {
  it('a consumer preparing across a provider replacement fails on semver drift', async () => {
    const runtime = createRuntime();
    const svcV1 = capability<{ v: number }>('test.svc', '1.0.0');
    const svcV2 = capability<{ v: number }>('test.svc', '2.0.0');
    const gate = createDeferred<void>();

    runtime.install(
      def({
        id: 'test.provider',
        version: '1.0.0',
        provides: [{ capability: svcV1 }],
        setup: (ctx) => {
          ctx.provide(svcV1, { v: 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.consumer',
        requires: [{ capability: svcV1, range: '^1.0.0' }],
        setup: async (ctx) => {
          await gate.promise; // hold the consumer in preparing
          ctx.require(svcV1); // binds after the replacement commits
        },
      }),
    );

    await runtime.start('test.provider');
    const startPromise = runtime.start('test.consumer');
    for (let i = 0; i < 200 && runtime.getStatus('test.consumer') !== 'preparing'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.getStatus('test.consumer')).toBe('preparing');

    // No active dependents (the consumer is preparing), so the
    // replacement commits while the consumer is mid-setup.
    await runtime.replace(
      def({
        id: 'test.provider',
        version: '2.0.0',
        provides: [{ capability: svcV2 }],
        setup: (ctx) => {
          ctx.provide(svcV2, { v: 2 });
        },
      }),
    );
    gate.resolve();

    // The drift error surfaces with its own code: the consumer never
    // silently bound the out-of-range generation.
    const error = expectCode(await rejectionOf(startPromise), 'INCOMPATIBLE_CAPABILITY');
    expect(error.details?.['reason']).toBe('binding-drifted');
    // The consumer never bound the drifted version.
    expect(runtime.getStatus('test.consumer')).toBe('stopped');
  });

  it('a compatible replacement still binds for a preparing consumer', async () => {
    const runtime = createRuntime();
    const svcV1 = capability<{ v: number }>('test.svc', '1.0.0');
    const svcV1Patch = capability<{ v: number }>('test.svc', '1.0.1');
    const gate = createDeferred<void>();
    let bound: { v: number } | undefined;

    runtime.install(
      def({
        id: 'test.provider',
        version: '1.0.0',
        provides: [{ capability: svcV1 }],
        setup: (ctx) => {
          ctx.provide(svcV1, { v: 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.consumer',
        requires: [{ capability: svcV1, range: '^1.0.0' }],
        setup: async (ctx) => {
          await gate.promise;
          bound = ctx.require(svcV1);
        },
      }),
    );

    await runtime.start('test.provider');
    const startPromise = runtime.start('test.consumer');
    for (let i = 0; i < 200 && runtime.getStatus('test.consumer') !== 'preparing'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.getStatus('test.consumer')).toBe('preparing');

    await runtime.replace(
      def({
        id: 'test.provider',
        version: '1.0.1',
        provides: [{ capability: svcV1Patch }],
        setup: (ctx) => {
          ctx.provide(svcV1Patch, { v: 2 });
        },
      }),
    );
    gate.resolve();

    await startPromise;
    expect(bound).toEqual({ v: 2 });
    expect(runtime.getStatus('test.consumer')).toBe('active');
  });
});

describe('F3: setup self-operation guard', () => {
  it('self-stop from setup short-circuits: no deadlock, plugin ends stopped', async () => {
    const runtime = createRuntime();
    const order: string[] = [];
    runtime.install(
      def({
        id: 'self',
        setup: async () => {
          order.push('setup-enter');
          await runtime.stop('self');
          order.push('setup-exit');
        },
      }),
    );

    const error = expectCode(await rejectionOf(runtime.start('self')), 'ACTIVATION_FAILED');
    expect(error.message).toContain('setup was interrupted');
    expect(order).toEqual(['setup-enter', 'setup-exit']);
    expect(runtime.getStatus('self')).toBe('stopped');
  }, 10000);

  it('self start/replace/uninstall from setup fail fast with INVALID_STATE', async () => {
    const runtime = createRuntime();
    const codes: string[] = [];
    runtime.install(
      def({
        id: 'self',
        setup: () => {
          for (const attempt of [
            () => runtime.start('self'),
            () => runtime.replace(def({ id: 'self', setup: () => {} })),
            () => runtime.uninstall('self'),
          ]) {
            try {
              void attempt();
            } catch (error) {
              codes.push(expectCode(error, 'INVALID_STATE').details?.['reason'] as string);
            }
          }
        },
      }),
    );

    // The outer start still succeeds: the self-operations were rejected at
    // call time instead of deadlocking the queue.
    await runtime.start('self');
    expect(codes).toEqual([
      'self-operation-during-setup',
      'self-operation-during-setup',
      'self-operation-during-setup',
    ]);
    expect(runtime.getStatus('self')).toBe('active');
  });

  it('the guard does not leak into unrelated external calls', async () => {
    const runtime = createRuntime();
    let externalStop: Promise<void> | undefined;
    runtime.install(
      def({
        id: 'self',
        setup: () => {
          // A lifecycle call for a *different* plugin from inside setup is
          // not a self-operation and queues normally.
          externalStop = runtime.stop('other');
        },
      }),
    );
    runtime.install(def({ id: 'other', setup: () => {} }));

    await runtime.start('other');
    await runtime.start('self');
    await externalStop;
    expect(runtime.getStatus('other')).toBe('stopped');
    expect(runtime.getStatus('self')).toBe('active');
  });
});

describe('F8: rollback emits balancing stopped events', () => {
  it('generations committed then rolled back emit started followed by stopped', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    runtime.subscribe((event) => {
      events.push(`${event.type}:${String(event.pluginId)}`);
    });
    runtime.install(
      def({
        id: 'test.provider',
        provides: [{ capability: storage }],
        setup: (ctx) => {
          ctx.provide(storage, { read: () => 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.consumer',
        requires: [{ capability: storage, range: '^1.0.0' }],
        setup: () => {
          throw new Error('boom');
        },
      }),
    );

    await rejectionOf(runtime.start('test.consumer'));

    const startedIdx = events.indexOf('started:test.provider');
    const stoppedIdx = events.indexOf('stopped:test.provider');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(stoppedIdx).toBeGreaterThan(startedIdx);
    expect(events).toContain('failed:test.consumer');
    expect(runtime.getStatus('test.provider')).toBe('stopped');
  });
});

describe('F9: nested observer reentrancy guard', () => {
  it('a nested synchronous emit does not clobber the outer guard', () => {
    const runtime = createRuntime();
    const order: string[] = [];
    let reentrantThrew = false;
    runtime.subscribe((event) => {
      if (event.type === 'installed' && event.pluginId === 'test.a') {
        order.push('outer-listener-1');
        // Synchronous nested emit: install dispatches 'installed' inline.
        runtime.install(def({ id: 'test.b', setup: () => {} }));
      }
    });
    runtime.subscribe((event) => {
      if (event.type === 'installed' && event.pluginId === 'test.a') {
        order.push('outer-listener-2');
        try {
          void runtime.start('test.a');
        } catch {
          reentrantThrew = true;
        }
      }
    });

    runtime.install(def({ id: 'test.a', setup: () => {} }));

    expect(order).toEqual(['outer-listener-1', 'outer-listener-2']);
    // With the old single-string guard the nested emit cleared it and the
    // reentrant start slipped through; the stack keeps it.
    expect(reentrantThrew).toBe(true);
  });
});

describe('F10: concurrent-start coalescing', () => {
  it('concurrent starts of a root and its provider activate the provider once', async () => {
    const runtime = createRuntime();
    let providerSetups = 0;
    const gate = createDeferred<void>();
    runtime.install(
      def({
        id: 'test.provider',
        provides: [{ capability: storage }],
        setup: async (ctx) => {
          providerSetups += 1;
          await gate.promise;
          ctx.provide(storage, { read: () => 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.consumer',
        requires: [{ capability: storage, range: '^1.0.0' }],
        setup: (ctx) => {
          void ctx.require(storage);
        },
      }),
    );

    const both = Promise.all([runtime.start('test.consumer'), runtime.start('test.provider')]);
    for (let i = 0; i < 200 && providerSetups === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    gate.resolve();
    // Before F10 the direct start threw INVALID_STATE('busy') here.
    await both;

    expect(providerSetups).toBe(1);
    expect(runtime.getStatus('test.provider')).toBe('active');
    expect(runtime.getStatus('test.consumer')).toBe('active');
  });

  it('a waiter on a failed activation makes a fresh attempt', async () => {
    const runtime = createRuntime();
    let providerAttempts = 0;
    const gate = createDeferred<void>();
    runtime.install(
      def({
        id: 'test.provider',
        provides: [{ capability: storage }],
        setup: async (ctx) => {
          providerAttempts += 1;
          await gate.promise;
          if (providerAttempts === 1) {
            throw new Error('first attempt fails');
          }
          ctx.provide(storage, { read: () => 1 });
        },
      }),
    );
    runtime.install(
      def({
        id: 'test.consumer',
        requires: [{ capability: storage, range: '^1.0.0' }],
        setup: (ctx) => {
          void ctx.require(storage);
        },
      }),
    );

    const consumerStart = runtime.start('test.consumer');
    const providerStart = runtime.start('test.provider');
    for (let i = 0; i < 200 && providerAttempts === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    gate.resolve();

    await rejectionOf(consumerStart);
    // The in-flight attempt failed; the waiter's own attempt succeeds.
    await providerStart;
    expect(providerAttempts).toBe(2);
    expect(runtime.getStatus('test.provider')).toBe('active');
  });
});
