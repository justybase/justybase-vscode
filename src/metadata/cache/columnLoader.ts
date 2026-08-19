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
import {
  buildNetezzaDatabaseCacheKey,
  decodeNetezzaCacheDatabasePart,
  isNetezzaExactCachePart,
} from '../helpers';

export interface ColumnLoaderState {
  columnsOnDisk: Map<string, string[]>;
  /** Exact normalized layer keys advertised by persisted column files. */
  columnLayerKeysOnDisk: Map<string, Set<string>>;
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
  exactNetezza = false,
): string | undefined {
  const databases = state.columnsOnDisk.get(connectionName);
  if (!databases) {
    return undefined;
  }
  const lookup = exactNetezza
    ? (isNetezzaExactCachePart(databaseName)
      ? databaseName
      : buildNetezzaDatabaseCacheKey(databaseName))
    : databaseName;
  return databases.find((db) =>
    (exactNetezza || isNetezzaExactCachePart(db) || isNetezzaExactCachePart(lookup))
      ? (isNetezzaExactCachePart(db) ? db : buildNetezzaDatabaseCacheKey(db)) === lookup
      : db.toUpperCase() === databaseName.toUpperCase(),
  );
}

export function hasColumnsOnDisk(
  state: ColumnLoaderState,
  connectionName: string,
  databaseName: string,
  exactNetezza = false,
): boolean {
  return resolveOnDiskDatabaseName(state, connectionName, databaseName, exactNetezza) !== undefined;
}

function normalizeColumnLayerKey(layerKey: string): string {
    const trimmed = layerKey.trim();
    return isNetezzaExactCachePart(trimmed) ? trimmed : trimmed.toUpperCase();
}

function normalizeNetezzaLayerKey(layerKey: string): string {
  const database = extractDatabaseFromLayerKey(layerKey);
  const databasePart = buildNetezzaDatabaseCacheKey(database);
  return layerKey.startsWith(database)
    ? `${databasePart}${layerKey.slice(database.length)}`
    : layerKey;
}

export function setColumnLayerKeysOnDisk(
  state: ColumnLoaderState,
  connectionName: string,
  layerKeys: readonly string[],
): void {
  if (layerKeys.length === 0) {
    state.columnLayerKeysOnDisk.delete(connectionName);
    return;
  }
  state.columnLayerKeysOnDisk.set(
    connectionName,
    new Set(layerKeys.map(normalizeColumnLayerKey)),
  );
}

export function hasColumnLayerOnDisk(
  state: ColumnLoaderState,
  connectionName: string,
  layerKey: string,
): boolean {
  const layerKeys = state.columnLayerKeysOnDisk.get(connectionName);
  if (!layerKeys) {
    return false;
  }
  const normalized = normalizeColumnLayerKey(layerKey);
  if (layerKeys.has(normalized)) {
    return true;
  }
  const parts = layerKey.split('.');
  if (parts.length < 3) {
    return false;
  }
  const database = isNetezzaExactCachePart(parts[0])
    ? parts[0]
    : buildNetezzaDatabaseCacheKey(parts[0]);
  const exactKey = `${database}.${parts[1]}.${parts.slice(2).join('.')}`;
  if (layerKeys.has(exactKey)) {
    return true;
  }
  const decodedDatabase = decodeNetezzaCacheDatabasePart(database);
  const legacyKey = `${decodedDatabase}.${parts[1]}.${parts.slice(2).join('.')}`;
  return layerKeys.has(legacyKey) || layerKeys.has(legacyKey.toUpperCase());
}

function rememberColumnFileLayerKeys(
  state: ColumnLoaderState,
  connectionName: string,
  columnFile: SerializedColumnFile,
): void {
  const keys = columnFile.schemaVersion === 3
    ? Object.keys(columnFile.layers)
    : Object.keys(columnFile.column);
  const existing = state.columnLayerKeysOnDisk.get(connectionName) ?? new Set<string>();
  for (const key of keys) {
    existing.add(normalizeColumnLayerKey(key));
  }
  state.columnLayerKeysOnDisk.set(connectionName, existing);
}

export function isColumnsLoaded(
  state: ColumnLoaderState,
  connectionName: string,
  databaseName: string,
  exactNetezza = false,
): boolean {
  const loaded = state.columnsLoadedDatabases.get(connectionName);
  if (!loaded) {
    return false;
  }
  const lookup = exactNetezza
    ? (isNetezzaExactCachePart(databaseName)
      ? databaseName
      : buildNetezzaDatabaseCacheKey(databaseName))
    : databaseName;
  for (const db of loaded) {
    if (
      (exactNetezza || isNetezzaExactCachePart(db) || isNetezzaExactCachePart(lookup))
        ? (isNetezzaExactCachePart(db) ? db : buildNetezzaDatabaseCacheKey(db)) === lookup
        : db.toUpperCase() === databaseName.toUpperCase()
    ) {
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
  const exactNetezza = deps.cache.isNetezzaConnection(connectionName);
  if (isColumnsLoaded(deps.state, connectionName, databaseName, exactNetezza)) {
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
    exactNetezza,
  );
  if (!canonicalDatabaseName) {
    return;
  }

  const loadKey = `${connectionName}|${normalizeColumnLayerKey(canonicalDatabaseName)}`;
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
  const exactNetezza = deps.cache.isNetezzaConnection(connectionName);
  if (isColumnsLoaded(deps.state, connectionName, databaseName, exactNetezza)) {
    return;
  }

  if (hasColumnsOnDisk(deps.state, connectionName, databaseName, exactNetezza)) {
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
    deps.cache.isNetezzaConnection(connectionName),
  );
  if (!canonicalDatabaseName || !deps.diskStorage) {
    return;
  }

  const layerLoadKey = `${connectionName}|${normalizeColumnLayerKey(layerKey)}`;
  const existing = deps.state.columnLayerLoadPromises.get(layerLoadKey);
  if (existing) {
    return existing;
  }

  const generation = deps.state.cacheGeneration;
  const loadStartMs = Date.now();
  const loadPromise = (async () => {
    const fileCacheKey = `${connectionName}|${normalizeColumnLayerKey(canonicalDatabaseName)}`;
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
    rememberColumnFileLayerKeys(deps.state, connectionName, columnFile);

    const requestedLayerKey = deps.cache.isNetezzaConnection(connectionName)
      ? normalizeNetezzaLayerKey(layerKey)
      : layerKey;
    const resolvedLayerKey =
      resolveColumnLayerKeyInFile(columnFile, requestedLayerKey)
      ?? (requestedLayerKey !== layerKey
        ? resolveColumnLayerKeyInFile(columnFile, layerKey)
        : undefined)
      ?? requestedLayerKey;
    const columns = decodeColumnLayerFromFile(columnFile, resolvedLayerKey);
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

  const fileCacheKey = `${connectionName}|${normalizeColumnLayerKey(databaseName)}`;
  deps.state.parsedColumnFileCache.set(fileCacheKey, columnFile);
  rememberColumnFileLayerKeys(deps.state, connectionName, columnFile);
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
    const lookup = isNetezzaExactCachePart(databaseName)
      ? databaseName
      : buildNetezzaDatabaseCacheKey(databaseName);
    const remaining = databases.filter((db) =>
      isNetezzaExactCachePart(db) || isNetezzaExactCachePart(lookup)
        ? (isNetezzaExactCachePart(db) ? db : buildNetezzaDatabaseCacheKey(db)) !== lookup
        : db.toUpperCase() !== databaseName.toUpperCase(),
    );
    if (remaining.length === 0) {
      deps.state.columnsOnDisk.delete(connectionName);
    } else {
      deps.state.columnsOnDisk.set(connectionName, remaining);
    }
  }
  const fileCacheKey = `${connectionName}|${normalizeColumnLayerKey(databaseName)}`;
  deps.state.parsedColumnFileCache.delete(fileCacheKey);
  const layerKeys = deps.state.columnLayerKeysOnDisk.get(connectionName);
  if (layerKeys) {
    const lookup = isNetezzaExactCachePart(databaseName)
      ? databaseName
      : buildNetezzaDatabaseCacheKey(databaseName);
    const remaining = new Set(
      [...layerKeys].filter((layerKey) => {
        const layerDatabase = extractDatabaseFromLayerKey(layerKey);
        return isNetezzaExactCachePart(layerDatabase) || isNetezzaExactCachePart(lookup)
          ? (isNetezzaExactCachePart(layerDatabase)
            ? layerDatabase
            : buildNetezzaDatabaseCacheKey(layerDatabase)) !== lookup
          : layerDatabase.toUpperCase() !== databaseName.toUpperCase();
      }),
    );
    if (remaining.size === 0) {
      deps.state.columnLayerKeysOnDisk.delete(connectionName);
    } else {
      deps.state.columnLayerKeysOnDisk.set(connectionName, remaining);
    }
  }
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
