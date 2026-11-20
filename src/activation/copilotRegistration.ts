import * as vscode from 'vscode';
import {
    CopilotService,
    CompileProcedureTool,
    DropObjectTool,
    ExecuteSqlTool,
    ExplainQueryTool,
    GetContextTool,
    GetObjectTool,
    GetReferenceTool,
    InspectImportFileTool,
    ProposeImportMappingTool,
    SearchCatalogTool,
    ValidateSqlTool
} from '../services/copilotService';
import { withContractEnforcement } from '../services/copilotTools/contractEnforcedTool';
import { allowedToolsForSurface, effectiveToolTier } from '../core/assistant/toolPolicy';
import { copilotToolName, type ToolTier } from '../core/assistant/toolCatalog';
import { getAiToolAccessConfig } from '../services/aiToolAccess';
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

    let registrations: vscode.Disposable[] = [];

    const createTool = (id: string, level: ToolTier): vscode.LanguageModelTool<object> | undefined => {
        const allowWrites = level !== 'read';
        const allowDestructive = level === 'destructive';
        switch (id) {
            case 'get_context':
                return new GetContextTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'search_catalog':
                return new SearchCatalogTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'get_object':
                return new GetObjectTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'explain_query':
                return new ExplainQueryTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'validate_sql':
                return new ValidateSqlTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'get_reference':
                return new GetReferenceTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'inspect_import_file':
                return new InspectImportFileTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'propose_import_mapping':
                return new ProposeImportMappingTool(copilotService) as unknown as vscode.LanguageModelTool<object>;
            case 'execute_sql':
                return new ExecuteSqlTool(copilotService, allowDestructive, allowWrites) as unknown as vscode.LanguageModelTool<object>;
            case 'drop_object':
                return new DropObjectTool(copilotService, allowDestructive) as unknown as vscode.LanguageModelTool<object>;
            case 'compile_procedure':
                return new CompileProcedureTool(copilotService, allowWrites, allowDestructive) as unknown as vscode.LanguageModelTool<object>;
            default:
                return undefined;
        }
    };

    const registerTools = (): void => {
        for (const registration of registrations) {
            registration.dispose();
        }
        registrations = [];
        let hasToolRegistrationFailure = false;
        const access = getAiToolAccessConfig();

        for (const tool of allowedToolsForSurface('copilot', access)) {
            try {
                const level = effectiveToolTier(tool, 'copilot', access);
                if (!level) continue;
                const name = copilotToolName(tool.id);
                const instance = createTool(tool.id, level);
                if (!instance) continue;
                registrations.push(languageModelApi.registerTool(name, withContractEnforcement(name, instance)));
            } catch {
                hasToolRegistrationFailure = true;
            }
        }

        if (hasToolRegistrationFailure) {
            showCopilotRegistrationWarning();
        }
    };

    registerTools();

    context.subscriptions.push(
        {
            dispose: () => {
                for (const registration of registrations) {
                    registration.dispose();
                }
                registrations = [];
            }
        },
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('justybase.ai.tools')) {
                registerTools();
            }
        })
    );

    return copilotService;
}
