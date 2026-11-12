import * as vscode from 'vscode';
import {
    CopilotService,
    GetContextTool,
    SearchCatalogTool,
    GetObjectDetailsTool,
    ExplainSqlTool,
    ValidateSqlTool,
    ValidateSqlOnDatabaseTool,
    ProcedureRepairTool,
    InspectImportFileTool,
    ProposeImportMappingTool,
    NetezzaReferenceTool
} from '../services/copilotService';
import { withContractEnforcement } from '../services/copilotTools/contractEnforcedTool';
import { isAiToolAllowed } from '../services/copilotTools/aiToolPolicy';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { ResultPanelView } from '../views/resultPanelView';
import { getExtensionConfiguration } from '../compatibility/configuration';

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

function isCopilotEnabled(): boolean {
    return getExtensionConfiguration('copilot').get<boolean>('enabled') ?? true;
}

function showCopilotDisabledMessage(): void {
    void vscode.window.showInformationMessage(
        'AI features are disabled. Enable them with "justybase.copilot.enabled".'
    );
}

export function registerCopilotFeatures(params: CopilotRegistrationParams): CopilotService {
    const { context, connectionManager, metadataCache, resultPanelProvider } = params;
    const copilotService = new CopilotService(connectionManager, context, metadataCache, resultPanelProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('netezza.describeDataWithCopilot', async (data: Record<string, unknown>[], sql?: string) => {
            if (!isCopilotEnabled()) {
                showCopilotDisabledMessage();
                return;
            }
            try {
                await copilotService.describeDataWithCopilot(data, sql);
            } catch (e: unknown) {
                showCopilotError(e);
            }
        }),
        vscode.commands.registerCommand('netezza.fixSqlError', async (errorMessage: string, sql: string) => {
            if (!isCopilotEnabled()) {
                showCopilotDisabledMessage();
                return;
            }
            try {
                await copilotService.fixSqlError(errorMessage, sql);
            } catch (e: unknown) {
                showCopilotError(e);
            }
        })
    );

    if (!isCopilotEnabled()) {
        return copilotService;
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
        { name: 'netezza_get_context', register: () => registerToolWithContract('netezza_get_context', new GetContextTool(copilotService)) },
        { name: 'netezza_search_catalog', register: () => registerToolWithContract('netezza_search_catalog', new SearchCatalogTool(copilotService)) },
        { name: 'netezza_get_object_details', register: () => registerToolWithContract('netezza_get_object_details', new GetObjectDetailsTool(copilotService)) },
        { name: 'netezza_explain_sql', register: () => registerToolWithContract('netezza_explain_sql', new ExplainSqlTool(copilotService)) },
        { name: 'netezza_validate_sql', register: () => registerToolWithContract('netezza_validate_sql', new ValidateSqlTool(copilotService)) },
        { name: 'netezza_validate_sql_on_database', register: () => registerToolWithContract('netezza_validate_sql_on_database', new ValidateSqlOnDatabaseTool(copilotService)) },
        { name: 'netezza_repair_procedure', register: () => registerToolWithContract('netezza_repair_procedure', new ProcedureRepairTool(copilotService)) },
        { name: 'netezza_inspect_import_file', register: () => registerToolWithContract('netezza_inspect_import_file', new InspectImportFileTool(copilotService)) },
        { name: 'netezza_propose_import_mapping', register: () => registerToolWithContract('netezza_propose_import_mapping', new ProposeImportMappingTool(copilotService)) },
        { name: 'netezza_get_dialect_reference', register: () => registerToolWithContract('netezza_get_dialect_reference', new NetezzaReferenceTool(copilotService)) }
    ];
    let hasToolRegistrationFailure = false;

    for (const toolRegistration of toolRegistrations.filter(tool => isAiToolAllowed(tool.name))) {
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
