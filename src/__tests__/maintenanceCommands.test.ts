/**
 * Unit tests for commands/schema/maintenanceCommands.ts
 */

import * as vscode from 'vscode';
import * as connectionFactory from '../core/connectionFactory';
import { registerMaintenanceCommands } from '../commands/schema/maintenanceCommands';
import { runQuery } from '../core/queryRunner';
import { executeWithProgress } from '../commands/schema/helpers';
import { SchemaCommandsDependencies, SchemaItemData } from '../commands/schema/types';

jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() })),
        executeCommand: jest.fn(),
    },
    window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showQuickPick: jest.fn(),
        showInputBox: jest.fn(),
        showTextDocument: jest.fn(),
    },
    workspace: {
        openTextDocument: jest.fn().mockResolvedValue({}),
    },
}));

jest.mock('../core/queryRunner', () => ({
    runQuery: jest.fn(),
}));

jest.mock('../commands/schema/helpers', () => {
    const { formatQualifiedObjectName } = require('../utils/identifierUtils');
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getFullName: (item: SchemaItemData, connectionManager?: any) => {
            const databaseKind = connectionManager?.getConnectionDatabaseKind?.(item.connectionName);
            return formatQualifiedObjectName(item.dbName, item.schema, item.rawLabel || item.label, databaseKind);
        },
        executeWithProgress: jest.fn((_title, task) => task()),
    };
});

describe('commands/schema/maintenanceCommands', () => {
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
        jest.restoreAllMocks();

        mockContext = {
            extensionUri: { fsPath: '/test/extension' },
            subscriptions: [],
        };

        mockConnectionManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('test-conn'),
            getConnection: jest.fn().mockResolvedValue({ name: 'test-conn', host: 'localhost' }),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            resolveConnectionName: jest.fn((_documentUri?: string, name?: string) => name || 'test-conn'),
            supportsCapability: jest.fn().mockReturnValue(true),
        };

        mockMetadataCache = {};
        mockSchemaProvider = {};
        mockSchemaTreeView = {};

        deps = {
            context: mockContext,
            connectionManager: mockConnectionManager,
            metadataCache: mockMetadataCache,
            schemaProvider: mockSchemaProvider,
            schemaTreeView: mockSchemaTreeView,
        };
    });

  describe('registerMaintenanceCommands', () => {
    it('registers all maintenance commands', () => {
      const disposables = registerMaintenanceCommands(deps);

      // 7 core Netezza commands + 5 PostgreSQL partition/index commands
      expect(disposables).toHaveLength(12);
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'netezza.groomTable',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'netezza.generateStatistics',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'netezza.checkSkew',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'netezza.recreateTable',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'netezza.vacuumTable',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'netezza.analyzeTable',
        expect.any(Function)
      );
 expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
 'netezza.reindexTable',
 expect.any(Function)
 );
 // PostgreSQL partition commands
 expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
 'postgresql.listPartitions',
 expect.any(Function)
 );
 expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
 'postgresql.createPartition',
 expect.any(Function)
 );
 expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
 'postgresql.attachPartition',
 expect.any(Function)
 );
 // PostgreSQL index commands
 expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
 'postgresql.listIndexes',
 expect.any(Function)
 );
 expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
 'postgresql.createIndex',
 expect.any(Function)
 );
 });
 
 it('returns disposables for cleanup', () => {
            const disposables = registerMaintenanceCommands(deps);

            disposables.forEach((disposable) => {
                expect(disposable).toHaveProperty('dispose');
            });
        });
    });

    describe('netezza.generateStatistics command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let generateStatsCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const statsCall = calls.find((call) => call[0] === 'netezza.generateStatistics');
            generateStatsCallback = statsCall![1];
        });

        it('does nothing when item is missing', async () => {
            await generateStatsCallback();

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('does nothing when item is not a TABLE', async () => {
            const item: SchemaItemData = {
                label: 'myview',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'VIEW',
            };

            await generateStatsCallback(item);

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('shows confirmation dialog for a valid table', async () => {
            const item: SchemaItemData = {
                label: 'mytable',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'TABLE',
                connectionName: 'test-conn',
            };

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'EXPRESS', value: 'express' });
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');

            await generateStatsCallback(item);

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Generate statistics for table'),
                { modal: true },
                'Yes, generate',
                'Cancel'
            );
        });

        it('does not run a query when cancelled', async () => {
            const item: SchemaItemData = {
                label: 'mytable',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'TABLE',
                connectionName: 'test-conn',
            };

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'EXPRESS', value: 'express' });
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');

            await generateStatsCallback(item);

            expect(runQuery).not.toHaveBeenCalled();
        });
    });

    describe('netezza.checkSkew command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let checkSkewCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const skewCall = calls.find((call) => call[0] === 'netezza.checkSkew');
            checkSkewCallback = skewCall![1];
        });

        it('does nothing when item is missing', async () => {
            await checkSkewCallback();

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('shows confirmation dialog for a valid table', async () => {
            const item: SchemaItemData = {
                label: 'mytable',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'TABLE',
            };

            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Cancel');

            await checkSkewCallback(item);

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Check skew for'),
                { modal: true },
                'Yes, check skew',
                'Cancel'
            );
        });

        it('blocks maintenance commands when the dialect does not support them', async () => {
            mockConnectionManager.supportsCapability.mockReturnValue(false);
            const item: SchemaItemData = {
                label: 'mytable',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'TABLE',
                connectionName: 'test-conn',
            };

            await checkSkewCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Skew check is not supported for the active database dialect.'
            );
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });
    });

    describe('netezza.recreateTable command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let recreateCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const recreateCall = calls.find((call) => call[0] === 'netezza.recreateTable');
            recreateCallback = recreateCall![1];
        });

        it('shows an error when item is missing', async () => {
            await recreateCallback();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Invalid object selected for Recreate Table'
            );
        });

        it('shows an error when item is not a TABLE', async () => {
            const item: SchemaItemData = {
                label: 'myview',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'VIEW',
            };

            await recreateCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Invalid object selected for Recreate Table'
            );
        });

        it('shows an error when the connection is not configured', async () => {
            const item: SchemaItemData = {
                label: 'mytable',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'TABLE',
            };

            mockConnectionManager.getConnection.mockResolvedValue(undefined);

            await recreateCallback(item);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Connection not configured. Please connect via Netezza: Connect...'
            );
        });

        it('cancels when input is cancelled', async () => {
            const item: SchemaItemData = {
                label: 'mytable',
                dbName: 'testdb',
                schema: 'admin',
                objType: 'TABLE',
            };

            (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

            await recreateCallback(item);

            expect(executeWithProgress).not.toHaveBeenCalled();
        });
    });

    describe('netezza.vacuumTable command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let vacuumCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const vacuumCall = calls.find((call) => call[0] === 'netezza.vacuumTable');
            vacuumCallback = vacuumCall![1];
        });

    it('delegates PostgreSQL vacuum operations to the maintenance provider', async () => {
        const provider = {
            vacuumTable: jest.fn().mockResolvedValue(undefined),
        };
        mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');
        jest.spyOn(connectionFactory, 'getDatabaseMaintenanceProvider').mockReturnValue(provider);

        const item: SchemaItemData = {
            label: 'mytable',
            dbName: 'testdb',
            schema: 'admin',
            objType: 'TABLE',
            connectionName: 'test-conn',
        };

        await vacuumCallback(item);

        expect(provider.vacuumTable).toHaveBeenCalledWith(
            expect.objectContaining({
                connectionName: 'test-conn',
                // PostgreSQL does not support 3-part references (database.schema.table)
                // It only supports 2-part notation (schema.table) within the current database
                qualifiedName: 'admin.mytable',
                tableName: 'mytable',
            }),
            expect.objectContaining({
                executeSql: expect.any(Function),
                getConnectionDetails: expect.any(Function),
                openSqlDocument: expect.any(Function),
                executeWithProgress: expect.any(Function),
                executeAndReport: expect.any(Function),
            })
        );
    });
    });

    describe('postgresql.createPartition command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let createPartitionCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const createPartitionCall = calls.find((call) => call[0] === 'postgresql.createPartition');
            createPartitionCallback = createPartitionCall![1];
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');
        });

        it('rejects whitespace-only partition names', async () => {
            const provider = {
                createPartition: jest.fn().mockResolvedValue(undefined),
            };
            jest.spyOn(connectionFactory, 'getDatabaseMaintenanceProvider').mockReturnValue(provider);
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('   ');

            await createPartitionCallback({
                label: 'orders',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE',
                connectionName: 'test-conn',
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Partition name cannot be empty.');
            expect(provider.createPartition).not.toHaveBeenCalled();
        });

        it('rejects whitespace-only partition bounds', async () => {
            const provider = {
                createPartition: jest.fn().mockResolvedValue(undefined),
            };
            jest.spyOn(connectionFactory, 'getDatabaseMaintenanceProvider').mockReturnValue(provider);
            (vscode.window.showInputBox as jest.Mock)
                .mockResolvedValueOnce('orders_2024_01')
                .mockResolvedValueOnce('   ');
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'RANGE' });

            await createPartitionCallback({
                label: 'orders',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE',
                connectionName: 'test-conn',
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Partition bound cannot be empty.');
            expect(provider.createPartition).not.toHaveBeenCalled();
        });
    });

    describe('postgresql.createIndex command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let createIndexCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const createIndexCall = calls.find((call) => call[0] === 'postgresql.createIndex');
            createIndexCallback = createIndexCall![1];
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');
        });

        it('rejects a blank column list', async () => {
            const provider = {
                createIndex: jest.fn().mockResolvedValue(undefined),
            };
            jest.spyOn(connectionFactory, 'getDatabaseMaintenanceProvider').mockReturnValue(provider);
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('   ');

            await createIndexCallback({
                label: 'orders',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE',
                connectionName: 'test-conn',
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Enter at least one column name.');
            expect(provider.createIndex).not.toHaveBeenCalled();
        });

        it('rejects column lists with empty entries', async () => {
            const provider = {
                createIndex: jest.fn().mockResolvedValue(undefined),
            };
            jest.spyOn(connectionFactory, 'getDatabaseMaintenanceProvider').mockReturnValue(provider);
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('created_at,,status');

            await createIndexCallback({
                label: 'orders',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE',
                connectionName: 'test-conn',
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Column list contains an empty entry. Remove extra commas and try again.'
            );
            expect(provider.createIndex).not.toHaveBeenCalled();
        });
    });

    describe('postgresql.listIndexes command handler', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let listIndexesCallback: (item?: SchemaItemData) => Promise<any>;

        beforeEach(() => {
            registerMaintenanceCommands(deps);
            const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
            const listIndexesCall = calls.find((call) => call[0] === 'postgresql.listIndexes');
            listIndexesCallback = listIndexesCall![1];
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');
        });

        it('reindexes the selected index instead of the whole table', async () => {
            const provider = {
                listIndexes: jest.fn().mockResolvedValue([
                    {
                        schema: 'archive',
                        name: 'orders_created_at_idx',
                        tableName: 'orders',
                        tableSchema: 'public',
                        indexType: 'btree',
                        isUnique: false,
                        isPrimary: false,
                        columns: ['created_at'],
                        definition: 'CREATE INDEX orders_created_at_idx ON public.orders (created_at)',
                        indexSize: 1024,
                        isValid: true,
                    },
                ]),
                reindexIndex: jest.fn().mockResolvedValue(undefined),
            };
            jest.spyOn(connectionFactory, 'getDatabaseMaintenanceProvider').mockReturnValue(provider);
            (vscode.window.showQuickPick as jest.Mock)
                .mockImplementationOnce(async (items) => items[0])
                .mockImplementationOnce(async (items) => items.find((item: { action: string }) => item.action === 'reindex'))
                .mockImplementationOnce(async (items) => items.find((item: { value: boolean }) => item.value === true));

            await listIndexesCallback({
                label: 'orders',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE',
                connectionName: 'test-conn',
            });

            expect(provider.reindexIndex).toHaveBeenCalledWith(
                expect.objectContaining({
                    connectionName: 'test-conn',
                    qualifiedName: 'public.orders',
                    tableName: 'orders',
                }),
                'orders_created_at_idx',
                { concurrently: true },
                expect.objectContaining({
                    executeSql: expect.any(Function),
                    getConnectionDetails: expect.any(Function),
                    openSqlDocument: expect.any(Function),
                    executeWithProgress: expect.any(Function),
                    executeAndReport: expect.any(Function),
                }),
                'archive'
            );
        });
    });
});
