import * as vscode from 'vscode';
import { activateEditorSync } from '../activation/activateEditorSync';

jest.mock('../commands/query/queryExecutionGate', () => ({
    retireQueryExecutionForDocument: jest.fn(),
}));

jest.mock('../services/contextKeyService', () => ({
    setContextIfChanged: jest.fn(),
}));

describe('activateEditorSync document cleanup', () => {
    let closeDocumentListener: ((document: vscode.TextDocument) => void) | undefined;

    beforeEach(() => {
        jest.clearAllMocks();
        closeDocumentListener = undefined;
        (vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = undefined;
        (vscode.workspace.onDidCloseTextDocument as jest.Mock).mockImplementation(
            (listener: (document: vscode.TextDocument) => void) => {
                closeDocumentListener = listener;
                return { dispose: jest.fn() };
            },
        );
    });

    function createDocument(scheme: string): vscode.TextDocument {
        return {
            uri: { scheme, toString: () => `${scheme}:query.sql` },
            languageId: 'sql',
        } as unknown as vscode.TextDocument;
    }

    it('clears the connection context when an untitled SQL tab closes', async () => {
        const connectionManager = {
            clearDocumentConnection: jest.fn().mockResolvedValue(undefined),
            closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
        };

        activateEditorSync({
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            connectionManager: connectionManager as never,
            connectionAccentDecorationProvider: { refresh: jest.fn() } as never,
            resultPanelProvider: { closeSource: jest.fn(), setActiveSource: jest.fn() } as never,
            metadataPrefetchCoordinator: { triggerForDocument: jest.fn() } as never,
        });

        closeDocumentListener?.(createDocument('untitled'));
        await Promise.resolve();

        expect(connectionManager.clearDocumentConnection).toHaveBeenCalledWith('untitled:query.sql');
        expect(connectionManager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
    });

    it('keeps the durable connection context when a saved SQL file closes', async () => {
        const connectionManager = {
            clearDocumentConnection: jest.fn().mockResolvedValue(undefined),
            closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
        };

        activateEditorSync({
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            connectionManager: connectionManager as never,
            connectionAccentDecorationProvider: { refresh: jest.fn() } as never,
            resultPanelProvider: { closeSource: jest.fn(), setActiveSource: jest.fn() } as never,
            metadataPrefetchCoordinator: { triggerForDocument: jest.fn() } as never,
        });

        closeDocumentListener?.(createDocument('file'));
        await Promise.resolve();

        expect(connectionManager.clearDocumentConnection).not.toHaveBeenCalled();
        expect(connectionManager.closeDocumentPersistentConnection).toHaveBeenCalledWith('file:query.sql');
    });
});
