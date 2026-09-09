import { expectGenerationDisposed, fakeResources, pluginHarness } from '@moult/test';

import type { TypedEventCapability } from '../src/index.js';
import { createEventBus } from '../src/index.js';
import { createScopeForTest } from './scope-test-helper.js';

interface Messages {
  readonly text: string;
  readonly count: number;
}

describe('events adapter (INV-12)', () => {
  it('INV-12: synchronous delivery is typed, ordered, and isolated', () => {
    const scope = createScopeForTest();
    const bus = createEventBus<Messages>('sync');
    const order: string[] = [];
    bus.on(scope, 'text', () => {
      order.push('first');
    });
    bus.on(scope, 'text', () => {
      order.push('throwing');
      throw new Error('subscriber failed');
    });
    bus.on(scope, 'text', (value) => {
      order.push(`${value}:last`);
    });
    void bus.emit('text', 'hello');
    expect(order).toEqual(['first', 'throwing', 'hello:last']);
  });

  it('INV-12: scope disposal removes subscriptions and async events preserve per-key order', async () => {
    const scope = createScopeForTest();
    const bus = createEventBus<Messages>('async');
    const received: string[] = [];
    bus.on(scope, 'text', (value) => {
      received.push(value);
    });
    const first = bus.emit('text', 'one');
    const second = bus.emit('text', 'two');
    await Promise.all([first, second, bus.flush()]);
    expect(received).toEqual(['one', 'two']);
    await scope[Symbol.asyncDispose]();
    await bus.emit('text', 'three');
    expect(received).toEqual(['one', 'two']);
  });

  it('INV-12: scope-owned subscriptions release their host resource after plugin disposal', async () => {
    const resources = fakeResources();
    const diagnostics: unknown[] = [];
    let bus: TypedEventCapability<Messages> | undefined;
    const harness = pluginHarness({
      id: 'events.test.plugin',
      version: '1.0.0',
      setup: async (context) => {
        const listenerResource = resources.listenerHost();
        await context.scope.acquire(listenerResource.create, listenerResource.dispose);
        bus = createEventBus<Messages>('sync');
        bus.on(
          context.scope,
          'text',
          () => {
            throw new Error('subscriber failure');
          },
          (error) => diagnostics.push(error),
        );
      },
    });
    await harness.run();
    if (bus === undefined) throw new Error('event bus was not created');
    void bus.emit('text', 'hello');
    expect(diagnostics).toHaveLength(1);
    expect(resources.counters()['listener.live']).toBe(1);
    await harness.dispose();
    await expectGenerationDisposed(harness.runtime, 'events.test.plugin');
    void bus.emit('text', 'after-disposal');
    expect(diagnostics).toHaveLength(1);
    resources.expectNoLeaks();
  });

  it('INV-12: asynchronous delivery is concurrent across event keys', async () => {
    const scope = createScopeForTest();
    const bus = createEventBus<Messages>('async');
    let releaseText: (() => void) | undefined;
    let signalTextStarted: (() => void) | undefined;
    const textStarted = new Promise<void>((resolve) => {
      signalTextStarted = resolve;
    });
    const textRelease = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    let countDelivered = false;
    bus.on(scope, 'text', async () => {
      signalTextStarted?.();
      await textRelease;
    });
    bus.on(scope, 'count', () => {
      countDelivered = true;
    });
    const textDelivery = bus.emit('text', 'held');
    await textStarted;
    const countDelivery = bus.emit('count', 1);
    await countDelivery;
    expect(countDelivered).toBe(true);
    if (releaseText === undefined) throw new Error('text delivery was not waiting');
    releaseText();
    await textDelivery;
    await scope[Symbol.asyncDispose]();
  });
});
