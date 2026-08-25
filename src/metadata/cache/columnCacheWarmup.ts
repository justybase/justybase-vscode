import type { DatabaseConnection } from '../../contracts/database';
import type { DatabaseKind } from '../../contracts/database';
import { getDatabaseMetadataProvider } from '../../core/connectionFactory';
import { netezzaMetadataProvider } from '../../dialects/netezza/metadata/provider';
import { logWithFallback } from '../../utils/logger';
import {
    buildColumnCacheKey,
    groupColumnRowsByTableKey,
    type RawColumnRowWithKeys,
} from '../columnRowMapping';
import { loadColumnsWithKeysRows } from '../columnMetadataService';
import { buildNetezzaCacheDatabasePart } from '../helpers';
import type { MetadataCache } from './MetadataCache';

export interface TableColumnWarmupTarget {
    database: string;
    schema?: string;
    table: string;
}

export type CatalogRowReader = (sql: string) => Promise<Record<string, unknown>[]>;

async function readRowsFromConnection<T extends object>(
    connection: DatabaseConnection,
    sql: string,
): Promise<T[]> {
    const command = connection.createCommand(sql);
    const reader = await command.executeReader();
    const rows: T[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index++) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row as T);
        }
    } finally {
        await reader.close();
    }
    return rows;
}

/** Load one table's columns from Netezza catalog into columnCache (tree-ready format). */
export async function warmTableColumnsFromCatalog(
    cache: MetadataCache,
    connectionName: string,
    target: TableColumnWarmupTarget,
    readRows: CatalogRowReader,
    databaseKind?: DatabaseKind,
): Promise<void> {
    const provider = databaseKind
        ? getDatabaseMetadataProvider(databaseKind)
        : netezzaMetadataProvider;
    const isNetezza = databaseKind === 'netezza'
        || (databaseKind === undefined && cache.isNetezzaConnection(connectionName));
    const cacheDatabase = isNetezza
        // DDL synchronization supplies the runtime catalog context. Keep that
        // exact value so a quoted lower-case database does not warm a second,
        // upper-case-only cache layer.
        ? buildNetezzaCacheDatabasePart(target.database)
        : target.database;
    const cacheSchema = isNetezza && target.schema !== undefined
        ? target.schema
        : target.schema;
    const cacheTable = isNetezza
        ? target.table
        : target.table;
    try {
        let rows = await loadColumnsWithKeysRows(
            target.database,
            {
                schema: target.schema,
                tableName: target.table,
            },
            isNetezza ? 'netezza' : databaseKind,
            (sql) => readRows(sql),
        ) as RawColumnRowWithKeys[];
        const columnKey = buildColumnCacheKey(
            cacheDatabase,
            cacheSchema,
            cacheTable,
            isNetezza ? { preserveCase: true } : undefined,
        );
        let columns = groupColumnRowsByTableKey(rows, {
            dbName: target.database,
            schemaName: target.schema,
        }, isNetezza ? { preserveCase: true, exactNetezza: true } : undefined).get(columnKey);

        // Some NPS versions omit EXTERNAL TABLE entries from
        // _V_OBJECT_DATA. The main query intentionally stays lean, so only
        // when it found no target columns do we consult the separate external
        // catalog query. Its aliases match RawColumnRowWithKeys.
        if ((!columns || columns.length === 0)
            && typeof provider.buildExternalTableColumnsQuery === 'function') {
            const externalQuery = provider.buildExternalTableColumnsQuery(
                target.database,
                target.schema ?? '',
                target.table,
            );
            if (externalQuery) {
                rows = await readRows(externalQuery) as RawColumnRowWithKeys[];
                columns = groupColumnRowsByTableKey(rows, {
                    dbName: target.database,
                    schemaName: target.schema,
                }, isNetezza ? { preserveCase: true, exactNetezza: true } : undefined).get(columnKey);
            }
        }

        if (!columns || columns.length === 0) {
            logWithFallback(
                'debug',
                `[columnCacheWarmup] No columns in catalog for ${columnKey}`,
            );
            return;
        }

        cache.setColumns(connectionName, columnKey, columns);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logWithFallback(
            'warn',
            `[columnCacheWarmup] Column warmup skipped for ${target.database}.${target.schema}.${target.table}: ${message}`,
        );
    }
}

export function createConnectionRowReader(
    connection: DatabaseConnection,
): CatalogRowReader {
    return sql => readRowsFromConnection<Record<string, unknown>>(connection, sql);
}
