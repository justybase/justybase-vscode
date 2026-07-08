/**
 * Backward-compatible barrel re-export for metadata cache.
 */

export {
  MetadataCache,
  DatabaseMetadata,
  PerKeyEntry,
  CacheType,
} from './metadata/cache/MetadataCache';

export type { CacheStatsSnapshot, CacheLayer } from './metadata/cache/MetadataCache';
