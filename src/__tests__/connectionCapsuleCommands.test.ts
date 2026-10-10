/**
 * Unit tests for the connection capsule menu (commands/connectionCapsuleCommands.ts).
 */

import * as vscode from 'vscode';
import {
    buildConnectionCapsuleMenu,
    registerConnectionCapsuleCommands,
    type ConnectionCapsuleCommandsContext,
} from '../commands/connectionCapsuleCommands';
import type { ConnectionCapsuleSnapshot } from '../services/connectionCapsule';
import { ConnectionManager } from '../core/connectionManager';

jest.mock('vscode');

const snapshot: ConnectionCapsuleSnapshot = {
    documentUri: 'file:///test.sql',
    connectionName: 'NZ',
    isMissing: false,
    isPinned: false,
    database: 'JUST_DATA',
    schema: 'ADMIN',
    keepOpen: true,
    connected: false,
};

function setActiveSqlEditor(): void {
    setActiveEditorForUri('sql', 'file:///test.sql');
}

function setActiveEditorForUri(languageId: string, uri: string): void {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
        document: {
            languageId,
            uri: { toString: () => uri },
        },
    };
}

function createManagerMock(overrides: Record<string, unknown> = {}): ConnectionManager {
    return {
        getConnections: jest.fn().mockResolvedValue([
            { name: 'NZ', host: '192.168.0.144', port: 5480, database: 'JUST_DATA', user: 'admin' },
            { name: 'PROD', host: '10.0.0.2', port: 5480, database: 'SALES', user: 'admin' },
        ]),
        getConnectionForExecution: jest.fn().mockReturnValue('NZ'),
        getActiveConnectionName: jest.fn().mockReturnValue('NZ'),
        getDocumentConnection: jest.fn().mockReturnValue(undefined),
        setDocumentConnection: jest.fn().mockResolvedValue(undefined),
        setDocumentDatabase: jest.fn().mockResolvedValue(undefined),
        getDocumentDatabase: jest.fn().mockReturnValue(undefined),
        getEffectiveDatabase: jest.fn().mockResolvedValue('JUST_DATA'),
        getEffectiveSchemaSync: jest.fn().mockReturnValue('ADMIN'),
        getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
        toggleDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false),
        closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
        getDocumentPersistentConnection: jest.fn().mockResolvedValue({}),
        isConnectionAvailable: jest.fn().mockReturnValue(true),
        getConnectionMetadata: jest.fn().mockReturnValue({
            name: 'NZ',
            host: '192.168.0.144',
            port: 5480,
            database: 'JUST_DATA',
            user: 'admin',
        }),
        getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
        hasDocumentPersistentConnection: jest.fn().mockReturnValue(false),
        ...overrides,
    } as unknown as ConnectionManager;
}

function createContext(manager: ConnectionManager): ConnectionCapsuleCommandsContext {
    return {
        context: {
            extensionUri: {},
            subscriptions: [],
        } as unknown as vscode.ExtensionContext,
        connectionManager: manager,
        metadataCache: {} as ConnectionCapsuleCommandsContext['metadataCache'],
        getDatabaseList: jest.fn().mockResolvedValue(['JUST_DATA', 'SALES']),
        refreshConnectionCapsule: jest.fn(),
    };
}

function getShowCapsuleHandler(): (...args: unknown[]) => Promise<void> {
    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
    const call = calls.find((entry: unknown[]) => entry[0] === 'netezza.showConnectionCapsule');
    expect(call).toBeDefined();
    return call[1] as (...args: unknown[]) => Promise<void>;
}

describe('connectionCapsuleCommands', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setActiveSqlEditor();
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    });

    describe('buildConnectionCapsuleMenu', () => {
        it('lays out connection, database, schema, session and action sections', () => {
            const items = buildConnectionCapsuleMenu(snapshot);
            const labels = items.map((item) => String(item.label));

            expect(labels).toEqual([
                'Connection',
                '$(database) NZ',
                'Database',
                '$(server) JUST_DATA',
                'Schema',
                '$(symbol-namespace) ADMIN',
                'Session',
                '$(plug) Persistent · Keep ON',
                '$(circle-outline) Not connected',
                '$(refresh) Reconnect...',
                'Actions',
                '$(plug) Connect...',
                '$(gear) Manage connections...',
            ]);
        });

        it('renders transient sessions and unknown schema', () => {
            const items = buildConnectionCapsuleMenu({ ...snapshot, keepOpen: false, schema: null });
            const labels = items.map((item) => String(item.label));

            expect(labels).toContain('$(debug-disconnect) Transient · Keep OFF');
            expect(labels).toContain('$(symbol-namespace) —');
        });
    });

    describe('netezza.showConnectionCapsule', () => {
        it('registers the capsule command', () => {
            registerConnectionCapsuleCommands(createContext(createManagerMock()));

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.showConnectionCapsule',
                expect.any(Function),
            );
        });

        it('warns outside SQL files', async () => {
            (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = {
                document: { languageId: 'javascript', uri: { toString: () => 'file:///a.js' } },
            };
            registerConnectionCapsuleCommands(createContext(createManagerMock()));

            await getShowCapsuleHandler()();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'This command is only available for SQL files',
            );
        });

        it('switches the tab connection through the menu', async () => {
            const manager = createManagerMock();
            const ctx = createContext(manager);
            registerConnectionCapsuleCommands(ctx);
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ label: '$(database) NZ', action: 'change-connection' })
                .mockResolvedValueOnce({ label: 'PROD', name: 'PROD' });

            await getShowCapsuleHandler()();

            expect(manager.setDocumentConnection).toHaveBeenCalledWith('file:///test.sql', 'PROD');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Connection for this tab set to: PROD',
            );
            expect(ctx.refreshConnectionCapsule).toHaveBeenCalled();
        });

        it('warns when no connections are configured', async () => {
            const manager = createManagerMock({
                getConnections: jest.fn().mockResolvedValue([]),
            });
            registerConnectionCapsuleCommands(createContext(manager));
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(database) NZ',
                action: 'change-connection',
            });

            await getShowCapsuleHandler()();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'No connections configured. Please connect first.',
            );
            expect(manager.setDocumentConnection).not.toHaveBeenCalled();
        });

        it('switches the tab database through the menu', async () => {
            const manager = createManagerMock();
            const ctx = createContext(manager);
            registerConnectionCapsuleCommands(ctx);
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ label: '$(server) JUST_DATA', action: 'change-database' })
                .mockResolvedValueOnce({ label: 'SALES', database: 'SALES' });

            await getShowCapsuleHandler()();

            expect(ctx.getDatabaseList).toHaveBeenCalledWith(
                expect.anything(),
                manager,
                'NZ',
                ctx.metadataCache,
            );
            expect(manager.setDocumentDatabase).toHaveBeenCalledWith('file:///test.sql', 'SALES');
            expect(ctx.refreshConnectionCapsule).toHaveBeenCalled();
        });

        it('toggles keep-connection through the menu', async () => {
            const manager = createManagerMock();
            const ctx = createContext(manager);
            registerConnectionCapsuleCommands(ctx);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(plug) Persistent · Keep ON',
                action: 'toggle-keep',
            });

            await getShowCapsuleHandler()();

            expect(manager.toggleDocumentKeepConnectionOpen).toHaveBeenCalledWith('file:///test.sql');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Keep connection: DISABLED'),
            );
            expect(ctx.refreshConnectionCapsule).toHaveBeenCalled();
        });

        it('reconnects by closing and reopening the tab session', async () => {
            const manager = createManagerMock();
            const ctx = createContext(manager);
            registerConnectionCapsuleCommands(ctx);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(refresh) Reconnect...',
                action: 'reconnect',
            });

            await getShowCapsuleHandler()();

            expect(manager.closeDocumentPersistentConnection).toHaveBeenCalledWith('file:///test.sql');
            expect(manager.getDocumentPersistentConnection).toHaveBeenCalledWith('file:///test.sql');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Reconnected: NZ');
            expect(ctx.refreshConnectionCapsule).toHaveBeenCalled();
        });

        it('only closes the session on reconnect when keep is OFF', async () => {
            const manager = createManagerMock({
                getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false),
            });
            const ctx = createContext(manager);
            registerConnectionCapsuleCommands(ctx);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(refresh) Reconnect...',
                action: 'reconnect',
            });

            await getShowCapsuleHandler()();

            expect(manager.closeDocumentPersistentConnection).toHaveBeenCalledWith('file:///test.sql');
            expect(manager.getDocumentPersistentConnection).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Disconnected: NZ (Keep is OFF — no persistent session to reopen)',
            );
            expect(ctx.refreshConnectionCapsule).toHaveBeenCalled();
        });

        it('warns on reconnect without a connection', async () => {
            const manager = createManagerMock({
                getConnectionForExecution: jest.fn().mockReturnValue(undefined),
            });
            registerConnectionCapsuleCommands(createContext(manager));
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(refresh) Reconnect...',
                action: 'reconnect',
            });

            await getShowCapsuleHandler()();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'No connection selected. Please select a connection first.',
            );
            expect(manager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
        });

        it('reports reconnect failures and still refreshes the capsule', async () => {
            const manager = createManagerMock({
                getDocumentPersistentConnection: jest.fn().mockRejectedValue(new Error('boom')),
            });
            const ctx = createContext(manager);
            registerConnectionCapsuleCommands(ctx);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(refresh) Reconnect...',
                action: 'reconnect',
            });

            await getShowCapsuleHandler()();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to reconnect NZ: boom');
            expect(ctx.refreshConnectionCapsule).toHaveBeenCalled();
        });

        it('reports connection picker failures instead of rejecting', async () => {
            const manager = createManagerMock({
                getConnections: jest.fn().mockRejectedValue(new Error('store down')),
            });
            registerConnectionCapsuleCommands(createContext(manager));
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(database) NZ',
                action: 'change-connection',
            });

            await expect(getShowCapsuleHandler()()).resolves.toBeUndefined();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Failed to select connection: store down',
            );
            expect(manager.setDocumentConnection).not.toHaveBeenCalled();
        });

        it('does nothing when the tab changes while the menu loads', async () => {
            let resolveEffectiveDb: ((value: string) => void) | undefined;
            const manager = createManagerMock({
                getEffectiveDatabase: jest.fn(
                    () => new Promise<string>((resolve) => {
                        resolveEffectiveDb = resolve;
                    }),
                ),
            });
            registerConnectionCapsuleCommands(createContext(manager));

            const pending = getShowCapsuleHandler()();
            setActiveEditorForUri('sql', 'file:///second.sql');
            resolveEffectiveDb?.('JUST_DATA');
            await pending;

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
            expect(manager.setDocumentConnection).not.toHaveBeenCalled();
        });

        it('keeps the menu open when a read-only info row is picked', async () => {
            registerConnectionCapsuleCommands(createContext(createManagerMock()));
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ label: '$(symbol-namespace) ADMIN' })
                .mockResolvedValueOnce(undefined);

            await getShowCapsuleHandler()();

            expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(2);
        });

        it('opens the login panel for Connect and Manage actions', async () => {            registerConnectionCapsuleCommands(createContext(createManagerMock()));
            const handler = getShowCapsuleHandler();

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(plug) Connect...',
                action: 'connect',
            });
            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.openLogin');

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
                label: '$(gear) Manage connections...',
                action: 'manage',
            });
            await handler();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.openLogin');
        });
    });
});
