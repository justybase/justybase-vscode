import type { Disposable } from './ports';

export type Cleanup = () => void | Promise<void>;

export interface DisposalCoordinator extends Disposable {
  add(cleanup: Cleanup): () => void;
  get disposed(): boolean;
}

/**
 * Owns adapter resources in registration order and disposes them in reverse
 * order. Both normal shutdown and failed initialization can safely call it
 * more than once.
 */
export function createDisposalCoordinator(): DisposalCoordinator {
  const cleanups: Cleanup[] = [];
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    disposal = (async () => {
      const failures: unknown[] = [];
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (!cleanup) continue;
        try { await cleanup(); } catch (error: unknown) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Multiple UI resources failed to dispose.');
    })();
    return disposal;
  };

  return {
    get disposed() { return disposed; },
    add: cleanup => {
      if (disposed) {
        void cleanup();
        return () => undefined;
      }
      cleanups.push(cleanup);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = cleanups.indexOf(cleanup);
        if (index >= 0) cleanups.splice(index, 1);
      };
    },
    dispose,
  };
}

export async function disposeOnInitializationFailure<T extends Disposable>(resource: T, initialize: () => Promise<void>): Promise<T> {
  try {
    await initialize();
    return resource;
  } catch (error: unknown) {
    try { await resource.dispose(); } catch { /* Preserve the initialization error. */ }
    throw error;
  }
}
