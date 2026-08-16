import * as vscode from 'vscode';
import { logWithFallback } from '../utils/logger';
import { ConnectionManager } from '../core/connectionManager';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import type {
    VisualQueryBuilderData,
    VisualQueryBuilderTable
} from '../contracts/webviews/visualQueryBuilderContracts';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import {
    getForeignKeysForSchema,
    getTablesInSchema,
    RelationshipEdge
} from './erdProvider';

interface SchemaRow extends Record<string, unknown> {
    SCHEMA: string;
}

interface SourceObjectRow extends Record<string, unknown> {
    OBJNAME: string;
    OBJTYPE?: string;
    SCHEMA?: string;
    DATABASE?: string;
}

interface SourceColumnRow extends Record<string, unknown> {
    TABLENAME: string;
    ATTNAME: string;
    FORMAT_TYPE?: string;
    DATA_TYPE?: string;
    SCHEMA?: string;
    SCHEMA_NAME?: string;
    DATABASE?: string;
    IS_PK?: unknown;
    IS_FK?: unknown;
}

type SupportedQueryBuilderKind = 'duckdb' | 'file';

function isInformationSchemaQueryBuilderKind(kind: string | undefined): kind is SupportedQueryBuilderKind {
    return kind === 'duckdb' || kind === 'file';
}

/**
 * File SQL always runs in the connection's private in-memory DuckDB catalog.
 * The database value on a schema-tree item may be a cached/display label, so
 * never use it as a catalog predicate for File SQL metadata queries.
 */
function metadataDatabaseName(kind: string | undefined, database: string): string {
    return kind === 'file' ? '' : database;
}

/**
 * DuckDB catalog names are case-sensitive in the information_schema
 * predicates used by the metadata provider. Keep the catalog value supplied
 * by the connection/tree item for DuckDB and File SQL; Netezza continues to
 * use its historical uppercase display convention.
 */
function displayDatabaseName(kind: string | undefined, database: string): string {
    return isInformationSchemaQueryBuilderKind(kind) ? database : database.toUpperCase();
}

function displaySchemaName(kind: string | undefined, schema: string): string {
    return isInformationSchemaQueryBuilderKind(kind) ? schema : schema.toUpperCase();
}

function normalizeSchemaName(value: unknown, uppercase = true): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? (uppercase ? normalized.toUpperCase() : normalized) : undefined;
}

function valueIsTrue(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'TRUE';
}

function sourceKey(database: string, schema: string, tableName: string): string {
    return `${database}\u0000${schema}\u0000${tableName}`.toLocaleUpperCase();
}

async function runMetadataRows<Row extends Record<string, unknown>>(
    context: vscode.ExtensionContext,
    sql: string,
    connectionManager: ConnectionManager,
    connectionName: string
): Promise<Row[]> {
    const result = await runQueryRaw(
        context,
        sql,
        true,
        connectionManager,
        connectionName,
        undefined,
        undefined,
        undefined,
        1000000,
        false
    );

    return result?.data ? queryResultToRows<Row>(result) : [];
}

async function getInformationSchemaTables(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    schema: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<VisualQueryBuilderTable[]> {
    const kind = connectionManager.getConnectionDatabaseKind?.(connectionName);
    const metadataProvider = getDatabaseMetadataProvider(kind);
    const metadataDatabase = metadataDatabaseName(kind, database);
    const preserveSchemaCase = isInformationSchemaQueryBuilderKind(kind);
    progress?.report({ message: `Fetching ${schema} sources...` });

    const [tableRows, viewRows, columnRows] = await Promise.all([
        runMetadataRows<SourceObjectRow>(
            context,
            metadataProvider.buildListTablesQuery(metadataDatabase, schema),
            connectionManager,
            connectionName
        ),
        runMetadataRows<SourceObjectRow>(
            context,
            metadataProvider.buildListViewsQuery(metadataDatabase, schema),
            connectionManager,
            connectionName
        ),
        runMetadataRows<SourceColumnRow>(
            context,
            metadataProvider.buildColumnsWithKeysQuery(metadataDatabase, { schema, objTypes: ['TABLE', 'VIEW'] }),
            connectionManager,
            connectionName
        )
    ]);

    const tables = new Map<string, VisualQueryBuilderTable>();
    const addSource = (row: SourceObjectRow, defaultObjectType: 'TABLE' | 'VIEW'): void => {
        const tableName = String(row.OBJNAME || '').trim();
        if (!tableName) {
            return;
        }
        const sourceSchema = normalizeSchemaName(row.SCHEMA, !preserveSchemaCase)
            || normalizeSchemaName(schema, !preserveSchemaCase)
            || (preserveSchemaCase ? 'main' : 'MAIN');
        const sourceDatabase = typeof row.DATABASE === 'string' && row.DATABASE.trim()
            ? row.DATABASE.trim()
            : database;
        const objectType = String(row.OBJTYPE || defaultObjectType).toUpperCase() === 'VIEW' ? 'VIEW' : 'TABLE';
        const key = sourceKey(sourceDatabase, sourceSchema, tableName);
        if (!tables.has(key)) {
            tables.set(key, {
                database: sourceDatabase,
                schema: sourceSchema,
                tableName,
                fullName: `${sourceDatabase}.${sourceSchema}.${tableName}`,
                columns: [],
                primaryKeyColumns: [],
                objectType
            });
        }
    };

    tableRows.forEach(row => addSource(row, 'TABLE'));
    viewRows.forEach(row => addSource(row, 'VIEW'));

    for (const row of columnRows) {
        const tableName = String(row.TABLENAME || '').trim();
        const columnName = String(row.ATTNAME || '').trim();
        if (!tableName || !columnName) {
            continue;
        }
        const sourceSchema = normalizeSchemaName(row.SCHEMA_NAME, !preserveSchemaCase)
            || normalizeSchemaName(row.SCHEMA, !preserveSchemaCase)
            || normalizeSchemaName(schema, !preserveSchemaCase)
            || (preserveSchemaCase ? 'main' : 'MAIN');
        const sourceDatabase = typeof row.DATABASE === 'string' && row.DATABASE.trim()
            ? row.DATABASE.trim()
            : database;
        const table = tables.get(sourceKey(sourceDatabase, sourceSchema, tableName));
        if (!table) {
            continue;
        }
        const isPrimaryKey = valueIsTrue(row.IS_PK);
        table.columns.push({
            name: columnName,
            dataType: String(row.FORMAT_TYPE || row.DATA_TYPE || 'UNKNOWN'),
            isPrimaryKey,
            isForeignKey: valueIsTrue(row.IS_FK)
        });
        if (isPrimaryKey) {
            table.primaryKeyColumns.push(columnName);
        }
    }

    return [...tables.values()];
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
    const kind = connectionManager.getConnectionDatabaseKind?.(connectionName);
    if (isInformationSchemaQueryBuilderKind(kind)) {
        const metadataProvider = getDatabaseMetadataProvider(kind);
        const metadataDatabase = metadataDatabaseName(kind, database);
        const schemaRows = await runMetadataRows<SchemaRow>(
            context,
            metadataProvider.buildListSchemasQuery(metadataDatabase),
            connectionManager,
            connectionName
        );
        return Array.from(new Set(schemaRows
            .map(row => normalizeSchemaName(row.SCHEMA, false))
            .filter((schema): schema is string => schema !== undefined)));
    }

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
    const kind = connectionManager.getConnectionDatabaseKind?.(connectionName);
    if (isInformationSchemaQueryBuilderKind(kind)) {
        const tables = await getInformationSchemaTables(
            context,
            connectionManager,
            connectionName,
            database,
            schema,
            progress
        );
        return {
            database: displayDatabaseName(kind, database),
            schema: displaySchemaName(kind, schema),
            tables: tables.sort((left, right) => left.tableName.localeCompare(right.tableName)),
            // DuckDB and File SQL deliberately keep JOIN creation manual. In
            // particular, File SQL views describe imported files/sheets and
            // should not acquire guessed relationships.
            relationships: []
        };
    }

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
 * This enables cross-schema queries for supported connection kinds.
 */
export async function buildVisualQueryBuilderDataForAllSchemas(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    database: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<VisualQueryBuilderData> {
    const allSchemas = await getSchemasForDatabase(context, connectionManager, connectionName, database);
    const kind = connectionManager.getConnectionDatabaseKind?.(connectionName);
    
    if (allSchemas.length === 0) {
        return {
            database: displayDatabaseName(kind, database),
            schema: '',
            tables: [],
            relationships: [],
            allSchemas: []
        };
    }

    // Load tables and relationships from all schemas
    const allTables: VisualQueryBuilderTable[] = [];
    const allRelationships: RelationshipEdge[] = [];

    for (const schema of allSchemas) {
        progress?.report({ message: `Loading schema ${schema}...` });
        
        try {
            if (isInformationSchemaQueryBuilderKind(kind)) {
                const tables = await getInformationSchemaTables(
                    context,
                    connectionManager,
                    connectionName,
                    database,
                    schema
                );
                allTables.push(...tables);
            } else {
                const [tables, relationships] = await Promise.all([
                    getTablesInSchema(context, connectionManager, connectionName, database, schema, undefined),
                    getForeignKeysForSchema(context, connectionManager, connectionName, database, schema)
                ]);
                allTables.push(...tables);
                allRelationships.push(...relationships);
            }
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
        database: displayDatabaseName(kind, database),
        schema: allSchemas[0], // Primary schema for reference
        tables: normalizedTables,
        relationships: allRelationships,
        allSchemas
    };
}
