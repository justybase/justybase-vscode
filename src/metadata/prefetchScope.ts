/**
 * Scope of the automatic metadata warm-up for Netezza connections.
 *
 * `activeAndPopular` keeps the database-scoped shadow prefetch: the active
 * database and the most recently used ones are warmed, the rest stays lazy.
 * `connection` restores the eager connection-wide prefetch while keeping the
 * per-database snapshots, DDL coalescing, and lazy fallback policy intact.
 */

import { getExtensionConfiguration } from '../compatibility/configuration';

export type MetadataPrefetchScope = 'activeAndPopular' | 'connection';

export const DEFAULT_METADATA_PREFETCH_SCOPE: MetadataPrefetchScope = 'activeAndPopular';

export function normalizeMetadataPrefetchScope(value: unknown): MetadataPrefetchScope {
    return value === 'connection' ? 'connection' : DEFAULT_METADATA_PREFETCH_SCOPE;
}

export function getMetadataPrefetchScope(): MetadataPrefetchScope {
    return normalizeMetadataPrefetchScope(
        getExtensionConfiguration('metadata')
            .get<string>('prefetchScope', DEFAULT_METADATA_PREFETCH_SCOPE),
    );
}
