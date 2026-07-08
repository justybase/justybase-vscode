/**
 * Incremental metadata search index over RAM cache layers.
 * Supports facet filters without requiring a full column prefetch.
 */

import type { MetadataStorageReader } from './cache/MetadataStorageReader';
import { searchCache } from './search';
import type { SearchResult } from './types';
import type { SchemaSearchResultItem } from '../contracts/webviews/schemaSearchContracts';

export interface SearchIndexFilters {
    connectionName?: string;
    database?: string;
    schema?: string;
    objectType?: string;
    matchType?: string;
}

export interface SearchIndexOptions extends SearchIndexFilters {
    limit?: number;
}

function normalizeFilterValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed.toUpperCase() : undefined;
}

export function applySearchIndexFilters(
    results: SearchResult[],
    filters: SearchIndexFilters,
): SearchResult[] {
    const database = normalizeFilterValue(filters.database);
    const schema = normalizeFilterValue(filters.schema);
    const objectType = normalizeFilterValue(filters.objectType);
    const matchType = normalizeFilterValue(filters.matchType);

    return results.filter((result) => {
        if (database && (result.database || '').toUpperCase() !== database) {
            return false;
        }
        if (schema && (result.schema || '').toUpperCase() !== schema) {
            return false;
        }
        if (objectType && result.type.toUpperCase() !== objectType) {
            return false;
        }
        if (matchType && (result.matchType || 'NAME').toUpperCase() !== matchType) {
            return false;
        }
        return true;
    });
}

export function searchMetadataIndex(
    cache: MetadataStorageReader,
    term: string,
    options: SearchIndexOptions = {},
): SearchResult[] {
    const connectionName = options.connectionName?.trim() || undefined;
    let results = searchCache(cache, term, connectionName);
    results = applySearchIndexFilters(results, options);

    if (typeof options.limit === 'number' && options.limit > 0) {
        results = results.slice(0, options.limit);
    }

    return results;
}

export function searchResultToSchemaItem(
    result: SearchResult,
    fallbackConnectionName?: string,
): SchemaSearchResultItem {
    const description =
        result.matchType === 'OBJ_DESC' || result.matchType === 'COL_DESC'
            ? (result.description || '')
            : 'Result from Cache';

    return {
        NAME: result.name,
        SCHEMA: result.schema || '',
        DATABASE: result.database || '',
        TYPE: result.type,
        PARENT: result.parent || '',
        DESCRIPTION: description,
        MATCH_TYPE: result.matchType || 'NAME',
        connectionName: result.connectionName || fallbackConnectionName,
    };
}

export function collectSearchFacets(results: SearchResult[]): {
    types: string[];
    schemas: string[];
    matchTypes: string[];
} {
    const types = new Set<string>();
    const schemas = new Set<string>();
    const matchTypes = new Set<string>();

    for (const result of results) {
        if (result.type) {
            types.add(result.type.toUpperCase());
        }
        if (result.schema) {
            schemas.add(result.schema.toUpperCase());
        }
        matchTypes.add((result.matchType || 'NAME').toUpperCase());
    }

    return {
        types: Array.from(types).sort(),
        schemas: Array.from(schemas).sort(),
        matchTypes: Array.from(matchTypes).sort(),
    };
}
