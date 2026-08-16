/**
 * Unit tests for commands/schema/viewCommands.ts
 */

import * as vscode from 'vscode';
import { registerViewCommands } from '../commands/schema/viewCommands';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { requireConnection } from '../commands/schema/helpers';
import { buildVisualQueryBuilderDataForAllSchemas } from '../schema/queryBuilderProvider';
import { VisualQueryBuilderView } from '../views/visualQueryBuilderView';
import { SchemaCommandsDependencies, SchemaItemData } from '../commands/schema/types';

jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() }))
    },
    window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showQuickPick: jest.fn()
    },
    ProgressLocation: {
        Notification: 15
    }
}));

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn()
}));

jest.mock('../commands/schema/helpers', () => ({
    requireConnection: jest.fn(),
    executeWithProgress: jest.fn((_title, task) => task({ report: jest.fn() }))
}));

jest.mock('../schema/queryBuilderProvider', () => ({
    buildVisualQueryBuilderDataForAllSchemas: jest.fn()
}));

jest.mock('../views/visualQueryBuilderView', () => ({
    VisualQueryBuilderView: {
        createOrShow: jest.fn()
    }
}));

describe('commands/schema/viewCommands', () => {
    const buildVisualQueryBuilderDataForAllSchemasMock = buildVisualQueryBuilderDataForAllSchemas as jest.MockedFunction<typeof buildVisualQueryBuilderDataForAllSchemas>;
    const createOrShowMock = VisualQueryBuilderView.createOrShow as jest.MockedFunction<typeof VisualQueryBuilderView.createOrShow>;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockContext: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockConnectionManager: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockMetadataCache: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockSchemaProvider: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockSchemaTreeView: any;
    let deps: SchemaCommandsDependencies;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            extensionUri: { fsPath: '/test/extension' },
            subscriptions: []
        };

        mockConnectionManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('test-conn'),
            getConnectionForExecution: jest.fn().mockReturnValue('test-conn'),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('access'),
            getConnection: jest.fn().mockResolvedValue({ name: 'test-conn', host: 'localhost' }),
            supportsCapability: jest.fn().mockReturnValue(true)
        };

        mockMetadataCache = {};

        mockSchemaProvider = {};

        mockSchemaTreeView = {};

        deps = {
            context: mockContext,
            connectionManager: mockConnectionManager,
            metadataCache: mockMetadataCache,
            schemaProvider: mockSchemaProvider,
            schemaTreeView: mockSchemaTreeView
        };
    });

    describe('registerViewCommands', () => {
        it('should register all view commands', () => {
            const disposables = registerViewCommands(deps);

            expect(disposables).toHaveLength(5);
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.showERD',
                expect.any(Function)
            );
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openVisualQueryBuilder',
                expect.any(Function)
            );
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openSecurityPanel',
                expect.any(Function)
            );
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.showSessionMonitor',
                expect.any(Function)
            );
            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.openTestDataGenerator',
                expect.any(Function)
            );
        });

        it('should return disposables for cleanup', () => {
            const disposables = registerViewCommands(deps);

            disposables.forEach(d => {
                expect(d).toHaveProperty('dispose');
            });
        });
    });

    describe('netezza.showERD command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let showERDCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerViewCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const showERDCall = calls.find(call => call[0] === 'netezza.showERD');
            showERDCallback = showERDCall![1];
        });

        it('should show error when item is missing', async () => {
            await showERDCallback();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Please right-click on a TABLE type group to show ERD'
            );
        });

        it('should show error when item contextValue is not typeGroup', async () => {
            const item: SchemaItemData = {
                label: 'test',
                contextValue: 'table',
                dbName: 'testdb',
                connectionName: 'test-conn'
            };

            await showERDCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Please right-click on a TABLE type group to show ERD'
            );
        });

        it('should show error when connectionName is missing', async () => {
            const item: SchemaItemData = {
                label: 'test',
                contextValue: 'typeGroup:TABLE',
                dbName: 'testdb'
            };

            await showERDCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No connection selected');
        });

        it('should show error when schema query fails', async () => {
            const item: SchemaItemData = {
                label: 'test',
                contextValue: 'typeGroup:TABLE',
                dbName: 'testdb',
                connectionName: 'test-conn'
            };

            (runQueryRaw as jest.Mock).mockResolvedValue(null);

            await showERDCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Could not retrieve schemas');
        });

        it('should show warning when no tables found', async () => {
            const item: SchemaItemData = {
                label: 'test',
                contextValue: 'typeGroup:TABLE',
                dbName: 'testdb',
                connectionName: 'test-conn'
            };

            (runQueryRaw as jest.Mock).mockResolvedValue({ data: [] });
            (queryResultToRows as jest.Mock).mockReturnValue([]);

            await showERDCallback(item);

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'No tables found in this database'
            );
        });
    });

    describe('netezza.openVisualQueryBuilder command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let openVisualQueryBuilderCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerViewCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const commandCall = calls.find(call => call[0] === 'netezza.openVisualQueryBuilder');
            openVisualQueryBuilderCallback = commandCall![1];
        });

        it('should show error when item is missing', async () => {
            await openVisualQueryBuilderCallback();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Please right-click on a TABLE or VIEW type group to open Visual Query Builder'
            );
        });

        it('should show error when connectionName is missing', async () => {
            const item: SchemaItemData = {
                contextValue: 'typeGroup:TABLE',
                dbName: 'TESTDB'
            };

            await openVisualQueryBuilderCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No connection selected');
        });

        it('should show warning when no schemas are available', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('netezza');
            const item: SchemaItemData = {
                contextValue: 'typeGroup:TABLE',
                dbName: 'TESTDB',
                connectionName: 'test-conn'
            };

            buildVisualQueryBuilderDataForAllSchemasMock.mockResolvedValue({
                database: 'TESTDB',
                schema: '',
                tables: [],
                relationships: [],
                allSchemas: []
            });

            await openVisualQueryBuilderCallback(item);

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No tables or views found in this database');
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('should load and open visual query builder', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('netezza');
            const item: SchemaItemData = {
                contextValue: 'typeGroup:TABLE',
                dbName: 'TESTDB',
                connectionName: 'test-conn'
            };

            buildVisualQueryBuilderDataForAllSchemasMock.mockResolvedValue({
                database: 'TESTDB',
                schema: 'ADMIN',
                tables: [{
                    database: 'TESTDB', schema: 'ADMIN', tableName: 'ORDERS', fullName: 'TESTDB.ADMIN.ORDERS',
                    primaryKeyColumns: [], columns: []
                }],
                relationships: [],
                allSchemas: ['ADMIN', 'SALES']
            });

            await openVisualQueryBuilderCallback(item);

            expect(buildVisualQueryBuilderDataForAllSchemasMock).toHaveBeenCalledWith(
                mockContext,
                mockConnectionManager,
                'test-conn',
                'TESTDB'
            );
            expect(createOrShowMock).toHaveBeenCalledWith(
                mockContext.extensionUri,
                mockContext,
                mockConnectionManager,
                'test-conn',
                ['ADMIN', 'SALES'],
                {
                    database: 'TESTDB',
                    schema: 'ADMIN',
                    tables: [{
                        database: 'TESTDB', schema: 'ADMIN', tableName: 'ORDERS', fullName: 'TESTDB.ADMIN.ORDERS',
                        primaryKeyColumns: [], columns: []
                    }],
                    relationships: [],
                    allSchemas: ['ADMIN', 'SALES']
                }
            );
        });
        it('opens the builder from a VIEW group for a File SQL connection', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('file');
            buildVisualQueryBuilderDataForAllSchemasMock.mockResolvedValue({
                database: 'MEMORY',
                schema: 'MAIN',
                tables: [{
                    database: 'memory', schema: 'MAIN', tableName: 'Sales', fullName: 'memory.MAIN.Sales',
                    objectType: 'VIEW', primaryKeyColumns: [], columns: []
                }],
                relationships: [],
                allSchemas: ['MAIN']
            });

            await openVisualQueryBuilderCallback({
                contextValue: 'typeGroup:VIEW', dbName: 'memory', connectionName: 'test-conn'
            });

            expect(buildVisualQueryBuilderDataForAllSchemasMock).toHaveBeenCalledWith(
                mockContext,
                mockConnectionManager,
                'test-conn',
                'memory'
            );
            expect(createOrShowMock).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Visual Query Builder ready: 1 sources, 0 relationships from 1 schema(s)'
            );
        });

        it('rejects a database kind without Visual Query Builder support', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');

            await openVisualQueryBuilderCallback({
                contextValue: 'typeGroup:TABLE', dbName: 'TESTDB', connectionName: 'test-conn'
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Visual Query Builder is available for Netezza, DuckDB, and File SQL connections.'
            );
        });
    });

    describe('netezza.openSecurityPanel command handler', () => {
        let openSecurityPanelCallback: () => Promise<void>;

        beforeEach(() => {
            registerViewCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const securityCall = calls.find(call => call[0] === 'netezza.openSecurityPanel');
            openSecurityPanelCallback = securityCall![1];
        });

        it('should show error when no connection', async () => {
            (requireConnection as jest.Mock).mockResolvedValue(false);

            await openSecurityPanelCallback();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Please connect to a database first.'
            );
        });

        it('should check connection before opening panel', async () => {
            (requireConnection as jest.Mock).mockResolvedValue(true);

            await openSecurityPanelCallback();

            expect(requireConnection).toHaveBeenCalled();
        });
    });

    describe('netezza.showSessionMonitor command handler', () => {
        let showSessionMonitorCallback: () => Promise<void>;

        beforeEach(() => {
            registerViewCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const sessionCall = calls.find(call => call[0] === 'netezza.showSessionMonitor');
            showSessionMonitorCallback = sessionCall![1];
        });

        it('should show error when no connection', async () => {
            (requireConnection as jest.Mock).mockResolvedValue(false);

            await showSessionMonitorCallback();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Please connect to a database first.'
            );
        });

        it('should handle errors gracefully', async () => {
            (requireConnection as jest.Mock).mockResolvedValue(true);

            // The command should complete without throwing
            await showSessionMonitorCallback();

            expect(requireConnection).toHaveBeenCalled();
        });

        it('should block session monitor when the dialect does not support it', async () => {
            (requireConnection as jest.Mock).mockResolvedValue(true);
            mockConnectionManager.supportsCapability.mockReturnValue(false);

            await showSessionMonitorCallback();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                "Session monitor is not supported for active connection 'test-conn' (access). Select a Netezza connection with \"JustyBase: Select Active Connection\" first."
            );
        });

        it('should use the selected schema connection instead of the global active connection', async () => {
            mockSchemaTreeView.selection = [{ connectionName: 'NetezzaWarehouse' }];
            mockConnectionManager.supportsCapability.mockImplementation(
                (_capability: string, _documentUri: string | undefined, connectionName: string) =>
                    connectionName === 'NetezzaWarehouse',
            );
            (requireConnection as jest.Mock).mockResolvedValue(true);

            await showSessionMonitorCallback();

            expect(mockConnectionManager.supportsCapability).toHaveBeenCalledWith(
                'supportsSessionMonitor',
                undefined,
                'NetezzaWarehouse',
            );
        });
    });
});
