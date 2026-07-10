import type { DatabaseConnection } from '../../contracts/database';
import { netezzaMetadataProvider } from '../../dialects/netezza/metadata/provider';
import { logWithFallback } from '../../utils/logger';
import {
    buildColumnCacheKey,
    groupColumnRowsByTableKey,
    type RawColumnRowWithKeys,
} from '../columnRowMapping';
import type { MetadataCache } from './MetadataCache';

export interface TableColumnWarmupTarget {
    database: string;
    schema: string;
    table: string;
}

export type CatalogRowReader = (sql: string) => Promise<RawColumnRowWithKeys[]>;

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
): Promise<void> {
    const query = netezzaMetadataProvider.buildColumnsWithKeysQuery(target.database, {
        schema: target.schema,
        tableName: target.table,
    });

    try {
        const rows = await readRows(query);
        const columnKey = buildColumnCacheKey(target.database, target.schema, target.table);
        const columns = groupColumnRowsByTableKey(rows, {
            dbName: target.database,
            schemaName: target.schema,
        }).get(columnKey);

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
    return sql => readRowsFromConnection<RawColumnRowWithKeys>(connection, sql);
}
