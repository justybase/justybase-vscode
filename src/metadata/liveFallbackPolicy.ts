/**
 * Policy for live catalog fallbacks.
 *
 * The shadow cache is the primary source for authoring features. This module
 * decides whether a missing cache scope may fall back to a live catalog query,
 * and it is intentionally tiny so every consumer applies the same rule.
 */

import { getExtensionConfiguration } from '../compatibility/configuration';
import type { MetadataRequestSource } from './metadataQueryDiagnostics';

export type MetadataLiveFallbackMode = 'never' | 'onDemand' | 'always';

export const DEFAULT_METADATA_LIVE_FALLBACK: MetadataLiveFallbackMode = 'onDemand';

/** Completion must never block on a catalog round-trip. */
const CACHE_ONLY_SOURCES: ReadonlySet<MetadataRequestSource> = new Set<MetadataRequestSource>([
    'completion',
]);

export function getMetadataLiveFallbackMode(): MetadataLiveFallbackMode {
    const configured = getExtensionConfiguration('metadata')
        .get<string>('liveFallback', DEFAULT_METADATA_LIVE_FALLBACK);
    if (configured === 'never' || configured === 'always') {
        return configured;
    }
    return DEFAULT_METADATA_LIVE_FALLBACK;
}

/**
 * @param explicitUserAction True when the user opened a scope (schema tree,
 * Edit Data, explicit refresh) rather than an automatic authoring path.
 */
export function allowsLiveMetadataFetch(explicitUserAction = false): boolean {
    const mode = getMetadataLiveFallbackMode();
    if (mode === 'always') {
        return true;
    }
    if (mode === 'never') {
        return false;
    }
    return explicitUserAction;
}

/** Live fallback decision for a metadata request source. */
export function allowsLiveMetadataFetchForSource(
    source: MetadataRequestSource | undefined,
): boolean {
    const explicit = source === undefined || !CACHE_ONLY_SOURCES.has(source);
    return allowsLiveMetadataFetch(explicit);
}
