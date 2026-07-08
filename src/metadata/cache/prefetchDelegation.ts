/**
 * Thin delegation wrappers for CachePrefetcher and disk prefetch locks.
 */

import type { QueryRunnerRawFn } from '../prefetch';
import type { CachePrefetcher } from '../prefetch';
import type { MetadataDiskStorage } from '../diskStorage';
import { Logger } from '../../utils/logger';
import type { MetadataStore } from './MetadataStore';

export interface PrefetchDelegationDeps {
  prefetcher: CachePrefetcher;
  store: MetadataStore;
  diskStorage: MetadataDiskStorage | undefined;
  isDiskPersistenceEnabled: () => boolean;
}

export async function prefetchColumnsForSchema(
  deps: PrefetchDelegationDeps,
  connectionName: string,
  dbName: string,
  schemaName: string | undefined,
  runQueryFn: QueryRunnerRawFn,
): Promise<void> {
  return deps.prefetcher.prefetchColumnsForSchema(
    connectionName,
    dbName,
    schemaName,
    runQueryFn,
  );
}

export async function prefetchAllObjects(
  deps: PrefetchDelegationDeps,
  connectionName: string,
  runQueryFn: QueryRunnerRawFn,
  databases?: string[],
): Promise<void> {
  return deps.prefetcher.prefetchAllObjects(
    connectionName,
    runQueryFn,
    false,
    databases,
  );
}

export function hasAllObjectsPrefetchTriggered(
  deps: PrefetchDelegationDeps,
  connectionName: string,
): boolean {
  return deps.prefetcher.hasAllObjectsPrefetchTriggered(connectionName);
}

export function hasConnectionPrefetchTriggered(
  deps: PrefetchDelegationDeps,
  connectionName: string,
): boolean {
  return deps.prefetcher.hasConnectionPrefetchTriggered(connectionName);
}

export function isConnectionPrefetchFresh(
  deps: PrefetchDelegationDeps,
  connectionName: string,
): boolean {
  const timestamp = deps.prefetcher.getConnectionPrefetchTimestamp(connectionName);
  if (timestamp === undefined) {
    return false;
  }
  return Date.now() - timestamp < deps.store.cacheTtl;
}

export async function tryAcquirePrefetchLock(
  deps: PrefetchDelegationDeps,
  connectionName: string,
): Promise<boolean> {
  if (!deps.isDiskPersistenceEnabled() || !deps.diskStorage) {
    return true;
  }
  const acquired = await deps.diskStorage.lock.acquireLock(connectionName);
  if (acquired) {
    Logger.getInstance().debug(
      `[MetadataDisk] lock: acquired for ${connectionName}`,
    );
    deps.diskStorage.lock.startHeartbeat(connectionName);
  } else {
    Logger.getInstance().info(
      `[MetadataDisk] lock: skipped for ${connectionName} (another instance prefetching)`,
    );
  }
  return acquired;
}

export function hasConnectionPrefetchInProgress(
  deps: PrefetchDelegationDeps,
  connectionName: string,
): boolean {
  return deps.diskStorage?.lock.hasOwnedLock(connectionName) ?? false;
}

export async function releasePrefetchLock(
  deps: PrefetchDelegationDeps,
  connectionName: string,
): Promise<void> {
  await deps.diskStorage?.lock.releaseLock(connectionName);
}

export function triggerConnectionPrefetch(
  deps: PrefetchDelegationDeps,
  connectionName: string,
  runQueryFn: QueryRunnerRawFn,
): void {
  deps.prefetcher.triggerConnectionPrefetch(connectionName, runQueryFn);
}

export async function prefetchColumnsForDatabase(
  deps: PrefetchDelegationDeps,
  connectionName: string,
  dbName: string,
  runQueryFn: QueryRunnerRawFn,
): Promise<void> {
  return deps.prefetcher.prefetchColumnsForDatabase(
    connectionName,
    dbName,
    runQueryFn,
  );
}
