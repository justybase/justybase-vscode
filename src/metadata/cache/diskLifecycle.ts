/**
 * Disk cache initialization and cross-window re-hydration.
 */

import type { ConnectionManager } from '../../core/connectionManager';
import { Logger } from '../../utils/logger';
import {
  hydrateConnectionMetadataChunked,
  MetadataDiskIndexWatcher,
  MetadataDiskStorage,
} from '../diskStorage';
import type { CachePrefetcher } from '../prefetch';
import type { MetadataCache } from './MetadataCache';
import type { MetadataStore } from './MetadataStore';
import {
  eagerPreloadColumnsIfEnabled,
  scheduleEagerColumnPreload,
  type ColumnLoaderDeps,
  type ColumnLoaderState,
} from './columnLoader';

export interface DiskLifecycleState {
  cacheGeneration: number;
  columnsOnDisk: Map<string, string[]>;
  deferredIndexConnections: Set<string>;
  diskInitPromise: Promise<void> | undefined;
  metadataHydratingConnections: Set<string>;
  metadataHydratePromises: Map<string, Promise<void>>;
}

export interface DiskLifecycleDeps {
  state: DiskLifecycleState;
  columnLoaderState: ColumnLoaderState;
  store: MetadataStore;
  diskStorage: MetadataDiskStorage | undefined;
  diskWatcher: MetadataDiskIndexWatcher | undefined;
  prefetcher: CachePrefetcher;
  cache: MetadataCache;
  connectionManager: ConnectionManager | undefined;
  columnLoaderDeps: ColumnLoaderDeps;
  isDiskPersistenceEnabled: () => boolean;
  isCacheGenerationCurrent: (generation: number) => boolean;
  onExternalRefresh: (connectionName: string) => void;
  hasConnectionPrefetchInProgress: (connectionName: string) => boolean;
  loadColumnsForDatabase: (
    connectionName: string,
    databaseName: string,
  ) => Promise<void>;
  columnsLoadedDatabases: Map<string, Set<string>>;
}

export async function initializeDiskCache(deps: DiskLifecycleDeps): Promise<void> {
  if (!deps.isDiskPersistenceEnabled() || !deps.diskStorage) {
    return;
  }

  const generation = deps.state.cacheGeneration;
  const initStartMs = Date.now();
  await deps.connectionManager?.ensureFullyLoaded?.();
  if (!deps.isCacheGenerationCurrent(generation)) {
    return;
  }
  await deps.diskStorage.cleanupTempFile();
  await deps.diskStorage.migrateLegacyIfNeeded();
  if (!deps.isCacheGenerationCurrent(generation)) {
    return;
  }

  const manifestReadStartMs = Date.now();
  const manifests = await deps.diskStorage.loadAllConnectionManifests();
  const manifestReadMs = Date.now() - manifestReadStartMs;
  if (!deps.isCacheGenerationCurrent(generation)) {
    return;
  }
  if (manifests.size === 0) {
    Logger.getInstance().info(
      '[MetadataCache] No disk cache found, will prefetch fresh',
    );
    return;
  }

  const { loadable, freshTimestamps } = deps.diskStorage.filterLoadableManifestConnections(
    manifests,
    deps.store.cacheTtl,
  );

  for (const [connectionName, manifest] of loadable) {
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }
    deps.state.columnsOnDisk.set(connectionName, [...manifest.columnDatabases]);
    if (manifest.database.data.length > 0) {
      deps.cache.setDatabases(connectionName, manifest.database.data);
    }
    scheduleBackgroundMetadataHydrate(deps, connectionName, generation);
  }

  if (!deps.isCacheGenerationCurrent(generation)) {
    return;
  }
  deps.prefetcher.restorePrefetchTimestamps(freshTimestamps);

  if (loadable.size > 0) {
    Logger.getInstance().info(
      `[MetadataCache] Loaded metadata manifests from disk (${loadable.size} connection(s), ${freshTimestamps.size} fresh, manifestRead=${manifestReadMs}ms, total=${Date.now() - initStartMs}ms)`,
    );
  }
}

function scheduleBackgroundMetadataHydrate(
  deps: DiskLifecycleDeps,
  connectionName: string,
  generation: number,
): void {
  if (deps.state.metadataHydratePromises.has(connectionName)) {
    return;
  }

  deps.state.metadataHydratingConnections.add(connectionName);
  const hydratePromise = hydrateConnectionMetadataFromDisk(
    deps,
    connectionName,
    generation,
  );
  deps.state.metadataHydratePromises.set(connectionName, hydratePromise);
  void hydratePromise.finally(() => {
    deps.state.metadataHydratePromises.delete(connectionName);
    deps.state.metadataHydratingConnections.delete(connectionName);
  });
}

async function hydrateConnectionMetadataFromDisk(
  deps: DiskLifecycleDeps,
  connectionName: string,
  generation: number,
): Promise<void> {
  if (!deps.diskStorage) {
    return;
  }

  const hydrateStartMs = Date.now();
  try {
    const index = await deps.diskStorage.readV3Index();
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }
    const indexEntry = index?.connections[connectionName];
    if (!indexEntry) {
      return;
    }
    const loaded = await deps.diskStorage.loadConnectionMetadataOnly(
      connectionName,
      indexEntry,
    );
    if (!loaded) {
      deps.prefetcher.clearConnectionPrefetchTimestamp(connectionName);
      Logger.getInstance().warn(
        `[MetadataCache] Full metadata file missing or invalid for ${connectionName}; prefetch freshness cleared`,
      );
      return;
    }
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }

    deps.state.columnsOnDisk.set(connectionName, [...loaded.columnDatabases]);
    await hydrateConnectionMetadataChunked(deps.cache, connectionName, loaded, {
      deferIndexes: true,
      cacheGeneration: generation,
    });
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }

    deps.state.deferredIndexConnections.add(connectionName);
    if (Object.keys(loaded.table).length > 0) {
      deps.prefetcher.markAllObjectsPrefetchTriggered(connectionName);
    }
    for (const dbName of Object.keys(loaded.schema)) {
      if (!deps.cache.hasCachedTypeGroups(connectionName, dbName)) {
        const derived = deps.cache.deriveTypeGroupsFromCache(connectionName, dbName);
        if (derived && derived.length > 0) {
          deps.cache.setTypeGroups(connectionName, dbName, derived);
        }
      }
    }

    deps.onExternalRefresh(connectionName);
    Logger.getInstance().debug(
      `[MetadataCache] metadata background hydrate ${connectionName}: ${Date.now() - hydrateStartMs}ms, ${Object.keys(loaded.table).length} table layer(s)`,
    );

    if (deps.state.metadataHydratingConnections.size <= 1) {
      scheduleEagerColumnPreload(deps.columnLoaderState, () =>
        eagerPreloadColumnsIfEnabled(deps.columnLoaderDeps),
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.getInstance().warn(
      `[MetadataCache] Background metadata hydrate failed for ${connectionName}: ${message}`,
    );
  }
}

export async function onExternalCacheUpdate(
  deps: DiskLifecycleDeps,
  connectionNames: string[],
): Promise<void> {
  if (!deps.diskStorage || !deps.isDiskPersistenceEnabled()) {
    return;
  }

  for (const connectionName of connectionNames) {
    const refreshStartedAt = performance.now();
    if (deps.hasConnectionPrefetchInProgress(connectionName)) {
      continue;
    }

    const generation = deps.state.cacheGeneration;

    const index = await deps.diskStorage.readV3Index();
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }
    const indexEntry = index?.connections[connectionName];
    if (!indexEntry) {
      continue;
    }

    const expectedFingerprint =
      deps.diskStorage.resolveConnectionFingerprint(connectionName);
    if (
      expectedFingerprint
      && indexEntry.connectionFingerprint !== expectedFingerprint
    ) {
      continue;
    }

    const loaded = await deps.diskStorage.loadConnectionMetadataOnly(
      connectionName,
      indexEntry,
    );
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }
    if (!loaded) {
      Logger.getInstance().warn(
        `[MetadataCache] External update: metadata load failed for ${connectionName}`,
      );
      continue;
    }

    Logger.getInstance().info(
      `[MetadataCache] External update detected for ${connectionName}, re-hydrating from disk`,
    );

    deps.state.columnsOnDisk.set(connectionName, [...loaded.columnDatabases]);
    await hydrateConnectionMetadataChunked(deps.cache, connectionName, loaded, {
      deferIndexes: true,
      cacheGeneration: generation,
    });
    if (!deps.isCacheGenerationCurrent(generation)) {
      return;
    }
    deps.state.deferredIndexConnections.add(connectionName);

    const loadedDbs = deps.columnsLoadedDatabases.get(connectionName);
    if (loadedDbs && loadedDbs.size > 0) {
      for (const dbName of loadedDbs) {
        if (!deps.isCacheGenerationCurrent(generation)) {
          return;
        }
        await deps.loadColumnsForDatabase(connectionName, dbName);
      }
    }

    if (indexEntry.isComplete !== false) {
      deps.prefetcher.restorePrefetchTimestamps(
        new Map([[connectionName, indexEntry.prefetchCompletedAt]]),
      );
    } else {
      deps.prefetcher.clearConnectionPrefetchTimestamp(connectionName);
    }
    deps.prefetcher.markAllObjectsPrefetchTriggered(connectionName);

    deps.onExternalRefresh(connectionName);

    const durationMs = performance.now() - refreshStartedAt;
    if (durationMs >= 100) {
      const memory = process.memoryUsage();
      Logger.getInstance().warn(
        `[MetadataCache] slow external refresh connection=${connectionName} durationMs=${durationMs.toFixed(1)} heapUsed=${memory.heapUsed} rss=${memory.rss}`,
      );
    }

    Logger.getInstance().info(
      `[MetadataCache] External update applied for ${connectionName}`,
    );
  }
}

export function startDiskWatcherAfterInit(
  diskWatcher: MetadataDiskIndexWatcher | undefined,
  initPromise: Promise<void>,
): void {
  if (diskWatcher) {
    void initPromise.then(() => {
      diskWatcher.start();
    });
  }
}
