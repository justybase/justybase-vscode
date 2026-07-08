import * as vscode from 'vscode';
import {
    CopilotService,
    SchemaTool,
    ColumnsTool,
    TablesTool,
    ExecuteQueryTool,
    SampleDataTool,
    ExplainPlanTool,
    TuningAdviceTool,
    SearchSchemaTool,
    TableStatsTool,
    DependenciesTool,
    ValidateSqlTool,
    ValidateSqlOnDatabaseTool,
    GetSqlDiagnosticsTool,
    InspectImportFileTool,
    ProposeImportMappingTool,
    ExecuteImportTool,
    ExportQueryResultsTool,
    DatabasesTool,
    SchemasTool,
    ProceduresTool,
    ViewsTool,
    ExternalTablesTool,
    FindTableLocationsTool,
    GetCommentsTool,
    FavoritesTool,
    GetDDLTool,
    CompileProcedureTool,
    ExecuteProcedureTool,
    RunDiagnosticQueriesTool
} from '../services/copilotService';
import { withContractEnforcement } from '../services/copilotTools/contractEnforcedTool';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { ResultPanelView } from '../views/resultPanelView';

interface CopilotRegistrationParams {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    metadataCache: MetadataCache;
    resultPanelProvider?: ResultPanelView;
}

function showCopilotError(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Copilot Error: ${msg}`);
}

function showCopilotRegistrationWarning(): void {
    void vscode.window.showWarningMessage(
        'JustyBase AI/Copilot could not be fully initialized. Some AI functions may not work correctly in this session.'
    );
}

export function registerCopilotFeatures(params: CopilotRegistrationParams): CopilotService {
    const { context, connectionManager, metadataCache, resultPanelProvider } = params;
    const copilotService = new CopilotService(connectionManager, context, metadataCache, resultPanelProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('netezza.copilotFixSql', async () => {
            try {
                await copilotService.fixSql();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilotOptimizeSql', async () => {
            try {
                await copilotService.optimizeSql();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilotExplainSql', async () => {
            try {
                await copilotService.explainSql();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilotCustomQuestion', async () => {
            try {
                await copilotService.askCustomQuestion();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilotGenerateSql', async () => {
            try {
                await copilotService.generateSqlInteractive();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilotBestPractices', async () => {
            try {
                await copilotService.bestPracticesSql();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilot.changeModel', async () => {
            try {
                await copilotService.changeModel();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.copilot.clearModel', async () => {
            try {
                await copilotService.clearPersistedModel();
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.describeDataWithCopilot', async (data: Record<string, unknown>[], sql?: string) => {
            try {
                await copilotService.describeDataWithCopilot(data, sql);
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.fixSqlError', async (errorMessage: string, sql: string) => {
            try {
                await copilotService.fixSqlError(errorMessage, sql);
            } catch (e: unknown) {
                showCopilotError(e);
            }
        })
    );

    const sqlCopilotParticipant = copilotService.registerChatParticipant(context);
    if (sqlCopilotParticipant) {
        context.subscriptions.push(sqlCopilotParticipant);
    }

    const languageModelApi = (vscode as typeof vscode & { lm?: typeof vscode.lm }).lm;
    if (!languageModelApi?.registerTool) {
        return copilotService;
    }

    const registerToolWithContract = <TInput extends object>(
        toolName: string,
        tool: vscode.LanguageModelTool<TInput>
    ): vscode.Disposable => languageModelApi.registerTool(toolName, withContractEnforcement(toolName, tool));

    const toolRegistrations: Array<{ name: string; register: () => vscode.Disposable }> = [
        { name: 'netezza_get_sql_schema', register: () => registerToolWithContract('netezza_get_sql_schema', new SchemaTool(copilotService)) },
        { name: 'netezza_get_columns', register: () => registerToolWithContract('netezza_get_columns', new ColumnsTool(copilotService)) },
        { name: 'netezza_get_tables', register: () => registerToolWithContract('netezza_get_tables', new TablesTool(copilotService)) },
        { name: 'netezza_execute_query', register: () => registerToolWithContract('netezza_execute_query', new ExecuteQueryTool(copilotService)) },
        { name: 'netezza_get_sample_data', register: () => registerToolWithContract('netezza_get_sample_data', new SampleDataTool(copilotService)) },
        { name: 'netezza_explain_plan', register: () => registerToolWithContract('netezza_explain_plan', new ExplainPlanTool(copilotService)) },
        { name: 'netezza_get_tuning_advice', register: () => registerToolWithContract('netezza_get_tuning_advice', new TuningAdviceTool(copilotService)) },
        { name: 'netezza_search_schema', register: () => registerToolWithContract('netezza_search_schema', new SearchSchemaTool(copilotService)) },
        { name: 'netezza_get_table_stats', register: () => registerToolWithContract('netezza_get_table_stats', new TableStatsTool(copilotService)) },
        { name: 'netezza_get_dependencies', register: () => registerToolWithContract('netezza_get_dependencies', new DependenciesTool(copilotService)) },
        { name: 'netezza_validate_sql', register: () => registerToolWithContract('netezza_validate_sql', new ValidateSqlTool(copilotService)) },
        { name: 'netezza_validate_sql_on_database', register: () => registerToolWithContract('netezza_validate_sql_on_database', new ValidateSqlOnDatabaseTool(copilotService)) },
        { name: 'netezza_get_sql_diagnostics', register: () => registerToolWithContract('netezza_get_sql_diagnostics', new GetSqlDiagnosticsTool(copilotService)) },
        { name: 'netezza_inspect_import_file', register: () => registerToolWithContract('netezza_inspect_import_file', new InspectImportFileTool(copilotService)) },
        { name: 'netezza_propose_import_mapping', register: () => registerToolWithContract('netezza_propose_import_mapping', new ProposeImportMappingTool(copilotService)) },
        { name: 'netezza_execute_import', register: () => registerToolWithContract('netezza_execute_import', new ExecuteImportTool(copilotService)) },
        { name: 'netezza_export_query_results', register: () => registerToolWithContract('netezza_export_query_results', new ExportQueryResultsTool(copilotService)) },
        { name: 'netezza_get_databases', register: () => registerToolWithContract('netezza_get_databases', new DatabasesTool(copilotService)) },
        { name: 'netezza_get_schemas', register: () => registerToolWithContract('netezza_get_schemas', new SchemasTool(copilotService)) },
        { name: 'netezza_get_procedures', register: () => registerToolWithContract('netezza_get_procedures', new ProceduresTool(copilotService)) },
        { name: 'netezza_get_views', register: () => registerToolWithContract('netezza_get_views', new ViewsTool(copilotService)) },
        { name: 'netezza_get_external_tables', register: () => registerToolWithContract('netezza_get_external_tables', new ExternalTablesTool(copilotService)) },
        { name: 'netezza_find_table_locations', register: () => registerToolWithContract('netezza_find_table_locations', new FindTableLocationsTool(copilotService)) },
        { name: 'netezza_get_comments', register: () => registerToolWithContract('netezza_get_comments', new GetCommentsTool(copilotService)) },
        { name: 'netezza_get_favorites', register: () => registerToolWithContract('netezza_get_favorites', new FavoritesTool(copilotService)) },
        { name: 'netezza_get_ddl', register: () => registerToolWithContract('netezza_get_ddl', new GetDDLTool(copilotService)) },
        { name: 'netezza_compile_procedure', register: () => registerToolWithContract('netezza_compile_procedure', new CompileProcedureTool(copilotService)) },
        { name: 'netezza_execute_procedure', register: () => registerToolWithContract('netezza_execute_procedure', new ExecuteProcedureTool(copilotService)) },
        { name: 'netezza_run_diagnostic_queries', register: () => registerToolWithContract('netezza_run_diagnostic_queries', new RunDiagnosticQueriesTool(copilotService)) }
    ];
    let hasToolRegistrationFailure = false;

    for (const toolRegistration of toolRegistrations) {
        try {
            context.subscriptions.push(toolRegistration.register());
        } catch {
            hasToolRegistrationFailure = true;
        }
    }

    if (hasToolRegistrationFailure) {
        showCopilotRegistrationWarning();
    }

    return copilotService;
}
