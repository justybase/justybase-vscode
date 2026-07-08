/**
 * Metadata Cache - Search Module
 * Search functionality across cached metadata
 */

import type { MetadataStorageReader } from './cache/MetadataStorageReader';
import { SearchResult } from './types';
import { extractLabel, matchesConnection } from './helpers';

export type CacheSearchMatchType = 'NAME' | 'OBJ_DESC' | 'COL_DESC' | 'TYPE';

function termMatches(lowerTerm: string, value: string | undefined): boolean {
    const trimmed = value?.trim();
    return trimmed ? trimmed.toLowerCase().includes(lowerTerm) : false;
}

function getObjectDescription(item: { DESCRIPTION?: string; detail?: string }): string | undefined {
    if (typeof item.DESCRIPTION === 'string' && item.DESCRIPTION.trim()) {
        return item.DESCRIPTION.trim();
    }
    return undefined;
}

function getColumnDescription(item: {
    documentation?: string;
    DESCRIPTION?: string;
}): string | undefined {
    if (typeof item.documentation === 'string' && item.documentation.trim()) {
        return item.documentation.trim();
    }
    if (typeof item.DESCRIPTION === 'string' && item.DESCRIPTION.trim()) {
        return item.DESCRIPTION.trim();
    }
    return undefined;
}

function buildResultKey(result: SearchResult): string {
    return [
        result.connectionName || '',
        result.database || '',
        result.schema || '',
        result.name,
        result.type,
        result.parent || '',
    ].join('|').toUpperCase();
}

function upsertResult(
    resultsByKey: Map<string, SearchResult>,
    candidate: SearchResult,
): void {
    const key = buildResultKey(candidate);
    const existing = resultsByKey.get(key);
    if (!existing) {
        resultsByKey.set(key, candidate);
        return;
    }

    const existingPriority = existing.matchType === 'NAME' ? 0 : 1;
    const candidatePriority = candidate.matchType === 'NAME' ? 0 : 1;
    if (candidatePriority < existingPriority) {
        resultsByKey.set(key, candidate);
    }
}

/**
 * Search through cached metadata for objects matching a term
 */
export function searchCache(
    cache: MetadataStorageReader,
    term: string,
    connectionName?: string
): SearchResult[] {
    const resultsByKey = new Map<string, SearchResult>();
    const lowerTerm = term.toLowerCase();

    if (!lowerTerm) {
        return [];
    }

    // Search Tables (in tableCache)
    for (const [key, entry] of cache.tableCache) {
        if (!matchesConnection(key, connectionName)) continue;

        const parts = key.split('|');
        if (parts.length < 2) continue;

        const cacheConnectionName = parts[0];
        const dbKey = parts[1];
        const dbParts = dbKey.split('.');
        const dbName = dbParts[0];
        const schemaName = dbParts.length > 1 && dbParts[1] ? dbParts[1] : undefined;

        for (const item of entry.data) {
            const name = extractLabel(item);
            if (!name) {
                continue;
            }

            const itemSchema = typeof item.SCHEMA === 'string' && item.SCHEMA.trim().length > 0
                ? item.SCHEMA.trim()
                : undefined;
            const resolvedSchema =
                itemSchema ||
                schemaName ||
                (item.detail && item.detail.includes('(') ? item.detail.match(/\((.*?)\)/)?.[1] : undefined);
            const objType = item.objType || (item.kind === 18 ? 'VIEW' : 'TABLE');
            const description = getObjectDescription(item);
            const nameMatches = termMatches(lowerTerm, name);
            const descriptionMatches = termMatches(lowerTerm, description);

            if (!nameMatches && !descriptionMatches) {
                continue;
            }

            upsertResult(resultsByKey, {
                name,
                type: objType,
                database: dbName,
                schema: resolvedSchema,
                connectionName: cacheConnectionName,
                description: descriptionMatches ? description : undefined,
                matchType: nameMatches ? 'NAME' : 'OBJ_DESC',
            });
        }
    }

    // Search Columns (in columnCache)
    for (const [key, entry] of cache.columnCache) {
        if (!matchesConnection(key, connectionName)) continue;

        const parts = key.split('|');
        if (parts.length < 2) continue;

        const cacheConnectionName = parts[0];
        const dbKey = parts[1];
        const dbParts = dbKey.split('.');
        const dbName = dbParts[0];
        const schemaName = dbParts[1];
        const tableName = dbParts[2];

        for (const item of entry.data) {
            const name = extractLabel(item) || item.ATTNAME;
            if (!name) {
                continue;
            }

            const dataType = item.detail || item.FORMAT_TYPE;
            const description = getColumnDescription(item);
            const nameMatches = termMatches(lowerTerm, name);
            const descriptionMatches = termMatches(lowerTerm, description);
            const typeMatches = termMatches(lowerTerm, typeof dataType === 'string' ? dataType : undefined);

            if (!nameMatches && !descriptionMatches && !typeMatches) {
                continue;
            }

            let matchType: CacheSearchMatchType = 'NAME';
            if (!nameMatches && descriptionMatches) {
                matchType = 'COL_DESC';
            } else if (!nameMatches && typeMatches) {
                matchType = 'TYPE';
            }

            upsertResult(resultsByKey, {
                name,
                type: 'COLUMN',
                database: dbName,
                schema: schemaName,
                parent: tableName,
                connectionName: cacheConnectionName,
                description: descriptionMatches ? description : undefined,
                dataType: typeof dataType === 'string' ? dataType : undefined,
                matchType,
            });
        }
    }

    return Array.from(resultsByKey.values());
}
