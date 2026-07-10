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
    ModelSelector,
    CopilotPromptDialectContext,
    CopilotPromptManager,
    CopilotContextBuilder,
    CopilotResponseHandler,
    CopilotTableProfilesManager,
    CopilotTableProfilesContextService,
    WorkspaceTableProfile,
    UpsertWorkspaceTableProfileInput
} from './copilot';
import { CopilotToolsHandler } from './copilot/CopilotToolsHandler';
import { getExtensionConfiguration } from '../compatibility/configuration';
import { logWithFallback } from '../utils/logger';

interface RewriteValidationCheck {
    hasBlockingErrors: boolean;
    warningCount: number;
    issueCount: number;
}

interface RewritePlanDeltaCheck {
    attempted: boolean;
    blockingRegression: boolean;
    summary: string;
    baselineCost?: number;
    rewrittenCost?: number;
    deltaPercent?: number;
}

export class CopilotService {
  private tableExtractor: TableReferenceExtractor;
  private ddlCacheManager: DDLCacheManager;
  private modelSelector: ModelSelector;
  private promptManager: CopilotPromptManager;
  private contextBuilder: CopilotContextBuilder;
  private toolsHandler: CopilotToolsHandler;
  private responseHandler: CopilotResponseHandler;
  private tableProfilesManager: CopilotTableProfilesManager;
  private tableProfilesContextService: CopilotTableProfilesContextService;

  /**
   * Checks if AI features are enabled in settings
   * @returns true if enabled, false if disabled
   */
  private isCopilotEnabled(): boolean {
    const config = getExtensionConfiguration('copilot');
    return config.get<boolean>('enabled') ?? true;
  }

  /**
   * Data-returning tools require an explicit opt-in because their output can
   * contain sensitive database values.
   */
  private isToolEnabledForCopilot(toolName: string): boolean {
    const protectedToolSettings: Record<string, string> = {
      netezza_execute_query: 'tools.executeQueryEnabled',
      netezza_get_sample_data: 'tools.sampleDataEnabled'
    };
    const setting = protectedToolSettings[toolName];
    return !setting || (getExtensionConfiguration('copilot').get<boolean>(setting) ?? false);
  }

  private getAvailableLanguageModelTools(): vscode.LanguageModelChatTool[] {
    return vscode.lm.tools
      .filter(tool => this.isToolEnabledForCopilot(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));
  }

  /**
   * Shows a message when AI features are disabled
   */
  private showDisabledMessage(): void {
    vscode.window.showInformationMessage(
      'AI features are disabled. Enable them in settings: "netezza.copilot.enabled"'
    );
  }

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
        this.modelSelector = new ModelSelector(context);
        this.promptManager = new CopilotPromptManager(() => this.resolveCopilotDialectContext());
        this.contextBuilder = new CopilotContextBuilder(
            connectionManager,
            this.tableExtractor,
            this.ddlCacheManager,
            this.tableProfilesContextService,
            context
        );
        this.toolsHandler = new CopilotToolsHandler(connectionManager, context, resultPanelProvider);
        this.responseHandler = new CopilotResponseHandler(this.promptManager);
    }

    /**
     * Initializes the service
     */
    public async init(): Promise<boolean> {
        return await this.modelSelector.init();
    }

    public async changeModel(): Promise<void> {
        await this.modelSelector.selectModel();
    }

    public async clearPersistedModel(): Promise<void> {
        await this.modelSelector.clearPersistedModel();
    }

    public getSelectedModelId(): string | undefined {
        return this.modelSelector.getSelectedModelId();
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

    private resolveCopilotDialectContext(): CopilotPromptDialectContext {
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

    // =================================================================================
    // Privacy Confirmation Methods
    // =================================================================================

    /**
     * Shows privacy confirmation dialog before sending data to AI
     * @param operation Name of the operation (e.g., "Fix SQL")
     * @param contextSummary Summary of data that will be sent
     * @returns true if user confirmed, false otherwise
     */
    private async confirmDataTransmission(operation: string, contextSummary: string): Promise<boolean> {
        const config = getExtensionConfiguration('copilot');
        const skipConfirmation = config.get<boolean>('skipPrivacyConfirmation', false);
        
        if (skipConfirmation) {
            return true;  // User has disabled confirmations
        }
        
        const confirmed = await vscode.window.showWarningMessage(
            `⚠️ Data Transmission Notice\n\n` +
            `The "${operation}" feature will send the following to GitHub Copilot AI (external servers):\n\n` +
            `${contextSummary}\n\n` +
            `Please ensure this data does NOT contain:\n` +
            `• Sensitive business information\n` +
            `• Personally identifiable information (PII)\n` +
            `• Confidential data\n\n` +
            `Do you want to proceed?`,
            { modal: true },
            'Yes, Proceed',
            "Don't ask again",
            'Cancel'
        );
        
        if (confirmed === "Don't ask again") {
            await config.update('skipPrivacyConfirmation', true);
            return true;
        }
        
        return confirmed === 'Yes, Proceed';
    }

    /**
     * Builds a human-readable summary of the context that will be sent to AI
     */
    private buildContextSummary(context: CopilotContext): string {
        const lines: string[] = [];
        lines.push(`• SQL code (${context.selectedSql.length} characters)`);
        if (context.ddlContext && !context.ddlContext.includes('No table')) {
            lines.push(`• Table DDL schemas`);
        }
        if (context.variables && !context.variables.includes('No variables')) {
            lines.push(`• Query variables`);
        }
        if (context.recentQueries && !context.recentQueries.includes('No recent')) {
            lines.push(`• Recent query history`);
        }
        return lines.join('\n');
    }

    // =================================================================================
    // Public API Methods - Full Implementation with Auto/Chat Modes
    // =================================================================================

  /**
   * Quick action: Fix SQL with context
   * User selects between Auto (applies via diff) or Chat (interactive discussion)
   */
  public async fixSql(): Promise<void> {
    try {
      // Check if AI features are enabled
      if (!this.isCopilotEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const mode = await this.responseHandler.selectCopilotMode('Fix SQL');
      if (!mode) return;

            const copilotContext = await this.gatherContext();
            let prompt = this.promptManager.getPrompt('fix');

            // Add NZPLSQL reference if code contains stored procedure
            if (this.responseHandler.isProcedureCode(copilotContext.selectedSql)) {
                prompt += `\n\n${this.getNetezzaReference('nzplsql')}`;
            }

            // Privacy confirmation - user must accept before sending data
            const contextSummary = this.buildContextSummary(copilotContext);
            const confirmed = await this.confirmDataTransmission('Fix SQL', contextSummary);
            if (!confirmed) {
                vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
                return;
            }

            if (mode === 'auto') {
                const model = await this.modelSelector.getModel();
                await this.responseHandler.sendToLanguageModel(copilotContext, prompt, true, model || undefined);
            } else {
                await this.responseHandler.sendToChatInteractive(copilotContext, prompt, 'Fix SQL');
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error fixing SQL: ${msg}`);
        }
    }

  /**
   * Quick action: Optimize SQL with context
   * User selects between Auto (applies via diff) or Chat (interactive discussion)
   */
  public async optimizeSql(): Promise<void> {
    try {
      // Check if AI features are enabled
      if (!this.isCopilotEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const mode = await this.responseHandler.selectCopilotMode('Optimize SQL');
      if (!mode) return;

            const copilotContext = await this.gatherContext();
            const basePrompt = this.promptManager.getPrompt('optimize');
            let prompt = `${basePrompt}\n\n${this.getNetezzaReference('optimization')}`;

            // Add NZPLSQL reference if code contains stored procedure
            if (this.responseHandler.isProcedureCode(copilotContext.selectedSql)) {
                prompt += `\n\n${this.getNetezzaReference('nzplsql')}`;
            }

            // Privacy confirmation - user must accept before sending data
            const contextSummary = this.buildContextSummary(copilotContext);
            const confirmed = await this.confirmDataTransmission('Optimize SQL', contextSummary);
            if (!confirmed) {
                vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
                return;
            }

            if (mode === 'auto') {
                await this.runGuardedAutoRewrite(copilotContext, prompt, 'Optimize SQL');
            } else {
                await this.responseHandler.sendToChatInteractive(copilotContext, prompt, 'Optimize SQL');
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error optimizing SQL: ${msg}`);
        }
    }

  /**
   * Quick action: Rewrite to Netezza Best Practices
   */
  public async bestPracticesSql(): Promise<void> {
    try {
      // Check if AI features are enabled
      if (!this.isCopilotEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const dialectLabel = `${this.resolveCopilotDialectContext().displayName} Best Practices`;
      const mode = await this.responseHandler.selectCopilotMode(dialectLabel);
      if (!mode) return;

            const copilotContext = await this.gatherContext();
            const basePrompt = this.promptManager.getPrompt('bestPractices');
            let prompt = `${basePrompt}\n\n${this.getNetezzaReference('optimization')}`;

            // Add NZPLSQL reference if code contains stored procedure
            if (this.responseHandler.isProcedureCode(copilotContext.selectedSql)) {
                prompt += `\n\n${this.getNetezzaReference('nzplsql')}`;
            }

            // Privacy confirmation - user must accept before sending data
            const contextSummary = this.buildContextSummary(copilotContext);
            const confirmed = await this.confirmDataTransmission(dialectLabel, contextSummary);
            if (!confirmed) {
                vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
                return;
            }

            if (mode === 'auto') {
                await this.runGuardedAutoRewrite(copilotContext, prompt, dialectLabel);
            } else {
                await this.responseHandler.sendToChatInteractive(copilotContext, prompt, dialectLabel);
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error applying best practices: ${msg}`);
        }
    }

  /**
   * Quick action: Explain SQL with context
   * User selects between Document (new markdown) or Chat (interactive discussion)
   */
  public async explainSql(): Promise<void> {
    try {
      // Check if AI features are enabled
      if (!this.isCopilotEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const mode = await vscode.window.showQuickPick(
                [
                    { label: '$(file-text) Document', description: 'Show explanation in new document', value: 'document' as const },
                    { label: '$(comment-discussion) Chat', description: 'Discuss in Copilot Chat', value: 'chat' as const }
                ],
                { placeHolder: 'How would you like the explanation?' }
            );
            if (!mode) return;

            const copilotContext = await this.gatherContext();
            const prompt = this.promptManager.getPrompt('explain');

            // Privacy confirmation - user must accept before sending data
            const contextSummary = this.buildContextSummary(copilotContext);
            const confirmed = await this.confirmDataTransmission('Explain SQL', contextSummary);
            if (!confirmed) {
                vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
                return;
            }

            if (mode.value === 'document') {
                // Show explanation in a new markdown document
                const model = await this.modelSelector.getModel();
                const response = await this.responseHandler.sendToLanguageModel(copilotContext, prompt, false, model || undefined);
                const doc = await vscode.workspace.openTextDocument({
                    content: `# SQL Query Explanation\n\n${response}`,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                vscode.window.showInformationMessage('✅ SQL explanation opened in new editor');
            } else {
                await this.responseHandler.sendToChatInteractive(copilotContext, prompt, 'Explain SQL');
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error explaining SQL: ${msg}`);
        }
    }

  /**
   * Custom question with full context
   * User enters question and selects response mode
   */
  public async askCustomQuestion(): Promise<void> {
    try {
      // Check if AI features are enabled
      if (!this.isCopilotEnabled()) {
        this.showDisabledMessage();
        return;
      }

      const userQuestion = await vscode.window.showInputBox({
                prompt: 'Ask Copilot about this SQL (with full database context)',
                placeHolder: 'e.g., "How can I improve this query?" or "Add an index hint"'
            });

            if (!userQuestion) {
                return;
            }

            const copilotContext = await this.gatherContext();

            // Ask how user wants to receive the response
            const action = await vscode.window.showQuickPick(
                [
                    { label: '$(edit) Apply Changes', description: 'Copilot modifies the SQL in editor', value: 'edit' as const },
                    { label: '$(file-text) Document', description: 'Get response in new document', value: 'document' as const },
                    { label: '$(comment-discussion) Chat', description: 'Discuss in Copilot Chat', value: 'chat' as const }
                ],
                { placeHolder: 'How would you like Copilot to respond?' }
            );

            if (!action) {
                return;
            }

            // Privacy confirmation - user must accept before sending data
            const contextSummary = this.buildContextSummary(copilotContext);
            const confirmed = await this.confirmDataTransmission('Custom Question', contextSummary);
            if (!confirmed) {
                vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
                return;
            }

            const model = await this.modelSelector.getModel();

            if (action.value === 'edit') {
                await this.responseHandler.sendToLanguageModel(copilotContext, userQuestion, true, model || undefined);
            } else if (action.value === 'document') {
                const response = await this.responseHandler.sendToLanguageModel(copilotContext, userQuestion, false, model || undefined);
                const doc = await vscode.workspace.openTextDocument({
                    content: `# Copilot Advice\n\n**Question:** ${userQuestion}\n\n${response}`,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } else {
                await this.responseHandler.sendToChatInteractive(copilotContext, userQuestion, 'Custom Question');
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error: ${msg}`);
        }
    }

  /**
   * Generate SQL from natural language description (Interactive mode)
   * Gathers schema overview (tables + columns) and sends to Copilot Chat
   * for interactive SQL generation
   */
  public async generateSqlInteractive(): Promise<void> {
    try {
      // Check if AI features are enabled
      if (!this.isCopilotEnabled()) {
        this.showDisabledMessage();
        return;
      }

      // Get user's natural language description
      const userDescription = await vscode.window.showInputBox({
                prompt: 'Describe the SQL query you need in natural language',
                placeHolder: 'e.g., "Find all customers who made purchases over $1000 last month"',
                ignoreFocusOut: true
            });

            if (!userDescription) {
                return;
            }

            // Privacy confirmation - user must accept before sending schema data
            const confirmed = await this.confirmDataTransmission(
                'Generate SQL',
                `• Database schema overview (tables, columns, types)\n• Connection information`
            );
            if (!confirmed) {
                vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
                return;
            }

            // Show progress while gathering schema
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: 'Gathering database schema...',
                cancellable: false
            }, async () => {
                const schemaOverview = await this.contextBuilder.gatherSchemaOverview();

                if (!schemaOverview) {
                    vscode.window.showErrorMessage('Could not gather schema information. Please ensure you are connected to a database.');
                    return;
                }

                // Build the prompt for SQL generation
                const generateSqlPrompt = this.contextBuilder.buildGenerateSqlPrompt(userDescription, schemaOverview);

                const model = await this.modelSelector.getModel();
                if (!model) {
                    await this.responseHandler.sendToChatInteractiveWithCustomPrompt(generateSqlPrompt, 'Generate SQL');
                    return;
                }

                const connectionName = this.connectionManager.getActiveConnectionName();
                const generationContext: CopilotContext = {
                    selectedSql: '',
                    ddlContext: schemaOverview,
                    variables: '',
                    recentQueries: '',
                    connectionInfo: connectionName ? `Connected to: ${connectionName}` : 'No active connection',
                    workspaceTableProfilesContext: 'No workspace curated tables selected.'
                };

                const response = await this.responseHandler.sendToLanguageModel(
                    generationContext,
                    generateSqlPrompt,
                    false,
                    model
                );
                const generatedSql = this.extractSqlFromCopilotResponse(response);
                if (!generatedSql) {
                    await this.responseHandler.sendToChatInteractiveWithCustomPrompt(generateSqlPrompt, 'Generate SQL');
                    vscode.window.showWarningMessage(
                        'Copilot response did not include SQL code. Opened interactive chat to refine generation.'
                    );
                    return;
                }

                const validationSummary = await this.toolsHandler.validateSqlParser(generatedSql);
                const reportDocument = await vscode.workspace.openTextDocument({
                    content: this.buildGeneratedSqlValidationReport(userDescription, generatedSql, validationSummary),
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(reportDocument, vscode.ViewColumn.Beside);

                if (this.isParserValidationSuccessful(validationSummary)) {
                    vscode.window.showInformationMessage('✅ Generated SQL validated with parser checks. Review the draft in the new document.');
                } else {
                    vscode.window.showWarningMessage('Generated SQL has parser validation issues. Review and adjust the SQL draft.');
                }
            });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error generating SQL: ${msg}`);
        }
    }

    private extractSqlFromCopilotResponse(response: string): string | undefined {
        const sqlFenceMatch = response.match(/```sql\s*([\s\S]*?)```/i);
        if (sqlFenceMatch && sqlFenceMatch[1].trim().length > 0) {
            return sqlFenceMatch[1].trim();
        }

        const genericFenceMatch = response.match(/```(?:\w+)?\s*([\s\S]*?)```/);
        if (genericFenceMatch && genericFenceMatch[1].trim().length > 0) {
            return genericFenceMatch[1].trim();
        }

        const trimmed = response.trim();
        if (/^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|EXPLAIN)\b/i.test(trimmed)) {
            return trimmed;
        }

        return undefined;
    }

    private buildGeneratedSqlValidationReport(userDescription: string, generatedSql: string, validationSummary: string): string {
        return `# Copilot Generated SQL (Validated)

**Request:** ${userDescription}

## Generated SQL
\`\`\`sql
${generatedSql}
\`\`\`

## Parser Validation
\`\`\`
${validationSummary}
\`\`\`
`;
    }

    private isParserValidationSuccessful(validationSummary: string): boolean {
        return /^SQL parser validation passed/i.test(validationSummary.trim());
    }

    private async runGuardedAutoRewrite(copilotContext: CopilotContext, prompt: string, actionLabel: string): Promise<void> {
        const model = await this.modelSelector.getModel();
        const response = await this.responseHandler.sendToLanguageModel(copilotContext, prompt, false, model || undefined);
        await this.applyGuardedRewrite(copilotContext.selectedSql, response, actionLabel);
    }

    private async applyGuardedRewrite(originalSql: string, aiResponse: string, actionLabel: string): Promise<void> {
        const rewrittenSql = this.extractSqlFromCopilotResponse(aiResponse);
        if (!rewrittenSql) {
            vscode.window.showWarningMessage(`⚠️ ${actionLabel}: response did not include executable SQL. No changes were applied.`);
            return;
        }

        const validationSummary = await this.toolsHandler.validateSqlParser(rewrittenSql);
        const validationCheck = this.evaluateRewriteValidation(validationSummary);
        const planDeltaCheck = await this.evaluatePlanDeltaGuard(originalSql, rewrittenSql);
        const shouldBlockApply = validationCheck.hasBlockingErrors || planDeltaCheck.blockingRegression;

        if (shouldBlockApply) {
            const reportDocument = await vscode.workspace.openTextDocument({
                content: this.buildRewriteGuardReport(
                    actionLabel,
                    originalSql,
                    rewrittenSql,
                    validationSummary,
                    validationCheck,
                    planDeltaCheck,
                    true
                ),
                language: 'markdown'
            });
            await vscode.window.showTextDocument(reportDocument, vscode.ViewColumn.Beside);
            vscode.window.showWarningMessage(`⚠️ ${actionLabel}: rewrite guard blocked applying this suggestion.`);
            return;
        }

        await this.responseHandler.applyModelResponseToEditor(aiResponse);

        if (validationCheck.warningCount > 0 || planDeltaCheck.attempted) {
            const reportDocument = await vscode.workspace.openTextDocument({
                content: this.buildRewriteGuardReport(
                    actionLabel,
                    originalSql,
                    rewrittenSql,
                    validationSummary,
                    validationCheck,
                    planDeltaCheck,
                    false
                ),
                language: 'markdown'
            });
            await vscode.window.showTextDocument(reportDocument, vscode.ViewColumn.Beside);
        }
    }

    private evaluateRewriteValidation(validationSummary: string): RewriteValidationCheck {
        if (this.isParserValidationSuccessful(validationSummary)) {
            return {
                hasBlockingErrors: false,
                warningCount: 0,
                issueCount: 0
            };
        }

        const aggregateMatch = validationSummary.match(
            /found\s+(\d+)\s+error\(s\)\s+and\s+(\d+)\s+warning\(s\);\s+unified quality checks found\s+(\d+)\s+issue\(s\)/i
        );
        const parserErrors = aggregateMatch ? Number(aggregateMatch[1]) : 0;
        const parserWarnings = aggregateMatch ? Number(aggregateMatch[2]) : 0;
        const issueCount = aggregateMatch ? Number(aggregateMatch[3]) : 0;
        const hasErrorSeverity = /\[[ \t]*error[ \t]*\]/i.test(validationSummary);

        return {
            hasBlockingErrors: parserErrors > 0 || hasErrorSeverity,
            warningCount: parserWarnings,
            issueCount
        };
    }

    private isExplainPlanComparable(sql: string): boolean {
        const normalized = sql.trim().toUpperCase();
        return /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b/.test(normalized);
    }

    private parseExplainPlanCost(planText: string): number | undefined {
        const matches = planText.matchAll(/cost=\s*[\d.]+\.\.([\d.]+)/gi);
        let maxCost: number | undefined;
        for (const match of matches) {
            const value = Number(match[1]);
            if (Number.isNaN(value)) {
                continue;
            }
            maxCost = maxCost === undefined ? value : Math.max(maxCost, value);
        }
        return maxCost;
    }

    private async evaluatePlanDeltaGuard(originalSql: string, rewrittenSql: string): Promise<RewritePlanDeltaCheck> {
        if (!this.isExplainPlanComparable(originalSql) || !this.isExplainPlanComparable(rewrittenSql)) {
            return {
                attempted: false,
                blockingRegression: false,
                summary: 'Plan delta check skipped (statement type is not supported for safe EXPLAIN comparison).'
            };
        }

        try {
            const baselinePlan = await this.toolsHandler.getExplainPlan(originalSql, false);
            const rewrittenPlan = await this.toolsHandler.getExplainPlan(rewrittenSql, false);
            const baselineCost = this.parseExplainPlanCost(baselinePlan);
            const rewrittenCost = this.parseExplainPlanCost(rewrittenPlan);

            if (baselineCost === undefined || rewrittenCost === undefined) {
                return {
                    attempted: true,
                    blockingRegression: false,
                    summary: 'Plan delta check completed but cost markers could not be parsed reliably.'
                };
            }

            if (baselineCost <= 0) {
                return {
                    attempted: true,
                    blockingRegression: false,
                    summary: 'Plan delta check completed but baseline cost was non-positive; regression gate skipped.',
                    baselineCost,
                    rewrittenCost
                };
            }

            const deltaPercent = ((rewrittenCost - baselineCost) / baselineCost) * 100;
            const threshold = getExtensionConfiguration('copilot')
                .get<number>('rewriteGuard.maxCostIncreasePercent', 20) ?? 20;
            const blockingRegression = deltaPercent > threshold;
            const summary = blockingRegression
                ? `Estimated plan cost increased by ${deltaPercent.toFixed(1)}% (threshold ${threshold.toFixed(1)}%).`
                : `Estimated plan cost delta: ${deltaPercent.toFixed(1)}% (threshold ${threshold.toFixed(1)}%).`;

            return {
                attempted: true,
                blockingRegression,
                summary,
                baselineCost,
                rewrittenCost,
                deltaPercent
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                attempted: false,
                blockingRegression: false,
                summary: `Plan delta check unavailable: ${msg}`
            };
        }
    }

    private buildRewriteGuardReport(
        actionLabel: string,
        originalSql: string,
        rewrittenSql: string,
        validationSummary: string,
        validationCheck: RewriteValidationCheck,
        planDeltaCheck: RewritePlanDeltaCheck,
        blocked: boolean
    ): string {
        const decision = blocked
            ? 'BLOCKED - Rewrite did not pass regression guard checks.'
            : 'PASSED - Rewrite passed regression guard checks.';
        const planCostLine = planDeltaCheck.baselineCost !== undefined && planDeltaCheck.rewrittenCost !== undefined
            ? `- Baseline cost: ${planDeltaCheck.baselineCost}\n- Rewritten cost: ${planDeltaCheck.rewrittenCost}\n- Delta: ${planDeltaCheck.deltaPercent?.toFixed(1) ?? 'n/a'}%`
            : '- Cost comparison: unavailable';

        return `# ${actionLabel} - AI Rewrite Guard Report

## Decision
${decision}

## Validation Gate
- Blocking errors detected: ${validationCheck.hasBlockingErrors ? 'yes' : 'no'}
- Parser warning count: ${validationCheck.warningCount}
- Unified issue count: ${validationCheck.issueCount}

\`\`\`
${validationSummary}
\`\`\`

## Optional Plan Delta Gate
- Check attempted: ${planDeltaCheck.attempted ? 'yes' : 'no'}
- Blocking regression: ${planDeltaCheck.blockingRegression ? 'yes' : 'no'}
- Summary: ${planDeltaCheck.summary}
${planCostLine}

## Original SQL
\`\`\`sql
${originalSql}
\`\`\`

## Rewritten SQL
\`\`\`sql
${rewrittenSql}
\`\`\`
`;
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
 * Fixes SQL error by sending error message and SQL to Copilot Chat
 * Called from Results panel when an error occurs
 */
public async fixSqlError(errorMessage: string, sql: string): Promise<void> {
    try {
        if (!sql.trim()) {
            vscode.window.showWarningMessage('No SQL to fix');
            return;
        }

        // Privacy confirmation - user must accept before sending data
        const contextSummary = `• SQL code (${sql.length} characters)\n• Error message\n• Table DDL schemas (if referenced)`;
        const confirmed = await this.confirmDataTransmission('Fix SQL Error', contextSummary);
        if (!confirmed) {
            vscode.window.showInformationMessage('Operation cancelled - no data was sent.');
            return;
        }

        // Show progress while gathering DDL
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Gathering table DDL for Copilot...',
            cancellable: false
        }, async () => {
                // Gather DDL for tables referenced in the SQL
                const ddlContext = await this.contextBuilder.getSchemaForSql(sql);

                const fixPrompt = this.promptManager.getPrompt('fix');
                const dialectDisplayName = this.resolveCopilotDialectContext().displayName;

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

                // Add DDL context if available
                if (ddlContext && !ddlContext.includes('No table references') && !ddlContext.includes('Could not gather DDL')) {
                    prompt += `
**Referenced Table Schemas (DDL):**
\`\`\`sql
${ddlContext}
\`\`\`
`;
                }

                // Add NZPLSQL reference if code contains stored procedure
                if (this.responseHandler.isProcedureCode(sql)) {
                    prompt += `\n${this.getNetezzaReference('nzplsql')}\n`;
                }

                prompt += `
Please:
1. Explain what caused this error
2. Provide the corrected SQL query
3. Explain the fix you made`;

                // Open Copilot Chat with the prompt
                await vscode.commands.executeCommand(
                    'workbench.action.chat.open',
                    { query: prompt }
                );
            });

            vscode.window.showInformationMessage('✅ Error sent to Copilot Chat for fixing. Check the Chat panel.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to send error to Copilot: ${msg}`);
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

    public async executeSelectQuery(sql: string, maxRows: number, database?: string): Promise<string> {
        return this.toolsHandler.executeSelectQuery(sql, maxRows, database);
    }

    public async getExplainPlan(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.toolsHandler.getExplainPlan(sql, verbose, database);
    }

    public async getExplainPlanAnalysis(sql: string, verbose: boolean, database?: string): Promise<string> {
        return this.toolsHandler.getExplainPlanAnalysis(sql, verbose, database);
    }

    public async getSchemaForSql(sql: string): Promise<string> {
        return this.contextBuilder.getSchemaForSql(sql);
    }

    public async getSchemaContextForCurrentSql(): Promise<string> {
        const copilotContext = await this.gatherContext();
        return copilotContext.ddlContext;
    }

    public async getSampleData(table: string, database: string | undefined, sampleSize: number): Promise<string> {
        return this.toolsHandler.getSampleData(table, database, sampleSize);
    }

    public async tableStats(table: string): Promise<string> {
        return this.toolsHandler.tableStats(table);
    }

    public async getTableStats(table: string, database?: string, mode: 'quick' | 'deep' = 'quick'): Promise<string> {
        return this.toolsHandler.getTableStats(table, database, mode);
    }

    public async getTuningAdvice(
        sql?: string,
        database?: string,
        analyzeAllTables: boolean = true,
        maxTables: number = 5
    ): Promise<string> {
        return this.toolsHandler.getTuningAdvice(sql, database, analyzeAllTables, maxTables);
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

    public async getObjectDefinition(objectName: string, objectType: 'view' | 'procedure', database?: string): Promise<string> {
        return this.toolsHandler.getObjectDefinition(objectName, objectType, database);
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

    public async getSqlDiagnostics(includeWarnings: boolean = true): Promise<string> {
        return this.toolsHandler.getSqlDiagnostics(includeWarnings);
    }

    public async inspectImportFile(filePath: string, sampleRows: number = 5): Promise<string> {
        return this.toolsHandler.inspectImportFile(filePath, sampleRows);
    }

    public async compileProcedure(sql: string, database?: string): Promise<string> {
        return this.toolsHandler.compileProcedure(sql, database);
    }

    public async executeProcedure(procedureName: string, args?: string, database?: string): Promise<string> {
        return this.toolsHandler.executeProcedure(procedureName, args, database);
    }

    public async runDiagnosticQueries(queries: string[], database?: string): Promise<string> {
        return this.toolsHandler.runDiagnosticQueries(queries, database);
    }

    public async proposeImportMapping(filePath: string, targetTable: string): Promise<string> {
        return this.toolsHandler.proposeImportMapping(filePath, targetTable);
    }

    public async executeImport(
        filePath: string,
        targetTable: string,
        dryRun: boolean = true,
        timeoutSeconds?: number
    ): Promise<string> {
        return this.toolsHandler.executeImport(filePath, targetTable, dryRun, timeoutSeconds);
    }

    public async exportQueryResults(
        sql?: string,
        format?: string,
        outputPath?: string,
        timeoutSeconds?: number,
        source?: 'sql' | 'activeResults',
        sqlFilePath?: string
    ): Promise<string> {
        return this.toolsHandler.exportQueryResults(sql, format, outputPath, timeoutSeconds, source, sqlFilePath);
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

    /**
     * Diagnostic method: Shows available Language Models
     */
    public async showAvailableModels(): Promise<void> {
        try {
            const allModels = await vscode.lm.selectChatModels();

            if (allModels.length === 0) {
                vscode.window.showWarningMessage('No Language Models available');
                return;
            }

            const modelInfo = allModels.map(m =>
                `• ${m.id}\n  Vendor: ${m.vendor}\n  Family: ${m.family}\n`
            ).join('\n');

            const copilotModels = allModels.filter(m => m.vendor === 'copilot');

            const doc = await vscode.workspace.openTextDocument({
                content: `# Available Language Models\n\n` +
                    `Total models: ${allModels.length}\n` +
                    `Copilot models: ${copilotModels.length}\n\n` +
                    `## All Models\n\n${modelInfo}`,
                language: 'markdown'
            });

            await vscode.window.showTextDocument(doc);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Error getting models: ${msg}`);
        }
    }

    // =================================================================================
    // Chat Participant Registration
    // =================================================================================

    /**
     * Registers the @sql-copilot chat participant with handlers for /schema, /optimize, /fix, /explain commands.
     * This allows users to use #schema-like functionality through slash commands in the Copilot Chat.
     */
    public registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable | undefined {
        try {
            // Create chat participant handler
            const handler: vscode.ChatRequestHandler = async (
                request: vscode.ChatRequest,
                chatContext: vscode.ChatContext,
                stream: vscode.ChatResponseStream,
                token: vscode.CancellationToken
            ) => {
                try {
                    // Handle different commands
                    if (request.command === 'schema') {
                        return await this.handleSchemaCommand(request, chatContext, stream, token);
                    } else if (request.command === 'optimize') {
                        return await this.handleOptimizeCommand(request, chatContext, stream, token);
                    } else if (request.command === 'fix') {
                        return await this.handleFixCommand(request, chatContext, stream, token);
                    } else if (request.command === 'explain') {
                        return await this.handleExplainCommand(request, chatContext, stream, token);
                    } else if (request.command === 'best-practices') {
                        return await this.handleBestPracticesCommand(request, chatContext, stream, token);
                    } else {
                        // Default: handle as general SQL question with context
                        return await this.handleGeneralQuery(request, chatContext, stream, token);
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    stream.markdown(`❌ Error: ${msg}`);
                    return { metadata: { error: msg } };
                }
            };

            // Create the chat participant
            const participant = vscode.chat.createChatParticipant('netezza.sqlcopilot', handler);
            participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

            // Add follow-up suggestions
            participant.followupProvider = {
                provideFollowups: (result, _context, _token) => {
                    const metadata = result.metadata as { command?: string };
                    if (metadata?.command === 'schema') {
                        return [
                            { prompt: 'Optimize the query for these tables', label: 'Optimize query', command: 'optimize' },
                            { prompt: 'Explain how these tables relate', label: 'Explain schema' }
                        ];
                    }
                    return [];
                }
            };

            logWithFallback('info', '[CopilotService] Chat participant @sql-copilot registered successfully');
            return participant;
        } catch (e) {
            logWithFallback('error', '[CopilotService] Failed to register chat participant:', e);
            return undefined;
        }
    }

    /**
     * Handles /schema command - extracts tables from current SQL and returns their DDL
     */
    private async handleSchemaCommand(
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        _token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Analyzing SQL for table references...');

        // Get current editor content
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            stream.markdown('⚠️ No SQL file is currently open. Please open a SQL file first.');
            return { metadata: { command: 'schema', success: false } };
        }

        const document = editor.document;
        const selection = editor.selection;
        const sql = selection.isEmpty ? document.getText() : document.getText(selection);

        if (!sql.trim()) {
            stream.markdown('⚠️ No SQL content found. Please enter some SQL or open a SQL file.');
            return { metadata: { command: 'schema', success: false } };
        }

        // Extract table references
        const tableRefs = this.tableExtractor.extract(sql);

        if (tableRefs.length === 0) {
            stream.markdown('ℹ️ No table references found in the current SQL.\n\nMake sure your SQL contains `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, or `DELETE FROM` clauses.');
            return { metadata: { command: 'schema', success: false } };
        }

        stream.progress(`Found ${tableRefs.length} table(s). Fetching DDL...`);

        // Get connection name
        const connectionName = this.connectionManager.getDocumentConnection(document.uri.toString())
            || this.connectionManager.getActiveConnectionName()
            || undefined;

        // Gather DDL
        const ddlContext = await this.contextBuilder.getSchemaForSql(sql);

        // Format response
        stream.markdown(`## 📊 Schema Context for Current SQL\n\n`);
        stream.markdown(`**Connection:** ${connectionName || 'Not connected'}\n\n`);
        stream.markdown(`**Tables found:** ${tableRefs.map(t => `\`${t.database ? t.database + '.' : ''}${t.schema ? t.schema + '.' : ''}${t.name}\``).join(', ')}\n\n`);

        if (ddlContext.includes('CREATE TABLE') || ddlContext.includes('-- Table:')) {
            stream.markdown(`### Table Definitions (DDL)\n\n\`\`\`sql\n${ddlContext}\n\`\`\`\n`);
        } else {
            stream.markdown(`### Schema Information\n\n${ddlContext}\n`);
        }

        // Add reference to the file
        if (document.uri.scheme === 'file') {
            stream.reference(document.uri);
        }

        // If user provided additional prompt, add that context
        if (request.prompt.trim()) {
            stream.markdown(`\n---\n\n**Your question:** ${request.prompt}\n\n`);
            stream.markdown(`*Use the schema information above to answer your question about the SQL.*`);
        }

        return { metadata: { command: 'schema', success: true, tableCount: tableRefs.length } };
    }

    /**
     * Handles /optimize command - optimizes SQL with Netezza best practices
     */
    private async handleOptimizeCommand(
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Gathering context and optimizing SQL...');

        const copilotContext = await this.gatherContext();
        const basePrompt = this.promptManager.getPrompt('optimize');
        let prompt = `${basePrompt}\n\n${this.getNetezzaReference('optimization')}`;

        if (this.responseHandler.isProcedureCode(copilotContext.selectedSql)) {
            prompt += `\n\n${this.getNetezzaReference('nzplsql')}`;
        }

        if (request.prompt.trim()) {
            prompt += `\n\nAdditional user instructions: ${request.prompt}`;
        }

        // Build messages for the model
        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\n${prompt}`;

        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];

        // Use the request's model to generate response
        const response = await request.model.sendRequest(messages, {}, token);

        for await (const chunk of response.text) {
            stream.markdown(chunk);
        }

        return { metadata: { command: 'optimize', success: true } };
    }

    /**
     * Handles /best-practices command - rewrites SQL to Netezza best practices
     */
    private async handleBestPracticesCommand(
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Analyzing SQL for Netezza best practices...');

        const copilotContext = await this.gatherContext();
        const basePrompt = this.promptManager.getPrompt('bestPractices');
        let prompt = `${basePrompt}\n\n${this.getNetezzaReference('optimization')}`;

        if (this.responseHandler.isProcedureCode(copilotContext.selectedSql)) {
            prompt += `\n\n${this.getNetezzaReference('nzplsql')}`;
        }

        if (request.prompt.trim()) {
            prompt += `\n\nAdditional user instructions: ${request.prompt}`;
        }

        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\n${prompt}`;

        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
        const response = await request.model.sendRequest(messages, {}, token);

        for await (const chunk of response.text) {
            stream.markdown(chunk);
        }

        return { metadata: { command: 'best-practices', success: true } };
    }

    /**
     * Handles /fix command - fixes SQL syntax errors
     */
    private async handleFixCommand(
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Analyzing SQL for errors...');

        const copilotContext = await this.gatherContext();
        let prompt = this.promptManager.getPrompt('fix');

        if (this.responseHandler.isProcedureCode(copilotContext.selectedSql)) {
            prompt += `\n\n${this.getNetezzaReference('nzplsql')}`;
        }

        if (request.prompt.trim()) {
            prompt += `\n\nAdditional context about the error: ${request.prompt}`;
        }

        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\n${prompt}`;

        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
        const response = await request.model.sendRequest(messages, {}, token);

        for await (const chunk of response.text) {
            stream.markdown(chunk);
        }

        return { metadata: { command: 'fix', success: true } };
    }

    /**
     * Handles /explain command - explains what the SQL does
     */
    private async handleExplainCommand(
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Analyzing SQL...');

        const copilotContext = await this.gatherContext();
        let prompt = this.promptManager.getPrompt('explain');

        if (request.prompt.trim()) {
            prompt += `\n\nFocus on: ${request.prompt}`;
        }

        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\n${prompt}`;

        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
        const response = await request.model.sendRequest(messages, {}, token);

        for await (const chunk of response.text) {
            stream.markdown(chunk);
        }

        return { metadata: { command: 'explain', success: true } };
    }

    /**
     * Handles general queries without specific command
     */
    private async handleGeneralQuery(
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Processing your SQL question...');

        // Try to gather context if there's an open SQL file
        let copilotContext: CopilotContext;
        try {
            copilotContext = await this.gatherContext();
        } catch {
            // No active editor or no SQL - use minimal context
            const connectionName = this.connectionManager.getActiveConnectionName();
            copilotContext = {
                selectedSql: '',
                ddlContext: 'No SQL file open',
                variables: '',
                recentQueries: '',
                connectionInfo: connectionName ? `Connected to: ${connectionName}` : 'No connection',
                workspaceTableProfilesContext: 'No workspace curated tables selected.'
            };
        }

        const systemPrompt = this.promptManager.buildSystemPrompt(copilotContext);
        const fullPrompt = `${systemPrompt}\n\nUser question: ${request.prompt}`;

        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
        
        // Sensitive data tools are excluded unless explicitly enabled in settings.
        const availableTools = this.getAvailableLanguageModelTools();
        
        // Pass tools to enable tool usage
        const options: vscode.LanguageModelChatRequestOptions = {
            tools: availableTools.length > 0 ? availableTools : undefined,
        };
        
        const response = await request.model.sendRequest(messages, options, token);

        // Handle tool calls if the model wants to use tools
        await this.handleToolCalls(response, messages, stream, request, options, token);

        return { metadata: { command: 'general', success: true } };
    }

    /**
     * Handles tool calls from the model response
     * Processes tool calls and sends results back to the model
     */
    private async streamResponseAndCollectToolCalls(
        response: vscode.LanguageModelChatResponse,
        stream: vscode.ChatResponseStream
    ): Promise<vscode.LanguageModelToolCallPart[]> {
        const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
        const responseWithStreams = response as unknown as { stream?: AsyncIterable<unknown>; text?: AsyncIterable<string> };

        if (responseWithStreams.stream) {
            for await (const part of responseWithStreams.stream) {
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallParts.push(part);
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                } else if (typeof part === 'string') {
                    stream.markdown(part);
                }
            }
            return toolCallParts;
        }

        if (responseWithStreams.text) {
            for await (const chunk of responseWithStreams.text) {
                stream.markdown(chunk);
            }
        }

        return toolCallParts;
    }

    private extractToolResultText(content: readonly unknown[] | undefined): string {
        if (!content || content.length === 0) {
            return '';
        }

        const textParts: string[] = [];
        for (const part of content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (typeof part === 'string') {
                textParts.push(part);
            } else if (part !== undefined && part !== null) {
                textParts.push(String(part));
            }
        }

        return textParts.join('\n').trim();
    }

    private createToolResultEnvelope(toolName: string, dataText: string, errorText?: string): string {
        const summary = errorText
            ? `Tool ${toolName} failed.`
            : `Tool ${toolName} executed successfully.`;
        const dataBlock = dataText && dataText.length > 0 ? dataText : '(no data returned)';
        const errors = errorText ? `- ${errorText}` : '- none';
        const nextActions = errorText
            ? '- Verify tool input/connection and retry this tool if needed.'
            : '- Continue with additional tools if more context is needed, then provide final answer.';

        return [
            'summary:',
            summary,
            '',
            'data:',
            dataBlock,
            '',
            'errors:',
            errors,
            '',
            'next-actions:',
            nextActions
        ].join('\n');
    }

    private buildToolFollowUpSuggestions(executedTools: string[]): string[] {
        const suggestions = new Set<string>();

        if (executedTools.some(tool => tool.includes('import'))) {
            suggestions.add('@sql-copilot Validate imported table counts and null rates.');
        }
        if (executedTools.some(tool => tool.includes('export'))) {
            suggestions.add('@sql-copilot Build a filtered export query with only required columns.');
        }
        if (executedTools.some(tool => tool.includes('validate'))) {
            suggestions.add('@sql-copilot /fix Resolve remaining SQL diagnostics.');
        }

        suggestions.add('@sql-copilot /schema');
        suggestions.add('@sql-copilot /explain');

        return Array.from(suggestions).slice(0, 4);
    }

    private async handleToolCalls(
        response: vscode.LanguageModelChatResponse,
        messages: vscode.LanguageModelChatMessage[],
        stream: vscode.ChatResponseStream,
        request: vscode.ChatRequest,
        options: vscode.LanguageModelChatRequestOptions,
        token: vscode.CancellationToken
    ): Promise<void> {
        const maxToolRounds = 4;
        const maxToolCalls = 12;
        let roundsWithTools = 0;
        let totalToolCalls = 0;
        const executedTools: string[] = [];
        let currentResponse = response;

        for (let round = 1; round <= maxToolRounds; round++) {
            const toolCallParts = await this.streamResponseAndCollectToolCalls(currentResponse, stream);

            if (toolCallParts.length === 0) {
                break;
            }

            if (totalToolCalls + toolCallParts.length > maxToolCalls) {
                stream.progress(`Tool budget reached (${maxToolCalls}). Generating final answer...`);
                const finalResponse = await request.model.sendRequest(
                    messages,
                    { ...options, tools: undefined },
                    token
                );
                await this.streamResponseAndCollectToolCalls(finalResponse, stream);
                break;
            }

            roundsWithTools++;
            totalToolCalls += toolCallParts.length;
            stream.progress(`Tool round ${round}/${maxToolRounds}: executing ${toolCallParts.length} call(s)...`);

            const toolResults = await Promise.all(
                toolCallParts.map(async toolCall => {
                    try {
                        const toolResult = await vscode.lm.invokeTool(
                            toolCall.name,
                            {
                                input: toolCall.input,
                                toolInvocationToken: request.toolInvocationToken
                            },
                            token
                        );
                        const resultText = this.extractToolResultText(toolResult.content as readonly unknown[]);
                        return {
                            toolCall,
                            success: true,
                            payload: this.createToolResultEnvelope(toolCall.name, resultText)
                        };
                    } catch (e) {
                        const errorMsg = e instanceof Error ? e.message : String(e);
                        return {
                            toolCall,
                            success: false,
                            payload: this.createToolResultEnvelope(toolCall.name, '', errorMsg)
                        };
                    }
                })
            );

            for (const toolResult of toolResults) {
                messages.push(vscode.LanguageModelChatMessage.Assistant([toolResult.toolCall]));
                messages.push(vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart(toolResult.toolCall.callId, [
                        new vscode.LanguageModelTextPart(toolResult.payload)
                    ])
                ]));

                if (toolResult.success) {
                    executedTools.push(toolResult.toolCall.name);
                }
            }

            if (round === maxToolRounds) {
                stream.progress('Tool round limit reached. Generating final answer...');
                const finalResponse = await request.model.sendRequest(
                    messages,
                    { ...options, tools: undefined },
                    token
                );
                await this.streamResponseAndCollectToolCalls(finalResponse, stream);
                break;
            }

            currentResponse = await request.model.sendRequest(messages, options, token);
        }

        if (roundsWithTools > 0) {
            const suggestions = this.buildToolFollowUpSuggestions(executedTools);
            stream.markdown(
                `\n\n### Tool execution summary\n- Rounds: ${roundsWithTools}\n- Tool calls: ${totalToolCalls}\n- Executed tools: ${executedTools.length > 0 ? executedTools.join(', ') : 'none'}\n`
            );
            stream.markdown(`\n**Suggested next prompts:**\n${suggestions.map(s => `- ${s}`).join('\n')}\n`);
        }
    }
}

// Re-export types and tools for consumers (e.g. extension.ts)
export { CopilotContext, TableReference, WorkspaceTableProfile, UpsertWorkspaceTableProfileInput } from './copilot';
export * from './copilotTools';
