/**
 * ERD (Entity Relationship Diagram) Provider
 * Retrieves foreign key relationships and builds graph data for visualization
 */

import * as vscode from 'vscode';
import { logWithFallback } from '../utils/logger';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { ConnectionManager } from '../core/connectionManager';
import { NZ_QUERIES } from '../metadata/systemQueries';

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
