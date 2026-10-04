import * as vscode from 'vscode';
import { activateEditorSync } from '../activation/activateEditorSync';
import {
    restoreQueryExecutionForReopenedDocument,
    retireQueryExecutionForDocument,
} from '../commands/query/queryExecutionGate';

jest.mock('../commands/query/queryExecutionGate', () => ({
    getQueryExecutionCoordinator: jest.fn(() => ({ getSnapshot: () => [] })),
    restoreQueryExecutionForReopenedDocument: jest.fn(),
    retireQueryExecutionForDocument: jest.fn(),
}));

jest.mock('../services/contextKeyService', () => ({
    setContextIfChanged: jest.fn(),
}));

describe('activateEditorSync document cleanup', () => {
    let closeDocumentListener: ((document: vscode.TextDocument) => void) | undefined;
    let openDocumentListener: ((document: vscode.TextDocument) => void) | undefined;

    beforeEach(() => {
        jest.clearAllMocks();
        closeDocumentListener = undefined;
        openDocumentListener = undefined;
        (vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = undefined;
        (vscode.workspace.onDidOpenTextDocument as jest.Mock).mockImplementation(
            (listener: (document: vscode.TextDocument) => void) => {
                openDocumentListener = listener;
                return { dispose: jest.fn() };
            },
        );
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

    it('restores only the document identity reopened by a language-mode change', () => {
        const connectionManager = {
            clearDocumentConnection: jest.fn().mockResolvedValue(undefined),
            closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
        };
        const document = createDocument('untitled');

        activateEditorSync({
            context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
            connectionManager: connectionManager as never,
            connectionAccentDecorationProvider: { refresh: jest.fn() } as never,
            resultPanelProvider: { closeSource: jest.fn(), setActiveSource: jest.fn() } as never,
            metadataPrefetchCoordinator: { triggerForDocument: jest.fn() } as never,
        });

        closeDocumentListener?.(document);
        openDocumentListener?.(document);

        expect(retireQueryExecutionForDocument).toHaveBeenCalledWith(document);
        expect(restoreQueryExecutionForReopenedDocument).toHaveBeenCalledWith(document);
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

    it('closes every retained independent result source before retiring the document', () => {
        const document=createDocument('untitled');
        const closeSource=jest.fn();
        const sources=['untitled:query.sql','untitled:query.sql#query-old','untitled:query.sql#query-recent'];
        activateEditorSync({context:{subscriptions:[]} as unknown as vscode.ExtensionContext,
            connectionManager:{clearDocumentConnection:jest.fn(async()=>undefined)} as never,
            connectionAccentDecorationProvider:{refresh:jest.fn()} as never,
            resultPanelProvider:{setActiveSource:jest.fn(),closeSource,getExecutionGroupSources:()=>sources} as never,
            metadataPrefetchCoordinator:{triggerForDocument:jest.fn()} as never});
        closeDocumentListener?.(document);
        expect(closeSource.mock.calls.map(([source])=>source)).toEqual([sources[1],sources[2],sources[0]]);
    });
});
