/**
 * DDL Generator - Table DDL Generation
 */

import { ColumnInfo, KeyInfo } from './types';
import { quoteNameIfNeeded } from './helpers';
import { getColumns, getDistributionInfo, getOrganizeInfo, getKeysInfo, getTableComment } from './metadata';

import { NzConnection } from '../../../types';

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
    if (columns.length === 0) {
        return `-- Table ${database}.${schema}.${tableName} has no columns or was not found`;
    }

    const cleanDatabase = quoteNameIfNeeded(database);
    const cleanSchema = quoteNameIfNeeded(schema);
    const cleanTableName = quoteNameIfNeeded(tableName);

    const ddlLines: string[] = [];
    ddlLines.push(`CREATE TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName}`);
    ddlLines.push('(');

    // Columns
    const columnDefs: string[] = [];
    for (const column of columns) {
        const cleanColumnName = quoteNameIfNeeded(column.name);
        let colDef = `    ${cleanColumnName} ${column.fullTypeName}`;
        if (column.notNull) colDef += ' NOT NULL';
        if (column.defaultValue !== null) colDef += ` DEFAULT ${column.defaultValue}`;
        columnDefs.push(colDef);
    }
    ddlLines.push(columnDefs.join(',\n'));

    // Distribution
    if (distributionColumns.length > 0) {
        const cleanDistCols = distributionColumns.map(c => quoteNameIfNeeded(c));
        ddlLines.push(`)\nDISTRIBUTE ON (${cleanDistCols.join(', ')})`);
    } else {
        ddlLines.push(')\nDISTRIBUTE ON RANDOM');
    }

    // Organize
    if (organizeColumns.length > 0) {
        const cleanOrgCols = organizeColumns.map(c => quoteNameIfNeeded(c));
        ddlLines.push(`ORGANIZE ON (${cleanOrgCols.join(', ')})`);
    }

    ddlLines.push(';');
    ddlLines.push('');

    // Keys
    for (const [keyName, keyInfo] of keysInfo) {
        const cleanKeyName = quoteNameIfNeeded(keyName);
        const cleanColumns = keyInfo.columns.map(c => quoteNameIfNeeded(c));

        if (keyInfo.typeChar === 'f') {
            const cleanPkCols = keyInfo.pkColumns.filter(c => c).map(c => quoteNameIfNeeded(c));
            if (cleanPkCols.length > 0) {
                ddlLines.push(
                    `ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} ` +
                    `ADD CONSTRAINT ${cleanKeyName} ${keyInfo.type} ` +
                    `(${cleanColumns.join(', ')}) ` +
                    `REFERENCES ${keyInfo.pkDatabase}.${keyInfo.pkSchema}.${keyInfo.pkRelation} ` +
                    `(${cleanPkCols.join(', ')}) ` +
                    `ON DELETE ${keyInfo.deleteType} ON UPDATE ${keyInfo.updateType};`
                );
            }
        } else if (keyInfo.typeChar === 'p' || keyInfo.typeChar === 'u') {
            ddlLines.push(
                `ALTER TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} ` +
                `ADD CONSTRAINT ${cleanKeyName} ${keyInfo.type} ` +
                `(${cleanColumns.join(', ')});`
            );
        }
    }

    // Table comment
    if (tableComment) {
        const cleanComment = tableComment.replace(/'/g, "''");
        ddlLines.push('');
        ddlLines.push(`COMMENT ON TABLE ${cleanDatabase}.${cleanSchema}.${cleanTableName} IS '${cleanComment}';`);
    }

    // Column comments
    for (const column of columns) {
        if (column.description) {
            const cleanColumnName = quoteNameIfNeeded(column.name);
            const cleanDesc = column.description.replace(/'/g, "''");
            ddlLines.push(
                `COMMENT ON COLUMN ${cleanDatabase}.${cleanSchema}.${cleanTableName}.${cleanColumnName} IS '${cleanDesc}';`
            );
        }
    }

    return ddlLines.join('\n');
}
