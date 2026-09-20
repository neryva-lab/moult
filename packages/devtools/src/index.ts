/**
 * Development-time diagnostics for Moult: generation timelines and leak
 * reports. Pure functions over the public {@link Runtime} inspection
 * surface — safe to bundle into dev builds and strip from production.
 *
 * @packageDocumentation
 */

import type { GraphIssue, Runtime, RuntimeInspection, TransitionRecord } from '@moult/runtime';

/**
 * One entry in a generation timeline: a lifecycle transition with its
 * sequence number and wall-clock timestamp, oldest first.
 *
 * @public
 */
export interface TimelineEntry {
  readonly seq: number;
  readonly at: number;
  readonly type: TransitionRecord['type'];
  readonly pluginId: string | undefined;
  readonly generation: string | undefined;
}

/**
 * The generation timeline: the runtime's bounded transition audit log as a
 * plain chronological list. Pass a plugin id to see one plugin's
 * generations — installs, starts, replacements, pins, quarantines, stops —
 * in order; omit it for the whole runtime.
 *
 * The log holds the most recent 128 transitions; entries older than that
 * were evicted and are not shown.
 *
 * @public
 */
export function timeline(runtime: Runtime, pluginId?: string): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const transition of runtime.transitions()) {
    if (pluginId !== undefined && transition.pluginId !== pluginId) {
      continue;
    }
    entries.push({
      seq: transition.seq,
      at: transition.at,
      type: transition.type,
      pluginId: transition.pluginId,
      generation: transition.generation,
    });
  }
  return Object.freeze(entries);
}

/**
 * A generation the runtime is keeping alive past its active lifetime, and
 * why it is retained.
 *
 * @public
 */
export interface RetainedGeneration {
  readonly pluginId: string;
  readonly generation: string | undefined;
  /** `pinned`: kept alive by `inFlight: 'pin'`; `quarantined`: withdrawn but serving. */
  readonly reason: 'pinned' | 'quarantined';
  /**
   * Milliseconds since the pin/quarantine transition. Undefined when the
   * transition was evicted from the bounded log — treat as "retained for a
   * while".
   */
  readonly retainedForMs: number | undefined;
}

/**
 * A plugin whose record carries an error: a failed start, a disposal
 * failure, a drain problem. The error is inspectable; the plugin itself
 * may be perfectly healthy — this is a diagnostic trail, not a verdict.
 *
 * @public
 */
export interface PluginErrorEntry {
  readonly pluginId: string;
  readonly error: unknown;
}

/**
 * The leak report from {@link findLeaks}: everything the runtime is
 * holding onto that deserves a second look. `clean` is true when every
 * list is empty.
 *
 * @public
 */
export interface LeakReport {
  /**
   * Generations kept alive by pin or quarantine. Pins are a manual
   * lifecycle — a pin older than the operation that created it is usually
   * a forgotten handle. Quarantined generations keep serving existing
   * holders while withdrawn from selection.
   */
  readonly retained: readonly RetainedGeneration[];
  /** `validate()` issues: stale bindings and orphaned generations are leaks in bookkeeping. */
  readonly issues: readonly GraphIssue[];
  /** Plugins whose records carry an error trail. */
  readonly pluginErrors: readonly PluginErrorEntry[];
  /**
   * Observer listener failures. Observer throws never affect lifecycle
   * outcomes, but a throwing listener is often a leaked subscription.
   */
  readonly observerErrors: RuntimeInspection['observerDiagnostics'];
  readonly clean: boolean;
}

/**
 * Finds everything the runtime is retaining that might be a leak:
 * pinned and quarantined generations (with retention age), `validate()`
 * issues, per-plugin error trails, and broken observer listeners.
 *
 * Pins and quarantines are legitimate by design — this report surfaces
 * them so a forgotten pin or a never-restored quarantine is visible,
 * not so they can be auto-released.
 *
 * @public
 */
export function findLeaks(runtime: Runtime): LeakReport {
  const inspected = runtime.inspect();
  const transitions = runtime.transitions();
  const now = Date.now();

  const retainedSince = new Map<string, number>();
  for (const transition of transitions) {
    if (
      (transition.type === 'pinned' || transition.type === 'quarantined') &&
      transition.pluginId !== undefined
    ) {
      retainedSince.set(`${transition.type}:${transition.pluginId}`, transition.at);
    }
  }

  const retained: RetainedGeneration[] = [];
  for (const plugin of inspected.plugins) {
    if (plugin.pinnedGeneration !== undefined) {
      const since = retainedSince.get(`pinned:${plugin.id}`);
      retained.push({
        pluginId: plugin.id,
        generation: plugin.pinnedGeneration,
        reason: 'pinned',
        retainedForMs: since === undefined ? undefined : Math.max(0, now - since),
      });
    }
    if (plugin.quarantined === true) {
      const since = retainedSince.get(`quarantined:${plugin.id}`);
      retained.push({
        pluginId: plugin.id,
        generation: plugin.generation,
        reason: 'quarantined',
        retainedForMs: since === undefined ? undefined : Math.max(0, now - since),
      });
    }
  }

  const pluginErrors: PluginErrorEntry[] = [];
  for (const plugin of inspected.plugins) {
    if (plugin.error !== undefined) {
      pluginErrors.push({ pluginId: plugin.id, error: plugin.error });
    }
  }

  const issues = runtime.validate();
  const observerErrors = inspected.observerDiagnostics;
  const clean =
    retained.length === 0 &&
    issues.length === 0 &&
    pluginErrors.length === 0 &&
    observerErrors.length === 0;

  return {
    retained: Object.freeze(retained),
    issues,
    pluginErrors: Object.freeze(pluginErrors),
    observerErrors,
    clean,
  };
}
