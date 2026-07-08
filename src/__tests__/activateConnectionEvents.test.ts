import * as vscode from 'vscode';
import { activateConnectionEvents } from '../activation/activateConnectionEvents';

jest.mock('vscode');

describe('activateConnectionEvents', () => {
    const updateActiveConnectionStatusBar = jest.fn();
    const updateActiveDatabaseStatusBar = jest.fn();
    const updateKeepConnectionStatusBar = jest.fn();

    let documentConnectionListener: ((documentUri: string) => void) | undefined;
    let documentDatabaseListener: ((documentUri: string) => void) | undefined;
    let visibleEditorsListener: (() => void) | undefined;
    let openTextDocumentListener: ((document: vscode.TextDocument) => void) | undefined;

    const mockConnectionManager = {
        onDidChangeActiveConnection: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeDocumentConnection: jest.fn((listener: (documentUri: string) => void) => {
            documentConnectionListener = listener;
            return { dispose: jest.fn() };
        }),
        onDidChangeDocumentDatabase: jest.fn((listener: (documentUri: string) => void) => {
            documentDatabaseListener = listener;
            return { dispose: jest.fn() };
        }),
        getActiveConnectionName: jest.fn().mockReturnValue('active'),
        getDocumentConnection: jest.fn().mockReturnValue('doc-connection'),
    };

    const mockConnectionAccentDecorationProvider = {
        refresh: jest.fn(),
    };

    const mockContext = {
        subscriptions: [] as vscode.Disposable[],
    } as unknown as vscode.ExtensionContext;

    beforeEach(() => {
        jest.clearAllMocks();
        documentConnectionListener = undefined;
        documentDatabaseListener = undefined;
        visibleEditorsListener = undefined;
        openTextDocumentListener = undefined;

        (vscode.window.onDidChangeActiveTextEditor as jest.Mock).mockImplementation(() => ({ dispose: jest.fn() }));
        (vscode.window.onDidChangeVisibleTextEditors as jest.Mock).mockImplementation((listener: () => void) => {
            visibleEditorsListener = listener;
            return { dispose: jest.fn() };
        });
        (vscode.workspace.onDidOpenTextDocument as jest.Mock).mockImplementation((listener: (document: vscode.TextDocument) => void) => {
            openTextDocumentListener = listener;
            return { dispose: jest.fn() };
        });

        Object.defineProperty(vscode.window, 'activeTextEditor', {
            configurable: true,
            value: {
                document: {
                    uri: { toString: () => 'untitled:Console-prod.sql' },
                },
            },
        });

        activateConnectionEvents({
            context: mockContext,
            connectionManager: mockConnectionManager as never,
            connectionAccentDecorationProvider: mockConnectionAccentDecorationProvider as never,
            statusBarHandlers: {
                updateActiveConnectionStatusBar,
                updateActiveDatabaseStatusBar,
                updateKeepConnectionStatusBar,
            },
            onPrefetchConnection: jest.fn(),
        });
    });

    it('registers visible editor changes to refresh status bars', () => {
        expect(vscode.window.onDidChangeVisibleTextEditors).toHaveBeenCalled();
        expect(visibleEditorsListener).toBeDefined();
    });

    it('does not refresh status bars for inactive document connection changes', () => {
        documentConnectionListener?.('untitled:Console-other.sql');

        expect(mockConnectionAccentDecorationProvider.refresh).toHaveBeenCalled();
        expect(updateActiveConnectionStatusBar).not.toHaveBeenCalled();
        expect(updateActiveDatabaseStatusBar).not.toHaveBeenCalled();
        expect(updateKeepConnectionStatusBar).not.toHaveBeenCalled();
    });

    it('refreshes status bars when the active document connection changes', () => {
        documentConnectionListener?.('untitled:Console-prod.sql');

        expect(updateActiveConnectionStatusBar).toHaveBeenCalled();
        expect(updateActiveDatabaseStatusBar).toHaveBeenCalled();
        expect(updateKeepConnectionStatusBar).toHaveBeenCalled();
    });

    it('updates database status only for the active document database override', () => {
        documentDatabaseListener?.('untitled:Console-other.sql');
        expect(updateActiveDatabaseStatusBar).not.toHaveBeenCalled();

        documentDatabaseListener?.('untitled:Console-prod.sql');
        expect(updateActiveDatabaseStatusBar).toHaveBeenCalledTimes(1);
    });

    it('refreshes status bars when visible editors change', () => {
        visibleEditorsListener?.();

        expect(updateActiveConnectionStatusBar).toHaveBeenCalled();
        expect(updateActiveDatabaseStatusBar).toHaveBeenCalled();
        expect(updateKeepConnectionStatusBar).toHaveBeenCalled();
    });

    it('refreshes status bars when a visible document is reopened as SQL', async () => {
        (vscode.window as unknown as { visibleTextEditors: vscode.TextEditor[] }).visibleTextEditors = [{
            document: {
                uri: { toString: () => 'untitled:Untitled-1' },
            },
        } as vscode.TextEditor];

        openTextDocumentListener?.({
            uri: { toString: () => 'untitled:Untitled-1' },
            languageId: 'sql',
        } as vscode.TextDocument);

        await Promise.resolve();

        expect(updateActiveConnectionStatusBar).toHaveBeenCalled();
        expect(updateActiveDatabaseStatusBar).toHaveBeenCalled();
        expect(updateKeepConnectionStatusBar).toHaveBeenCalled();
    });

    it('does not refresh status bars when a non-SQL document opens in the background', async () => {
        (vscode.window as unknown as { visibleTextEditors: vscode.TextEditor[] }).visibleTextEditors = [];

        openTextDocumentListener?.({
            uri: { toString: () => 'untitled:notes.txt' },
            languageId: 'plaintext',
        } as vscode.TextDocument);

        await Promise.resolve();

        expect(updateActiveConnectionStatusBar).not.toHaveBeenCalled();
        expect(updateActiveDatabaseStatusBar).not.toHaveBeenCalled();
        expect(updateKeepConnectionStatusBar).not.toHaveBeenCalled();
    });
});
