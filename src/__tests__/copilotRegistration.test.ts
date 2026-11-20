jest.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
    },
    commands: {
        registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    },
    lm: {
        registerTool: jest.fn(() => ({ dispose: jest.fn() })),
    },
    workspace: {
        onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
    },
    MarkdownString: jest.fn(),
}));

jest.mock('../services/copilotTools/contractEnforcedTool', () => ({
    withContractEnforcement: jest.fn((_name: string, tool: unknown) => tool),
}));

jest.mock('../services/copilotService', () => ({
    CopilotService: jest.fn(() => ({ kind: 'copilot-service' })),
    CompileProcedureTool: jest.fn(() => ({ tool: 'compile_procedure' })),
    DropObjectTool: jest.fn(() => ({ tool: 'drop_object' })),
    ExecuteSqlTool: jest.fn(() => ({ tool: 'execute_sql' })),
    ExplainQueryTool: jest.fn(() => ({ tool: 'explain_query' })),
    GetContextTool: jest.fn(() => ({ tool: 'get_context' })),
    GetObjectTool: jest.fn(() => ({ tool: 'get_object' })),
    GetReferenceTool: jest.fn(() => ({ tool: 'get_reference' })),
    InspectImportFileTool: jest.fn(() => ({ tool: 'inspect_import_file' })),
    ProposeImportMappingTool: jest.fn(() => ({ tool: 'propose_import_mapping' })),
    SearchCatalogTool: jest.fn(() => ({ tool: 'search_catalog' })),
    ValidateSqlTool: jest.fn(() => ({ tool: 'validate_sql' })),
}));

jest.mock('../services/aiToolAccess', () => ({
    getAiToolAccessConfig: jest.fn(),
}));

jest.mock('../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(),
}));

import * as vscode from 'vscode';
import { registerCopilotFeatures } from '../activation/copilotRegistration';
import {
    CompileProcedureTool,
    DropObjectTool,
    ExecuteSqlTool,
} from '../services/copilotService';
import { getAiToolAccessConfig } from '../services/aiToolAccess';
import { getExtensionConfiguration } from '../compatibility/configuration';
import { normalizeAiToolAccess } from '../core/assistant/toolPolicy';

const registerTool = vscode.lm.registerTool as jest.Mock;
const onDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration as jest.Mock;
const getAccess = getAiToolAccessConfig as jest.Mock;
const getConfiguration = getExtensionConfiguration as jest.Mock;

function createContext(): vscode.ExtensionContext {
    return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function activate(enabled: boolean | undefined, access: unknown): {
    context: vscode.ExtensionContext;
    service: unknown;
} {
    getConfiguration.mockReturnValue({ get: jest.fn(() => enabled) });
    getAccess.mockReturnValue(normalizeAiToolAccess(access));
    const context = createContext();
    const service = registerCopilotFeatures({
        context,
        connectionManager: {} as never,
        metadataCache: {} as never,
    });
    return { context, service };
}

function registeredToolNames(): string[] {
    return registerTool.mock.calls.map(call => call[0] as string);
}

describe('Copilot tool registration policy', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('does not register tools when Copilot is disabled', () => {
        const { service } = activate(false, { copilot: 'full' });

        expect(service).toEqual({ kind: 'copilot-service' });
        expect(registerTool).not.toHaveBeenCalled();
        expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(2);
    });

    it('defaults to enabled and registers nothing while access is off', () => {
        activate(undefined, {});

        expect(registerTool).not.toHaveBeenCalled();
    });

    it('skips registration when the language model API is unavailable', () => {
        const lm = vscode.lm as { registerTool?: unknown };
        const original = lm.registerTool;
        lm.registerTool = undefined;

        try {
            activate(true, { copilot: 'read-only' });
            expect(registerTool).not.toHaveBeenCalled();
        } finally {
            lm.registerTool = original;
        }
    });

    it('registers read tools only on the read-only profile', () => {
        activate(true, { copilot: 'read-only' });

        const names = registeredToolNames();
        expect(names).toContain('netezza_get_context');
        expect(names).toContain('netezza_search_catalog');
        expect(names).not.toContain('netezza_execute_sql');
        expect(names).not.toContain('netezza_drop_object');
        expect(names).not.toContain('netezza_compile_procedure');
    });

    it('registers write tools without destructive access on read-write', () => {
        activate(true, { copilot: 'read-write' });

        expect(registeredToolNames()).toContain('netezza_execute_sql');
        expect(registeredToolNames()).toContain('netezza_compile_procedure');
        expect(registeredToolNames()).not.toContain('netezza_drop_object');
        expect(ExecuteSqlTool).toHaveBeenCalledWith(expect.anything(), false, true);
        expect(CompileProcedureTool).toHaveBeenCalledWith(expect.anything(), true, false);
    });

    it('grants destructive access on the full profile', () => {
        activate(true, { copilot: 'full' });

        expect(registeredToolNames()).toContain('netezza_execute_sql');
        expect(registeredToolNames()).toContain('netezza_drop_object');
        expect(registeredToolNames()).toContain('netezza_compile_procedure');
        expect(ExecuteSqlTool).toHaveBeenCalledWith(expect.anything(), true, true);
        expect(DropObjectTool).toHaveBeenCalledWith(expect.anything(), true);
        expect(CompileProcedureTool).toHaveBeenCalledWith(expect.anything(), true, true);
    });

    it('reports a registration failure without aborting activation', () => {
        registerTool.mockImplementationOnce(() => {
            throw new Error('LM unavailable');
        });

        activate(true, { copilot: 'read-only' });

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            'JustyBase AI/Copilot could not be fully initialized. Some AI functions may not work correctly in this session.'
        );
    });

    it('re-registers only when the AI tool setting changes', () => {
        activate(true, { copilot: 'read-only' });
        const handler = onDidChangeConfiguration.mock.calls[0]?.[0] as (event: {
            affectsConfiguration(key: string): boolean;
        }) => void;
        registerTool.mockClear();

        handler({ affectsConfiguration: () => false });
        expect(registerTool).not.toHaveBeenCalled();

        handler({ affectsConfiguration: key => key === 'justybase.ai.tools' });
        expect(registerTool).toHaveBeenCalled();
    });
});
