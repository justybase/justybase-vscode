/**
 * ERD (Entity Relationship Diagram) Provider
 * Retrieves foreign key relationships and builds graph data for visualization
 */

import * as vscode from 'vscode';
import { logWithFallback } from '../utils/logger';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { ConnectionManager } from '../core/connectionManager';
import { NZ_QUERIES } from '../metadata/systemQueries';
import type { DatabaseMetadataProvider } from '../contracts/database';

/**
 * Represents a table node in the ERD
 */
export interface TableNode {
    database: string;
    schema: string;
    tableName: string;
    fullName: string;
    columns: ColumnInfo[];
    primaryKeyColumns: string[];
}

/**
 * Column information for a table
 */
export interface ColumnInfo {
    name: string;
    dataType: string;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

/**
 * Represents a relationship (foreign key) edge in the ERD
 */
export interface RelationshipEdge {
    constraintName: string;
    fromTable: string; // schema.table
    toTable: string; // schema.table (referenced table)
    fromColumns: string[];
    toColumns: string[];
    onDelete: string;
    onUpdate: string;
}

/**
 * Complete ERD data structure
 */
export interface ERDData {
    database: string;
    schema: string;
    tables: TableNode[];
    relationships: RelationshipEdge[];
}

/**
 * Get all foreign key relationships for a schema
 */
export async function getForeignKeysForSchema(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    schema: string
): Promise<RelationshipEdge[]> {
    // Use centralized query builder for FK relationships
    const sql = NZ_QUERIES.getForeignKeyRelationships(database, schema);

    const relationships = new Map<string, RelationshipEdge>();

    try {
        const resultRaw = await runQueryRaw(context, sql, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);

        if (!resultRaw || !resultRaw.data) {
            return [];
        }

        const rows = queryResultToRows<{
            CONSTRAINTNAME: string;
            SCHEMA: string;
            FROM_TABLE: string;
            FROM_COLUMN: string;
            PKDATABASE: string;
            PKSCHEMA: string;
            TO_TABLE: string;
            TO_COLUMN: string;
            UPDT_TYPE: string;
            DEL_TYPE: string;
            CONSEQ: number;
        } & { [key: string]: unknown }>(resultRaw);

        for (const row of rows) {
            const constraintName = row.CONSTRAINTNAME;
            const fromTable = `${row.SCHEMA}.${row.FROM_TABLE}`;
            const toTable = `${row.PKSCHEMA}.${row.TO_TABLE}`;

            if (!relationships.has(constraintName)) {
                relationships.set(constraintName, {
                    constraintName,
                    fromTable,
                    toTable,
                    fromColumns: [],
                    toColumns: [],
                    onDelete: row.DEL_TYPE || 'NO ACTION',
                    onUpdate: row.UPDT_TYPE || 'NO ACTION'
                });
            }

            const rel = relationships.get(constraintName)!;
            rel.fromColumns.push(row.FROM_COLUMN);
            rel.toColumns.push(row.TO_COLUMN);
        }
    } catch (e) {
        logWithFallback('warn', 'Cannot retrieve FK relationships:', e);
    }

    return Array.from(relationships.values());
}

/**
 * Get tables involved in relationships (have FK or are referenced by FK)
 */
export async function getTablesInSchema(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    schema: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<TableNode[]> {
    // Get all tables in schema
    progress?.report({ message: 'Fetching tables list...' });
    const tablesSql = `
        SELECT
            T.TABLENAME,
            T.OWNER,
            T.DATABASE
        FROM
            ${database.toUpperCase()}.._V_TABLE T
        WHERE
            T.SCHEMA = '${schema.toUpperCase()}'
        ORDER BY T.TABLENAME
    `;
    // Get columns for all tables
    const columnsSql = `
        SELECT 
            A.NAME AS TABLENAME,
            A.ATTNAME,
            A.FORMAT_TYPE
        FROM 
            ${database.toUpperCase()}.._V_RELATION_COLUMN A
        WHERE 
            A.SCHEMA = '${schema.toUpperCase()}'
            AND A.TYPE = 'TABLE'
        ORDER BY A.NAME, A.ATTNUM
    `;

    // Get primary keys
    const pkSql = `
        SELECT 
            X.RELATION,
            X.ATTNAME
        FROM 
            ${database.toUpperCase()}.._V_RELATION_KEYDATA X
        WHERE 
            X.CONTYPE = 'p'
            AND X.SCHEMA = '${schema.toUpperCase()}'
        ORDER BY X.RELATION, X.CONSEQ
    `;

    const tables = new Map<string, TableNode>();

    try {
        // Get tables
        const tablesResult = await runQueryRaw(context, tablesSql, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);
        if (tablesResult && tablesResult.data) {
            const tablesRows = queryResultToRows<{ TABLENAME: string; OWNER: string; DATABASE?: string } & { [key: string]: unknown }>(tablesResult);
            for (const row of tablesRows) {
                const tableName = row.TABLENAME;
                const actualDatabase = row.DATABASE || database;
                tables.set(tableName, {
                    database: actualDatabase,
                    schema,
                    tableName,
                    fullName: `${actualDatabase}.${schema}.${tableName}`,
                    columns: [],
                    primaryKeyColumns: []
                });
            }
        }

        // Get columns
        progress?.report({ message: 'Fetching columns...' });
        const columnsResult = await runQueryRaw(context, columnsSql, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);
        if (columnsResult && columnsResult.data) {
            const columnsRows = queryResultToRows<{ TABLENAME: string; ATTNAME: string; FORMAT_TYPE: string } & { [key: string]: unknown }>(columnsResult);
            for (const row of columnsRows) {
                const table = tables.get(row.TABLENAME);
                if (table) {
                    table.columns.push({
                        name: row.ATTNAME,
                        dataType: row.FORMAT_TYPE,
                        isPrimaryKey: false,
                        isForeignKey: false
                    });
                }
            }
        }

        // Get primary keys
        progress?.report({ message: 'Fetching primary keys...' });
        const pkResult = await runQueryRaw(context, pkSql, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);
        if (pkResult && pkResult.data) {
            const pkRows = queryResultToRows<{ RELATION: string; ATTNAME: string } & { [key: string]: unknown }>(pkResult);
            for (const row of pkRows) {
                const table = tables.get(row.RELATION);
                if (table) {
                    table.primaryKeyColumns.push(row.ATTNAME);
                    const col = table.columns.find(c => c.name === row.ATTNAME);
                    if (col) {
                        col.isPrimaryKey = true;
                    }
                }
            }
        }
    } catch (e) {
        logWithFallback('warn', 'Cannot retrieve table information:', e);
    }

    return Array.from(tables.values());
}

/**
 * Build complete ERD data for a schema
 */
export async function buildERDData(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    schema: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ERDData> {
    // Get all tables and relationships
    const [tables, relationships] = await Promise.all([
        getTablesInSchema(context, connectionManager, connectionName, database, schema, progress),
        getForeignKeysForSchema(context, connectionManager, connectionName, database, schema)
    ]);

    // Mark FK columns
    for (const rel of relationships) {
        const fromTableName = rel.fromTable.split('.')[1];
        const table = tables.find(t => t.tableName === fromTableName);
        if (table) {
            for (const colName of rel.fromColumns) {
                const col = table.columns.find(c => c.name === colName);
                if (col) {
                    col.isForeignKey = true;
                }
            }
        }
    }

    // Filter to only tables that participate in relationships
    const tablesInRelationships = new Set<string>();
    for (const rel of relationships) {
        tablesInRelationships.add(rel.fromTable.split('.')[1]);
        tablesInRelationships.add(rel.toTable.split('.')[1]);
    }

    const filteredTables = tables.filter(t => tablesInRelationships.has(t.tableName) || tables.length <= 20);

    return {
        database,
        schema,
        tables: filteredTables,
        relationships
    };
}

function isTruthyFlag(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return typeof value === 'string' && /^(1|t|true|y|yes)$/i.test(value.trim());
}

function rowText(row: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = row[key] ?? row[key.toLowerCase()];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
}

/**
 * Builds ERD data from catalog rows returned by a dialect metadata provider
 * (object list, columns with keys and FK pairs). Pure so it can be unit-tested.
 */
export function buildERDDataFromCatalogRows(
    database: string,
    schema: string,
    tableRows: readonly Record<string, unknown>[],
    columnRows: readonly Record<string, unknown>[],
    foreignKeyRows: readonly Record<string, unknown>[],
): ERDData {
    const tables = new Map<string, TableNode>();
    for (const row of tableRows) {
        const tableName = rowText(row, 'OBJNAME', 'TABLENAME', 'TABLE_NAME');
        const rowSchema = rowText(row, 'SCHEMA', 'SCHEMA_NAME');
        if (!tableName || (rowSchema && rowSchema !== schema)) continue;
        tables.set(tableName, { database, schema, tableName, fullName: `${database}.${schema}.${tableName}`, columns: [], primaryKeyColumns: [] });
    }
    for (const row of columnRows) {
        const table = tables.get(rowText(row, 'TABLENAME', 'TABLE_NAME'));
        const rowSchema = rowText(row, 'SCHEMA', 'SCHEMA_NAME');
        const name = rowText(row, 'ATTNAME', 'COLUMN_NAME');
        if (!table || !name || (rowSchema && rowSchema !== schema)) continue;
        const isPrimaryKey = isTruthyFlag(row.IS_PK ?? row.is_pk);
        table.columns.push({ name, dataType: rowText(row, 'FORMAT_TYPE', 'DATA_TYPE'), isPrimaryKey, isForeignKey: false });
        if (isPrimaryKey) table.primaryKeyColumns.push(name);
    }

    const relationships = new Map<string, RelationshipEdge & { ordinals: number[] }>();
    for (const row of foreignKeyRows) {
        const fromSchema = rowText(row, 'FROM_SCHEMA');
        const fromTableName = rowText(row, 'FROM_TABLE');
        if (fromSchema !== schema || !tables.has(fromTableName)) continue;
        const toSchema = rowText(row, 'TO_SCHEMA');
        const toTableName = rowText(row, 'TO_TABLE');
        const constraintName = rowText(row, 'CONSTRAINT_NAME') || `${fromTableName}_${toTableName}_fk`;
        const key = `${fromTableName}|${constraintName}`;
        const edge = relationships.get(key) ?? {
            constraintName,
            fromTable: `${fromSchema}.${fromTableName}`,
            toTable: `${toSchema}.${toTableName}`,
            fromColumns: [],
            toColumns: [],
            onDelete: 'NO ACTION',
            onUpdate: 'NO ACTION',
            ordinals: [],
        };
        edge.fromColumns.push(rowText(row, 'FROM_COLUMN'));
        edge.toColumns.push(rowText(row, 'TO_COLUMN'));
        edge.ordinals.push(Number(row.ORDINAL_POSITION ?? edge.ordinals.length + 1));
        relationships.set(key, edge);
        const fromColumn = tables.get(fromTableName)?.columns.find(column => column.name === rowText(row, 'FROM_COLUMN'));
        if (fromColumn) fromColumn.isForeignKey = true;
    }

    const edges: RelationshipEdge[] = [...relationships.values()].map(({ ordinals, ...edge }) => {
        const order = ordinals.map((ordinal, index) => ({ ordinal, index })).sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.index);
        return { ...edge, fromColumns: order.map(index => edge.fromColumns[index]), toColumns: order.map(index => edge.toColumns[index]) };
    });
    const involved = new Set<string>();
    for (const edge of edges) {
        involved.add(edge.fromTable.split('.').pop()!);
        if (edge.toTable.startsWith(`${schema}.`)) involved.add(edge.toTable.slice(schema.length + 1));
    }
    const allTables = [...tables.values()];
    return {
        database,
        schema,
        tables: allTables.filter(table => involved.has(table.tableName) || allTables.length <= 20),
        relationships: edges,
    };
}

/**
 * ERD for dialects that expose object, column and FK catalogue queries
 * through their metadata provider (PostgreSQL, Oracle, SQL Server, MySQL, Db2).
 */
export async function buildERDDataFromMetadataProvider(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    provider: DatabaseMetadataProvider,
    database: string,
    schema: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<ERDData> {
    const read = async (sql: string | undefined) => {
        if (!sql) return [];
        const result = await runQueryRaw(context, sql, true, connectionManager, connectionName, undefined, undefined, undefined, 1000000, false);
        return result ? queryResultToRows<Record<string, unknown>>(result) : [];
    };
    progress?.report({ message: 'Fetching tables...' });
    const tableRows = await read(provider.buildObjectTypeQuery(database, 'TABLE'));
    progress?.report({ message: 'Fetching columns and keys...' });
    const columnRows = await read(provider.buildColumnsWithKeysQuery(database, { schema, objTypes: ['TABLE'] }));
    progress?.report({ message: 'Fetching foreign keys...' });
    const foreignKeyRows = await read(provider.buildForeignKeyRelationshipsQuery?.(database, { schema }));
    return buildERDDataFromCatalogRows(database, schema, tableRows, columnRows, foreignKeyRows);
}
