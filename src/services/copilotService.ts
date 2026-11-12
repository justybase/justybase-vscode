/**
 * Copilot Service
 * 
 * Handles interaction with GitHub Copilot Chat using Language Models API
 * and provides context from SQL files (DDL, variables, query history)
 * 
 * @version 3.0 - Modular architecture with full feature parity
 */

import * as vscode from 'vscode';
import type { DatabaseReferenceTopic } from '../contracts/database';
import { ConnectionManager } from '../core/connectionManager';
import {
    getDatabaseDialect,
    getRequiredDatabaseCopilotReferenceProvider
} from '../core/connectionFactory';
import { MetadataCache } from '../metadataCache';
import { ResultPanelView } from '../views/resultPanelView';
import {
    CopilotContext,
    TableReferenceExtractor,
    DDLCacheManager,
    CopilotContextBuilder,
    CopilotResponseHandler,
    CopilotTableProfilesManager,
    CopilotTableProfilesContextService,
    WorkspaceTableProfile,
    UpsertWorkspaceTableProfileInput
} from './copilot';
import { CopilotToolsHandler } from './copilot/CopilotToolsHandler';
import { showCopilotPromptPreview } from './copilotPromptPreview';
import type { CopilotPromptPreviewResult } from './copilotPromptPreview';
import { logWithFallback } from '../utils/logger';
import type { ProcedureRepairInput } from './copilot/tools/procedureRepairUtils';

export class CopilotService {
  private tableExtractor: TableReferenceExtractor;
  private ddlCacheManager: DDLCacheManager;
  private contextBuilder: CopilotContextBuilder;
  private toolsHandler: CopilotToolsHandler;
  private responseHandler: CopilotResponseHandler;
  private tableProfilesManager: CopilotTableProfilesManager;
  private tableProfilesContextService: CopilotTableProfilesContextService;

    constructor(
        private connectionManager: ConnectionManager,
        context: vscode.ExtensionContext,
        _metadataCache?: MetadataCache,
        resultPanelProvider?: ResultPanelView
    ) {
        // Initialize sub-services
        this.tableExtractor = new TableReferenceExtractor();
        this.ddlCacheManager = new DDLCacheManager();
        this.tableProfilesManager = new CopilotTableProfilesManager(context);
        this.tableProfilesContextService = new CopilotTableProfilesContextService(this.tableProfilesManager);
        this.contextBuilder = new CopilotContextBuilder(
            connectionManager,
            this.tableExtractor,
            this.ddlCacheManager,
            this.tableProfilesContextService,
            context
        );
        this.toolsHandler = new CopilotToolsHandler(connectionManager, context, resultPanelProvider);
        this.responseHandler = new CopilotResponseHandler();
    }

    /**
     * Gets Netezza-specific reference documentation
     */
    public getNetezzaReference(topic: 'optimization' | 'nzplsql' | 'all' = 'all'): string {
        const mappedTopic: DatabaseReferenceTopic =
            topic === 'nzplsql'
                ? 'procedure'
                : topic;
        return this.resolveCopilotDialectContext().referenceProvider.getReference(mappedTopic);
    }

    private resolveCopilotDialectContext(): { displayName: string; referenceProvider: ReturnType<typeof getRequiredDatabaseCopilotReferenceProvider> } {
        const activeDocumentUri = vscode.window.activeTextEditor?.document.uri?.toString();
        const connectionName = this.connectionManager.resolveConnectionName?.(activeDocumentUri)
            ?? (activeDocumentUri ? this.connectionManager.getDocumentConnection(activeDocumentUri) : undefined)
            ?? this.connectionManager.getActiveConnectionName()
            ?? undefined;
        const databaseKind = this.connectionManager.getConnectionDatabaseKind?.(connectionName);
        const dialect = getDatabaseDialect(databaseKind);
        return {
            displayName: dialect.displayName,
            referenceProvider: getRequiredDatabaseCopilotReferenceProvider(databaseKind)
        };
    }

    /**
     * Gathers context from current document and database state
     */
    async gatherContext(): Promise<CopilotContext> {
        return await this.contextBuilder.gatherContext();
    }

    /**
    * Clears DDL cache
    */
    clearDDLCache(): void {
        this.ddlCacheManager.clear();
        logWithFallback('info', '[CopilotService] DDL cache cleared');
    }

    /**
     * Sends data to Copilot Chat for description and analysis
     */
    public async describeDataWithCopilot(data: Record<string, unknown>[], sql?: string): Promise<void> {
        try {
            if (!data || data.length === 0) {
                vscode.window.showWarningMessage('No data to describe');
                return;
            }

            // Privacy confirmation - user must accept before sending data
            const rowCount = data.length;
            const columnCount = Object.keys(data[0] || {}).length;
            const dataSize = rowCount > 50 ? '50 (limited for context)' : rowCount;

            const confirmed = await vscode.window.showWarningMessage(
                `⚠️ Privacy Notice: You are about to send ${dataSize} rows with ${columnCount} columns to GitHub Copilot AI.\n\n` +
                `This data will be transmitted to external servers for analysis. ` +
                `Please ensure the data does NOT contain sensitive, confidential, or personally identifiable information.\n\n` +
                `Do you want to proceed?`,
                { modal: true },
                'Yes, Send to Copilot',
                'Cancel'
            );

            if (confirmed !== 'Yes, Send to Copilot') {
                vscode.window.showInformationMessage('Data analysis cancelled - no data was sent.');
                return;
            }

            // Convert data to markdown table
            const markdown = this.responseHandler.convertDataToMarkdown(data);

            // Build prompt
            const dialectDisplayName = this.resolveCopilotDialectContext().displayName;
            let prompt = `Describe and analyze the following data from ${dialectDisplayName}:\n\n`;

            if (sql) {
                prompt += `**Source Query:**\n\`\`\`sql\n${sql}\n\`\`\`\n\n`;
            }

            prompt += `**Data (${data.length} rows):**\n\n${markdown}\n\n`;
            prompt += `Please provide:\n`;
            prompt += `1. A summary of the data patterns and key observations\n`;
            prompt += `2. Any notable trends, outliers, or anomalies\n`;
            prompt += `3. Suggestions for further analysis if applicable`;

            // Open Copilot Chat with the prompt
            await vscode.commands.executeCommand(
                'workbench.action.chat.open',
                { query: prompt }
            );

            vscode.window.showInformationMessage('✅ Data sent to Copilot Chat for analysis. Check the Chat panel for results.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to send data to Copilot: ${msg}`);
        }
    }

    /**
     * Opens a copy-ready preview for a SQL error. The exact prompt — error
     * message, executed SQL, referenced table DDL and any dialect reference —
     * is shown, but the extension never sends it: the user copies it and
     * pastes it into their own Copilot Chat thread.
     * Called from the Results panel error card and the linter quick fix.
     */
    public async fixSqlError(errorMessage: string, sql: string): Promise<void> {
        try {
            if (!sql.trim()) {
                vscode.window.showWarningMessage('No SQL to fix');
                return;
            }

            let previewResult: CopilotPromptPreviewResult | undefined;

            // Gather DDL first so the preview can show the complete payload.
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: 'Gathering table DDL for Copilot...',
                cancellable: false
            }, async (progress) => {
                // Gather DDL for tables referenced in the SQL
                const ddlContext = await this.contextBuilder.getSchemaForSql(sql);

                const dialectDisplayName = this.resolveCopilotDialectContext().displayName;
                const fixPrompt = `Fix the syntax errors in the following ${dialectDisplayName} SQL query. Preserve ${dialectDisplayName}-specific SQL dialect features.`;

                // Build comprehensive prompt with DDL context
                let prompt = `${fixPrompt}

IMPORTANT ${dialectDisplayName.toUpperCase()} SQL NAMING CONVENTIONS:
- Three-part name: DATABASE.SCHEMA.OBJECT - fully qualified reference to a table/view/procedure
- Two-part name with double dots: DATABASE..OBJECT - references object in the specified database (searches across schemas or uses default schema depending on configuration)
- Two-part name with single dot: SCHEMA.OBJECT - uses current/default database with specified schema
- Single name: OBJECT - uses current database and current schema
- System views like _V_TABLE, _V_VIEW, _V_PROCEDURE are in each database; use DATABASE.._V_TABLE to query a specific database's system views
- DATABASE..TABLE syntax may be valid in the active dialect - do NOT rewrite naming patterns unless the dialect rules require it.
- Preserve dialect-specific SQL extensions and object naming rules when correcting the query.

**Error from ${dialectDisplayName}:**
\`\`\`
${errorMessage}
\`\`\`

**SQL Query that caused the error:**
\`\`\`sql
${sql}
\`\`\`
`;

                const hasDdlContext = Boolean(
                    ddlContext
                    && !ddlContext.includes('No table references')
                    && !ddlContext.includes('Could not gather DDL')
                );

                // Add DDL context if available
                if (hasDdlContext) {
                    prompt += `
**Referenced Table Schemas (DDL):**
\`\`\`sql
${ddlContext}
\`\`\`
`;
                }

                const includesNzplsqlReference = this.responseHandler.isProcedureCode(sql);

                // Add NZPLSQL reference if code contains stored procedure
                if (includesNzplsqlReference) {
                    prompt += `\n${this.getNetezzaReference('nzplsql')}\n`;
                }

                prompt += `
Please:
1. Explain what caused this error
2. Provide the corrected SQL query
3. Explain the fix you made`;

                progress.report({ message: 'Preparing the prompt for review...' });

                const payloadItems = [
                    `Error message (${errorMessage.length.toLocaleString('en-US')} characters)`,
                    `Executed SQL (${sql.length.toLocaleString('en-US')} characters)`,
                ];
                if (hasDdlContext) {
                    payloadItems.push(`Referenced table DDL (${ddlContext.length.toLocaleString('en-US')} characters)`);
                }
                if (includesNzplsqlReference) {
                    payloadItems.push('NZPLSQL language reference');
                }

                previewResult = await showCopilotPromptPreview({
                    operation: 'Discuss SQL error with Copilot',
                    prompt,
                    items: payloadItems,
                });
            });

            if (previewResult === 'copied') {
                vscode.window.showInformationMessage(
                    'Prompt copied to clipboard. Paste it into your Copilot Chat thread to continue.',
                );
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to prepare the Copilot prompt: ${msg}`);
        }
    }

    // =================================================================================
    // Tool Support Methods
    // =================================================================================

    public async getTablesFromDatabase(database?: string, schema?: string): Promise<string> {
        return this.toolsHandler.getTablesFromDatabase(database, schema);
    }

    public async getColumnsForTables(tables: string[], database?: string): Promise<string> {
        return this.toolsHandler.getColumnsForTables(tables, database);
    }

    public async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.toolsHandler.getExplainPlanAnalysis(sql, verbose, database);
    }

    public async getSchemaForSql(sql: string): Promise<string> {
        return this.contextBuilder.getSchemaForSql(sql);
    }

    /**
     * Builds a compact, tool-friendly context bundle for agent orchestration.
     */
    public async getToolContext(
        sql?: string,
        includeSchema: boolean = true,
        includeDiagnostics: boolean = true
    ): Promise<string> {
        const editor = vscode.window.activeTextEditor;
        const dialectDisplayName = this.resolveCopilotDialectContext().displayName;
        const connectionName = (editor
            ? this.connectionManager.getDocumentConnection(editor.document.uri.toString())
            : undefined)
            || this.connectionManager.getActiveConnectionName()
            || undefined;

        const selectedSql = sql !== undefined
            ? sql
            : editor
                ? (editor.selection.isEmpty
                    ? editor.document.getText()
                    : editor.document.getText(editor.selection))
                : '';

        const lines: string[] = [
            `Dialect: ${dialectDisplayName}`,
            `Connection: ${connectionName || 'none'}`
        ];

        if (selectedSql.trim().length > 0) {
            lines.push('', 'SQL:', '```sql', selectedSql.trim(), '```');
        } else {
            lines.push('', 'SQL: (no active SQL editor content)');
        }

        if (includeSchema && selectedSql.trim().length > 0) {
            lines.push('', 'Schema and referenced table DDL:', await this.getSchemaForSql(selectedSql));
        }

        if (includeDiagnostics) {
            const diagnostics = sql !== undefined && selectedSql.trim().length > 0
                ? await this.validateSql(selectedSql)
                : await this.getSqlDiagnostics(true);
            lines.push('', 'Diagnostics:', diagnostics);
        }

        return lines.join('\n');
    }

    public async getTableStats(table: string, database?: string): Promise<string> {
        return this.toolsHandler.getTableStats(table, database);
    }

    public async getDatabases(): Promise<string> {
        return this.toolsHandler.getDatabases();
    }

    public async getSchemas(database?: string): Promise<string> {
        return this.toolsHandler.getSchemas(database);
    }

    public async getProcedures(database?: string, schema?: string): Promise<string> {
        return this.toolsHandler.getProcedures(database, schema);
    }

    public async getViews(database?: string, schema?: string): Promise<string> {
        return this.toolsHandler.getViews(database, schema);
    }

    public async getExternalTables(database?: string, schema?: string, pattern?: string): Promise<string> {
        return this.toolsHandler.getExternalTables(database, schema, pattern);
    }

    public async validateSql(sql: string): Promise<string> {
        return this.toolsHandler.validateSql(sql);
    }

    public async getObjectDependencies(
        object: string,
        database?: string,
        objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE'
    ): Promise<string> {
        return this.toolsHandler.getObjectDependencies(object, database, objectType);
    }

    public async searchSchema(pattern: string, searchType: string, database?: string): Promise<string> {
        return this.toolsHandler.searchSchema(pattern, searchType, database);
    }

    public async findTableLocations(tableName: string): Promise<string> {
        return this.toolsHandler.findTableLocations(tableName);
    }

    public async getComments(tableName: string, database?: string, schema?: string, includeColumns: boolean = true): Promise<string> {
        return this.toolsHandler.getComments(tableName, database, schema, includeColumns);
    }

    public async getDDL(params: {
        objectName: string;
        objectType: string;
        database?: string;
        schema?: string;
    }): Promise<string> {
        return this.toolsHandler.getDDL(params);
    }

    public async validateSqlParser(sql: string): Promise<string> {
        return this.toolsHandler.validateSqlParser(sql);
    }

    public async validateSqlOnDatabase(sql: string, database?: string): Promise<string> {
        return this.toolsHandler.validateSqlOnDatabase(sql, database);
    }

    public async repairProcedure(input: ProcedureRepairInput, token?: vscode.CancellationToken): Promise<string> {
        return this.toolsHandler.repairProcedure(input, token);
    }

    public async getSqlDiagnostics(includeWarnings: boolean = true): Promise<string> {
        return this.toolsHandler.getSqlDiagnostics(includeWarnings);
    }

    public async inspectImportFile(filePath: string, sampleRows: number = 5): Promise<string> {
        return this.toolsHandler.inspectImportFile(filePath, sampleRows);
    }

    public async proposeImportMapping(filePath: string, targetTable: string): Promise<string> {
        return this.toolsHandler.proposeImportMapping(filePath, targetTable);
    }

    public async getWorkspaceTableProfiles(): Promise<WorkspaceTableProfile[]> {
        return this.tableProfilesManager.getProfiles();
    }

    public async upsertWorkspaceTableProfile(input: UpsertWorkspaceTableProfileInput): Promise<WorkspaceTableProfile> {
        return this.tableProfilesManager.upsertProfile(input);
    }

    public async deleteWorkspaceTableProfile(profileId: string): Promise<void> {
        await this.tableProfilesManager.deleteProfile(profileId);
    }

    public async includeWorkspaceTableProfileNow(profileId: string): Promise<boolean> {
        return this.tableProfilesManager.includeNow(profileId);
    }

    public async getWorkspaceTableProfilesSummary(mode?: 'full' | 'summary' | 'content', profileNames?: string[]): Promise<string> {
        return this.tableProfilesManager.formatProfilesForToolOutput(mode, profileNames);
    }

}

// Re-export types and tools for consumers (e.g. extension.ts)
export type { CopilotContext, TableReference, WorkspaceTableProfile, UpsertWorkspaceTableProfileInput } from './copilot';
export * from './copilotTools';
