import type { MetadataPrefetchTarget } from './cache/MetadataPrefetchTarget';
import { buildColumnCacheKey } from './columnRowMapping';
import { extractLabel, parseCacheKey } from './helpers';
import type { ColumnMetadata } from './types';
import { stripIdentifierQuoting } from '../utils/identifierUtils';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../utils/sqlUtils';

/**
 * Parse REFOBJNAME from _V_SYNONYM into database/schema/table parts.
 */
export function parseSynonymTargetReference(
    database: string,
    schema: string | undefined,
    referenceName: string,
): { database: string; schema?: string; table: string } | undefined {
    const trimmedReference = referenceName.trim();
    if (!trimmedReference) {
        return undefined;
    }

    const strip = (value: string): string => stripIdentifierQuoting(value, 'netezza');
    const doubleDotIndex = trimmedReference.indexOf('..');
    if (doubleDotIndex > 0) {
        const refDatabase = strip(trimmedReference.slice(0, doubleDotIndex));
        const refTable = strip(trimmedReference.slice(doubleDotIndex + 2));
        if (!refDatabase || !refTable) {
            return undefined;
        }

        return {
            database: refDatabase,
            table: refTable,
        };
    }

    const parts = trimmedReference
        .split('.')
        .map(part => strip(part))
        .filter(part => part.length > 0);

    if (parts.length === 1) {
        return {
            database,
            schema,
            table: parts[0],
        };
    }

    if (parts.length === 2) {
        return {
            database,
            schema: parts[0],
            table: parts[1],
        };
    }

    return {
        database: parts[0],
        schema: parts[1],
        table: parts.slice(2).join('.'),
    };
}

function resolveTargetColumns(
    cache: MetadataPrefetchTarget,
    connectionName: string,
    target: { database: string; schema?: string; table: string },
): ColumnMetadata[] | undefined {
    const directKey = buildColumnCacheKey(target.database, target.schema, target.table);
    const direct = cache.getColumns(connectionName, directKey);
    if (direct && direct.length > 0) {
        return direct;
    }

    if (!target.schema) {
        return cache.getColumnsAnySchema(connectionName, target.database, target.table);
    }

    return undefined;
}

/**
 * After batch column prefetch, copy target table columns onto synonym cache keys.
 */
export async function mirrorSynonymColumnsForConnection(
    cache: MetadataPrefetchTarget,
    connectionName: string,
): Promise<number> {
    let mirroredCount = 0;
    const connPrefix = `${connectionName}|`;

    for (const [tableCacheKey, entry] of cache.tableCache) {
        if (!tableCacheKey.startsWith(connPrefix)) {
            continue;
        }

        const parsedKey = parseCacheKey(tableCacheKey);
        if (!parsedKey) {
            continue;
        }

        const { dbName, schemaName } = parsedKey;

        for (const item of entry.data) {
            if ((item.objType || '').toUpperCase() !== 'SYNONYM') {
                continue;
            }

            const synonymName = extractLabel(item) || item.OBJNAME || item.TABLENAME;
            if (!synonymName) {
                continue;
            }

            const refObjName =
                typeof item.REFOBJNAME === 'string' ? item.REFOBJNAME.trim() : '';
            if (!refObjName) {
                continue;
            }

            const itemSchema =
                typeof item.SCHEMA === 'string' && item.SCHEMA.trim().length > 0
                    ? item.SCHEMA
                    : schemaName;
            const synonymKey = buildColumnCacheKey(dbName, itemSchema, synonymName);

            if (cache.getColumns(connectionName, synonymKey)) {
                continue;
            }

            const target = parseSynonymTargetReference(dbName, itemSchema, refObjName);
            if (!target) {
                continue;
            }

            await cache.ensureColumnsLoaded(connectionName, target.database);
            const targetColumns = resolveTargetColumns(cache, connectionName, target);
            if (!targetColumns || targetColumns.length === 0) {
                continue;
            }

            cache.setColumns(connectionName, synonymKey, targetColumns);
            mirroredCount += 1;
        }
    }

    return mirroredCount;
}

export function buildSynonymTargetQuery(
    database: string,
    synonymName: string,
    schema?: string,
): string {
    const dbId = escapeSqlIdentifier(database);
    const dbLit = escapeSqlLiteral(database);
    const name = escapeSqlLiteral(synonymName);
    let whereClause =
        `UPPER(DATABASE) = UPPER(${dbLit}) AND UPPER(SYNONYM_NAME) = UPPER(${name})`;
    if (schema) {
        whereClause += ` AND UPPER(SCHEMA) = UPPER(${escapeSqlLiteral(schema)})`;
    }

    return `
        SELECT REFOBJNAME
        FROM ${dbId}.._V_SYNONYM
        WHERE ${whereClause}
    `.trim();
}
