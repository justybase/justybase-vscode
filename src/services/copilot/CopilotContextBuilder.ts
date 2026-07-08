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

type SqlGenerationIntent = 'reporting' | 'aggregation' | 'quality-check' | 'etl-transform' | 'general';

interface IntentPromptProfile {
    id: SqlGenerationIntent;
    label: string;
    objective: string;
    scaffold: string[];
}

const INTENT_PROMPT_PROFILES: Record<SqlGenerationIntent, IntentPromptProfile> = {
    reporting: {
        id: 'reporting',
        label: 'Reporting / KPI extraction',
        objective: 'Produce a business-readable dataset with stable dimensions, metrics, and clear ordering.',
        scaffold: [
            'Project report-friendly dimensions and metric columns with explicit aliases.',
            'Prefer deterministic date windows and ordering for dashboard repeatability.',
            'Include null-safe handling for KPI columns when necessary.'
        ]
    },
    aggregation: {
        id: 'aggregation',
        label: 'Aggregation / summarization',
        objective: 'Generate efficient grouped metrics while minimizing scan and redistribution overhead.',
        scaffold: [
            'Pre-filter raw rows before GROUP BY to reduce shuffled data volume.',
            'Aggregate at the requested grain and validate grouping keys explicitly.',
            'Use HAVING only for post-aggregate predicates and include clear metric aliases.'
        ]
    },
    'quality-check': {
        id: 'quality-check',
        label: 'Data quality validation',
        objective: 'Detect anomalies (nulls, duplicates, invalid ranges, referential mismatches) with auditable evidence.',
        scaffold: [
            'Emit issue-centric columns (issue_type, affected_count, sample keys) when possible.',
            'Use explicit null/duplicate checks and deterministic thresholds.',
            'Keep checks explainable so they can be automated in ETL quality gates.'
        ]
    },
    'etl-transform': {
        id: 'etl-transform',
        label: 'ETL / transformation flow',
        objective: 'Produce transformation SQL that is safe for incremental loads and operational reruns.',
        scaffold: [
            'Prefer set-based transforms over row-by-row procedural logic.',
            'For merge/upsert patterns, define match keys and change conditions clearly.',
            'Keep staging/target assumptions explicit (source grain, deduping, idempotency).'
        ]
    },
    general: {
        id: 'general',
        label: 'General SQL request',
        objective: 'Generate correct and maintainable SQL with explicit assumptions.',
        scaffold: [
            'Choose tables/columns directly tied to the user request.',
            'Use explicit joins and predicates over implicit defaults.',
            'Keep output focused on actionable result columns.'
        ]
    }
};

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

            const sql = metadataProvider.buildColumnsWithKeysQuery(database, {
                objTypes: ['TABLE', 'VIEW']
            });

            interface SchemaRow {
                SCHEMA: string;
                TABLENAME: string;
                DESCRIPTION: string;
                ATTNAME: string;
                FORMAT_TYPE: string;
                ATTNUM: number;
                IS_PK: number;
                IS_FK: number;
            }

            const result = await executeDatabaseQuery<SchemaRow>(nzConnection, sql);

            if (!result || result.length === 0) {
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

    /**
     * Builds the prompt for SQL generation from natural language
     */
    public buildGenerateSqlPrompt(userDescription: string, schemaOverview: string): string {
        const intentProfile = this.getIntentPromptProfile(userDescription);
        const intentScaffold = intentProfile.scaffold
            .map((step, index) => `${index + 1}. ${step}`)
            .join('\n');

        return `You are a Netezza SQL expert. The user wants to generate a SQL query based on their description.

IMPORTANT NETEZZA SQL NAMING CONVENTIONS:
- Three-part name: DATABASE.SCHEMA.OBJECT - fully qualified reference to a table/view/procedure
- Two-part name with double dots: DATABASE..OBJECT - references object in the specified database (searches across schemas or uses default schema depending on configuration)
- Two-part name with single dot: SCHEMA.OBJECT - uses current/default database with specified schema
- Single name: OBJECT - uses current database and current schema
- System views like _V_TABLE, _V_VIEW, _V_PROCEDURE are in each database; use DATABASE.._V_TABLE to query a specific database's system views
- DATABASE..TABLE syntax is valid and CORRECT in Netezza - do NOT "fix" it by adding a schema name!
- Netezza supports: DISTRIBUTE ON, ORGANIZE ON, GROOM TABLE, GENERATE STATISTICS, zone maps, etc.

USER REQUEST:
${userDescription}

DETECTED SQL INTENT:
- Intent: ${intentProfile.id} (${intentProfile.label})
- Objective: ${intentProfile.objective}

INTENT-SPECIALIZED SCAFFOLD:
${intentScaffold}

AVAILABLE DATABASE SCHEMA:
\`\`\`
${schemaOverview}
\`\`\`

INSTRUCTIONS:
1. Restate the user intent in one short sentence.
2. Identify and list candidate tables/columns you plan to use before writing SQL.
3. Generate a complete, executable Netezza SQL query using those tables/columns.
4. Validate the generated SQL with parser validation (validateSqlParser / tool netezza_validate_sql).
5. If parser reports issues, fix the SQL and return the corrected final query.
6. Return:
   - FINAL SQL in one \`\`\`sql block
   - A short validation summary (parser result + any assumptions)

If the request is ambiguous, ask clarifying questions before generating SQL.
If key columns are missing, state what is missing and provide the best safe draft query.

Start with step 1 now.`;
    }

    private getIntentPromptProfile(userDescription: string): IntentPromptProfile {
        const normalized = userDescription.toLowerCase();

        if (
            /(\betl\b|\bpipeline\b|\bstaging?\b|\bupsert\b|\bmerge\b|\bincremental\b|\bscd\b|\bslowly\s+changing\b|\btransform(?:ation)?s?\b|\bload(?:ing)?\b)/.test(
                normalized
            )
        ) {
            return INTENT_PROMPT_PROFILES['etl-transform'];
        }

        if (
            /(\bquality\b|\bduplicate(?:s)?\b|\bnull(?:s)?\b|\bmissing\b|\binvalid\b|\banomal(?:y|ies)\b|\breconcile\b|\bconsistency\b|\bfreshness\b|\borphan(?:s)?\b)/.test(
                normalized
            )
        ) {
            return INTENT_PROMPT_PROFILES['quality-check'];
        }

        if (
            /(\bsum\b|\bcount\b|\bavg\b|\baverage\b|\bmin\b|\bmax\b|\bgroup\s+by\b|\baggregate(?:d|s|ion)?\b|\brollup\b|\bkpi(?:s)?\b|\bratio\b|\bpercentile(?:s)?\b)/.test(
                normalized
            )
        ) {
            return INTENT_PROMPT_PROFILES.aggregation;
        }

        if (
            /(\breport(?:ing)?\b|\bdashboard(?:s)?\b|\btrend(?:s)?\b|\btop\b|\bmonthly\b|\bweekly\b|\bquarterly\b|\bdaily\b|\bbreakdown\b)/.test(
                normalized
            )
        ) {
            return INTENT_PROMPT_PROFILES.reporting;
        }

        return INTENT_PROMPT_PROFILES.general;
    }
}
