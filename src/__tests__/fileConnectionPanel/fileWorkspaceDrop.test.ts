/**
 * Schema tree drag & drop: dropping data files onto a File SQL connection
 * node attaches them to the connection profile.
 */

import * as vscode from 'vscode';
import { SchemaProvider, SchemaItem } from '../../providers/schemaProvider';
import { ConnectionManager } from '../../core/connectionManager';
import { MetadataCache } from '../../metadataCache';

jest.mock('../../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(() => []),
}));

jest.mock('../../providers/tableMetadataProvider', () => ({
    buildColumnMetadataQuery: jest.fn(() => 'SELECT'),
    parseColumnMetadata: jest.fn(() => []),
}));

function createContext() {
    return {
        secrets: { get: jest.fn(), store: jest.fn(), delete: jest.fn() },
        globalState: { get: jest.fn(), update: jest.fn() },
        extensionUri: { fsPath: '/test', toString: () => 'file:///test' } as vscode.Uri,
        subscriptions: [],
        asAbsolutePath: jest.fn((relativePath: string) => `/test/${relativePath}`),
    } as unknown as vscode.ExtensionContext;
}

describe('SchemaProvider handleDrop on File SQL connections', () => {
    let provider: SchemaProvider;
    let savedDetails: Array<Record<string, unknown>>;

    beforeEach(() => {
        savedDetails = [];
        const connectionManager = {
            getConnections: jest.fn().mockResolvedValue([]),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('file'),
            getConnection: jest.fn().mockResolvedValue({
                name: 'Sales Files',
                host: 'local',
                database: '/data/sales.csv',
                user: 'file',
                dbType: 'file',
                options: {},
            }),
            getConnectionMetadata: jest.fn().mockReturnValue({
                name: 'Sales Files',
                host: 'local',
                database: '/data/sales.csv',
                user: 'file',
                dbType: 'file',
                options: {},
            }),
            ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
            saveConnection: jest.fn(async (details: Record<string, unknown>) => {
                savedDetails.push(details);
            }),
            refreshFileConnection: jest.fn().mockResolvedValue(undefined),
            onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
            dispose: jest.fn(),
        } as unknown as jest.Mocked<ConnectionManager>;

        const metadataCache = {
            getDatabases: jest.fn().mockReturnValue(null),
            setDatabases: jest.fn(),
            onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() })),
        } as unknown as jest.Mocked<MetadataCache>;

        provider = new SchemaProvider(createContext(), connectionManager, metadataCache);
        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor | undefined }).activeTextEditor = undefined;
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
    });

    function fileConnectionItem(): SchemaItem {
        return new SchemaItem(
            'Sales Files',
            vscode.TreeItemCollapsibleState.Collapsed,
            'serverInstance',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'Sales Files',
        );
    }

    function dropTransfer(uriList: string): vscode.DataTransfer {
        return {
            get: jest.fn((key: string) => {
                if (key === 'application/vnd.code.tree.netezza') return undefined;
                if (key === 'text/uri-list') return { value: uriList };
                return undefined;
            }),
        } as unknown as vscode.DataTransfer;
    }

    it('attaches dropped data files to a File SQL connection', async () => {
        const token = { isCancellationRequested: false } as vscode.CancellationToken;
        await provider.handleDrop(
            fileConnectionItem(),
            dropTransfer('file:///data/sales.xlsx\r\nfile:///data/extra.csv'),
            token,
        );

        expect(savedDetails).toHaveLength(1);
        const saved = savedDetails[0] as { options: Record<string, string> };
        expect(JSON.parse(saved.options.fileWorkspace as string)).toEqual({
            version: 1,
            files: ['/data/sales.csv', '/data/sales.xlsx', '/data/extra.csv'],
        });
    });

    it('ignores unsupported file types on drop', async () => {
        const token = { isCancellationRequested: false } as vscode.CancellationToken;
        await provider.handleDrop(
            fileConnectionItem(),
            dropTransfer('file:///data/notes.txt\r\nfile:///data/extra.csv'),
            token,
        );

        expect(savedDetails).toHaveLength(1);
        const saved = savedDetails[0] as { options: Record<string, string> };
        expect(JSON.parse(saved.options.fileWorkspace as string)).toEqual({
            version: 1,
            files: ['/data/sales.csv', '/data/extra.csv'],
        });
    });

    it('warns when only unsupported files are dropped', async () => {
        const token = { isCancellationRequested: false } as vscode.CancellationToken;
        await provider.handleDrop(
            fileConnectionItem(),
            dropTransfer('file:///data/notes.txt'),
            token,
        );

        expect(savedDetails).toHaveLength(0);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('No supported data files'),
        );
    });

    it('warns when the editable copy is disabled by workspace conversion', async () => {
        savedDetails = [];
        const connectionManager = (provider as unknown as { connectionManager: ConnectionManager }).connectionManager;
        (connectionManager.getConnection as jest.Mock).mockResolvedValue({
            name: 'Sales Files',
            host: 'local',
            database: '/data/sales.csv',
            user: 'file',
            dbType: 'file',
            options: { editable: true },
        });

        const token = { isCancellationRequested: false } as vscode.CancellationToken;
        await provider.handleDrop(
            fileConnectionItem(),
            dropTransfer('file:///data/extra.csv'),
            token,
        );

        expect(savedDetails).toHaveLength(1);
        const saved = savedDetails[0] as { options: Record<string, unknown> };
        expect(saved.options.editable).toBeUndefined();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('read-only multi-file workspace'),
        );
    });

    it('does not attach files when the drop target is not a file connection', async () => {
        const netezzaItem = new SchemaItem(
            'Netezza',
            vscode.TreeItemCollapsibleState.Collapsed,
            'serverInstance',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            'Netezza',
        );
        const connectionManager = (provider as unknown as { connectionManager: ConnectionManager }).connectionManager;
        (connectionManager.getConnectionMetadata as jest.Mock).mockReturnValue({
            name: 'Netezza',
            host: 'h',
            database: 'd',
            user: 'u',
            dbType: 'netezza',
        });

        const token = { isCancellationRequested: false } as vscode.CancellationToken;
        await provider.handleDrop(
            netezzaItem,
            dropTransfer('file:///data/extra.csv'),
            token,
        );

        expect(savedDetails).toHaveLength(0);
    });
});
