import * as vscode from 'vscode';
import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import { applyGeneratedIdentifierCase } from '../core/dialectTraits';
import { runQueryRaw } from '../core/queryRunner';
import type { ConnectionManager } from '../core/connectionManager';
import type { TableMetadata } from '../metadata/types';
import { buildIdLookupKey, extractLabel } from '../metadata/helpers';
import { normalizeCompletionDescription } from '../utils/completionDescriptionUtils';
import { formatQualifiedObjectName } from '../utils/identifierUtils';
import { createNetezzaCatalogIdentifier, formatNetezzaIdentifier, isNetezzaQuotedIdentifier } from '../dialects/netezza/metadata/identifierUtils';
import type { MetadataQueryContext } from '../metadata/metadataQueryDiagnostics';

const SCHEMA_QUERY_TIMEOUT = 300 * 1000;

export function clickHouseTableDefinitionFromRow(
    row: Record<string, unknown>,
): TableMetadata['tableDefinition'] | undefined {
    const engine = typeof row.CLICKHOUSE_ENGINE === 'string' ? row.CLICKHOUSE_ENGINE.trim() : '';
    if (!engine) {
        return undefined;
    }

    const definition: NonNullable<TableMetadata['tableDefinition']> = { engine };
    const fields: Array<[keyof NonNullable<TableMetadata['tableDefinition']>, string]> = [
        ['engineClause', 'CLICKHOUSE_ENGINE_FULL'],
        ['partitionBy', 'CLICKHOUSE_PARTITION_BY'],
        ['primaryKey', 'CLICKHOUSE_PRIMARY_KEY'],
        ['orderBy', 'CLICKHOUSE_ORDER_BY'],
        ['sampleBy', 'CLICKHOUSE_SAMPLE_BY'],
        ['ttl', 'CLICKHOUSE_TTL'],
        ['settings', 'CLICKHOUSE_SETTINGS'],
        ['sourceDdl', 'CLICKHOUSE_SOURCE_DDL'],
    ];
    for (const [target, source] of fields) {
        const value = row[source];
        if (typeof value === 'string' && value.trim()) {
            definition[target] = value.trim();
        }
    }
    return definition;
}

const DB2_GLOBAL_TYPE_GROUPS = new Set([
    'SERVER',
    'SERVER OPTION',
    'WRAPPER',
    'WRAPPER OPTION',
    'USER MAPPING',
    'PASSTHRU AUTH',
]);

const DB2_SCHEMA_SCOPED_TYPE_GROUPS = new Set(['TABLE', 'VIEW', 'NICKNAME', 'ALIAS', 'PROCEDURE', 'FUNCTION']);


export class SchemaQueryTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SchemaQueryTimeoutError';
    }
}

export async function runQueryWithTimeout(
    context: vscode.ExtensionContext,
    query: string,
    connectionManager: ConnectionManager,
    connectionName: string | undefined,
    timeoutMs: number = SCHEMA_QUERY_TIMEOUT,
    metadataContext?: MetadataQueryContext,
): Promise<{ columns: { name: string }[]; data: unknown[][] } | undefined> {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    try {
        return await runQueryRaw({
            context,
            query,
            silent: true,
            connectionManager,
            connectionName,
            maxRows: 1000000,
            isUserQuery: false,
            timeoutSeconds,
            metadataContext,
        });
    } catch (error: unknown) {
        if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
            throw new SchemaQueryTimeoutError(
                `Query timed out after ${timeoutMs}ms. Server may be unreachable.`,
            );
        }
        throw error;
    }
}

const FLAT_FILE_DIALECTS = new Set(['sqlite', 'access']);

export function generateAutoTableNameFromDbInfo(
    dbInfo: { CURRENT_CATALOG?: string; CURRENT_SCHEMA?: string } | undefined,
    kind?: string | DatabaseKind,
    dateGenerator: () => Date = () => new Date(),
    randomGenerator: () => number = () => Math.floor(Math.random() * 10000),
): string | null {
    if (!dbInfo) return null;

    const database = dbInfo.CURRENT_CATALOG || 'SYSTEM';
    const schema = dbInfo.CURRENT_SCHEMA || 'ADMIN';

    const now = dateGenerator();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = randomGenerator().toString().padStart(4, '0');
    const generatedTableName = applyGeneratedIdentifierCase(`IMPORT_${dateStr}_${random}`, kind);

    // Flat file dialects (SQLite, Microsoft Access) have no database/schema
    // hierarchy, so qualified three-part targets would be rejected downstream.
    if (kind && FLAT_FILE_DIALECTS.has(tryNormalizeDatabaseKind(kind) ?? '')) {
        return generatedTableName;
    }

    return `${database}.${schema}.${generatedTableName}`;
}

/**
 * Extracts pure function for building object type query - testable
 */
export function buildObjectTypeQuery(dbName: string, objType: string): string {
    return buildObjectTypeQueryForKind(dbName, objType);
}

/**
 * Extracts pure function for building type groups query - testable
 */
export function buildTypeGroupsQuery(dbName: string): string {
    return buildTypeGroupsQueryForKind(dbName);
}

export function buildObjectTypeQueryForKind(dbName: string, objType: string, kind?: string | DatabaseKind): string {
    const metadataDatabase = kind === 'netezza'
        ? formatNetezzaCatalogIdentifier(dbName)
        : dbName;
    return getDatabaseMetadataProvider(kind).buildObjectTypeQuery(metadataDatabase, objType);
}

export function buildTypeGroupsQueryForKind(dbName: string, kind?: string | DatabaseKind): string {
    const metadataDatabase = kind === 'netezza'
        ? formatNetezzaCatalogIdentifier(dbName)
        : dbName;
    return getDatabaseMetadataProvider(kind).buildTypeGroupsQuery(metadataDatabase);
}

export function formatNetezzaCatalogIdentifier(value: string): string {
    if (isNetezzaQuotedIdentifier(value)) {
        return value;
    }
    return formatNetezzaIdentifier(createNetezzaCatalogIdentifier(value));
}

export function buildSchemaTableIdMap(
    dbName: string,
    schemaName: string | undefined,
    tables: readonly TableMetadata[],
): Map<string, number> {
    const idMap = new Map<string, number>();
    for (const table of tables) {
        const label = extractLabel(table) || table.OBJNAME || table.TABLENAME;
        if (!label || typeof table.OBJID !== 'number') {
            continue;
        }
        idMap.set(buildIdLookupKey(dbName, schemaName, label), table.OBJID);
    }
    return idMap;
}

/**
 * Extracts pure function for filtering cached objects by type - testable
 */
export function filterObjectsByType(
    cachedObjects: {
        item: { objType?: string; kind?: number; detail?: string };
        schema?: string;
        objId?: number;
        description?: string;
        owner?: string;
    }[],
    targetType: string,
): {
    item: { objType?: string; kind?: number; detail?: string };
    schema?: string;
    objId?: number;
    description?: string;
    owner?: string;
}[] {
    return cachedObjects.filter((obj) => {
        const item = obj.item;
        // Check objType if available (preferred)
        if (item.objType) {
            return item.objType === targetType;
        }
        // Fallback to strict kind check if objType missing (legacy cache?)
        if (targetType === 'VIEW') return item.kind === 18;
        if (targetType === 'TABLE') return item.kind !== 18 && item.detail !== 'EXTERNAL TABLE';
        if (targetType === 'EXTERNAL TABLE')
            return item.detail === 'EXTERNAL TABLE' || item.detail?.startsWith('EXTERNAL TABLE');
        return false;
    });
}

/**
 * Extracts pure function for building insert text from schema item data - testable
 */
export function buildInsertText(label: string, schema?: string, dbName?: string, kind?: string | DatabaseKind): string {
    return formatQualifiedObjectName(dbName, schema, label, kind);
}

/**
 * Extracts pure function for determining if object type is expandable - testable
 */
export function isExpandableType(objType: string | undefined): boolean {
    const expandableTypes = ['TABLE', 'GLOBAL TEMP TABLE', 'VIEW', 'NICKNAME', 'ALIAS', 'SYNONYM', 'EXTERNAL TABLE', 'SYSTEM VIEW', 'SYSTEM TABLE'];
    return objType ? expandableTypes.includes(objType) : false;
}

export function normalizeInlineTreeMetadata(value: unknown): string {
    const normalized = normalizeCompletionDescription(value);
    return normalized ? normalized.replace(/\s+/g, ' ').trim() : '';
}

export function getTypeGroupInlineDescription(objType: string | undefined, kind?: string | DatabaseKind): string {
    const normalizedType = objType?.trim().toUpperCase();
    if (!normalizedType || kind !== 'db2') {
        return '';
    }

    if (DB2_GLOBAL_TYPE_GROUPS.has(normalizedType)) {
        return 'global federated';
    }

    if (DB2_SCHEMA_SCOPED_TYPE_GROUPS.has(normalizedType)) {
        return 'schema-scoped';
    }

    return '';
}

export function getTypeGroupContextValue(objType: string | undefined, kind?: string | DatabaseKind): string {
    const normalizedType = objType?.trim().toUpperCase() || 'UNKNOWN';
    if (normalizedType === 'DYNAMIC TABLE' && kind === 'snowflake') {
        return 'typeGroup:DYNAMIC TABLE:snowflake';
    }

    return `typeGroup:${normalizedType}`;
}

export function getSchemaObjectContextValue(objType: string | undefined, kind?: string | DatabaseKind): string {
    const normalizedType = objType?.trim().toUpperCase() || 'UNKNOWN';
    if (normalizedType === 'DYNAMIC TABLE' && kind === 'snowflake') {
        return 'netezza:DYNAMIC TABLE:snowflake';
    }

    return `netezza:${normalizedType}`;
}

export function getColumnTypeIndicator(dataType: string | undefined): string {
    if (!dataType) {
        return '';
    }

    const normalizedType = dataType.toUpperCase();
    if (/\b(TIMESTAMP|DATE|TIME|INTERVAL)\b/.test(normalizedType)) {
        return '📅';
    }

    if (
        /\b(BYTEINT|SMALLINT|INTEGER|BIGINT|DECIMAL|NUMERIC|NUMBER|REAL|DOUBLE|FLOAT|MONEY|INT)\b/.test(normalizedType)
    ) {
        return '123';
    }

    if (/\b(CHARACTER|VARCHAR|NVARCHAR|CHAR|NCHAR|TEXT|CLOB|XML|JSON)\b/.test(normalizedType)) {
        return 'txt';
    }

    return '';
}

export function buildInlineTreeDescription(
    contextValue: string,
    schema?: string,
    objectDescription?: unknown,
    dataType?: string,
): string {
    const inlineDescription = normalizeInlineTreeMetadata(objectDescription);

    if (contextValue === 'column') {
        const indicator = getColumnTypeIndicator(dataType);
        if (indicator && inlineDescription) {
            return `${indicator} - ${inlineDescription}`;
        }
        return indicator || inlineDescription;
    }

    if (contextValue.startsWith('typeGroup')) {
        return inlineDescription;
    }

    if (contextValue.startsWith('netezza:')) {
        const schemaDescription = schema ? `(${schema})` : '';
        if (schemaDescription && inlineDescription) {
            return `${schemaDescription} - ${inlineDescription}`;
        }
        return schemaDescription || inlineDescription;
    }

    return schema ? `(${schema})` : '';
}
