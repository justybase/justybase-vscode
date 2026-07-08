import * as vscode from 'vscode';
import { ConnectionManager } from '../../../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery,
    getRequiredDatabaseDdlProvider
} from '../../../core/connectionFactory';
import { runQueryRaw } from '../../../core/queryRunner';
import { NzConnection } from '../../../types';
import {
    buildColumnsWithKeysQuery,
    buildCopilotDefaultObjectTypes,
    CanonicalColumnMetadata,
    groupCanonicalColumnsByTable,
    parseColumnsWithKeysResult,
    toCacheColumnMetadata
} from '../../../metadata/columnMetadataService';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../../../utils/sqlUtils';
import { MetadataCache } from '../../../metadataCache';
import { ColumnMetadata } from '../../../metadata/types';
import { CopilotToolRuntime } from './copilotToolRuntime';

type TableStatsMode = 'quick' | 'deep';

interface CopilotSchemaIntrospectionToolsDeps {
    connectionManager: ConnectionManager;
    context: vscode.ExtensionContext;
    metadataCache?: MetadataCache;
    runtime: CopilotToolRuntime;
}

export class CopilotSchemaIntrospectionTools {
    constructor(private readonly deps: CopilotSchemaIntrospectionToolsDeps) { }

    async getTablesFromDatabase(database?: string, schema?: string): Promise<string> {
        // Get current database if not specified
        let db = database;
        if (!db) {
            const activeConn = this.deps.connectionManager.getActiveConnectionName();
            if (activeConn) {
                db = await this.deps.connectionManager.getCurrentDatabase(activeConn) ?? undefined;
            }
        }
        if (!db) {
            return 'No database specified and no active connection';
        }

        // Use cross-database syntax: DB.._V_TABLE
        const dbUpper = db.toUpperCase();
        let sql = `SELECT OWNER, TABLENAME, 'TABLE' as TYPE FROM ${dbUpper}.._V_TABLE WHERE DATABASE = '${dbUpper}' AND TABLENAME NOT LIKE '_t_%'`;

        if (schema) {
            sql += ` AND OWNER = '${schema.toUpperCase()}'`;
        }

        sql += ` ORDER BY TABLENAME LIMIT 200`;
        return this.deps.runtime.runQuerySafe(sql, 'fetch tables');
    }

    async getColumnsForTables(tables: string[], _database?: string): Promise<string> {
        if (tables.length === 0) return '[]';

        const connectionName = this.deps.connectionManager.getActiveConnectionName();
        if (!connectionName) {
            return '[]';
        }

        interface TableIdentifier {
            database: string | null;
            schema: string | null;
            tableName: string;
        }

        const parsedTables: TableIdentifier[] = tables.map(t => {
            const parts = t.split('.');
            if (parts.length === 3) {
                return { database: parts[0].toUpperCase(), schema: parts[1].toUpperCase(), tableName: parts[2].toUpperCase() };
            } else if (parts.length === 2) {
                return { database: null, schema: parts[0].toUpperCase(), tableName: parts[1].toUpperCase() };
            }
            return { database: null, schema: null, tableName: parts[0].toUpperCase() };
        });

        let currentDatabase: string | undefined;
        const tablesWithoutDatabase = parsedTables.filter(t => !t.database);
        if (tablesWithoutDatabase.length > 0) {
            const db = await this.deps.connectionManager.getCurrentDatabase(connectionName);
            currentDatabase = db ?? undefined;
        }

        const cachedResults: Array<{ database: string; schema: string; tableName: string; columns: ColumnMetadata[] }> = [];
        const tablesToQuery: TableIdentifier[] = [];

        if (this.deps.metadataCache) {
            for (const table of parsedTables) {
                const db = table.database || currentDatabase?.toUpperCase();
                if (!db) {
                    tablesToQuery.push(table);
                    continue;
                }

                // Build cache key
                let cacheKey: string;
                let cachedColumns: ColumnMetadata[] | undefined;

                if (table.schema) {
                    // Full key: DB.SCHEMA.TABLE
                    cacheKey = `${db}.${table.schema}.${table.tableName}`;
                    cachedColumns = this.deps.metadataCache.getColumns(connectionName, cacheKey);
                } else {
                    // Try to find columns without schema
                    cachedColumns = this.deps.metadataCache.getColumnsAnySchema(connectionName, db, table.tableName);
                }

                if (cachedColumns && cachedColumns.length > 0) {
                    cachedResults.push({
                        database: db,
                        schema: table.schema || '',
                        tableName: table.tableName,
                        columns: cachedColumns
                    });
                } else {
                    tablesToQuery.push(table);
                }
            }
        } else {
            tablesToQuery.push(...parsedTables);
        }

        if (tablesToQuery.length === 0 && cachedResults.length > 0) {
            return this.formatColumnsResult(cachedResults);
        }

        const targetsToQuery = new Map<string, { database: string; schema?: string; tableName: string }>();
        for (const table of tablesToQuery) {
            const dbName = table.database || currentDatabase?.toUpperCase();
            if (!dbName) {
                continue;
            }

            const schema = table.schema || undefined;
            const key = `${dbName}.${schema || ''}.${table.tableName}`;
            if (!targetsToQuery.has(key)) {
                targetsToQuery.set(key, {
                    database: dbName,
                    schema,
                    tableName: table.tableName
                });
            }
        }

        if (targetsToQuery.size === 0) {
            return cachedResults.length > 0 ? this.formatColumnsResult(cachedResults) : '[]';
        }

        const databaseKind = this.deps.connectionManager.getConnectionDatabaseKind(connectionName);
        const objectTypes = buildCopilotDefaultObjectTypes(databaseKind);
        const fetchedColumns: CanonicalColumnMetadata[] = [];

        await Promise.all(
            Array.from(targetsToQuery.values()).map(async target => {
                const sql = buildColumnsWithKeysQuery(target.database, {
                    schema: target.schema,
                    tableName: target.tableName,
                    objTypes: objectTypes
                }, databaseKind);

                try {
                    const result = await runQueryRaw(
                        this.deps.context,
                        sql,
                        true,
                        this.deps.connectionManager,
                        connectionName,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        false
                    );

                    const parsedColumns = parseColumnsWithKeysResult(result, target.database);
                    for (const column of parsedColumns) {
                        if (column.tableName !== target.tableName.toUpperCase()) {
                            continue;
                        }
                        if (target.schema && column.schema !== target.schema.toUpperCase()) {
                            continue;
                        }
                        fetchedColumns.push(column);
                    }
                } catch {
                    // Keep partial results when a single target lookup fails.
                }
            })
        );

        const fetchedResults = groupCanonicalColumnsByTable(fetchedColumns).map(group => ({
            database: group.database,
            schema: group.schema,
            tableName: group.tableName,
            columns: group.columns.map(toCacheColumnMetadata)
        }));

        if (this.deps.metadataCache) {
            for (const item of fetchedResults) {
                const cacheKey = `${item.database}.${item.schema}.${item.tableName}`;
                this.deps.metadataCache.setColumns(connectionName, cacheKey, item.columns);
            }
        }

        const allResults = [...cachedResults, ...fetchedResults];

        if (allResults.length === 0) {
            return '[]';
        }

        return this.formatColumnsResult(allResults);
    }

    /**
     * Format columns result for output
     */
    private formatColumnsResult(results: Array<{ database: string; schema: string; tableName: string; columns: ColumnMetadata[] }>): string {
        const lines: string[] = ['DATABASE|SCHEMA|TABLE_NAME|COLUMN_NAME|DATA_TYPE|NOT_NULL'];

        for (const item of results) {
            for (const col of item.columns) {
                lines.push(`${item.database}|${item.schema}|${item.tableName}|${col.ATTNAME}|${col.FORMAT_TYPE}|f`);
            }
        }

        return lines.join('\n');
    }


    async getSampleData(table: string, database: string | undefined, sampleSize: number): Promise<string> {
        const sql = `SELECT * FROM ${table} LIMIT ${sampleSize}`;
        return this.deps.runtime.runQuerySafe(sql, 'fetch sample data', database);
    }

    async tableStats(table: string): Promise<string> {
        const sql = `SELECT * FROM _V_TABLE WHERE TABLENAME = '${table.toUpperCase()}'`;
        return this.deps.runtime.runQuerySafe(sql, 'fetch table stats');
    }

    /**
     * Gets table statistics including distribution info and skew analysis.
     * quick mode: catalog estimates only (low-cost)
     * deep mode: exact COUNT(*) + DATASLICE skew scan (higher-cost)
     */
    async getTableStats(tableName: string, database?: string, mode: TableStatsMode = 'quick'): Promise<string> {
        const connectionName = this.deps.connectionManager.getActiveConnectionName();
        if (!connectionName) {
            return 'No active database connection. Please connect to a Netezza database first.';
        }

        try {
            const effectiveMode: TableStatsMode = mode === 'deep' ? 'deep' : 'quick';

            // Parse table name
            const parts = tableName.split('.');
            let db: string | undefined;
            let schema: string | undefined;
            let table: string;

            if (parts.length === 3) {
                [db, schema, table] = parts;
            } else if (parts.length === 2) {
                [schema, table] = parts;
                db = database;
            } else {
                table = parts[0];
                db = database;
            }

            const connectionDetails = await this.deps.connectionManager.getConnection(connectionName);
            if (!connectionDetails) {
                return `Connection "${connectionName}" not found.`;
            }
            const ddlProvider = getRequiredDatabaseDdlProvider(connectionDetails.dbType);

            if (!db) {
                db = await this.deps.connectionManager.getCurrentDatabase(connectionName) || undefined;
            }
            if (!db) {
                return 'Could not determine database. Please specify database name.';
            }

            const connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails);
            if (!connection) {
                return 'Could not establish database connection.';
            }

            try {
                // Find schema if not specified
                if (!schema) {
                    schema = await this.findTableSchema(connection, ddlProvider, db, table);
                }
                if (!schema) {
                    return `Table "${table}" not found in database "${db}".`;
                }

                const fullTableName = `${db}.${schema}.${table}`;
                const lines: string[] = [`## Table Statistics: ${fullTableName}`, `**Mode:** ${effectiveMode}\n`];

                // Get table info from system catalog
                const infoQuery = ddlProvider.buildTableStatsQuery(db, schema, table);
                const infoResult = await executeDatabaseQuery(connection, infoQuery);
                if (infoResult && infoResult.length > 0) {
                    const info = infoResult[0] as Record<string, unknown>;
                    lines.push(`**Distribution Key:** ${info.DIST_KEY || 'RANDOM'}`);
                    lines.push(`**Owner:** ${info.OWNER || 'N/A'}`);
                }

                if (effectiveMode === 'deep') {
                    try {
                        const countQuery = `SELECT COUNT(*) AS ROW_COUNT FROM ${fullTableName}`;
                        const countResult = await executeDatabaseQuery(connection, countQuery);
                        if (countResult && countResult.length > 0) {
                            const count = (countResult[0] as Record<string, unknown>).ROW_COUNT;
                            lines.push(`**Row Count:** ${Number(count).toLocaleString()}`);
                        } else {
                            lines.push('**Row Count:** Unable to retrieve');
                        }
                    } catch {
                        lines.push('**Row Count:** Unable to retrieve');
                    }

                    lines.push('\n### Data Distribution (Skew Check)\n');
                    try {
                        const skewQuery = ddlProvider.buildSkewCheckQuery(fullTableName);
                        const skewResult = await executeDatabaseQuery(connection, skewQuery);
                        if (skewResult && skewResult.length > 0) {
                            const counts = skewResult.map(r => Number((r as Record<string, unknown>).ROW_COUNT));
                            const min = Math.min(...counts);
                            const max = Math.max(...counts);
                            const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
                            const skewRatio = max > 0 ? ((max - min) / max * 100).toFixed(1) : '0';

                            lines.push(`**SPU Count:** ${skewResult.length}`);
                            lines.push(`**Min Rows/SPU:** ${min.toLocaleString()}`);
                            lines.push(`**Max Rows/SPU:** ${max.toLocaleString()}`);
                            lines.push(`**Avg Rows/SPU:** ${Math.round(avg).toLocaleString()}`);
                            lines.push(`**Skew Ratio:** ${skewRatio}%`);

                            if (Number(skewRatio) > 20) {
                                lines.push('\n⚠️ **Warning:** High data skew detected. Consider reviewing distribution key.');
                            } else {
                                lines.push('\n✅ Data distribution looks balanced.');
                            }
                        } else {
                            lines.push('No distribution data available.');
                        }
                    } catch {
                        lines.push('Could not retrieve distribution data.');
                    }
                } else {
                    lines.push('**Row Count:** [quick mode] use deep mode for exact COUNT(*)');
                    lines.push('\n### Data Distribution (Skew Check)\n');
                    try {
                        const storageQuery = `
                            SELECT
                                s.TBL_ROWS,
                                s.ALLOCATED_BYTES,
                                s.USED_BYTES,
                                s.SKEW
                            FROM ${db.toUpperCase()}.._V_TABLE_STORAGE_STAT s
                            JOIN ${db.toUpperCase()}.._V_TABLE t ON s.OBJID = t.OBJID
                            WHERE UPPER(t.SCHEMA) = ${escapeSqlLiteral(schema.toUpperCase())}
                                AND UPPER(t.TABLENAME) = ${escapeSqlLiteral(table.toUpperCase())}
                            LIMIT 1
                        `;
                        const storageResult = await executeDatabaseQuery(connection, storageQuery);
                        if (storageResult && storageResult.length > 0) {
                            const storage = storageResult[0] as Record<string, unknown>;
                            const estimatedRows = Number(storage.TBL_ROWS);
                            const allocatedBytes = Number(storage.ALLOCATED_BYTES);
                            const usedBytes = Number(storage.USED_BYTES);
                            const skewRatio = Number(storage.SKEW);

                            if (!Number.isNaN(estimatedRows)) {
                                lines.push(`**Estimated Row Count:** ${estimatedRows.toLocaleString()}`);
                            }
                            if (!Number.isNaN(allocatedBytes)) {
                                lines.push(`**Allocated Size:** ${(allocatedBytes / (1024 * 1024)).toFixed(2)} MB`);
                            }
                            if (!Number.isNaN(usedBytes)) {
                                lines.push(`**Used Size:** ${(usedBytes / (1024 * 1024)).toFixed(2)} MB`);
                            }
                            if (!Number.isNaN(skewRatio)) {
                                lines.push(`**Skew Ratio:** ${skewRatio.toFixed(1)}%`);
                                if (skewRatio > 20) {
                                    lines.push('\n⚠️ **Warning:** High data skew detected (catalog estimate).');
                                } else {
                                    lines.push('\n✅ Data distribution looks balanced (catalog estimate).');
                                }
                            } else {
                                lines.push('No distribution data available.');
                            }
                        } else {
                            lines.push('No distribution data available.');
                        }
                    } catch {
                        lines.push('Could not retrieve distribution data.');
                    }
                }

                return lines.join('\n');
            } finally {
                await connection.close();
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Error getting table statistics: ${msg}`;
        }
    }

    private async findTableSchema(
        connection: NzConnection,
        ddlProvider: ReturnType<typeof getRequiredDatabaseDdlProvider>,
        database: string,
        tableName: string
    ): Promise<string | undefined> {
        try {
            const sql = ddlProvider.buildFindTableSchemaQuery(database, tableName.replace(/'/g, "''"));
            interface SchemaRow { SCHEMA: string }
            const result = await executeDatabaseQuery<SchemaRow>(connection, sql);
            if (result && result.length > 0) {
                return result[0].SCHEMA;
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    async findTableLocations(tableName: string): Promise<string> {
        try {
            const parts = tableName.toUpperCase().split('.');
            let targetTable: string;
            let targetSchema: string = 'ADMIN';
            let targetDatabase: string | null = null;

            // Parse the input
            if (parts.length === 1) {
                targetTable = parts[0];
                // Use ADMIN as default schema
            } else if (parts.length === 2) {
                // Could be SCHEMA.TABLE or DATABASE.TABLE (empty schema)
                if (parts[0] === '') {
                    // DATABASE..TABLE format (empty schema means ADMIN)
                    targetDatabase = 'N/A'; // marker that user intended ADMIN
                    targetTable = parts[1];
                } else {
                    // SCHEMA.TABLE format
                    targetSchema = parts[0];
                    targetTable = parts[1];
                }
            } else if (parts.length === 3) {
                // DATABASE.SCHEMA.TABLE format
                targetDatabase = parts[0];
                targetSchema = parts[1];
                targetTable = parts[2];
            } else {
                throw new Error('Invalid table name format. Use: TABLENAME or SCHEMA.TABLENAME or DATABASE.SCHEMA.TABLENAME or DATABASE..TABLENAME');
            }

            const results: string[] = [];
            results.push(`## Table Location Search: **${tableName}**\n`);

            // If specific database was provided, search only there
            if (targetDatabase && targetDatabase !== 'N/A') {
                const sql = `
                    SELECT 
                        '${targetDatabase}' as DATABASE,
                        D.SCHEMA,
                        D.OBJNAME as TABLE_NAME
                    FROM ${escapeSqlIdentifier(targetDatabase)}.._V_OBJECT_DATA D
                    WHERE D.OBJTYPE = 'TABLE'
                        AND D.OBJNAME = '${targetTable}'
                        AND D.SCHEMA = '${targetSchema}'
                `;
                try {
                    const result = await this.deps.runtime.runQuerySafe(sql, 'fetch table location');
                    if (result && result.includes(targetTable)) {
                        results.push(`✅ Found: **${targetDatabase}..${targetSchema}.${targetTable}**`);
                    } else {
                        results.push(`❌ Table **${targetTable}** not found in ${targetDatabase}..${targetSchema}.`);
                    }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    results.push(`⚠️ Error searching ${targetDatabase}: ${msg}`);
                }
                return results.join('\n');
            }

            // Search across all databases
            results.push('### Searching across all databases...\n');

            const dbSql = `SELECT DATABASE FROM _V_DATABASE ORDER BY DATABASE`;
            try {
                const dbResult = await this.deps.runtime.runQuerySafe(dbSql, 'fetch databases');
                const dbLines = dbResult.split('\n').filter(line => line.trim().length > 0);

                if (dbLines.length === 0) {
                    results.push('No databases found.');
                    return results.join('\n');
                }

                const foundLocations: Array<{ database: string; schema: string; table: string }> = [];

                // Parse database list and search each one
                for (const dbLine of dbLines) {
                    // Skip header rows like "DATABASE" or formatting
                    if (dbLine.includes('DATABASE') || dbLine.includes('-')) continue;

                    const db = dbLine.trim();
                    if (db.length === 0) continue;

                    try {
                        const searchSql = `
                            SELECT 
                                '${db}' as DATABASE,
                                D.SCHEMA,
                                D.OBJNAME as TABLE_NAME
                            FROM ${escapeSqlIdentifier(db)}.._V_OBJECT_DATA D
                            WHERE D.OBJTYPE = 'TABLE'
                                AND D.OBJNAME = '${targetTable}'
                                AND D.SCHEMA = '${targetSchema}'
                        `;
                        const locResult = await this.deps.runtime.runQuerySafe(searchSql, `fetch table location in ${db}`);

                        if (locResult && locResult.includes(targetTable)) {
                            foundLocations.push({
                                database: db,
                                schema: targetSchema,
                                table: targetTable
                            });
                        }
                    } catch {
                        // Continue searching other databases if query fails
                    }
                }

                if (foundLocations.length === 0) {
                    results.push(`❌ Table **${targetTable}** not found in any database with schema **${targetSchema}**.`);
                    results.push(`\n**Tip:** If you know a different schema, try: SCHEMA.${targetTable}`);
                } else {
                    results.push(`✅ Found **${foundLocations.length}** location(s):\n`);
                    for (const loc of foundLocations) {
                        results.push(`- \`${loc.database}..${loc.schema}.${loc.table}\``);
                    }
                    results.push('\n**You can reference this table as:**');
                    if (foundLocations.length === 1) {
                        const loc = foundLocations[0];
                        results.push(`- \`${loc.database}..${loc.schema}.${loc.table}\` (full qualified)`);
                        results.push(`- \`${loc.schema}.${loc.table}\` (if in same database)`);
                        results.push(`- \`${loc.table}\` (if schema is ADMIN and it's in your current database)`);
                    } else {
                        results.push(`- Use full qualified name: \`DATABASE..SCHEMA.TABLENAME\``);
                        results.push(`- Or \`SCHEMA.TABLENAME\` if in the same database`);
                    }
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`Error searching databases: ${msg}`);
            }

            return results.join('\n');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to find table locations: ${msg}`, { cause: e });
        }
    }

    async searchSchema(pattern: string, searchType: string, database?: string): Promise<string> {
        const like = pattern.toUpperCase();
        const normalizedType = (searchType || 'ALL').toUpperCase();

        // Get database - use provided or get from active connection
        let db = database;
        if (!db) {
            const connectionName = this.deps.connectionManager.getActiveConnectionName();
            if (connectionName) {
                db = await this.deps.connectionManager.getCurrentDatabase(connectionName) || undefined;
            }
        }

        // Use cross-database syntax if database is specified
        const dbPrefix = db ? `${escapeSqlIdentifier(db)}..` : '';
        let sql: string;

        if (normalizedType === 'COLUMNS') {
            sql = `
                SELECT D.OBJNAME as TABLE_NAME, X.ATTNAME as COLUMN_NAME 
                FROM ${dbPrefix}_V_RELATION_COLUMN X
                INNER JOIN ${dbPrefix}_V_OBJECT_DATA D ON X.OBJID = D.OBJID
                WHERE X.ATTNAME LIKE '%${like}%' 
                LIMIT 100
            `;
        } else if (normalizedType === 'TABLES' || normalizedType === 'TABLE') {
            sql = `SELECT TABLENAME, OWNER FROM ${dbPrefix}_V_TABLE WHERE TABLENAME LIKE '%${like}%' LIMIT 100`;
        } else if (['VIEW', 'PROCEDURE', 'FUNCTION', 'AGGREGATE', 'SYNONYM', 'EXTERNAL TABLE'].includes(normalizedType)) {
            sql = `
                SELECT OBJNAME AS OBJECT_NAME, OBJTYPE AS TYPE, SCHEMA AS OWNER
                FROM ${dbPrefix}_V_OBJECT_DATA
                WHERE OBJTYPE = '${normalizedType}' AND OBJNAME LIKE '%${like}%'
                LIMIT 100
            `;
        } else {
            // Search both (UNION)
            sql = `
                SELECT TABLENAME AS OBJECT_NAME, 'TABLE' AS TYPE FROM ${dbPrefix}_V_TABLE WHERE TABLENAME LIKE '%${like}%'
                UNION ALL
                SELECT VIEWNAME AS OBJECT_NAME, 'VIEW' AS TYPE FROM ${dbPrefix}_V_VIEW WHERE VIEWNAME LIKE '%${like}%'
                UNION ALL
                SELECT PROCEDURE AS OBJECT_NAME, 'PROCEDURE' AS TYPE FROM ${dbPrefix}_V_PROCEDURE WHERE PROCEDURE LIKE '%${like}%'
                LIMIT 100
             `;
        }
        return this.deps.runtime.runQuerySafe(sql, 'search schema');
    }

    /**
     * Gets comments (DESCRIPTION) for a table and optionally its columns
     * Supports various table name formats:
     * - TABLENAME (searches all schemas in current database)
     * - SCHEMA.TABLENAME (specific schema)
     * - DATABASE..TABLENAME (Netezza-style, ADMIN schema)
     * - DATABASE.SCHEMA.TABLENAME (fully qualified)
     */
    async getComments(
        tableName: string,
        database?: string,
        schema?: string,
        includeColumns: boolean = true
    ): Promise<string> {
        try {
            // Parse table name
            const parts = tableName.toUpperCase().split('.');
            let db: string | undefined = database;
            let schemaName: string | undefined = schema;
            let table: string;

            if (parts.length === 1) {
                table = parts[0];
                // Don't default to ADMIN - search all schemas if not specified
            } else if (parts.length === 2) {
                if (parts[0] === '') {
                    // DATABASE..TABLE format
                    db = database;
                    schemaName = 'ADMIN';
                    table = parts[1];
                } else {
                    // SCHEMA.TABLE format
                    schemaName = parts[0];
                    table = parts[1];
                }
            } else if (parts.length === 3) {
                db = parts[0];
                schemaName = parts[1];
                table = parts[2];
            } else {
                throw new Error('Invalid table name format');
            }

            const results: string[] = [];
            results.push(`## Comments for Table: **${tableName}**\n`);

            // Get database if not specified
            if (!db) {
                const activeConn = this.deps.connectionManager.getActiveConnectionName();
                if (activeConn) {
                    db = await this.deps.connectionManager.getCurrentDatabase(activeConn) || undefined;
                }
            }

            if (!db) {
                throw new Error('Could not determine database. Please specify database or connect to one.');
            }

            // Get table comment
            const schemaCondition = schemaName ? `AND SCHEMA = '${schemaName}'` : '';
            const tableCommentSql = `
                SELECT DESCRIPTION
                FROM ${escapeSqlIdentifier(db)}.._V_OBJECT_DATA
                WHERE OBJTYPE = 'TABLE'
                    AND OBJNAME = '${table}'
                    ${schemaCondition}
            `;

            try {
                const tableCommentResult = await this.deps.runtime.runQuerySafe(tableCommentSql, 'fetch table comment');
                let description: string | undefined;

                // Handle JSON format
                const trimmed = tableCommentResult?.trim() || '';
                if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        const rows = Array.isArray(parsed) ? parsed : [parsed];
                        if (rows.length > 0 && rows[0].DESCRIPTION) {
                            description = rows[0].DESCRIPTION;
                        }
                    } catch {
                        // Fall through to pipe-delimited parsing
                    }
                }

                // Fall back to pipe-delimited format
                if (!description) {
                    const lines = tableCommentResult.split('\n').filter(l => l.trim().length > 0);
                    const descLine = lines.find(l => !l.includes('DESCRIPTION') && !l.includes('---'));
                    if (descLine) {
                        description = descLine.trim();
                    }
                }

                if (description && description.length > 0) {
                    results.push(`### Table Comment\n`);
                    const fullName = schemaName ? `${db}..${schemaName}.${table}` : `${db}..${table}`;
                    results.push(`**${fullName}**`);
                    results.push(`> ${description}\n`);
                } else {
                    results.push('*No comment set for this table.*\n');
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`⚠️ Error fetching table comment: ${msg}\n`);
            }

            // Get column comments if requested
            if (includeColumns) {
                results.push(`### Column Comments\n`);

                const columnCommentSql = `
                    SELECT 
                        X.ATTNAME as COLUMN_NAME,
                        X.DESCRIPTION as COMMENT
                    FROM ${escapeSqlIdentifier(db)}.._V_RELATION_COLUMN X
                    INNER JOIN ${escapeSqlIdentifier(db)}.._V_OBJECT_DATA D ON X.OBJID = D.OBJID
                    WHERE D.OBJTYPE = 'TABLE'
                        AND D.OBJNAME = '${table}'
                        ${schemaCondition}
                        AND X.DESCRIPTION IS NOT NULL
                    ORDER BY X.ATTNUM
                `;

                try {
                    const columnCommentResult = await this.deps.runtime.runQuerySafe(columnCommentSql, 'fetch column comments');
                    let columnComments: Array<{ columnName: string; comment: string }> = [];

                    // Handle JSON format
                    const trimmed = columnCommentResult?.trim() || '';
                    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(trimmed);
                            const rows = Array.isArray(parsed) ? parsed : [parsed];
                            columnComments = rows
                                .filter(row => row.COLUMN_NAME || row.column_name)
                                .map(row => ({
                                    columnName: row.COLUMN_NAME || row.column_name || '',
                                    comment: row.COMMENT || row.comment || ''
                                }));
                        } catch {
                            // Fall through to pipe-delimited parsing
                        }
                    }

                    // Fall back to pipe-delimited format
                    if (columnComments.length === 0) {
                        const lines = columnCommentResult.split('\n').filter(l => l.trim().length > 0);

                        // Skip header rows
                        const dataLines = lines.filter(l =>
                            !l.includes('COLUMN_NAME') &&
                            !l.includes('---') &&
                            l.trim().length > 0
                        );

                        for (const line of dataLines) {
                            const parts = line.split('|').map(p => p.trim()).filter(p => p.length > 0);
                            if (parts.length >= 2) {
                                columnComments.push({
                                    columnName: parts[0],
                                    comment: parts[1]
                                });
                            }
                        }
                    }

                    if (columnComments.length > 0) {
                        results.push('| Column | Comment |');
                        results.push('|--------|---------|');
                        for (const cc of columnComments) {
                            results.push(`| ${cc.columnName} | ${cc.comment} |`);
                        }
                    } else {
                        results.push('*No column comments found.*');
                    }
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    results.push(`⚠️ Error fetching column comments: ${msg}`);
                }
            }

            return results.join('\n');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to get comments: ${msg}`, { cause: e });
        }
    }

    /**
     * Gets DDL for a database object (table, view, procedure, external table, synonym)
     * Uses the existing generateDDL function from ddlGenerator
     */
    async getDDL(params: {
        objectName: string;
        objectType: string;
        database?: string;
        schema?: string;
    }): Promise<string> {
        const connectionName = this.deps.connectionManager.getActiveConnectionName();
        if (!connectionName) {
            return 'No active database connection. Please connect to a Netezza database first.';
        }

        try {
            const connectionDetails = await this.deps.connectionManager.getConnection(connectionName);
            if (!connectionDetails) {
                return `Connection "${connectionName}" not found.`;
            }

            const normalizedObjectType = (params.objectType || 'table').toLowerCase();

            // Parse object name to extract database, schema, and object name
            // Supports formats:
            // - TABLENAME (current database, ADMIN schema)
            // - SCHEMA.TABLENAME (current database)
            // - DATABASE..TABLENAME (Netezza-style, search across all schemas)
            // - DATABASE.SCHEMA.TABLENAME (fully qualified)
            const parts = params.objectName.toUpperCase().split('.');
            let db: string | undefined = params.database;
            let schemaName: string | undefined = params.schema;
            let objectName: string;
            let searchAllSchemas = false;

            if (parts.length === 1) {
                // TABLENAME
                objectName = parts[0];
            } else if (parts.length === 2) {
                // SCHEMA.TABLENAME
                schemaName = parts[0];
                objectName = parts[1];
            } else if (parts.length === 3) {
                if (parts[1] === '') {
                    // DATABASE..TABLENAME format (Netezza-style)
                    // Search for table in any schema
                    db = parts[0];
                    objectName = parts[2];
                    searchAllSchemas = true;
                } else {
                    // DATABASE.SCHEMA.TABLENAME format
                    db = parts[0];
                    schemaName = parts[1];
                    objectName = parts[2];
                }
            } else {
                throw new Error('Invalid object name format. Use: TABLENAME, SCHEMA.TABLENAME, DATABASE..TABLENAME, or DATABASE.SCHEMA.TABLENAME');
            }

            // Get database if not specified
            if (!db) {
                db = await this.deps.connectionManager.getCurrentDatabase(connectionName) || undefined;
            }
            if (!db) {
                throw new Error('Could not determine database. Please specify database or connect to one.');
            }

            // If searchAllSchemas is true (DATABASE..TABLENAME format), find the schema first
            if (searchAllSchemas) {
                const safeDb = escapeSqlIdentifier(db);
                const safeObjectName = escapeSqlLiteral(objectName);
                const schemaSearchQueries: Array<{ sql: string; description: string }> = [];

                if (normalizedObjectType === 'view') {
                    schemaSearchQueries.push({
                        sql: `SELECT OWNER FROM ${safeDb}.._V_VIEW WHERE VIEWNAME = ${safeObjectName} LIMIT 1`,
                        description: 'find view schema'
                    });
                } else if (normalizedObjectType === 'procedure') {
                    schemaSearchQueries.push({
                        sql: `SELECT SCHEMA FROM ${safeDb}.._V_PROCEDURE WHERE PROCEDURE = ${safeObjectName} LIMIT 1`,
                        description: 'find procedure schema'
                    });
                } else {
                    schemaSearchQueries.push(
                        {
                            sql: `SELECT OWNER FROM ${safeDb}.._V_TABLE WHERE TABLENAME = ${safeObjectName} LIMIT 1`,
                            description: 'find table schema'
                        },
                        {
                            sql: `SELECT OWNER FROM ${safeDb}.._V_VIEW WHERE VIEWNAME = ${safeObjectName} LIMIT 1`,
                            description: 'find view schema'
                        },
                        {
                            sql: `SELECT SCHEMA FROM ${safeDb}.._V_PROCEDURE WHERE PROCEDURE = ${safeObjectName} LIMIT 1`,
                            description: 'find procedure schema'
                        }
                    );
                }

                for (const schemaQuery of schemaSearchQueries) {
                    try {
                        const schemaResult = await this.deps.runtime.runQuerySafe(schemaQuery.sql, schemaQuery.description);
                        const resolvedSchema = this.deps.runtime.extractSingleColumnValue(schemaResult);
                        if (resolvedSchema) {
                            schemaName = resolvedSchema;
                            break;
                        }
                    } catch {
                        // Try next metadata source and fall back to ADMIN when none resolve.
                    }
                }
                if (!schemaName) {
                    schemaName = 'ADMIN';
                }
            }

            // Default schema to ADMIN if not specified
            if (!schemaName) {
                schemaName = 'ADMIN';
            }

            // Import and use the existing generateDDL function
            const { generateDDL } = await import('../../../ddlGenerator');

            const result = await generateDDL(
                connectionDetails,
                db,
                schemaName,
                objectName,
                normalizedObjectType
            );

            if (result.success) {
                const header = `## DDL for ${normalizedObjectType.toUpperCase()}: ${db}.${schemaName}.${objectName}\n\n`;
                return header + '```sql\n' + result.ddlCode + '\n```';
            } else {
                return `Failed to generate DDL: ${result.error}`;
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return `Error generating DDL: ${msg}`;
        }
    }
}
