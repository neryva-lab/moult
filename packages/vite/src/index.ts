/**
 * Vite HMR bindings that delegate update lifecycle to Moult.
 * @packageDocumentation
 */

import type { PluginDefinition, Runtime } from '@moult/runtime';
import { MoltError } from '@moult/runtime';

/** The three module lifecycle events understood by the bridge. @public */
export type VitePluginEvent = 'added' | 'changed' | 'removed';

/** A module update delivered by a host-facing HMR event source. @public */
export interface VitePluginUpdate {
  /** Stable plugin id associated with the module update. */
  readonly pluginId: string;
  /** Loads the candidate definition; rejected loading is a replacement failure. */
  readonly loadDefinition?: (() => PluginDefinition | Promise<PluginDefinition>) | undefined;
}

/** A diagnostic sink for import failures that occur before core can run replacement. @public */
export type ViteDiagnostic = (error: MoltError) => void;

/** Minimal event source implemented by a Vite `import.meta.hot` integration. @public */
export interface ViteHotSource {
  /** Registers a listener for one HMR lifecycle event. */
  on(
    event: VitePluginEvent,
    listener: (update: VitePluginUpdate) => void | Promise<void>,
  ): () => void;
}

/** Options for {@link createViteBridge}. @public */
export interface ViteBridgeOptions {
  /** Runtime that owns plugin lifecycle and serializes updates. */
  readonly runtime: Runtime;
  /** Host-provided HMR event source. */
  readonly hot: ViteHotSource;
  /** Receives structured bridge failures. */
  readonly diagnose?: ViteDiagnostic | undefined;
}

/** Installed HMR bridge controls. @public */
export interface ViteBridge {
  /** Removes all HMR listeners installed by the bridge. */
  readonly close: () => void;
  /** Processes a module-added update. */
  readonly handleAdded: (update: VitePluginUpdate) => Promise<void>;
  /** Processes a module-changed update. */
  readonly handleChanged: (update: VitePluginUpdate) => Promise<void>;
  /** Processes a module-removed update. */
  readonly handleRemoved: (update: VitePluginUpdate) => Promise<void>;
}

function loadRequired(update: VitePluginUpdate): Promise<PluginDefinition> {
  if (update.loadDefinition === undefined) {
    return Promise.reject(
      new MoltError({
        code: 'INVALID_DEFINITION',
        message: `HMR update ${update.pluginId} did not provide a definition loader`,
        pluginId: update.pluginId,
      }),
    );
  }
  return Promise.resolve(update.loadDefinition());
}

function bridgeError(error: unknown, pluginId: string): MoltError {
  if (error instanceof MoltError && error.code === 'REPLACEMENT_FAILED') return error;
  return new MoltError(
    {
      code: 'REPLACEMENT_FAILED',
      message: `HMR update of ${pluginId} failed`,
      pluginId,
      details: { reason: 'module-import-failed' },
    },
    error,
  );
}

/**
 * Creates a Vite bridge without exposing Vite types or module graph objects to core.
 * @throws Errors thrown while registering the host event listeners.
 * @public
 */
export function createViteBridge(options: ViteBridgeOptions): ViteBridge {
  const { runtime, hot, diagnose } = options;
  const subscriptions = [
    // Listener rejections are reported through diagnose inside each handler;
    // the event source receives no rejection.
    hot.on('added', (update) => handleAdded(update).catch(() => undefined)),
    hot.on('changed', (update) => handleChanged(update).catch(() => undefined)),
    hot.on('removed', (update) => handleRemoved(update).catch(() => undefined)),
  ];

  const report = (error: unknown, pluginId: string): void => {
    const structured = error instanceof MoltError ? error : bridgeError(error, pluginId);
    if (diagnose === undefined) return;
    try {
      diagnose(
        structured.code === 'REPLACEMENT_FAILED' ? structured : bridgeError(structured, pluginId),
      );
    } catch {
      // A diagnostic observer cannot change the already-preserved old generation.
    }
  };

  async function handleAdded(update: VitePluginUpdate): Promise<void> {
    try {
      const definition = await loadRequired(update);
      runtime.install(definition);
      await runtime.start(definition.id);
    } catch (error) {
      const structured = bridgeError(error, update.pluginId);
      report(structured, update.pluginId);
      throw structured;
    }
  }

  async function handleChanged(update: VitePluginUpdate): Promise<void> {
    try {
      const definition = await loadRequired(update);
      await runtime.replace(definition);
    } catch (error) {
      const structured = bridgeError(error, update.pluginId);
      report(structured, update.pluginId);
      throw structured;
    }
  }

  async function handleRemoved(update: VitePluginUpdate): Promise<void> {
    try {
      await runtime.uninstall(update.pluginId);
    } catch (error) {
      const structured = bridgeError(error, update.pluginId);
      report(structured, update.pluginId);
      throw structured;
    }
  }

  return {
    close: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    },
    handleAdded,
    handleChanged,
    handleRemoved,
  };
}
