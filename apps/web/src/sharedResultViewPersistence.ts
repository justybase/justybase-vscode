import type { UiResultSurfaceState, UiResultViewState } from '@justybase/ui-core';
import {
  decodeLegacyResultView,
  decodePersistedResultView,
  encodePersistedResultView,
  resultViewPersistenceIdentity,
  resultViewPersistenceKey,
} from '@justybase/ui-core';
import { readLegacyWorkspaceValue, type WorkspaceStorage } from './workspacePersistence';

export interface SharedResultViewRead {
  readonly view: UiResultViewState;
  readonly migratedFromLegacy: boolean;
}

function sharedResultViewIdentity(userId: string, result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'>) {
  return resultViewPersistenceIdentity({
    productId: 'web',
    userId,
    workspaceId: `web:${userId}`,
    sourceId: result.sourceId,
  }, result.resultSetId);
}

/** Reads the versioned shared envelope, then the pre-shared Web grid state. */
export function readSharedResultView(
  storage: WorkspaceStorage,
  userId: string,
  result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'>,
  queryId?: string,
  statementIndex = 0,
): SharedResultViewRead | undefined {
  const identity = sharedResultViewIdentity(userId, result);
  const current = decodePersistedResultView(storage.get(resultViewPersistenceKey(result.resultSetId)), { scope: 'user', identity });
  if (current) return { view: current, migratedFromLegacy: false };

  const legacyValues = [
    storage.get(`grid_v2_${result.resultSetId}`),
    ...(queryId === undefined ? [] : [storage.get(`grid_${queryId}_${statementIndex}`)]),
    readLegacyWorkspaceValue(`jwb_grid_v2_${result.resultSetId}`),
    ...(queryId === undefined ? [] : [readLegacyWorkspaceValue(`jwb_grid_${queryId}_${statementIndex}`)]),
  ];
  for (const value of legacyValues) {
    const legacy = decodeLegacyResultView(value, result.resultSetId);
    if (legacy) return { view: legacy, migratedFromLegacy: true };
  }
  return undefined;
}

export function writeSharedResultView(
  storage: WorkspaceStorage,
  userId: string,
  result: Pick<UiResultSurfaceState, 'sourceId' | 'resultSetId'>,
  view: UiResultViewState,
): void {
  try {
    storage.set(
      resultViewPersistenceKey(result.resultSetId),
      encodePersistedResultView(view, { scope: 'user', identity: sharedResultViewIdentity(userId, result) }),
    );
  } catch {
    // A full or policy-blocked browser store must not make the grid unusable.
  }
}
