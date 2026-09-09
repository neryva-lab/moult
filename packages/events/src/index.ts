/**
 * Generation-scoped typed events for Moult hosts and plugins.
 * @packageDocumentation
 */

import type { Capability, Scope } from '@moult/runtime';
import { capability } from '@moult/runtime';

/**
 * A type-safe event map. Each key names one payload type.
 * @public
 */
export type EventMap = object;

/**
 * Delivery mode selected once when a bus is created.
 * @public
 */
export type DeliveryMode = 'sync' | 'async';

/**
 * Receives one typed event payload. Returning a promise is supported in async mode.
 * @public
 */
export type EventListener<T> = (payload: T) => void | Promise<void>;

/**
 * Receives an isolated subscriber failure; throwing from this hook is ignored.
 * @public
 */
export type EventDiagnostic = (error: unknown) => void;

/**
 * A typed bus whose subscriptions are owned by the supplied Moult scope.
 * @public
 */
export interface TypedEventCapability<TMap extends EventMap> {
  /** Delivery mode fixed for this bus instance. */
  readonly mode: DeliveryMode;
  /** Registers a scope-owned listener and returns its idempotent unsubscribe function. */
  on<K extends keyof TMap & string>(
    scope: Scope,
    event: K,
    listener: EventListener<TMap[K]>,
    diagnose?: EventDiagnostic,
  ): () => void;
  /** Delivers one event according to the bus-level delivery mode. */
  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): void | Promise<void>;
  /** Resolves after all queued asynchronous deliveries currently known to the bus. */
  flush(): Promise<void>;
}

/**
 * A factory value suitable for publishing as the standard event capability.
 * @public
 */
export interface EventBusFactory<TMap extends EventMap> {
  /** Creates a bus, optionally overriding this factory's default mode. */
  create(options?: { readonly mode?: DeliveryMode | undefined }): TypedEventCapability<TMap>;
}

/**
 * Standard host/plugin capability token for a typed event-bus factory.
 * @public
 */
export const eventBusCapability: Capability<EventBusFactory<EventMap>> = capability<
  EventBusFactory<EventMap>
>('events.bus', '1.0.0');

interface Subscriber<T> {
  readonly listener: EventListener<T>;
  readonly diagnose: EventDiagnostic | undefined;
  active: boolean;
}

/**
 * Creates a typed event bus with generation-scoped subscriptions.
 * @throws `INVALID_STATE` when a caller supplies an already-disposed scope.
 * @public
 */
export function createEventBus<TMap extends EventMap>(
  mode: DeliveryMode = 'sync',
): TypedEventCapability<TMap> {
  const subscribers = new Map<string, Set<Subscriber<unknown>>>();
  const queues = new Map<string, Promise<void>>();

  const report = (subscriber: Subscriber<unknown>, error: unknown): void => {
    if (subscriber.diagnose === undefined) return;
    try {
      subscriber.diagnose(error);
    } catch {
      // Diagnostics are observers of a failure and cannot become a second
      // failure visible to the emitter.
    }
  };

  const deliverSync = (event: string, payload: unknown): void => {
    const current = subscribers.get(event);
    if (current === undefined) return;
    for (const subscriber of [...current]) {
      if (!subscriber.active) continue;
      try {
        const result = subscriber.listener(payload);
        if (result !== undefined) {
          void Promise.resolve(result).catch((error: unknown) => report(subscriber, error));
        }
      } catch (error) {
        report(subscriber, error);
      }
    }
  };

  const deliverAsync = async (event: string, payload: unknown): Promise<void> => {
    const current = subscribers.get(event);
    if (current === undefined) return;
    for (const subscriber of [...current]) {
      if (!subscriber.active) continue;
      try {
        await subscriber.listener(payload);
      } catch (error) {
        report(subscriber, error);
      }
    }
  };

  const on = <K extends keyof TMap & string>(
    scope: Scope,
    event: K,
    listener: EventListener<TMap[K]>,
    diagnose?: EventDiagnostic,
  ): (() => void) => {
    const subscriber: Subscriber<TMap[K]> = { listener, diagnose, active: true };
    const unsubscribe = (): void => {
      if (!subscriber.active) return;
      subscriber.active = false;
      const set = subscribers.get(event);
      if (set === undefined) return;
      // The event-key map validates that this erased subscriber belongs to this set.
      set.delete(subscriber as Subscriber<unknown>);
      if (set.size === 0) subscribers.delete(event);
    };
    scope.onDispose(unsubscribe);
    const set = subscribers.get(event) ?? new Set<Subscriber<unknown>>();
    // The event-key map preserves the typed payload relationship before erasure.
    set.add(subscriber as Subscriber<unknown>);
    subscribers.set(event, set);
    return unsubscribe;
  };

  const emit = <K extends keyof TMap & string>(
    event: K,
    payload: TMap[K],
  ): void | Promise<void> => {
    if (mode === 'sync') {
      deliverSync(event, payload);
      return;
    }
    const previous = queues.get(event) ?? Promise.resolve();
    const next = previous.then(() => deliverAsync(event, payload));
    const settled = next.catch(() => undefined);
    queues.set(event, settled);
    void settled.then(() => {
      if (queues.get(event) === settled) queues.delete(event);
    });
    return next;
  };

  return {
    mode,
    on,
    emit,
    flush: () => Promise.all([...queues.values()]).then(() => undefined),
  };
}

/**
 * Creates the standard capability factory with a fixed bus delivery mode.
 * Factory construction performs no registration and throws no error.
 *
 * @public
 */
export function eventBusFactory<TMap extends EventMap>(
  mode: DeliveryMode = 'sync',
): EventBusFactory<TMap> {
  return { create: (options) => createEventBus<TMap>(options?.mode ?? mode) };
}
