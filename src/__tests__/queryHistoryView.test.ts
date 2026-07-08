import * as vscode from 'vscode';
import { QueryHistoryView } from '../views/queryHistoryView';

jest.mock('../core/queryHistoryManager', () => ({
    QueryHistoryManager: {
        getInstance: jest.fn()
    }
}));

import { QueryHistoryManager } from '../core/queryHistoryManager';

const getInstanceMock = QueryHistoryManager.getInstance as unknown as jest.Mock;

interface HistoryEntry {
    id: string;
    host: string;
    database: string;
    schema: string;
    query: string;
    timestamp: number;
    tags?: string;
    description?: string;
    is_favorite?: boolean;
}

describe('QueryHistoryView', () => {
    let historyView: QueryHistoryView;
    let extensionUri: vscode.Uri;
    let context: vscode.ExtensionContext;
    let messageHandler: ((message: { type: string; [key: string]: unknown }) => Promise<void>) | undefined;
    let disposeHandler: (() => void) | undefined;
    let historyListener: ((entry: HistoryEntry) => void) | undefined;

    const mockHistoryManager = {
        onDidAddEntry: jest.fn(),
        getHistory: jest.fn(),
        getStats: jest.fn(),
        searchArchive: jest.fn(),
        searchAll: jest.fn(),
        clearHistory: jest.fn(),
        deleteEntry: jest.fn(),
        toggleFavorite: jest.fn(),
        updateEntry: jest.fn(),
        getFavorites: jest.fn(),
        getByTag: jest.fn(),
        getAllTags: jest.fn()
    };

    const createWebviewView = (): vscode.WebviewView =>
        ({
            webview: {
                options: {},
                html: '',
                cspSource: 'mock-csp',
                postMessage: jest.fn().mockResolvedValue(true),
                asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
                onDidReceiveMessage: jest.fn((handler: (message: unknown) => Promise<void>) => {
                    messageHandler = handler as (message: { type: string; [key: string]: unknown }) => Promise<void>;
                    return { dispose: jest.fn() };
                })
            },
            onDidDispose: jest.fn((handler: () => void) => {
                disposeHandler = handler;
                return { dispose: jest.fn() };
            })
        }) as unknown as vscode.WebviewView;

    beforeEach(() => {
        jest.clearAllMocks();
        messageHandler = undefined;
        disposeHandler = undefined;
        historyListener = undefined;

        extensionUri = {
            fsPath: 'D:\\ext',
            toString: () => 'file:///D:/ext'
        } as vscode.Uri;
        context = {
            extensionUri,
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        mockHistoryManager.onDidAddEntry.mockImplementation((listener: (entry: HistoryEntry) => void) => {
            historyListener = listener;
            return { dispose: jest.fn() };
        });
        mockHistoryManager.getHistory.mockResolvedValue([
            {
                id: 'h1',
                host: 'localhost',
                database: 'TEST',
                schema: 'PUBLIC',
                query: 'SELECT 1',
                timestamp: Date.now(),
                tags: 'tagA',
                description: 'desc'
            }
        ]);
        mockHistoryManager.getStats.mockResolvedValue({
            activeEntries: 1,
            archivedEntries: 0,
            totalEntries: 1,
            activeFileSizeMB: 0.1,
            archiveFileSizeMB: 0,
            totalFileSizeMB: 0.1
        });
        mockHistoryManager.searchAll.mockResolvedValue([]);
        mockHistoryManager.searchArchive.mockResolvedValue([]);
        mockHistoryManager.clearHistory.mockResolvedValue(undefined);
        mockHistoryManager.deleteEntry.mockResolvedValue(undefined);
        mockHistoryManager.toggleFavorite.mockResolvedValue(undefined);
        mockHistoryManager.updateEntry.mockResolvedValue(undefined);
        mockHistoryManager.getFavorites.mockResolvedValue([]);
        mockHistoryManager.getByTag.mockResolvedValue([]);
        mockHistoryManager.getAllTags.mockResolvedValue(['tagA', 'tagB']);

        getInstanceMock.mockReturnValue(mockHistoryManager);

        (vscode.window as unknown as { showWarningMessage: jest.Mock }).showWarningMessage = jest.fn();
        (vscode.window as unknown as { showInformationMessage: jest.Mock }).showInformationMessage = jest.fn();
        (vscode.window as unknown as { showErrorMessage: jest.Mock }).showErrorMessage = jest.fn();
        (vscode.window as unknown as { showInputBox: jest.Mock }).showInputBox = jest.fn();
        (vscode.window as unknown as { showQuickPick: jest.Mock }).showQuickPick = jest.fn();
        (vscode.window as unknown as { showTextDocument: jest.Mock }).showTextDocument = jest.fn().mockResolvedValue(undefined);
        (vscode.workspace as unknown as { openTextDocument: jest.Mock }).openTextDocument = jest.fn().mockResolvedValue({});
        (vscode.window as unknown as { createWebviewPanel: jest.Mock }).createWebviewPanel = jest.fn();
        (vscode as unknown as { env: { clipboard: { writeText: jest.Mock } } }).env = {
            clipboard: {
                writeText: jest.fn().mockResolvedValue(undefined)
            }
        };

        historyView = new QueryHistoryView(extensionUri, context);
    });

    it('initializes webview, subscribes to updates, and sends initial history', async () => {
        const webviewView = createWebviewView();

        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await messageHandler?.({ type: 'getHistory' });
        await Promise.resolve();

        expect(getInstanceMock).toHaveBeenCalledWith(context);
        expect(webviewView.webview.options).toEqual(
            expect.objectContaining({
                enableScripts: true,
                localResourceRoots: [extensionUri]
            })
        );
        expect(webviewView.webview.html).toContain('Query History');
        expect(webviewView.webview.html).toContain('queryHistory.js');
        expect((webviewView.webview.postMessage as jest.Mock)).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'historyData',
                reset: true
            })
        );

        historyListener?.({
            id: 'h2',
            host: 'localhost',
            database: 'TEST',
            schema: 'PUBLIC',
            query: 'SELECT 2',
            timestamp: Date.now()
        });
        await Promise.resolve();

        expect((webviewView.webview.postMessage as jest.Mock)).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'historyData'
            })
        );

        disposeHandler?.();
    });

    it('handles search by merging active and archive results without duplicates', async () => {
        const webviewView = createWebviewView();
        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        mockHistoryManager.searchAll.mockResolvedValue([
            {
                id: 'same',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT active',
                timestamp: Date.now()
            }
        ]);
        mockHistoryManager.searchArchive.mockResolvedValue([
            {
                id: 'same',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT duplicate',
                timestamp: Date.now()
            },
            {
                id: 'archive-only',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT archive',
                timestamp: Date.now()
            }
        ]);

        await messageHandler?.({ type: 'search', term: 'select' });

        expect(mockHistoryManager.searchAll).toHaveBeenCalledWith('select');
        expect(mockHistoryManager.searchArchive).toHaveBeenCalledWith('select');
        expect((webviewView.webview.postMessage as jest.Mock)).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'searchResults',
                source: 'active+archive',
                history: expect.arrayContaining([
                    expect.objectContaining({ id: 'same' }),
                    expect.objectContaining({ id: 'archive-only' })
                ])
            })
        );
    });

    it('handles clearAll and deleteEntry confirmation flows', async () => {
        const webviewView = createWebviewView();
        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Clear All');
        await messageHandler?.({ type: 'clearAll' });
        expect(mockHistoryManager.clearHistory).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Query history cleared');

        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Delete');
        await messageHandler?.({ type: 'deleteEntry', id: 'h1', query: 'SELECT 1' });
        expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('h1');
        expect((webviewView.webview.postMessage as jest.Mock)).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'entryDeleted', id: 'h1' })
        );
    });

    it('copies and executes query through VS Code API', async () => {
        const webviewView = createWebviewView();
        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        await messageHandler?.({ type: 'copyQuery', query: 'SELECT 123' });
        await messageHandler?.({ type: 'executeQuery', query: 'SELECT 456' });

        const vscodeEnv = vscode as unknown as { env: { clipboard: { writeText: jest.Mock } } };
        expect(vscodeEnv.env.clipboard.writeText).toHaveBeenCalledWith('SELECT 123');
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
            content: 'SELECT 456',
            language: 'sql'
        });
        expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it('handles entry edit requests for not found, cancel, and success paths', async () => {
        const webviewView = createWebviewView();
        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        mockHistoryManager.getHistory.mockResolvedValueOnce([]);
        await messageHandler?.({ type: 'requestEdit', id: 'missing' });
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Entry not found (might be archived)');

        mockHistoryManager.getHistory.mockResolvedValueOnce([
            {
                id: 'h1',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT 1',
                timestamp: Date.now(),
                tags: 'old',
                description: 'old desc'
            }
        ]);
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);
        await messageHandler?.({ type: 'requestEdit', id: 'h1' });
        expect(mockHistoryManager.updateEntry).not.toHaveBeenCalled();

        mockHistoryManager.getHistory.mockResolvedValueOnce([
            {
                id: 'h1',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT 1',
                timestamp: Date.now(),
                tags: 'old',
                description: 'old desc'
            }
        ]);
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('new-tag').mockResolvedValueOnce('new-desc');
        await messageHandler?.({ type: 'requestEdit', id: 'h1' });

        expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith('h1', 'new-tag', 'new-desc');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Entry updated successfully');
    });

    it('supports favorites and tag filtering including quick pick selection', async () => {
        const webviewView = createWebviewView();
        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        mockHistoryManager.getFavorites.mockResolvedValue([
            {
                id: 'fav1',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT fav',
                timestamp: Date.now(),
                is_favorite: true
            }
        ]);
        await messageHandler?.({ type: 'showFavoritesOnly' });

        expect((webviewView.webview.postMessage as jest.Mock)).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'historyData',
                filter: 'favorites'
            })
        );

        mockHistoryManager.getByTag.mockResolvedValue([
            {
                id: 'tag1',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT tag',
                timestamp: Date.now(),
                tags: 'one,two'
            }
        ]);
        await messageHandler?.({ type: 'filterByTag', tag: 'one' });
        expect(mockHistoryManager.getByTag).toHaveBeenCalledWith('one');

        await messageHandler?.({ type: 'requestTagFilter', tags: ['single'] });
        expect(mockHistoryManager.getByTag).toHaveBeenCalledWith('single');

        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('selectedTag');
        await messageHandler?.({ type: 'requestTagFilter', tags: ['a', 'selectedTag'] });
        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        expect(mockHistoryManager.getByTag).toHaveBeenCalledWith('selectedTag');
    });

    it('opens extended view and handles extended commands', async () => {
        let extendedMessageHandler: ((message: { type: string; [key: string]: unknown }) => Promise<void>) | undefined;
        const extendedPanel = {
            webview: {
                html: '',
                cspSource: 'mock-csp',
                postMessage: jest.fn().mockResolvedValue(true),
                asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
                onDidReceiveMessage: jest.fn((handler: (message: unknown) => Promise<void>) => {
                    extendedMessageHandler = handler as (message: { type: string; [key: string]: unknown }) => Promise<void>;
                    return { dispose: jest.fn() };
                })
            },
            onDidDispose: jest.fn((_handler: () => void) => {
                return { dispose: jest.fn() };
            }),
            dispose: jest.fn()
        } as unknown as vscode.WebviewPanel;
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(extendedPanel);

        const webviewView = createWebviewView();
        historyView.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        await messageHandler?.({ type: 'showExtendedView' });

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'netezza.queryHistoryExtended',
            'Query History - Extended View',
            vscode.ViewColumn.One,
            expect.objectContaining({ enableScripts: true })
        );
        expect(extendedPanel.webview.html).toContain('Query History - Extended View');

        await extendedMessageHandler?.({ type: 'getHistory' });
        expect(extendedPanel.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'historyData' })
        );

        mockHistoryManager.searchAll.mockResolvedValueOnce([
            {
                id: 'a1',
                host: 'h',
                database: 'd',
                schema: 's',
                query: 'SELECT active',
                timestamp: Date.now()
            }
        ]);
        mockHistoryManager.searchArchive.mockResolvedValueOnce([]);
        await extendedMessageHandler?.({ type: 'search', term: 'active' });
        expect(extendedPanel.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'searchResults', term: 'active' })
        );
    });
});
