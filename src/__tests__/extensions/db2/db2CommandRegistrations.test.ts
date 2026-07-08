import * as vscode from 'vscode';
import { registerDb2PartitionCommands } from '../../../../extensions/db2/src/db2PartitionCommands';
import { registerDb2IndexCommands } from '../../../../extensions/db2/src/db2IndexCommands';
import {
    isTableItem,
    resolveOperationContext
} from '../../../../extensions/db2/src/db2CommandContext';

jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() })),
    },
    window: {
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showQuickPick: jest.fn(),
    },
}));

jest.mock('../../../../extensions/db2/src/db2CommandContext', () => ({
    isTableItem: jest.fn(),
    resolveOperationContext: jest.fn(),
    getErrorMessage: jest.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
}));

describe('Db2 extension command registrations', () => {
    const mockContext = {} as vscode.ExtensionContext;
    const mockConnectionManager = {} as never;
    const mockIsTableItem = isTableItem as jest.MockedFunction<typeof isTableItem>;
    const mockResolveOperationContext = resolveOperationContext as jest.MockedFunction<typeof resolveOperationContext>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockIsTableItem.mockReturnValue(true);
    });

    it('registers all contributed Db2 partition and index commands', () => {
        const partitionDisposables = registerDb2PartitionCommands(mockContext, mockConnectionManager);
        const indexDisposables = registerDb2IndexCommands(mockContext, mockConnectionManager);

        expect(partitionDisposables).toHaveLength(5);
        expect(indexDisposables).toHaveLength(4);
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.listPartitions',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.addPartition',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.detachPartition',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.attachPartition',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.dropPartition',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.listIndexes',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.createIndex',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.dropIndex',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.db2.reorgIndexes',
            expect.any(Function)
        );
    });

    it('uses the direct drop-partition command to select and drop a Db2 partition', async () => {
        const provider = {
            listPartitions: jest.fn().mockResolvedValue([
                {
                    schema: 'ADMIN',
                    name: 'PART_2024_Q1',
                    parentTable: 'SALES',
                    partitionBound: "STARTING FROM ('2024-01-01') ENDING AT ('2024-03-31')",
                    partitionStrategy: 'RANGE' as const,
                    rowCount: 42,
                },
            ]),
            dropPartition: jest.fn().mockResolvedValue(undefined),
        };
        const resolved = {
            provider,
            target: {
                connectionName: 'db2-conn',
                databaseName: 'SAMPLE',
                schemaName: 'ADMIN',
                tableName: 'SALES',
                qualifiedName: '"ADMIN"."SALES"',
            },
            services: {} as never,
        };
        mockResolveOperationContext.mockReturnValue(resolved);

        registerDb2PartitionCommands(mockContext, mockConnectionManager);

        const callback = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
            ([command]) => command === 'justybase.db2.dropPartition'
        )?.[1];

        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            label: 'PART_2024_Q1',
            partition: { schema: 'ADMIN' },
        });

        await callback({
            label: 'SALES',
            dbName: 'SAMPLE',
            schema: 'ADMIN',
            objType: 'TABLE',
        });

        expect(provider.listPartitions).toHaveBeenCalledWith(resolved.target, resolved.services);
        expect(provider.dropPartition).toHaveBeenCalledWith(
            resolved.target,
            'PART_2024_Q1',
            resolved.services,
            false,
            'ADMIN'
        );
    });

    it('uses the direct drop-index command to select and drop a Db2 index', async () => {
        const provider = {
            listIndexes: jest.fn().mockResolvedValue([
                {
                    schema: 'ADMIN',
                    name: 'IDX_SALES_CREATED_AT',
                    tableName: 'SALES',
                    tableSchema: 'ADMIN',
                    indexType: 'btree',
                    isUnique: false,
                    isPrimary: false,
                    columns: ['CREATED_AT'],
                },
            ]),
            dropIndex: jest.fn().mockResolvedValue(undefined),
        };
        const resolved = {
            provider,
            target: {
                connectionName: 'db2-conn',
                databaseName: 'SAMPLE',
                schemaName: 'ADMIN',
                tableName: 'SALES',
                qualifiedName: '"ADMIN"."SALES"',
            },
            services: {} as never,
        };
        mockResolveOperationContext.mockReturnValue(resolved);

        registerDb2IndexCommands(mockContext, mockConnectionManager);

        const callback = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
            ([command]) => command === 'justybase.db2.dropIndex'
        )?.[1];

        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
            index: { name: 'IDX_SALES_CREATED_AT' },
        });

        await callback({
            label: 'SALES',
            dbName: 'SAMPLE',
            schema: 'ADMIN',
            objType: 'TABLE',
        });

        expect(provider.listIndexes).toHaveBeenCalledWith(resolved.target, resolved.services);
        expect(provider.dropIndex).toHaveBeenCalledWith(
            resolved.target,
            'IDX_SALES_CREATED_AT',
            resolved.services,
            false,
            false
        );
    });
});
