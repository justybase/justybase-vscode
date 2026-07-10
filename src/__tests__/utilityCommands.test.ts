/**
 * Tests for commands/schema/utilityCommands.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from 'vscode';
import { registerUtilityCommands } from '../commands/schema/utilityCommands';
import { SchemaCommandsDependencies } from '../commands/schema/types';
import * as variableResolver from '../core/variableResolver';

// Mock vscode
jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn(),
        executeCommand: jest.fn()
    },
    window: {
        setStatusBarMessage: jest.fn(() => ({
            dispose: jest.fn()
        })),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showInputBox: jest.fn(),
        showQuickPick: jest.fn(),
        showTextDocument: jest.fn(),
        activeTextEditor: undefined
    },
    workspace: {
        openTextDocument: jest.fn()
    },
    TreeItemCollapsibleState: {
        Collapsed: 1
    }
}));

// Mock queryRunner
jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn()
}));

// Mock SchemaItem
jest.mock('../providers/schemaProvider', () => ({
    SchemaItem: jest.fn().mockImplementation(() => ({
        label: '',
        collapsibleState: 1,
        contextValue: '',
        dbName: '',
        objType: '',
        schema: '',
        objId: 0,
        connectionName: ''
    }))
}));

jest.mock('../core/favoritesManager', () => ({
    FavoritesManager: {
        getInstance: jest.fn()
    }
}));

jest.mock('../core/queryHistoryManager', () => ({
    QueryHistoryManager: {
        getInstance: jest.fn()
    }
}));

jest.mock('../core/connectionFactory', () => ({
    getDatabaseMetadataProvider: jest.fn()
}));

describe('commands/schema/utilityCommands', () => {
    let registeredCommands: Map<string, Function>; // eslint-disable-line @typescript-eslint/no-unsafe-function-type
    let mockDeps: SchemaCommandsDependencies;
    let mockHistoryManager: { clearHistory: jest.Mock };
    let mockFavoritesManager: {
        toggleFavorite: jest.Mock;
        addFolder: jest.Mock;
        getFavoriteById: jest.Mock;
        updateNote: jest.Mock;
        getFavorites: jest.Mock;
        moveItem: jest.Mock;
        removeFavoriteById: jest.Mock;
        addSqlSnippet: jest.Mock;
        setCopilotSettings: jest.Mock;
        includeNow: jest.Mock;
    };

    const mockedRegisterCommand = vscode.commands.registerCommand as jest.Mock;
    const mockedExecuteCommand = vscode.commands.executeCommand as jest.Mock;
    const mockedShowWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    const mockedShowErrorMessage = vscode.window.showErrorMessage as jest.Mock;
    const mockedShowInformationMessage = vscode.window.showInformationMessage as jest.Mock;
    const mockedShowInputBox = vscode.window.showInputBox as jest.Mock;
    const mockedShowQuickPick = vscode.window.showQuickPick as jest.Mock;
    const mockedShowTextDocument = vscode.window.showTextDocument as jest.Mock;
    const mockedOpenTextDocument = vscode.workspace.openTextDocument as jest.Mock;
    const mockedSetStatusBarMessage = vscode.window.setStatusBarMessage as jest.Mock;
    const { runQueryRaw, queryResultToRows } = require('../core/queryRunner');
    const { FavoritesManager } = require('../core/favoritesManager');
    const { QueryHistoryManager } = require('../core/queryHistoryManager');
    const { getDatabaseMetadataProvider } = require('../core/connectionFactory');
    const mockedRunQueryRaw = runQueryRaw as jest.Mock;
    const mockedQueryResultToRows = queryResultToRows as jest.Mock;
    const mockedFavoritesGetInstance = FavoritesManager.getInstance as jest.Mock;
    const mockedQueryHistoryGetInstance = QueryHistoryManager.getInstance as jest.Mock;
    const mockedGetDatabaseMetadataProvider = getDatabaseMetadataProvider as jest.Mock;

    beforeEach(() => {
        registeredCommands = new Map();
        mockedRegisterCommand.mockImplementation((command: string, handler: Function) => { // eslint-disable-line @typescript-eslint/no-unsafe-function-type
            registeredCommands.set(command, handler);
            return { dispose: jest.fn() };
        });

        mockDeps = {
            context: {
                workspaceState: { get: jest.fn(), update: jest.fn() },
                globalState: { get: jest.fn(), update: jest.fn(), setKeysForSync: jest.fn() },
                extensionUri: {} as any,
                storageUri: {} as any,
                globalStorageUri: {} as any,
                logUri: {} as any,
                extensionMode: 1,
                environmentVariableCollection: {} as any
            } as any,
            connectionManager: {
                getActiveConnectionName: jest.fn(() => 'test-connection'),
                getConnection: jest.fn(),
                getConnectionForExecution: jest.fn(),
                getCurrentDatabase: jest.fn(),
                getConnectionDatabaseKind: jest.fn(() => 'netezza')
            } as any,
            metadataCache: {
                findObjectWithType: jest.fn(),
                hasConnectionPrefetchTriggered: jest.fn(() => true),
                isConnectionPrefetchFresh: jest.fn(() => true),
                triggerConnectionPrefetch: jest.fn(() => Promise.resolve())
            } as any,
            schemaTreeView: {
                reveal: jest.fn()
            } as any,
            schemaProvider: {} as any
        };

        (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue({
            host: 'localhost',
            port: 5480,
            database: 'testdb',
            user: 'testuser',
            password: 'testpass'
        });
        (mockDeps.connectionManager.getCurrentDatabase as jest.Mock).mockResolvedValue('testdb');

        mockHistoryManager = {
            clearHistory: jest.fn().mockResolvedValue(undefined)
        };
        mockFavoritesManager = {
            toggleFavorite: jest.fn().mockResolvedValue(true),
            addFolder: jest.fn().mockResolvedValue('folder-1'),
            getFavoriteById: jest.fn(),
            updateNote: jest.fn().mockResolvedValue(undefined),
            getFavorites: jest.fn().mockResolvedValue([]),
            moveItem: jest.fn().mockResolvedValue(undefined),
            removeFavoriteById: jest.fn().mockResolvedValue(undefined),
            addSqlSnippet: jest.fn().mockResolvedValue('sql-1'),
            setCopilotSettings: jest.fn().mockResolvedValue(undefined),
            includeNow: jest.fn().mockResolvedValue(true)
        };
        mockedQueryHistoryGetInstance.mockReturnValue(mockHistoryManager);
        mockedFavoritesGetInstance.mockReturnValue(mockFavoritesManager);
        mockedGetDatabaseMetadataProvider.mockReturnValue({
            buildObjectSearchQuery: jest.fn(() => 'SELECT GENERIC OBJECT SEARCH'),
            buildListDatabasesQuery: jest.fn(() => 'SELECT GENERIC DATABASES')
        });

        (vscode.window as any).activeTextEditor = undefined;
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    const getCommandHandler = (command: string) => {
        registerUtilityCommands(mockDeps);
        const handler = registeredCommands.get(command);
        expect(handler).toBeDefined();
        return handler as (...args: any[]) => Promise<void>;
    };

    const createActiveEditor = (
        selectedText: string,
        fullText: string,
        languageId = 'sql'
    ) => {
        const insert = jest.fn();
        const edit = jest.fn(async (callback: (editBuilder: { insert: jest.Mock }) => void) => {
            callback({ insert });
            return true;
        });

        const editor = {
            document: {
                languageId,
                uri: { toString: () => 'file:///tmp/query.sql' },
                getText: jest.fn((selection?: unknown) => (selection ? selectedText : fullText))
            },
            selection: { active: { line: 0, character: 0 } },
            edit
        };

        (vscode.window as any).activeTextEditor = editor;
        return { insert, edit, editor };
    };

    describe('registerUtilityCommands', () => {
        it('should register all utility commands', () => {
            const disposables = registerUtilityCommands(mockDeps);

            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.revealInSchema', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.showQueryHistory', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.clearQueryHistory', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.toggleSchemaFavorite', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.addFolder', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.editNote', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.delete', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.moveToFolder', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.addSqlSnippet', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.openSql', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.toggleCopilotAutoInclude', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.toggleCopilotEnabled', expect.any(Function));
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith('netezza.insertToEditor', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.favorites.includeNow', expect.any(Function));
            expect(mockedRegisterCommand).toHaveBeenCalledWith('netezza.refreshSchemaSelection', expect.any(Function));
            expect(disposables).toHaveLength(19);
        });

        it('should return disposables for cleanup', () => {
            const disposables = registerUtilityCommands(mockDeps);

            expect(disposables).toHaveLength(19);
            expect(disposables[0].dispose).toBeDefined();
            expect(disposables[1].dispose).toBeDefined();
            expect(disposables[2].dispose).toBeDefined();
            expect(disposables[3].dispose).toBeDefined();
            expect(disposables[4].dispose).toBeDefined();
            expect(disposables[5].dispose).toBeDefined();
            expect(disposables[6].dispose).toBeDefined();
            expect(disposables[7].dispose).toBeDefined();
            expect(disposables[8].dispose).toBeDefined();
            expect(disposables[9].dispose).toBeDefined();
            expect(disposables[10].dispose).toBeDefined();
            expect(disposables[11].dispose).toBeDefined();
            expect(disposables[12].dispose).toBeDefined();
            expect(disposables[13].dispose).toBeDefined();
            expect(disposables[14].dispose).toBeDefined();
            expect(disposables[15].dispose).toBeDefined();
            expect(disposables[16].dispose).toBeDefined();
            expect(disposables[17].dispose).toBeDefined();
        });
    });

    describe('netezza.revealInSchema command handler', () => {
        it('should show warning when no active connection', async () => {
            (mockDeps.connectionManager.getActiveConnectionName as jest.Mock).mockReturnValue(undefined);
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({ name: 'test_table' });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith('No active connection. Please select a connection first.');
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"operation":"schema.reveal_in_schema"'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"error_code":"NO_CONNECTION"'));
            logSpy.mockRestore();
        });

        it('should find object from cache', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue({
                name: 'test_table',
                objType: 'TABLE',
                schema: 'public',
                objId: 123
            });

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'test_table',
                database: 'testdb',
                schema: 'public'
            });

            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalled();
            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalledWith(expect.anything(), { select: true, focus: true });
            expect(mockedExecuteCommand).toHaveBeenCalledWith('netezza.schema.focus');
            expect(mockedSetStatusBarMessage).toHaveBeenCalled();
        });

        it('should use current database for cache lookup when payload database is missing', async () => {
            (mockDeps.connectionManager.getCurrentDatabase as jest.Mock).mockResolvedValue('testdb');
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue({
                name: 'test_table',
                objType: 'TABLE',
                schema: 'public',
                objId: 123
            });

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'test_table',
                schema: 'public'
            });

            expect(mockDeps.metadataCache.findObjectWithType).toHaveBeenCalledWith(
                'test-connection',
                'testdb',
                'public',
                'test_table'
            );
            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalledWith(expect.anything(), { select: true, focus: true });
        });

        it('should query database when not in cache', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue(null);
            (mockDeps.metadataCache.isConnectionPrefetchFresh as jest.Mock).mockReturnValue(true);

            mockedRunQueryRaw.mockResolvedValue({
                data: [['test_table', 'TABLE', 'public', 123]],
                columns: [{ name: 'OBJNAME' }, { name: 'OBJTYPE' }, { name: 'SCHEMA' }, { name: 'OBJID' }]
            });

            mockedQueryResultToRows.mockReturnValue([
                { OBJNAME: 'test_table', OBJTYPE: 'TABLE', SCHEMA: 'public', OBJID: 123 }
            ]);

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'test_table',
                database: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            });

            expect(mockedRunQueryRaw).toHaveBeenCalled();
            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalled();
        });

        it('should use dialect metadata queries for MySQL reveal lookups', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue(null);
            (mockDeps.connectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue('mysql');
            (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue({
                database: 'hr'
            });

            const buildObjectSearchQuery = jest.fn(() => 'SELECT MYSQL OBJECT SEARCH');
            mockedGetDatabaseMetadataProvider.mockReturnValue({
                buildObjectSearchQuery,
                buildListDatabasesQuery: jest.fn(() => 'SELECT MYSQL DATABASES')
            });

            mockedRunQueryRaw.mockResolvedValue({
                data: [['employees', 'hr', 'hr', 'TABLE']],
                columns: [{ name: 'NAME' }, { name: 'SCHEMA' }, { name: 'DATABASE' }, { name: 'TYPE' }]
            });
            mockedQueryResultToRows.mockReturnValue([
                { NAME: 'employees', SCHEMA: 'hr', DATABASE: 'hr', TYPE: 'TABLE' }
            ]);

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: '`employees`',
                database: '`hr`',
                schema: '`hr`',
                objType: 'TABLE'
            });

            expect(buildObjectSearchQuery).toHaveBeenCalledWith('hr', '%EMPLOYEES%');
            expect(mockedRunQueryRaw).toHaveBeenCalledWith(
                expect.anything(),
                'SELECT MYSQL OBJECT SEARCH',
                true,
                mockDeps.connectionManager,
                'test-connection',
                undefined,
                undefined,
                undefined,
                1000000,
                false
            );
            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalled();
        });

        it('should show warning when object not found', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue(null);
            (mockDeps.metadataCache.isConnectionPrefetchFresh as jest.Mock).mockReturnValue(true);
            (mockDeps.connectionManager.getCurrentDatabase as jest.Mock).mockResolvedValue('testdb');

            mockedRunQueryRaw.mockResolvedValue({
                data: [],
                columns: []
            });

            mockedQueryResultToRows.mockReturnValue([]);

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'nonexistent_table',
                database: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith('Could not find TABLE nonexistent_table');
        });

        it('should handle column reveal with parent', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue({
                name: 'test_table',
                objType: 'TABLE',
                schema: 'public',
                objId: 123
            });

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'column1',
                objType: 'COLUMN',
                parent: 'test_table',
                database: 'testdb',
                schema: 'public'
            });

            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalled();
        });

        it('should show warning when column has no parent', async () => {
            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'column1',
                objType: 'COLUMN'
            });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith('Cannot find column without parent table');
        });

        it('should use SQL editor mapped connection when available', async () => {
            createActiveEditor('', '');
            (mockDeps.connectionManager.getConnectionForExecution as jest.Mock).mockReturnValue('editor-connection');
            (mockDeps.connectionManager.getActiveConnectionName as jest.Mock).mockReturnValue(undefined);
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue({
                name: 'table_via_editor',
                objType: 'TABLE',
                schema: 'public',
                objId: 11
            });

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'table_via_editor',
                schema: 'public'
            });

            expect(mockDeps.connectionManager.getConnectionForExecution).toHaveBeenCalledWith('file:///tmp/query.sql');
            expect(mockDeps.metadataCache.findObjectWithType).toHaveBeenCalledWith(
                'editor-connection',
                'testdb',
                'public',
                'table_via_editor'
            );
        });

        it('should show warning when cache miss and connection details are unavailable', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue(null);
            (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue(undefined);

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'missing_table',
                database: 'testdb'
            });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith(
                'Not connected to database and object not found in cache.'
            );
        });

        it('should fallback to cross-database search when target database is unknown', async () => {
            (mockDeps.connectionManager.getCurrentDatabase as jest.Mock).mockResolvedValue(undefined);
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue(null);

            mockedRunQueryRaw
                .mockResolvedValueOnce({
                    data: [['db1'], ['db2']],
                    columns: [{ name: 'DATABASE' }]
                })
                .mockResolvedValueOnce({
                    data: [],
                    columns: []
                })
                .mockResolvedValueOnce({
                    data: [['target_table', 'TABLE', 'public', 42]],
                    columns: [{ name: 'OBJNAME' }, { name: 'OBJTYPE' }, { name: 'SCHEMA' }, { name: 'OBJID' }]
                });

            mockedQueryResultToRows
                .mockReturnValueOnce([{ DATABASE: 'db1' }, { DATABASE: 'db2' }])
                .mockReturnValueOnce([])
                .mockReturnValueOnce([{ OBJNAME: 'target_table', OBJTYPE: 'TABLE', SCHEMA: 'public', OBJID: 42 }]);

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({ name: 'target_table', objType: 'TABLE' });

            expect(mockedRunQueryRaw).toHaveBeenCalledTimes(3);
            expect(mockedRunQueryRaw.mock.calls[1][1]).toContain('FROM db1.._V_OBJECT_DATA');
            expect(mockedRunQueryRaw.mock.calls[2][1]).toContain('FROM db2.._V_OBJECT_DATA');
            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalled();
        });

        it('should resolve procedure signature before reveal', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue(null);
            mockedRunQueryRaw
                .mockResolvedValueOnce({
                    data: [['proc_a', 'PROCEDURE', 'public', 77]],
                    columns: [{ name: 'OBJNAME' }, { name: 'OBJTYPE' }, { name: 'SCHEMA' }, { name: 'OBJID' }]
                })
                .mockResolvedValueOnce({
                    data: [['proc_a(integer)']],
                    columns: [{ name: 'PROCEDURESIGNATURE' }]
                });
            mockedQueryResultToRows
                .mockReturnValueOnce([{ OBJNAME: 'proc_a', OBJTYPE: 'PROCEDURE', SCHEMA: 'public', OBJID: 77 }])
                .mockReturnValueOnce([{ PROCEDURESIGNATURE: 'proc_a(integer)' }]);

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'proc_a',
                database: 'testdb',
                objType: 'PROCEDURE'
            });

            expect(mockedRunQueryRaw).toHaveBeenCalledTimes(2);
            expect(mockedRunQueryRaw.mock.calls[1][1]).toContain('_V_PROCEDURE');
            expect(mockDeps.schemaTreeView.reveal).toHaveBeenCalled();
        });

        it('should report CQ01-REVEAL-005 when reveal throws', async () => {
            (mockDeps.metadataCache.findObjectWithType as jest.Mock).mockReturnValue({
                name: 'test_table',
                objType: 'TABLE',
                schema: 'public',
                objId: 123
            });
            (mockDeps.schemaTreeView.reveal as jest.Mock).mockRejectedValue(new Error('Reveal exploded'));

            const handler = getCommandHandler('netezza.revealInSchema');

            await handler({
                name: 'test_table',
                database: 'testdb',
                schema: 'public'
            });

            expect(mockedShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Error revealing item (CQ01-REVEAL-005): Reveal exploded')
            );
        });
    });

    describe('netezza.showQueryHistory command handler', () => {
        it('should execute query history command', async () => {
            mockedExecuteCommand.mockResolvedValue(undefined);

            const handler = getCommandHandler('netezza.showQueryHistory');

            await handler();

            expect(mockedExecuteCommand).toHaveBeenCalledWith('netezza.queryHistory.focus');
        });
    });

    describe('netezza.clearQueryHistory command handler', () => {
        it('should be registered', () => {
            registerUtilityCommands(mockDeps);
            const handler = registeredCommands.get('netezza.clearQueryHistory');
            expect(handler).toBeDefined();
        });

        it('should clear query history after confirmation', async () => {
            mockedShowWarningMessage.mockResolvedValue('Clear All');
            const handler = getCommandHandler('netezza.clearQueryHistory');

            await handler();

            expect(mockHistoryManager.clearHistory).toHaveBeenCalledTimes(1);
            expect(mockedShowInformationMessage).toHaveBeenCalledWith('Query history cleared');
        });

        it('should skip clear when confirmation is dismissed', async () => {
            mockedShowWarningMessage.mockResolvedValue(undefined);
            const handler = getCommandHandler('netezza.clearQueryHistory');

            await handler();

            expect(mockHistoryManager.clearHistory).not.toHaveBeenCalled();
        });
    });

    describe('favorites command handlers', () => {
        it('should add favorite and show confirmation message', async () => {
            mockFavoritesManager.toggleFavorite.mockResolvedValue(true);
            const handler = getCommandHandler('netezza.toggleSchemaFavorite');

            await handler({ label: 'orders' });

            expect(mockFavoritesManager.toggleFavorite).toHaveBeenCalled();
            expect(mockedShowInformationMessage).toHaveBeenCalledWith('Added orders to Favorites');
        });

        it('should remove favorite and show confirmation message', async () => {
            mockFavoritesManager.toggleFavorite.mockResolvedValue(false);
            const handler = getCommandHandler('netezza.toggleSchemaFavorite');

            await handler({ label: 'orders' });

            expect(mockedShowInformationMessage).toHaveBeenCalledWith('Removed orders from Favorites');
        });

        it('should show CQ01-FAV-001 on toggle favorite error', async () => {
            mockFavoritesManager.toggleFavorite.mockRejectedValue(new Error('toggle failed'));
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
            const handler = getCommandHandler('netezza.toggleSchemaFavorite');

            await handler({ label: 'orders' });

            expect(mockedShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Failed to toggle favorite (CQ01-FAV-001): toggle failed')
            );
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"operation":"schema.favorite.toggle"'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"error_code":"CQ01-FAV-001"'));
            logSpy.mockRestore();
        });

        it('should add folder in selected parent favorites folder', async () => {
            mockedShowInputBox.mockResolvedValue('My Folder');
            const handler = getCommandHandler('netezza.favorites.addFolder');

            await handler({ contextValue: 'favoritesFolder', id: 'folder-parent' });

            expect(mockFavoritesManager.addFolder).toHaveBeenCalledWith('My Folder', 'folder-parent');
        });

        it('should skip adding folder when user cancels input', async () => {
            mockedShowInputBox.mockResolvedValue(undefined);
            const handler = getCommandHandler('netezza.favorites.addFolder');

            await handler();

            expect(mockFavoritesManager.addFolder).not.toHaveBeenCalled();
        });

        it('should edit favorite note when user provides value', async () => {
            mockFavoritesManager.getFavoriteById.mockReturnValue({ customNote: 'old note' });
            mockedShowInputBox.mockResolvedValue('new note');
            const handler = getCommandHandler('netezza.favorites.editNote');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockFavoritesManager.updateNote).toHaveBeenCalledWith('fav-1', 'new note');
        });

        it('should not edit note when input is canceled', async () => {
            mockFavoritesManager.getFavoriteById.mockReturnValue({ customNote: 'old note' });
            mockedShowInputBox.mockResolvedValue(undefined);
            const handler = getCommandHandler('netezza.favorites.editNote');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockFavoritesManager.updateNote).not.toHaveBeenCalled();
        });

        it('should move favorite to root when root target is selected', async () => {
            mockFavoritesManager.getFavorites.mockResolvedValue([
                { id: 'folder-a', type: 'folder', label: 'Folder A', customNote: 'A' }
            ]);
            mockedShowQuickPick.mockResolvedValue({
                label: '$(star-full) (Root)',
                description: 'Move to top level Favorites'
            });
            const handler = getCommandHandler('netezza.favorites.moveToFolder');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockFavoritesManager.moveItem).toHaveBeenCalledWith('fav-1', undefined);
        });

        it('should move favorite to selected folder target', async () => {
            mockFavoritesManager.getFavorites.mockResolvedValue([
                { id: 'folder-a', type: 'folder', label: 'Folder A', customNote: 'A' }
            ]);
            mockedShowQuickPick.mockResolvedValue({
                label: '$(folder) Folder A',
                id: 'folder-a'
            });
            const handler = getCommandHandler('netezza.favorites.moveToFolder');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockFavoritesManager.moveItem).toHaveBeenCalledWith('fav-1', 'folder-a');
        });

        it('should delete favorite by id', async () => {
            const handler = getCommandHandler('netezza.favorites.delete');

            await handler({ id: 'fav-1' });

            expect(mockFavoritesManager.removeFavoriteById).toHaveBeenCalledWith('fav-1');
        });

        it('should add SQL snippet using selected text', async () => {
            createActiveEditor('SELECT 1', 'SELECT * FROM all_rows');
            mockedShowInputBox.mockResolvedValue('Snippet 1');
            const handler = getCommandHandler('netezza.favorites.addSqlSnippet');

            await handler();

            expect(mockFavoritesManager.addSqlSnippet).toHaveBeenCalledWith('Snippet 1', 'SELECT 1');
            expect(mockedShowInformationMessage).toHaveBeenCalledWith('Saved snippet "Snippet 1" to Favorites');
        });

        it('should add SQL snippet using whole document when selection is empty', async () => {
            createActiveEditor('', 'SELECT * FROM all_rows');
            mockedShowInputBox.mockResolvedValue('Snippet All');
            const handler = getCommandHandler('netezza.favorites.addSqlSnippet');

            await handler();

            expect(mockFavoritesManager.addSqlSnippet).toHaveBeenCalledWith('Snippet All', 'SELECT * FROM all_rows');
        });

        it('should skip adding SQL snippet when editor is unavailable', async () => {
            (vscode.window as any).activeTextEditor = undefined;
            const handler = getCommandHandler('netezza.favorites.addSqlSnippet');

            await handler();

            expect(mockFavoritesManager.addSqlSnippet).not.toHaveBeenCalled();
        });

        it('should skip adding SQL snippet when extracted text is blank', async () => {
            createActiveEditor('   ', 'SELECT * FROM fallback_table');
            const handler = getCommandHandler('netezza.favorites.addSqlSnippet');

            await handler();

            expect(mockedShowInputBox).not.toHaveBeenCalled();
            expect(mockFavoritesManager.addSqlSnippet).not.toHaveBeenCalled();
        });

        it('should show warning when toggling auto-include for missing favorite', async () => {
            mockFavoritesManager.getFavoriteById.mockReturnValue(undefined);
            const handler = getCommandHandler('netezza.favorites.toggleCopilotAutoInclude');

            await handler({ id: 'missing-fav', label: 'orders' });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith('Favorite not found');
            expect(mockFavoritesManager.setCopilotSettings).not.toHaveBeenCalled();
        });

        it('should toggle copilot auto-include setting', async () => {
            mockFavoritesManager.getFavoriteById.mockReturnValue({ autoInclude: true });
            const handler = getCommandHandler('netezza.favorites.toggleCopilotAutoInclude');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockFavoritesManager.setCopilotSettings).toHaveBeenCalledWith('fav-1', { autoInclude: false });
            expect(mockedShowInformationMessage).toHaveBeenCalledWith(
                'Copilot auto-include disabled for orders'
            );
        });

        it('should toggle copilot enabled setting', async () => {
            mockFavoritesManager.getFavoriteById.mockReturnValue({ enabled: false });
            const handler = getCommandHandler('netezza.favorites.toggleCopilotEnabled');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockFavoritesManager.setCopilotSettings).toHaveBeenCalledWith('fav-1', { enabled: true });
            expect(mockedShowInformationMessage).toHaveBeenCalledWith('Copilot context enabled for orders');
        });

        it('should include favorite immediately when includeNow succeeds', async () => {
            mockFavoritesManager.includeNow.mockResolvedValue(true);
            const handler = getCommandHandler('netezza.favorites.includeNow');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockedShowInformationMessage).toHaveBeenCalledWith(
                'orders will be included in the next Copilot request'
            );
        });

        it('should show warning when includeNow fails', async () => {
            mockFavoritesManager.includeNow.mockResolvedValue(false);
            const handler = getCommandHandler('netezza.favorites.includeNow');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith('Failed to include favorite');
        });

        it('should show CQ01-FAV-012 when includeNow throws', async () => {
            mockFavoritesManager.includeNow.mockRejectedValue(new Error('include failed'));
            const handler = getCommandHandler('netezza.favorites.includeNow');

            await handler({ id: 'fav-1', label: 'orders' });

            expect(mockedShowErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('Failed to include favorite for next Copilot request (CQ01-FAV-012): include failed')
            );
        });
    });

    describe('editor insert command handlers', () => {
        it('should warn when insertToEditor has no active editor', async () => {
            (vscode.window as any).activeTextEditor = undefined;
            const handler = getCommandHandler('netezza.insertToEditor');

            await handler({ label: 'orders' });

            expect(mockedShowWarningMessage).toHaveBeenCalledWith('No active text editor to insert into.');
        });

        it('should insert fully qualified object name for non-column schema item', async () => {
            const { insert } = createActiveEditor('', '');
            const handler = getCommandHandler('netezza.insertToEditor');

            await handler({
                label: 'orders',
                schema: 'public',
                dbName: 'testdb',
                contextValue: 'table'
            });

            expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'testdb.public."orders"');
        });

        it('should insert plain column name for column items', async () => {
            const { insert } = createActiveEditor('', '');
            const handler = getCommandHandler('netezza.insertToEditor');

            await handler({
                label: 'ID (INTEGER)',
                contextValue: 'column',
                schema: 'public',
                dbName: 'testdb'
            });

            expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'ID');
        });

        it('should strip type suffix for column labels with nested parentheses', async () => {
            const { insert } = createActiveEditor('', '');
            const handler = getCommandHandler('netezza.insertToEditor');

            await handler({
                label: 'AMOUNT (NUMERIC(10,2))',
                contextValue: 'column',
                schema: 'public',
                dbName: 'testdb'
            });

            expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'AMOUNT');
        });

        it('should require double-click when insert comes from tree click', async () => {
            const { insert } = createActiveEditor('', '');
            const nowSpy = jest.spyOn(Date, 'now')
                .mockReturnValueOnce(1000)
                .mockReturnValueOnce(1200);
            const handler = getCommandHandler('netezza.insertToEditor');
            const item = { id: 'table-1', label: 'orders', contextValue: 'table' };

            await handler(item, { fromTreeClick: true });
            await handler(item, { fromTreeClick: true });

            expect(insert).toHaveBeenCalledTimes(1);
            nowSpy.mockRestore();
        });

        it('should open SQL in active editor when available', async () => {
            const { insert } = createActiveEditor('', '');
            const handler = getCommandHandler('netezza.favorites.openSql');

            await handler({ sqlContent: 'SELECT 1', id: 'sql-1', label: 'Snippet' });

            expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'SELECT 1');
        });

        it('should open SQL in a new document when no active editor is present', async () => {
            (vscode.window as any).activeTextEditor = undefined;
            const fakeDoc = { uri: 'file:///tmp/new.sql' };
            mockedOpenTextDocument.mockResolvedValue(fakeDoc);
            const handler = getCommandHandler('netezza.favorites.openSql');

            await handler({ sqlContent: 'SELECT 2', id: 'sql-2', label: 'Snippet 2' });

            expect(mockedOpenTextDocument).toHaveBeenCalledWith({
                content: 'SELECT 2',
                language: 'sql'
            });
            expect(mockedShowTextDocument).toHaveBeenCalledWith(fakeDoc);
        });

        it('should require double-click when opening SQL from tree click', async () => {
            const { insert } = createActiveEditor('', '');
            const nowSpy = jest.spyOn(Date, 'now')
                .mockReturnValueOnce(2000)
                .mockReturnValueOnce(2300);
            const handler = getCommandHandler('netezza.favorites.openSql');
            const item = { id: 'sql-3', label: 'Snippet 3', sqlContent: 'SELECT 3' };

            await handler(item, { fromTreeClick: true });
            await handler(item, { fromTreeClick: true });

            expect(insert).toHaveBeenCalledTimes(1);
            nowSpy.mockRestore();
        });

        it('should resolve snippet parameters before inserting SQL', async () => {
            const { insert } = createActiveEditor('', '');
            jest.spyOn(variableResolver, 'resolveQueryVariables').mockResolvedValue('SELECT 42');
            const handler = getCommandHandler('netezza.favorites.openSql');

            await handler({ sqlContent: 'SELECT ${value}', id: 'sql-param', label: 'Snippet Param' });

            expect(variableResolver.resolveQueryVariables).toHaveBeenCalledWith(
                'SELECT ${value}',
                false,
                mockDeps.context
            );
            expect(insert).toHaveBeenCalledWith({ line: 0, character: 0 }, 'SELECT 42');
        });
    });
});
