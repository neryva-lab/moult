/**
 * React bindings for committed, generation-scoped Moult contributions.
 * @packageDocumentation
 */

import type { ContributionEntry, ContributionKey, Runtime, RuntimeListener } from '@moult/runtime';
import { contributionKey } from '@moult/runtime';
import type { ComponentType, ErrorInfo, ReactElement, ReactNode } from 'react';
import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Component, createContext, createElement } from 'react';

/** A route contribution rendered by a host router. @public */
export interface ReactRouteContribution {
  /** Host-router path for the contribution. */
  readonly path: string;
  /** React component rendered for the route. */
  readonly component: ComponentType;
}

/** A widget contribution rendered in a host-defined slot. @public */
export interface ReactWidgetContribution {
  /** React component rendered in the host-defined widget slot. */
  readonly component: ComponentType;
  /** Optional host-visible label. */
  readonly label?: string | undefined;
}

/** The standard contribution key for route registrations. @public */
export const reactRoute = contributionKey<ReactRouteContribution>('react.route');

/** The standard contribution key for widget registrations. @public */
export const reactWidget = contributionKey<ReactWidgetContribution>('react.widget');

interface SnapshotStore {
  readonly getSnapshot: () => ReturnType<Runtime['contributions']>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly close: () => void;
}

function createSnapshotStore(runtime: Runtime): SnapshotStore {
  let snapshot = runtime.contributions();
  const listeners = new Set<() => void>();
  let unsubscribeRuntime: (() => void) | undefined;
  const onRuntimeEvent: RuntimeListener = (event) => {
    if (
      event.type !== 'started' &&
      event.type !== 'stopped' &&
      event.type !== 'replaced' &&
      event.type !== 'failed' &&
      event.type !== 'disposed'
    ) {
      return;
    }
    const next = runtime.contributions();
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      unsubscribeRuntime ??= runtime.subscribe(onRuntimeEvent);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeRuntime?.();
          unsubscribeRuntime = undefined;
        }
      };
    },
    close: () => {
      unsubscribeRuntime?.();
      unsubscribeRuntime = undefined;
      listeners.clear();
    },
  };
}

const RuntimeSnapshotContext = createContext<SnapshotStore | undefined>(undefined);

/** Props for {@link RuntimeProvider}. @public */
export interface RuntimeProviderProps {
  /** Runtime whose committed contribution snapshots are rendered. */
  readonly runtime: Runtime;
  /** Descendant React tree that consumes the runtime snapshot store. */
  readonly children?: ReactNode;
}

/**
 * Provides committed Moult contribution snapshots to descendant hooks.
 * Render errors propagate to the host tree; per-contribution isolation is
 * the role of {@link ContributionErrorBoundary}.
 *
 * @public
 */
export function RuntimeProvider({ runtime, children }: RuntimeProviderProps): ReactElement {
  const store = useMemo(() => createSnapshotStore(runtime), [runtime]);
  useEffect(() => () => store.close(), [store]);
  return createElement(RuntimeSnapshotContext.Provider, { value: store }, children);
}

/**
 * Returns committed values for one contribution key. Staged values are never returned.
 * @throws `Error` when called outside a {@link RuntimeProvider}.
 * @public
 */
export function useContributions<T>(key: ContributionKey<T>): readonly T[] {
  const store = useContext(RuntimeSnapshotContext);
  if (store === undefined) throw new Error('useContributions must be used inside RuntimeProvider');
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const entries = snapshot.entries.get(key.id) ?? [];
  // The contribution key is the type authority for the opaque value at this boundary.
  return entries.map((entry) => entry.value as T);
}

/**
 * Returns committed entries, including ownership metadata for generation-aware rendering.
 * @throws `Error` when called outside a {@link RuntimeProvider}.
 * @public
 */
export function useContributionEntries<T>(
  key: ContributionKey<T>,
): readonly (ContributionEntry & { readonly value: T })[] {
  const store = useContext(RuntimeSnapshotContext);
  if (store === undefined)
    throw new Error('useContributionEntries must be used inside RuntimeProvider');
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const entries = snapshot.entries.get(key.id) ?? [];
  // The contribution key is the type authority for the opaque value at this boundary.
  return entries as readonly (ContributionEntry & { readonly value: T })[];
}

/** Props for the per-contribution error boundary. @public */
export interface ContributionErrorBoundaryProps {
  /** Content rendered while the contribution is healthy. */
  readonly children?: ReactNode;
  /** Content rendered after this boundary catches a component error. */
  readonly fallback?: ReactNode;
  /** Receives the error without affecting runtime lifecycle state. */
  readonly onError: (error: unknown, info: ErrorInfo) => void;
}

/** State shape used by the contribution error boundary. @public */
export interface ContributionBoundaryState {
  /** Whether the boundary has isolated a render failure. */
  readonly error: boolean;
}

/** Isolates a plugin contribution render failure from sibling contributions. @public */
export class ContributionErrorBoundary extends Component<
  ContributionErrorBoundaryProps,
  ContributionBoundaryState
> {
  /** Current boundary state. */
  override state: ContributionBoundaryState = { error: false };

  /** Converts a descendant render error into fallback state. */
  static getDerivedStateFromError(_error: unknown): ContributionBoundaryState {
    return { error: true };
  }

  /** Reports the isolated error to the host adapter. */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(error, info);
  }

  /** Renders either the healthy contribution or its fallback. */
  override render(): ReactNode {
    return this.state.error ? (this.props.fallback ?? null) : this.props.children;
  }
}

/**
 * A stale generation callback becomes a no-op after replacement or disposal.
 * @throws Errors thrown by the wrapped callback are forwarded to its caller.
 * @public
 */
export function guardGenerationCallback<TArgs extends readonly unknown[], TResult>(
  runtime: Runtime,
  generation: string,
  callback: (...args: TArgs) => TResult,
  onStale?: () => void,
): (...args: TArgs) => TResult | undefined {
  return (...args: TArgs): TResult | undefined => {
    const current = runtime
      .inspect()
      .plugins.some((plugin) => plugin.status === 'active' && plugin.generation === generation);
    if (!current) {
      onStale?.();
      return undefined;
    }
    return callback(...args);
  };
}
