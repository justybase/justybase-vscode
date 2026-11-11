import * as vscode from 'vscode';
import { SnippetsView } from '../views/snippetsView';
import { FavoritesManager } from '../core/favoritesManager';

jest.mock('../core/favoritesManager', () => ({
    FavoritesManager: {
        getInstance: jest.fn()
    }
}));

jest.mock('../utils/logger', () => ({
    logWithFallback: jest.fn()
}));

import { logWithFallback } from '../utils/logger';

const getInstanceMock = FavoritesManager.getInstance as unknown as jest.Mock;

interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

describe('SnippetsView', () => {
    let view: SnippetsView;
    let messageHandler: ((message: WebviewMessage) => Promise<void>) | undefined;
    let disposeHandler: (() => void) | undefined;
    let favoritesHandler: (() => void) | undefined;
    let favoritesDisposable: { dispose: jest.Mock };
    let webviewView: vscode.WebviewView;
    let extensionUri: vscode.Uri;
    let context: vscode.ExtensionContext;
    let webview: {
        options: unknown;
        html: string;
        cspSource: string;
        postMessage: jest.Mock;
        asWebviewUri: jest.Mock;
        onDidReceiveMessage: jest.Mock;
    };
    let manager: {
        onDidChangeFavorites: jest.Mock;
        getSqlSnippets: jest.Mock;
        addSqlSnippet: jest.Mock;
        updateSnippet: jest.Mock;
        removeFavoriteById: jest.Mock;
    };

    const flush = async (): Promise<void> => {
        for (let i = 0; i < 4; i += 1) {
            await Promise.resolve();
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        messageHandler = undefined;
        disposeHandler = undefined;
        favoritesHandler = undefined;
        favoritesDisposable = { dispose: jest.fn() };

        extensionUri = {
            fsPath: 'D:\\ext',
            toString: () => 'file:///D:/ext'
        } as vscode.Uri;
        context = {
            extensionUri,
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        manager = {
            onDidChangeFavorites: jest.fn((handler: () => void) => {
                favoritesHandler = handler;
                return favoritesDisposable;
            }),
            getSqlSnippets: jest.fn().mockResolvedValue([
                {
                    id: 's1',
                    type: 'sql',
                    label: 'Monthly totals',
                    sqlContent: 'SELECT 1;',
                    tags: 'report, monthly',
                    timestamp: 123
                }
            ]),
            addSqlSnippet: jest.fn().mockResolvedValue('s2'),
            updateSnippet: jest.fn().mockResolvedValue(true),
            removeFavoriteById: jest.fn().mockResolvedValue(undefined)
        };
        getInstanceMock.mockReturnValue(manager);

        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({});
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(undefined);
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

        webview = {
            options: {},
            html: '',
            cspSource: 'mock-csp',
            postMessage: jest.fn().mockResolvedValue(true),
            asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
            onDidReceiveMessage: jest.fn((handler: (message: WebviewMessage) => Promise<void>) => {
                messageHandler = handler;
                return { dispose: jest.fn() };
            })
        };
        webviewView = {
            webview,
            onDidDispose: jest.fn((handler: () => void) => {
                disposeHandler = handler;
                return { dispose: jest.fn() };
            })
        } as unknown as vscode.WebviewView;

        view = new SnippetsView(extensionUri, context);
        view.resolveWebviewView(webviewView);
    });

    it('renders the snippets webview shell', () => {
        expect(webview.html).toContain('snippets.css');
        expect(webview.html).toContain('snippets.js');
    });

    it('sends snippets and the current SQL on request', async () => {
        await messageHandler!({ type: 'getSnippets' });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsData',
            snippets: [
                {
                    id: 's1',
                    name: 'Monthly totals',
                    tags: 'report, monthly',
                    sql: 'SELECT 1;',
                    updatedAt: 123
                }
            ],
            currentSql: ''
        });
    });

    it('creates a snippet with tags', async () => {
        await messageHandler!({
            type: 'saveSnippet',
            name: ' New ',
            tags: 'a, b',
            sql: ' SELECT 2; '
        });

        expect(manager.addSqlSnippet).toHaveBeenCalledWith('New', 'SELECT 2;', undefined, 'a, b');
        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetSaved',
            id: 's2',
            name: 'New'
        });
    });

    it('updates an existing snippet', async () => {
        await messageHandler!({
            type: 'saveSnippet',
            id: 's1',
            name: 'Updated',
            tags: '',
            sql: 'SELECT 3;'
        });

        expect(manager.updateSnippet).toHaveBeenCalledWith('s1', 'Updated', 'SELECT 3;', '');
    });

    it('rejects a snippet without a name', async () => {
        await messageHandler!({
            type: 'saveSnippet',
            name: '   ',
            tags: '',
            sql: 'SELECT 1;'
        });

        expect(manager.addSqlSnippet).not.toHaveBeenCalled();
        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsError',
            message: 'Give the snippet a name.'
        });
    });

    it('deletes a snippet after confirmation', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

        await messageHandler!({ type: 'deleteSnippet', id: 's1', name: 'Monthly totals' });

        expect(manager.removeFavoriteById).toHaveBeenCalledWith('s1');
    });

    it('keeps a snippet when deletion is cancelled', async () => {
        await messageHandler!({ type: 'deleteSnippet', id: 's1', name: 'Monthly totals' });

        expect(manager.removeFavoriteById).not.toHaveBeenCalled();
    });

    it('sends the selected SQL from the active SQL editor', async () => {
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: {
                languageId: 'sql',
                getText: jest.fn(() => 'SELECT 42;')
            },
            selection: { isEmpty: false }
        };

        await messageHandler!({ type: 'getCurrentSql' });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'currentSql',
            sql: 'SELECT 42;'
        });
    });

    it('inserts a snippet into the active SQL editor', async () => {
        const insert = jest.fn();
        const edit = jest.fn(async (callback: (builder: unknown) => void) => {
            callback({ insert, replace: jest.fn() });
            return true;
        });
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: { languageId: 'sql', getText: jest.fn(() => '') },
            selection: { isEmpty: true, active: { line: 0, character: 0 } },
            edit
        };

        await messageHandler!({ type: 'insertSnippet', sql: 'SELECT 2;' });

        expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'SELECT 2;');
    });

    it('opens a new SQL editor and runs the snippet', async () => {
        await messageHandler!({ type: 'runSnippet', sql: 'SELECT 1;', name: 'X' });

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
            language: 'sql',
            content: 'SELECT 1;'
        });
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.runQuery');
    });

    it('opens a form prefilled with the current SQL from the command entry point', async () => {
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: { languageId: 'sql', getText: jest.fn(() => 'SELECT 7;') },
            selection: { isEmpty: true }
        };

        await view.openNewSnippet();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.snippets.focus');
        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'openForm',
            sql: 'SELECT 7;'
        });
    });

    it('refreshes snippets when favorites change', async () => {
        favoritesHandler!();
        await flush();

        expect(manager.getSqlSnippets).toHaveBeenCalledTimes(1);
        expect(webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'snippetsData' })
        );
    });

    it('defaults missing tags and SQL in snippet DTOs', async () => {
        manager.getSqlSnippets.mockResolvedValue([
            { id: 'bare', type: 'sql', label: 'Bare', timestamp: 9 }
        ]);

        await messageHandler!({ type: 'getSnippets' });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsData',
            snippets: [
                { id: 'bare', name: 'Bare', tags: '', sql: '', updatedAt: 9 }
            ],
            currentSql: ''
        });
    });

    it('stops posting and disposes favorites tracking after the view is disposed', async () => {
        disposeHandler!();

        expect(favoritesDisposable.dispose).toHaveBeenCalled();
        webview.postMessage.mockClear();

        await messageHandler!({ type: 'getSnippets' });
        await messageHandler!({ type: 'getCurrentSql' });

        expect(webview.postMessage).not.toHaveBeenCalled();
    });

    it('opens the form through the save-current command entry point', async () => {
        await view.openFormWithCurrentSql();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.snippets.focus');
        expect(webview.postMessage).toHaveBeenCalledWith({ type: 'openForm', sql: '' });
    });

    it('queues a form until the view resolves', async () => {
        disposeHandler!();
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: { languageId: 'sql', getText: jest.fn(() => 'SELECT 8;') },
            selection: { isEmpty: true }
        };

        await view.openNewSnippet();

        expect(webview.postMessage).not.toHaveBeenCalled();

        const secondWebview = {
            options: {},
            html: '',
            cspSource: 'mock-csp',
            postMessage: jest.fn().mockResolvedValue(true),
            asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
            onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() }))
        };
        const secondView = {
            webview: secondWebview,
            onDidDispose: jest.fn(() => ({ dispose: jest.fn() }))
        } as unknown as vscode.WebviewView;

        view.resolveWebviewView(secondView);

        expect(secondWebview.postMessage).toHaveBeenCalledWith({
            type: 'openForm',
            sql: 'SELECT 8;'
        });
    });

    it('reports a failure to load snippets', async () => {
        manager.getSqlSnippets.mockRejectedValue(new Error('boom'));

        await messageHandler!({ type: 'getSnippets' });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsError',
            message: 'Could not load snippets: boom'
        });
    });

    it('rejects a snippet without SQL', async () => {
        await messageHandler!({
            type: 'saveSnippet',
            name: 'Empty',
            tags: '',
            sql: '   '
        });

        expect(manager.addSqlSnippet).not.toHaveBeenCalled();
        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsError',
            message: 'The SQL text is empty.'
        });
    });

    it('reports a rejected snippet update', async () => {
        manager.updateSnippet.mockResolvedValue(false);

        await messageHandler!({
            type: 'saveSnippet',
            id: 's1',
            name: 'Duplicate',
            tags: '',
            sql: 'SELECT 1;'
        });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsError',
            message: 'Could not update "Duplicate". The name may already be in use.'
        });
    });

    it('reports snippet save errors', async () => {
        manager.addSqlSnippet.mockRejectedValue(new Error('Snippet "Duplicate" already exists'));

        await messageHandler!({
            type: 'saveSnippet',
            name: 'Duplicate',
            tags: '',
            sql: 'SELECT 1;'
        });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsError',
            message: 'Snippet "Duplicate" already exists'
        });
    });

    it('reports snippet delete errors', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
        manager.removeFavoriteById.mockRejectedValue(new Error('nope'));

        await messageHandler!({ type: 'deleteSnippet', id: 's1', name: 'Monthly totals' });

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'snippetsError',
            message: 'Could not delete the snippet: nope'
        });
    });

    it('replaces the selection when inserting a snippet', async () => {
        const replace = jest.fn();
        const selection = { isEmpty: false, active: { line: 0, character: 0 } };
        const edit = jest.fn(async (callback: (builder: unknown) => void) => {
            callback({ insert: jest.fn(), replace });
            return true;
        });
        (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
            document: { languageId: 'sql', getText: jest.fn(() => '') },
            selection,
            edit
        };

        await messageHandler!({ type: 'insertSnippet', sql: 'SELECT 4;' });

        expect(replace).toHaveBeenCalledWith(selection, 'SELECT 4;');
    });

    it('opens a new editor when inserting without a SQL editor', async () => {
        await messageHandler!({ type: 'insertSnippet', sql: 'SELECT 5;' });

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
            language: 'sql',
            content: 'SELECT 5;'
        });
        expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it('logs when running a snippet fails', async () => {
        (vscode.commands.executeCommand as jest.Mock).mockRejectedValueOnce(new Error('no runner'));

        await messageHandler!({ type: 'runSnippet', sql: 'SELECT 6;', name: 'Y' });

        expect(logWithFallback).toHaveBeenCalledWith(
            'error',
            '[SnippetsView] Failed to run snippet',
            expect.any(Error)
        );
    });
});
