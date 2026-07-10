import * as vscode from 'vscode';

import { registerSqlLanguageFeatures } from '../activation/sqlLanguageRegistration';

jest.mock('vscode', () => ({
    CodeActionKind: {
        QuickFix: { value: 'quickfix' },
    },
    CodeAction: jest.fn().mockImplementation((title: string, kind: unknown) => ({ title, kind })),
    languages: {
        registerFoldingRangeProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentSymbolProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerSignatureHelpProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerCodeLensProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentSemanticTokensProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentFormattingEditProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerDocumentRangeFormattingEditProvider: jest.fn(() => ({ dispose: jest.fn() })),
        registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
    },
    workspace: {
        onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    },
    commands: {
        registerCommand: jest.fn(() => ({ dispose: jest.fn() }))
    },
    window: {
        activeTextEditor: undefined,
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn()
    }
}));

jest.mock('../providers/foldingProvider', () => ({
    NetezzaFoldingRangeProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/documentSymbolProvider', () => ({
    NetezzaDocumentSymbolProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/signatureHelpProvider', () => ({
    NetezzaSignatureHelpProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../editors/sqlShortcuts', () => ({
    registerSqlShortcuts: jest.fn()
}));

jest.mock('../providers/parserHoverProvider', () => ({
    NetezzaParserHoverProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/sqlCodeLensProvider', () => ({
    SqlCodeLensProvider: jest.fn().mockImplementation(() => ({
        dispose: jest.fn()
    }))
}));

jest.mock('../providers/sqlDataAffordanceResolver', () => ({
    SqlDataAffordanceResolver: jest.fn().mockImplementation(() => ({

    }))
}));

jest.mock('../providers/semanticTokensProvider', () => ({
    NetezzaSemanticTokensProvider: jest.fn().mockImplementation(() => ({
        getLegend: jest.fn().mockReturnValue({ tokenTypes: [], tokenModifiers: [] })
    }))
}));

jest.mock('../providers/sqlSelectionActionHoverProvider', () => ({
    SqlSelectionActionHoverProvider: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../providers/sqlExecutionCodeActions', () => ({
    SqlExecutionCodeActionProvider: jest.fn().mockImplementation(() => ({
        providedCodeActionKinds: [{ value: 'quickfix' }],
    })),
}));

jest.mock('../providers/sqlFormattingProvider', () => ({
    SqlFormattingProvider: jest.fn().mockImplementation(() => ({}))
}));

describe('registerSqlLanguageFeatures', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    const createParams = () => ({
        context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
        metadataCache: {
            onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })),
            onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })),
        } as never,
        connectionManager: {
            onDidChangeDocumentConnection: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeDocumentDatabase: jest.fn(() => ({ dispose: jest.fn() })),
        } as never
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterAll(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it('always registers parser and selection hover providers regardless of NODE_ENV', () => {
        process.env.NODE_ENV = 'production';

        registerSqlLanguageFeatures(createParams());

        expect(vscode.languages.registerHoverProvider).toHaveBeenCalledTimes(2);
        expect(vscode.languages.registerCodeActionsProvider).toHaveBeenCalledTimes(1);
    });

    it('registers parser and selection hover providers in test mode', () => {
        process.env.NODE_ENV = 'test';

        registerSqlLanguageFeatures(createParams());

        expect(vscode.languages.registerHoverProvider).toHaveBeenCalledTimes(2);
        expect(vscode.languages.registerCodeActionsProvider).toHaveBeenCalledTimes(1);
    });
});