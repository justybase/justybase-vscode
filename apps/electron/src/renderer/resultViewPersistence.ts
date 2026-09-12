import type { UiIdentity } from '@justybase/contracts';
import type { UiResultSurfaceState, UiResultViewState } from '@justybase/ui-core';
import {
  decodePersistedResultView,
  encodePersistedResultView,
  resultViewPersistenceIdentity,
  resultViewPersistenceKey,
} from '@justybase/ui-core';

export interface ElectronResultViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function electronResultViewIdentity(
  result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'>,
): UiIdentity {
  return resultViewPersistenceIdentity({
    productId: 'electron',
    workspaceId: 'electron-profile',
    sourceId: result.sourceId,
  }, result.resultSetId);
}

export function getElectronResultViewStorage(): ElectronResultViewStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readElectronResultView(
  storage: ElectronResultViewStorage | undefined,
  result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'>,
): UiResultViewState | undefined {
  if (!storage) return undefined;
  try {
    return decodePersistedResultView(storage.getItem(resultViewPersistenceKey(result.resultSetId)), {
      scope: 'profile',
      identity: electronResultViewIdentity(result),
    });
  } catch {
    return undefined;
  }
}

export function writeElectronResultView(
  storage: ElectronResultViewStorage | undefined,
  result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'>,
  view: UiResultViewState,
): void {
  if (!storage) return;
  try {
    storage.setItem(resultViewPersistenceKey(result.resultSetId), encodePersistedResultView(view, {
      scope: 'profile',
      identity: electronResultViewIdentity(result),
    }));
  } catch {
    // Renderer storage is optional; grid interaction must remain available.
  }
}
