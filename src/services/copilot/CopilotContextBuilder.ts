import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery,
    getDatabaseMetadataProvider,
    getRequiredDatabaseDdlProvider
} from '../../core/connectionFactory';
import { extractVariables } from '../../core/variableUtils';
import { NzConnection } from '../../types';
import { TableReferenceExtractor } from './TableReferenceExtractor';
import { DDLCacheManager } from './DDLCacheManager';
import { CopilotContext, TableReference } from './types';
import { CopilotTableProfilesContextService } from './CopilotTableProfilesContextService';
import { QueryHistoryManager } from '../../core/queryHistoryManager';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import { loadColumnsWithKeysRows } from '../../metadata/columnMetadataService';

export class CopilotContextBuilder {
    constructor(
        private connectionManager: ConnectionManager,
        private tableExtractor: TableReferenceExtractor,
        private ddlCacheManager: DDLCacheManager,
        private tableProfilesContextService?: CopilotTableProfilesContextService,
        private extensionContext?: vscode.ExtensionContext
    ) { }

    public async gatherContext(): Promise<CopilotContext> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('No active editor');
        }

        const document = editor.document;
        const selection = editor.selection;
        const selectedSql = selection.isEmpty
            ? document.getText()
            : document.getText(new vscode.Range(selection.start, selection.end));

        if (!selectedSql.trim()) {
            throw new Error('No SQL selected or document is empty');
        }

        const variables = extractVariables(selectedSql);
        const variablesStr = variables.size > 0
            ? `Variables: ${Array.from(variables).join(', ')}`
            : 'No variables detected';

        const connectionName = this.connectionManager.getDocumentConnection(document.uri.toString())
            || this.connectionManager.getActiveConnectionName()
            || undefined;

        const connectionInfo = connectionName
            ? `Connected to: ${connectionName}`
            : 'No connection selected';

        const tableRefs = this.tableExtractor.extract(selectedSql);
        const ddlContext = await this.gatherTablesDDL(tableRefs, connectionName);
        const formattedDdl = this.formatDdlForPrompt(ddlContext);
        const recentQueries = await this.getRecentQueriesSummary();
        const workspaceTableProfilesContext = await this.gatherWorkspaceProfilesContext(connectionName);

        return {
            selectedSql,
            ddlContext: formattedDdl,
            variables: variablesStr,
            recentQueries,
            connectionInfo,
            workspaceTableProfilesContext
        };
    }

    public async getSchemaForSql(sql: string): Promise<string> {
        // Extract references
        const tableRefs = this.tableExtractor.extract(sql);
        if (tableRefs.length === 0) {
            return 'No tables found in SQL.';
        }

        const connectionName = this.connectionManager.getActiveConnectionName();
        if (!connectionName) return 'No active connection.';

        // Gather DDL
        const ddlEntries = await this.gatherTablesDDL(tableRefs, connectionName);

        return ddlEntries;
    }

    private async gatherTablesDDL(
        tableRefs: TableReference[],
        connectionName: string | undefined
    ): Promise<string> {
        if (tableRefs.length === 0) {
            return 'No table references detected in SQL';
        }

        if (!connectionName) {
            const tableNames = tableRefs
                .map(t => {
                    const parts = [t.database, t.schema, t.name].filter(Boolean);
                    return parts.join('.');
                })
                .join(', ');
            return `Could not gather DDL - no connection selected.\nFound table references: ${tableNames}`;
        }

        const connectionDetails = await this.connectionManager.getConnection(connectionName);
        if (!connectionDetails) {
            return `Connection "${connectionName}" not found`;
        }
        const ddlProvider = getRequiredDatabaseDdlProvider(connectionDetails.dbType);

        let nzConnection: NzConnection | undefined;
        try {
            nzConnection = await createConnectedDatabaseConnectionFromDetails(connectionDetails) as NzConnection;
        } catch (e) {
            return `Failed to create connection: ${e instanceof Error ? e.message : String(e)}`;
        }

        const maxTablesForDDL = getExtensionConfiguration('ddl').get<number>('maxTablesForContext', 10) ?? 10;
        const ddlLines: string[] = [];
        const tablesToProcess = tableRefs.slice(0, maxTablesForDDL);

        if (tableRefs.length > maxTablesForDDL) {
            ddlLines.push(`-- NOTE: Showing DDL for ${maxTablesForDDL} out of ${tableRefs.length} tables (limit reached)`);
            ddlLines.push('-- To see more tables, reduce the number of table references in your query');
            ddlLines.push('');
        }

        try {
            for (const tableRef of tablesToProcess) {
                try {
                    let database = tableRef.database;
                    if (!database) {
                        database = await this.connectionManager.getCurrentDatabase(connectionName) || undefined;
                    }
                    if (!database) {
                        ddlLines.push(`-- Table: ${tableRef.name} (cannot determine database)`);
                        ddlLines.push('');
                        continue;
                    }

                    let schema = tableRef.schema;
                    if (!schema) {
                        schema = await this.findTableSchema(nzConnection, ddlProvider, database, tableRef.name);
                    }

                    if (!schema) {
                        ddlLines.push(`-- Table: ${database}..${tableRef.name} (table not found in database)`);
                        ddlLines.push('');
                        continue;
                    }

                    const tableName = tableRef.name;
                    const displayName = `${database}.${schema}.${tableName}`;
                    const cacheKey = `${connectionName}|${database}|${schema}|${tableName}`;

                    const ddl = await this.ddlCacheManager.getCachedDDL(cacheKey, async () => {
                        return await ddlProvider.generateTableDDL(nzConnection!, database!, schema!, tableName);
                    });

                    if (ddl && !ddl.toLowerCase().includes('not found')) {
                        ddlLines.push(`-- Table: ${displayName}`);
                        ddlLines.push(ddl);
                        ddlLines.push('');
                    } else {
                        ddlLines.push(`-- Table: ${displayName} (DDL not found)`);
                        ddlLines.push('');
                    }
                } catch (e) {
                    const displayName = `${tableRef.database || ''}.${tableRef.schema || ''}.${tableRef.name}`.replace(/^\.+/, '');
                    // console.warn(`[CopilotContextBuilder] Could not get DDL for ${displayName}:`, e);
                    ddlLines.push(`-- Table: ${displayName} (error retrieving DDL: ${e instanceof Error ? e.message : String(e)})`);
                    ddlLines.push('');
                }
            }
        } catch (e) {
            console.error('[CopilotContextBuilder] Error gathering DDL:', e);
            ddlLines.push(`-- Error gathering DDL: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            if (nzConnection) {
                try {
                    await nzConnection.close();
                } catch {
                    // Silent catch for connection close errors
                }
            }
        }

        return ddlLines.length > 0
            ? ddlLines.join('\n')
            : `Could not retrieve DDL for tables: ${tableRefs.map(t => t.name).join(', ')}`;
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

    private formatDdlForPrompt(ddlContext: string): string {
        const hasValidDdl = ddlContext.includes('CREATE TABLE') ||
            (ddlContext.includes('-- Table:') && !ddlContext.includes('error retrieving') && !ddlContext.includes('not found'));

        if (hasValidDdl) {
            return '```sql\n' + ddlContext + '\n```';
        } else {
            // Return error message without code block
            if (ddlContext.includes('not found')) {
                return 'Table not found';
            }
            if (ddlContext.includes('error retrieving DDL')) {
                return 'Error gathering DDL';
            }
            return ddlContext;
        }
    }

    private async getRecentQueriesSummary(): Promise<string> {
        if (!this.extensionContext) {
            return 'Recent query history unavailable in this context';
        }

        try {
            const historyManager = QueryHistoryManager.getInstance(this.extensionContext);
            const recentEntries = await historyManager.getHistory(5);

            if (recentEntries.length === 0) {
                return 'No recent query history.';
            }

            const maxQueryLength = 180;
            const lines = ['Recent queries (latest first):'];

            for (const entry of recentEntries) {
                const normalizedQuery = entry.query.replace(/\s+/g, ' ').trim();
                const compactQuery = normalizedQuery.length > maxQueryLength
                    ? `${normalizedQuery.substring(0, maxQueryLength - 3)}...`
                    : normalizedQuery;
                const scope = [entry.database, entry.schema].filter(Boolean).join('.');
                lines.push(`- [${scope || 'N/A'}] ${compactQuery}`);
            }

            const summary = lines.join('\n');
            const maxSummaryLength = 1500;
            return summary.length > maxSummaryLength ? `${summary.substring(0, maxSummaryLength - 3)}...` : summary;
        } catch {
            return 'Recent query history unavailable in this context';
        }
    }

    private async gatherWorkspaceProfilesContext(connectionName: string | undefined): Promise<string> {
        if (!this.tableProfilesContextService) {
            return 'No workspace curated tables selected.';
        }

        const selection = await this.tableProfilesContextService.buildSelectionForPrompt();
        if (selection.tableReferences.length === 0 && (!selection.sqlSnippets || selection.sqlSnippets.length === 0)) {
            return selection.notesSummary;
        }

        let contextString = selection.notesSummary;

        if (selection.tableReferences.length > 0) {
            const ddlContext = await this.gatherTablesDDL(selection.tableReferences, connectionName);
            const formattedDdl = this.formatDdlForPrompt(ddlContext);
            contextString += `\n\nCurated tables DDL:\n${formattedDdl}`;
        }

        if (selection.sqlSnippets && selection.sqlSnippets.length > 0) {
            contextString += `\n\nCurated SQL Snippets:\n`;
            for (const snippet of selection.sqlSnippets) {
                contextString += `\n--- SQL: ${snippet.name} ---\n\`\`\`sql\n${snippet.content}\n\`\`\`\n`;
            }
        }

        return contextString;
    }

    /**
     * Gathers a compact schema overview for the current database
     * Returns a formatted string with table names and their columns
     * Optimized for token efficiency - only names, not full DDL
     */
    public async gatherSchemaOverview(): Promise<string | null> {
        const connectionName = this.connectionManager.getActiveConnectionName();
        if (!connectionName) {
            return null;
        }

        const connectionDetails = await this.connectionManager.getConnection(connectionName);
        if (!connectionDetails) {
            return null;
        }
        const metadataProvider = getDatabaseMetadataProvider(connectionDetails.dbType);

        let nzConnection: NzConnection | null = null;
        try {
            nzConnection = await createConnectedDatabaseConnectionFromDetails(connectionDetails) as NzConnection;
            const database = await this.connectionManager.getCurrentDatabase(connectionName);

            if (!database) {
                return null;
            }

            interface SchemaRow extends Record<string, unknown> {
                SCHEMA: string;
                TABLENAME: string;
                DESCRIPTION: string | null;
                ATTNAME: string;
                FORMAT_TYPE: string;
                ATTNUM: number;
                IS_PK: number;
                IS_FK: number;
            }

            const mainResult = await loadColumnsWithKeysRows(
                database,
                { objTypes: ['TABLE', 'VIEW'] },
                connectionDetails.dbType,
                (sql) => executeDatabaseQuery<Record<string, unknown>>(nzConnection!, sql),
                metadataProvider,
            ) as SchemaRow[];
            let externalResult: SchemaRow[] = [];
            const buildExternalQuery = metadataProvider.buildExternalColumnsWithKeysQuery;
            if (typeof buildExternalQuery === 'function') {
                try {
                    const externalSql = buildExternalQuery(database, {
                        objTypes: ['EXTERNAL TABLE'],
                    });
                    externalResult = await executeDatabaseQuery<SchemaRow>(nzConnection, externalSql) ?? [];
                } catch (error: unknown) {
                    // The regular catalog overview remains useful when an NPS
                    // instance does not expose the external catalog.
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[CopilotContextBuilder] External columns unavailable: ${message}`);
                }
            }

            // The regular three-query snapshot and optional external query stay
            // separate. Resolve duplicates so an external compatibility row can
            // never replace the regular catalog's richer metadata.
            const resultByColumn = new Map<string, SchemaRow>();
            for (const row of [...(mainResult ?? []), ...externalResult]) {
                const key = [row.SCHEMA, row.TABLENAME, row.ATTNAME]
                    .map(part => String(part ?? '').trim().toUpperCase())
                    .join('|');
                if (!resultByColumn.has(key)) {
                    resultByColumn.set(key, row);
                }
            }
            const result = [...resultByColumn.values()];

            if (result.length === 0) {
                return 'No tables found in database';
            }

            const tableMap = new Map<string, {
                schema: string;
                tableName: string;
                tableDescription: string;
                columns: Array<{ name: string; type: string; description: string; isPk: boolean; isFk: boolean }>;
            }>();

            for (const row of result) {
                const key = `${row.SCHEMA}.${row.TABLENAME}`;
                if (!tableMap.has(key)) {
                    tableMap.set(key, {
                        schema: row.SCHEMA,
                        tableName: row.TABLENAME,
                        tableDescription: row.DESCRIPTION || '',
                        columns: []
                    });
                }
                tableMap.get(key)!.columns.push({
                    name: row.ATTNAME,
                    type: row.FORMAT_TYPE,
                    description: row.DESCRIPTION || '',
                    isPk: Number(row.IS_PK) === 1,
                    isFk: Number(row.IS_FK) === 1
                });
            }

            // Format output - compact but informative
            const lines: string[] = [];
            lines.push(`DATABASE: ${database}`);
            lines.push(`TABLES: ${tableMap.size}`);
            lines.push('');
            lines.push('SCHEMA OVERVIEW:');
            lines.push('================');
            lines.push('');

            // Group by schema for better organization
            const schemaGroups = new Map<string, typeof tableMap>();
            for (const [key, table] of tableMap) {
                if (!schemaGroups.has(table.schema)) {
                    schemaGroups.set(table.schema, new Map());
                }
                schemaGroups.get(table.schema)!.set(key, table);
            }

            for (const [schema, tables] of schemaGroups) {
                lines.push(`[SCHEMA: ${schema}]`);

                for (const [, table] of tables) {
                    const tableDesc = table.tableDescription ? ` -- ${table.tableDescription}` : '';
                    lines.push(`  TABLE: ${table.tableName}${tableDesc}`);

                    // List columns with types and key indicators
                    const columnList = table.columns.map(c => {
                        const keyIndicators: string[] = [];
                        if (c.isPk) keyIndicators.push('PK');
                        if (c.isFk) keyIndicators.push('FK');
                        const keyStr = keyIndicators.length > 0 ? ` [${keyIndicators.join(', ')}]` : '';
                        const desc = c.description ? ` (${c.description})` : '';
                        return `    - ${c.name}: ${c.type}${keyStr}${desc}`;
                    });
                    lines.push(columnList.join('\n'));
                    lines.push('');
                }
            }

            return lines.join('\n');
        } catch (e) {
            console.error('[CopilotContextBuilder] Error gathering schema overview:', e);
            return null;
        } finally {
            if (nzConnection) {
                try {
                    await nzConnection.close();
                } catch (e) {
                    console.warn('[CopilotContextBuilder] Error closing connection:', e);
                }
            }
        }
    }
}
