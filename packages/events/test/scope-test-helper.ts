import type { Scope } from '@moult/runtime';

export function createScopeForTest(): Scope {
  let disposed = false;
  const controller = new AbortController();
  const disposers: Array<() => void | Promise<void>> = [];
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const disposer of disposers.reverse()) {
      await disposer();
    }
  };
  const scope: Scope = {
    signal: controller.signal,
    onDispose(disposer) {
      if (disposed) throw new Error('scope already disposed');
      disposers.push(disposer);
    },
    acquire: async <T>(
      create: () => T | Promise<T>,
      dispose: (value: T) => void | Promise<void>,
    ) => {
      const value = await create();
      if (disposed) {
        await dispose(value);
        throw new Error('scope already disposed');
      }
      disposers.push(() => dispose(value));
      return value;
    },
    [Symbol.asyncDispose]: dispose,
    isDisposed: () => disposed,
  };
  return scope;
}
