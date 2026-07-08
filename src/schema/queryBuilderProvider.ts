import * as vscode from 'vscode';
import { logWithFallback } from '../utils/logger';
import { ConnectionManager } from '../core/connectionManager';
import type { VisualQueryBuilderData } from '../contracts/webviews/visualQueryBuilderContracts';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import {
    getForeignKeysForSchema,
    getTablesInSchema,
    RelationshipEdge,
    TableNode
} from './erdProvider';

interface SchemaRow extends Record<string, unknown> {
    SCHEMA: string;
}

function getShortTableName(qualifiedTable: string): string {
    const dotIndex = qualifiedTable.lastIndexOf('.');
    if (dotIndex === -1) {
        return qualifiedTable;
    }
    return qualifiedTable.slice(dotIndex + 1);
}

export async function getSchemasForDatabase(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string
): Promise<string[]> {
    const schemaQuery = `SELECT DISTINCT SCHEMA FROM ${database}.._V_TABLE ORDER BY SCHEMA`;
    const schemaResult = await runQueryRaw(
        context,
        schemaQuery,
        true,
        connectionManager,
        connectionName,
        undefined,
        undefined,
        undefined,
        1000000,
        false
    );

    if (!schemaResult || !schemaResult.data || schemaResult.data.length === 0) {
        return [];
    }

    const schemaRows = queryResultToRows<SchemaRow>(schemaResult);
    const normalizedSchemas = schemaRows
        .map(row => row.SCHEMA)
        .filter((schema): schema is string => typeof schema === 'string' && schema.trim().length > 0)
        .map(schema => schema.trim().toUpperCase());

    return Array.from(new Set(normalizedSchemas));
}

export async function buildVisualQueryBuilderData(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    schema: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<VisualQueryBuilderData> {
    const [tables, relationships] = await Promise.all([
        getTablesInSchema(context, connectionManager, connectionName, database, schema, progress),
        getForeignKeysForSchema(context, connectionManager, connectionName, database, schema)
    ]);

    const fkColumnsByTable = new Map<string, Set<string>>();
    for (const relationship of relationships) {
        const fromTableName = getShortTableName(relationship.fromTable).toUpperCase();
        const tableColumns = fkColumnsByTable.get(fromTableName) || new Set<string>();
        for (const fromColumn of relationship.fromColumns) {
            tableColumns.add(fromColumn.toUpperCase());
        }
        fkColumnsByTable.set(fromTableName, tableColumns);
    }

    const normalizedTables = tables
        .map(table => {
            const fkColumns = fkColumnsByTable.get(table.tableName.toUpperCase());
            return {
                ...table,
                columns: table.columns.map(column => ({
                    ...column,
                    isForeignKey: column.isForeignKey || (fkColumns?.has(column.name.toUpperCase()) ?? false)
                }))
            };
        })
        .sort((left, right) => left.tableName.localeCompare(right.tableName));

    return {
        database: database.toUpperCase(),
        schema: schema.toUpperCase(),
        tables: normalizedTables,
        relationships
    };
}

/**
 * Build Visual Query Builder data for all schemas in a database
 * This enables cross-schema queries in Netezza
 */
export async function buildVisualQueryBuilderDataForAllSchemas(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<VisualQueryBuilderData> {
    const allSchemas = await getSchemasForDatabase(context, connectionManager, connectionName, database);
    
    if (allSchemas.length === 0) {
        return {
            database: database.toUpperCase(),
            schema: '',
            tables: [],
            relationships: [],
            allSchemas: []
        };
    }

    // Load tables and relationships from all schemas
    const allTables: TableNode[] = [];
    const allRelationships: RelationshipEdge[] = [];

    for (const schema of allSchemas) {
        progress?.report({ message: `Loading schema ${schema}...` });
        
        try {
            const [tables, relationships] = await Promise.all([
                getTablesInSchema(context, connectionManager, connectionName, database, schema, undefined),
                getForeignKeysForSchema(context, connectionManager, connectionName, database, schema)
            ]);
            
            allTables.push(...tables);
            allRelationships.push(...relationships);
        } catch (e) {
            logWithFallback('warn', `Failed to load schema ${schema}:`, e);
        }
    }

    // Mark FK columns across all tables
    const fkColumnsByTable = new Map<string, Set<string>>();
    for (const relationship of allRelationships) {
        const fromTableName = getShortTableName(relationship.fromTable).toUpperCase();
        const tableColumns = fkColumnsByTable.get(fromTableName) || new Set<string>();
        for (const fromColumn of relationship.fromColumns) {
            tableColumns.add(fromColumn.toUpperCase());
        }
        fkColumnsByTable.set(fromTableName, tableColumns);
    }

    const normalizedTables = allTables
        .map(table => {
            const fkColumns = fkColumnsByTable.get(table.tableName.toUpperCase());
            return {
                ...table,
                columns: table.columns.map(column => ({
                    ...column,
                    isForeignKey: column.isForeignKey || (fkColumns?.has(column.name.toUpperCase()) ?? false)
                }))
            };
        })
        .sort((left, right) => {
            // Sort by schema first, then by table name
            const schemaCompare = left.schema.localeCompare(right.schema);
            if (schemaCompare !== 0) {
                return schemaCompare;
            }
            return left.tableName.localeCompare(right.tableName);
        });

    return {
        database: database.toUpperCase(),
        schema: allSchemas[0], // Primary schema for reference
        tables: normalizedTables,
        relationships: allRelationships,
        allSchemas
    };
}
