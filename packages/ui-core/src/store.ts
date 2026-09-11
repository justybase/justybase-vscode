import type { UiAction, UiState } from './types';
import { reduceUiState } from './reducer';
import type { Disposable, Unsubscribe } from './ports';

export interface UiStore extends Disposable {
  getState(): UiState;
  dispatch(action: UiAction): UiState;
  subscribe(listener: (state: UiState, action: UiAction) => void): Unsubscribe;
}
/** Small host-independent store used by Web, Electron and VS Code adapters. */
export function createUiStore(initialState: UiState): UiStore {
  let state = initialState;
  let disposed = false;
  const listeners = new Set<(nextState: UiState, action: UiAction) => void>();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
  };

  return {
    getState: () => state,
    dispatch: action => {
      if (disposed) return state;
      const nextState = reduceUiState(state, action);
      if (nextState === state) return state;
      state = nextState;
      for (const listener of [...listeners]) listener(state, action);
      return state;
    },
    subscribe: listener => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
  };
}
