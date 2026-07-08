import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION } from '../lsp/protocol';
import { SQL_AUTHORING_LANGUAGE_IDS } from '../utils/sqlLanguage';

jest.mock('vscode');

const mockStart = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockOnRequest = jest.fn();
const mockSendNotification = jest.fn();
const mockLanguageClient = jest.fn().mockImplementation((_id, _name, _serverOptions, clientOptions) => ({
    onRequest: mockOnRequest,
    sendNotification: mockSendNotification,
    start: mockStart,
    stop: mockStop,
    clientOptions
}));

jest.mock('vscode-languageclient/node', () => ({
    LanguageClient: mockLanguageClient,
    TransportKind: {
        ipc: 'ipc'
    }
}));

jest.mock('../providers/providers/metadataProvider', () => ({
    MetadataProvider: jest.fn().mockImplementation(() => ({}))
}));

describe('startSqlLanguageClient', () => {
    function createMetadataCache(): MetadataCache {
        return {
            onDidInvalidate: jest.fn(() => ({ dispose: jest.fn() })),
            onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() }))
        } as unknown as MetadataCache;
    }

    function createConnectionManager(): ConnectionManager {
        return {
            onDidChangeDocumentConnection: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeDocumentDatabase: jest.fn(() => ({ dispose: jest.fn() }))
        } as unknown as ConnectionManager;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.NODE_ENV;
    });

    afterEach(async () => {
        const { stopSqlLanguageClient } = await import('../activation/lspRegistration');
        await stopSqlLanguageClient();
    });

    it('registers untitled MSSQL documents with the LSP client', async () => {
        const { startSqlLanguageClient } = await import('../activation/lspRegistration');
        const context = {
            asAbsolutePath: jest.fn((value: string) => value),
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
        const connectionManager = createConnectionManager();

        await startSqlLanguageClient(context, createMetadataCache(), connectionManager);

        expect(mockLanguageClient).toHaveBeenCalledWith(
            'netezza-sql-language-server',
            'Netezza SQL Language Server',
            expect.anything(),
            expect.objectContaining({
                documentSelector: expect.arrayContaining([
                    expect.objectContaining({ scheme: 'file', language: 'mssql' }),
                    expect.objectContaining({ scheme: 'untitled', language: 'mssql' })
                ])
            })
        );
        expect(mockStart).toHaveBeenCalled();
    });

    it('registers every SQL authoring language for both file and untitled documents', async () => {
        const { startSqlLanguageClient } = await import('../activation/lspRegistration');
        const context = {
            asAbsolutePath: jest.fn((value: string) => value),
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
        const connectionManager = createConnectionManager();

        await startSqlLanguageClient(context, createMetadataCache(), connectionManager);

        const clientOptions = mockLanguageClient.mock.calls[0]?.[3];
        expect(clientOptions).toBeDefined();

        for (const language of SQL_AUTHORING_LANGUAGE_IDS) {
            expect(clientOptions.documentSelector).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ scheme: 'file', language }),
                    expect.objectContaining({ scheme: 'untitled', language })
                ])
            );
        }
    });

    it('synchronizes current and legacy SQL configuration sections', async () => {
        const { startSqlLanguageClient } = await import('../activation/lspRegistration');
        const context = {
            asAbsolutePath: jest.fn((value: string) => value),
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
        const connectionManager = createConnectionManager();

        await startSqlLanguageClient(context, createMetadataCache(), connectionManager);

        const clientOptions = mockLanguageClient.mock.calls[0]?.[3];
        expect(clientOptions?.synchronize?.configurationSection).toEqual(
            expect.arrayContaining([
                'justybase.linter',
                'justybase.sql',
                'netezza.linter',
                'netezza.sql'
            ])
        );
    });

    it('coalesces concurrent startSqlLanguageClient calls into one LanguageClient.start', async () => {
        const { startSqlLanguageClient } = await import('../activation/lspRegistration');
        const context = {
            asAbsolutePath: jest.fn((value: string) => value),
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
        const connectionManager = createConnectionManager();

        let resolveStart: (() => void) | undefined;
        const startGate = new Promise<void>((resolve) => {
            resolveStart = resolve;
        });
        mockStart.mockImplementationOnce(() => startGate);

        const firstStart = startSqlLanguageClient(context, createMetadataCache(), connectionManager);
        const secondStart = startSqlLanguageClient(context, createMetadataCache(), connectionManager);

        expect(mockLanguageClient).toHaveBeenCalledTimes(1);
        expect(mockStart).toHaveBeenCalledTimes(1);

        resolveStart?.();
        await Promise.all([firstStart, secondStart]);
    });

    it('forwards metadata cache invalidation to the language server', async () => {
        const { startSqlLanguageClient } = await import('../activation/lspRegistration');
        const context = {
            asAbsolutePath: jest.fn((value: string) => value),
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
        const connectionManager = createConnectionManager();
        let invalidateListener: (() => void) | undefined;
        const metadataCache = {
            onDidInvalidate: jest.fn((listener: () => void) => {
                invalidateListener = listener;
                return { dispose: jest.fn() };
            }),
            onDidExternalRefresh: jest.fn(() => ({ dispose: jest.fn() }))
        } as unknown as MetadataCache;

        await startSqlLanguageClient(context, metadataCache, connectionManager);

        invalidateListener?.();

        expect(mockSendNotification).toHaveBeenCalledWith(
            NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION
        );
    });
});
