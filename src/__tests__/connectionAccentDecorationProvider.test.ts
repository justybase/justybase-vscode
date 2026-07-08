import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { ConnectionAccentDecorationProvider } from '../decorations/connectionAccentDecorationProvider';
import { getConnectionAccentResourceUri } from '../utils/connectionAccent';

describe('ConnectionAccentDecorationProvider', () => {
    let provider: ConnectionAccentDecorationProvider;
    let mockConnectionManager: jest.Mocked<Pick<
        ConnectionManager,
        'getConnectionForExecution' | 'getConnectionMetadata'
    >>;
    const cancellationToken = { isCancellationRequested: false } as vscode.CancellationToken;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnectionManager = {
            getConnectionForExecution: jest.fn(),
            getConnectionMetadata: jest.fn()
        };

        provider = new ConnectionAccentDecorationProvider(
            mockConnectionManager as unknown as ConnectionManager
        );

        const textDocuments = vscode.workspace.textDocuments as vscode.TextDocument[];
        textDocuments.splice(0, textDocuments.length);
        (vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = undefined;
    });

    afterEach(() => {
        provider.dispose();
    });

    it('should decorate SQL documents using the effective connection accent', () => {
        const uri = vscode.Uri.parse('file:///queries/test.sql');
        const textDocuments = vscode.workspace.textDocuments as vscode.TextDocument[];
        textDocuments.push({
            uri,
            languageId: 'sql'
        } as vscode.TextDocument);

        mockConnectionManager.getConnectionForExecution.mockReturnValue('Prod');
        mockConnectionManager.getConnectionMetadata.mockReturnValue({
            name: 'Prod',
            host: 'localhost',
            port: 5480,
            database: 'SYSTEM',
            user: 'admin',
            accentColor: 'red'
        });

        const decoration = provider.provideFileDecoration(uri, cancellationToken);

        expect(mockConnectionManager.getConnectionForExecution).toHaveBeenCalledWith(uri.toString());
        expect(decoration).toMatchObject({
            badge: '🔴',
            tooltip: expect.stringContaining('Prod')
        });
        expect(decoration?.color).toBeUndefined();
    });

    it('should ignore non-SQL documents', () => {
        const uri = vscode.Uri.parse('file:///queries/readme.txt');
        const textDocuments = vscode.workspace.textDocuments as vscode.TextDocument[];
        textDocuments.push({
            uri,
            languageId: 'plaintext'
        } as vscode.TextDocument);

        const decoration = provider.provideFileDecoration(uri, cancellationToken);

        expect(decoration).toBeUndefined();
        expect(mockConnectionManager.getConnectionForExecution).not.toHaveBeenCalled();
    });

    it('should fall back to the active SQL editor for newly opened tabs', () => {
        const uri = vscode.Uri.parse('untitled:/new-query.sql');
        (vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = {
            document: {
                uri,
                languageId: 'sql'
            }
        } as vscode.TextEditor;

        mockConnectionManager.getConnectionForExecution.mockReturnValue('DefaultConnection');
        mockConnectionManager.getConnectionMetadata.mockReturnValue({
            name: 'DefaultConnection',
            host: 'localhost',
            port: 5480,
            database: 'SYSTEM',
            user: 'admin',
            accentColor: 'green'
        });

        const decoration = provider.provideFileDecoration(uri, cancellationToken);

        expect(decoration?.badge).toBe('🟢');
        expect(decoration?.color).toBeUndefined();
        expect(mockConnectionManager.getConnectionForExecution).toHaveBeenCalledWith(uri.toString());
    });

    it('should decorate schema connection nodes using synthetic resource URIs', () => {
        const uri = getConnectionAccentResourceUri('Warehouse');
        mockConnectionManager.getConnectionMetadata.mockReturnValue({
            name: 'Warehouse',
            host: 'localhost',
            port: 5480,
            database: 'SYSTEM',
            user: 'admin',
            accentColor: 'blue'
        });

        const decoration = provider.provideFileDecoration(uri, cancellationToken);

        expect(mockConnectionManager.getConnectionForExecution).not.toHaveBeenCalled();
        expect(decoration?.badge).toBe('🔵');
        expect(decoration?.color).toBeUndefined();
        expect(decoration?.tooltip).toContain('Warehouse');
    });

    it('should fire decoration change events on refresh', () => {
        const listener = jest.fn();
        provider.onDidChangeFileDecorations(listener);

        provider.refresh();

        expect(listener).toHaveBeenCalledWith(undefined);
    });
});
