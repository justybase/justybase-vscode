/**
 * Lazy column hydration from disk column files.
 */

import type { MetadataCache } from './MetadataCache';
import { Logger } from '../../utils/logger';
import { extractDatabaseFromLayerKey } from '../diskStorage/metadataDiskPaths';
import {
  decodeColumnLayerFromFile,
  hydrateColumnsFromDatabase,
  resolveColumnLayerKeyInFile,
} from '../diskStorage';
import type { MetadataDiskStorage, SerializedColumnFile } from '../diskStorage';
import { yieldToEventLoop } from '../hydrateScheduler';
import type { CachePrefetcher } from '../prefetch';

export interface ColumnLoaderState {
  columnsOnDisk: Map<string, string[]>;
  columnsLoadedDatabases: Map<string, Set<string>>;
  columnLoadPromises: Map<string, Promise<void>>;
  columnLayerLoadPromises: Map<string, Promise<void>>;
  /** Parsed column files kept in RAM to avoid re-reading gzip on each table expand. */
  parsedColumnFileCache: Map<string, SerializedColumnFile>;
  eagerPreloadPromise: Promise<void> | undefined;
  cacheGeneration: number;
}

export interface ColumnLoaderDeps {
  state: ColumnLoaderState;
  diskStorage: MetadataDiskStorage | undefined;
  prefetcher: CachePrefetcher;
  cache: MetadataCache;
  isCacheGenerationCurrent: (generation: number) => boolean;
  onNeedColumnRecovery: (connectionName: string) => void;
}

export function resolveOnDiskDatabaseName(
  state: ColumnLoaderState,
  connectionName: string,
  databaseName: string,
): string | undefined {
  const databases = state.columnsOnDisk.get(connectionName);
  if (!databases) {
    return undefined;
  }
  const upperDb = databaseName.toUpperCase();
  return databases.find((db) => db.toUpperCase() === upperDb);
}

export function hasColumnsOnDisk(
  state: ColumnLoaderState,
  connectionName: string,
  databaseName: string,
): boolean {
  return resolveOnDiskDatabaseName(state, connectionName, databaseName) !== undefined;
}

export function isColumnsLoaded(
  state: ColumnLoaderState,
  connectionName: string,
  databaseName: string,
): boolean {
  const loaded = state.columnsLoadedDatabases.get(connectionName);
  if (!loaded) {
    return false;
  }
  const upperDb = databaseName.toUpperCase();
  for (const db of loaded) {
    if (db.toUpperCase() === upperDb) {
      return true;
    }
  }
  return false;
}

export async function ensureColumnsLoaded(
  deps: ColumnLoaderDeps,
  connectionName: string,
  databaseName: string,
): Promise<void> {
  if (isColumnsLoaded(deps.state, connectionName, databaseName)) {
    return;
  }

  if (deps.cache.isLargeTableCatalog(connectionName, databaseName)) {
    Logger.getInstance().debug(
      `[MetadataCache] Skipping full column disk hydrate for large catalog ${connectionName}/${databaseName} (per-table layers)`,
    );
    return;
  }

  const canonicalDatabaseName = resolveOnDiskDatabaseName(
    deps.state,
    connectionName,
    databaseName,
  );
  if (!canonicalDatabaseName) {
    return;
  }

  const loadKey = `${connectionName}|${canonicalDatabaseName.toUpperCase()}`;
  const existing = deps.state.columnLoadPromises.get(loadKey);
  if (existing) {
    return existing;
  }

  const loadPromise = loadColumnsForDatabase(
    deps,
    connectionName,
    canonicalDatabaseName,
  );
  deps.state.columnLoadPromises.set(loadKey, loadPromise);
  try {
    await loadPromise;
  } finally {
    deps.state.columnLoadPromises.delete(loadKey);
  }
}

export async function ensureColumnsLoadedForTableKey(
  deps: ColumnLoaderDeps,
  connectionName: string,
  layerKey: string,
): Promise<void> {
  if (deps.cache.getColumns(connectionName, layerKey)) {
    return;
  }

  const databaseName = extractDatabaseFromLayerKey(layerKey);
  if (isColumnsLoaded(deps.state, connectionName, databaseName)) {
    return;
  }

  if (hasColumnsOnDisk(deps.state, connectionName, databaseName)) {
    await loadColumnLayerFromDisk(deps, connectionName, layerKey);
    if (deps.cache.getColumns(connectionName, layerKey)) {
      return;
    }
  }

  if (!deps.cache.isLargeTableCatalog(connectionName, databaseName)) {
    await ensureColumnsLoaded(deps, connectionName, databaseName);
  }
}

export async function preloadColumnsForConnection(
  deps: ColumnLoaderDeps,
  connectionName: string,
  options?: { concurrency?: number },
): Promise<void> {
  const databases = deps.state.columnsOnDisk.get(connectionName);
  if (!databases || databases.length === 0) {
    return;
  }

  const concurrency = options?.concurrency ?? 1;
  for (let i = 0; i < databases.length; i += concurrency) {
    const batch = databases.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (dbName) => {
        if (deps.cache.isLargeTableCatalog(connectionName, dbName)) {
          Logger.getInstance().debug(
            `[MetadataCache] Skipping eager column preload for large catalog ${connectionName}/${dbName}`,
          );
          return;
        }
        await ensureColumnsLoaded(deps, connectionName, dbName);
      }),
    );
    await yieldToEventLoop();
  }
}

function isColumnsLoadedFully(
  state: ColumnLoaderState,
  connectionName: string,
): boolean {
  const databases = state.columnsOnDisk.get(connectionName);
  if (!databases || databases.length === 0) {
    return true;
  }
  return databases.every((db) => isColumnsLoaded(state, connectionName, db));
}

export async function eagerPreloadColumnsIfEnabled(
  deps: ColumnLoaderDeps,
): Promise<void> {
  if (!deps.diskStorage) {
    return;
  }

  const connectionNames = [...deps.state.columnsOnDisk.keys()];
  if (connectionNames.length === 0) {
    return;
  }

  const preloadStartMs = Date.now();
  let totalDatabases = 0;
  Logger.getInstance().info(
    `[MetadataCache] Eager column preload started for ${connectionNames.length} connection(s)`,
  );

  for (const connectionName of connectionNames) {
    const databases = deps.state.columnsOnDisk.get(connectionName);
    if (!databases || databases.length === 0) {
      continue;
    }

    if (isColumnsLoadedFully(deps.state, connectionName)) {
      continue;
    }

    totalDatabases += databases.length;
    await preloadColumnsForConnection(deps, connectionName, { concurrency: 1 });
    await yieldToEventLoop();

    Logger.getInstance().debug(
      `[MetadataCache] Eager column preload: ${connectionName} — ${databases.length} database(s) loaded`,
    );
  }

  const elapsed = Date.now() - preloadStartMs;
  Logger.getInstance().info(
    `[MetadataCache] Eager column preload completed: ${connectionNames.length} connection(s), ${totalDatabases} database(s), ${elapsed}ms`,
  );
}

export async function whenEagerPreloadComplete(
  state: ColumnLoaderState,
): Promise<void> {
  await state.eagerPreloadPromise;
}

async function loadColumnLayerFromDisk(
  deps: ColumnLoaderDeps,
  connectionName: string,
  layerKey: string,
): Promise<void> {
  const databaseName = extractDatabaseFromLayerKey(layerKey);
  const canonicalDatabaseName = resolveOnDiskDatabaseName(
    deps.state,
    connectionName,
    databaseName,
  );
  if (!canonicalDatabaseName || !deps.diskStorage) {
    return;
  }

  const layerLoadKey = `${connectionName}|${layerKey.toUpperCase()}`;
  const existing = deps.state.columnLayerLoadPromises.get(layerLoadKey);
  if (existing) {
    return existing;
  }

  const generation = deps.state.cacheGeneration;
  const loadStartMs = Date.now();
  const loadPromise = (async () => {
    const fileCacheKey = `${connectionName}|${canonicalDatabaseName.toUpperCase()}`;
    let columnFile = deps.state.parsedColumnFileCache.get(fileCacheKey);
    if (!columnFile) {
      const loaded = await deps.diskStorage!.loadColumnFileForDatabase(
        connectionName,
        canonicalDatabaseName,
      );
      await yieldToEventLoop();
      if (!loaded || !deps.isCacheGenerationCurrent(generation)) {
        if (!loaded) {
          markColumnDiskLoadFailed(deps, connectionName, canonicalDatabaseName);
        }
        return;
      }
      columnFile = loaded;
      deps.state.parsedColumnFileCache.set(fileCacheKey, columnFile);
    }

    const resolvedLayerKey =
      resolveColumnLayerKeyInFile(columnFile, layerKey) ?? layerKey;
    const columns = decodeColumnLayerFromFile(columnFile, layerKey);
    if (!columns || !deps.isCacheGenerationCurrent(generation)) {
      return;
    }

    deps.cache.setColumns(connectionName, resolvedLayerKey, columns);
    Logger.getInstance().debug(
      `[MetadataCache] column layer load ${connectionName}/${resolvedLayerKey}: ${Date.now() - loadStartMs}ms, ${columns.length} column(s)`,
    );
  })();

  deps.state.columnLayerLoadPromises.set(layerLoadKey, loadPromise);
  try {
    await loadPromise;
  } finally {
    deps.state.columnLayerLoadPromises.delete(layerLoadKey);
  }
}

async function loadColumnsForDatabase(
  deps: ColumnLoaderDeps,
  connectionName: string,
  databaseName: string,
): Promise<void> {
  if (!deps.diskStorage) {
    return;
  }

  const generation = deps.state.cacheGeneration;
  const loadStartMs = Date.now();
  const columnFile = await deps.diskStorage.loadColumnFileForDatabase(
    connectionName,
    databaseName,
  );
  await yieldToEventLoop();
  if (!deps.isCacheGenerationCurrent(generation)) {
    Logger.getInstance().debug(
      `[MetadataCache] column load discarded after cache clear: ${connectionName}/${databaseName}`,
    );
    return;
  }
  if (!columnFile) {
    Logger.getInstance().warn(
      `[MetadataCache] Column file missing for ${connectionName}/${databaseName}`,
    );
    markColumnDiskLoadFailed(deps, connectionName, databaseName);
    return;
  }

  const fileCacheKey = `${connectionName}|${databaseName.toUpperCase()}`;
  deps.state.parsedColumnFileCache.set(fileCacheKey, columnFile);
  hydrateColumnsFromDatabase(deps.cache, connectionName, columnFile);
  await yieldToEventLoop();
  let loaded = deps.state.columnsLoadedDatabases.get(connectionName);
  if (!loaded) {
    loaded = new Set();
    deps.state.columnsLoadedDatabases.set(connectionName, loaded);
  }
  loaded.add(databaseName);

  const layerCount =
    columnFile.schemaVersion === 3
      ? Object.keys(columnFile.layers).length
      : Object.keys(columnFile.column).length;
  Logger.getInstance().debug(
    `[MetadataCache] column load ${connectionName}/${databaseName}: ${Date.now() - loadStartMs}ms, ${layerCount} layer(s)`,
  );
}

function markColumnDiskLoadFailed(
  deps: ColumnLoaderDeps,
  connectionName: string,
  databaseName: string,
): void {
  const databases = deps.state.columnsOnDisk.get(connectionName);
  if (databases) {
    const upperDb = databaseName.toUpperCase();
    const remaining = databases.filter((db) => db.toUpperCase() !== upperDb);
    if (remaining.length === 0) {
      deps.state.columnsOnDisk.delete(connectionName);
    } else {
      deps.state.columnsOnDisk.set(connectionName, remaining);
    }
  }
  const fileCacheKey = `${connectionName}|${databaseName.toUpperCase()}`;
  deps.state.parsedColumnFileCache.delete(fileCacheKey);
  deps.prefetcher.clearConnectionPrefetchTimestamp(connectionName);
  Logger.getInstance().info(
    `[MetadataCache] Column disk load failed for ${connectionName}/${databaseName}; prefetch freshness cleared for DB recovery`,
  );
  deps.onNeedColumnRecovery(connectionName);
}

export function scheduleEagerColumnPreload(
  state: ColumnLoaderState,
  preloadFn: () => Promise<void>,
): void {
  state.eagerPreloadPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve(preloadFn());
    }, 0);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    Logger.getInstance().warn(`[MetadataCache] Eager column preload failed: ${message}`);
  });
}
