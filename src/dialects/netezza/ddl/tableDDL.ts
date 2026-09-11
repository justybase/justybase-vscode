/**
 * DDL Generator - Table DDL Generation
 */

import type { ColumnInfo, KeyInfo } from './types';
import { buildNetezzaTableDdl } from '@justybase/designer-core';
import { getColumns, getDistributionInfo, getOrganizeInfo, getKeysInfo, getTableComment } from './metadata';

import type { NzConnection } from '../../../types';

/**
 * Generate complete DDL code for creating a table in Netezza
 */
export async function generateTableDDL(
    connection: NzConnection,
    database: string,
    schema: string,
    tableName: string
): Promise<string> {
    // Get table data
    const columns = await getColumns(connection, database, schema, tableName);
    if (columns.length === 0) {
        throw new Error(`Table ${database}.${schema}.${tableName} not found or has no columns`);
    }

    const distributionColumns = await getDistributionInfo(connection, database, schema, tableName);
    const organizeColumns = await getOrganizeInfo(connection, database, schema, tableName);
    const keysInfo = await getKeysInfo(connection, database, schema, tableName);
    const tableComment = await getTableComment(connection, database, schema, tableName);

    return buildTableDDLFromCache(
        database,
        schema,
        tableName,
        columns,
        distributionColumns,
        organizeColumns,
        keysInfo,
        tableComment
    );
}

/**
 * Build table DDL from pre-fetched cache data (no DB queries)
 */
export function buildTableDDLFromCache(
    database: string,
    schema: string,
    tableName: string,
    columns: ColumnInfo[],
    distributionColumns: string[],
    organizeColumns: string[],
    keysInfo: Map<string, KeyInfo>,
    tableComment: string | null
): string {
    return buildNetezzaTableDdl(
        database,
        schema,
        tableName,
        columns,
        distributionColumns,
        organizeColumns,
        keysInfo,
        tableComment,
    );
}
