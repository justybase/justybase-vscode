import * as vscode from 'vscode';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { getForeignKeysForSchema, getTablesInSchema } from '../schema/erdProvider';
import {
    buildVisualQueryBuilderData,
    getSchemasForDatabase
} from '../schema/queryBuilderProvider';
import { ConnectionManager } from '../core/connectionManager';

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn()
}));

jest.mock('../schema/erdProvider', () => ({
    getForeignKeysForSchema: jest.fn(),
    getTablesInSchema: jest.fn()
}));

describe('schema/queryBuilderProvider', () => {
    const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
    const queryResultToRowsMock = queryResultToRows as jest.MockedFunction<typeof queryResultToRows>;
    const getForeignKeysForSchemaMock = getForeignKeysForSchema as jest.MockedFunction<typeof getForeignKeysForSchema>;
    const getTablesInSchemaMock = getTablesInSchema as jest.MockedFunction<typeof getTablesInSchema>;

    let mockContext: vscode.ExtensionContext;
    let mockConnectionManager: ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            extensionUri: { fsPath: '/test' },
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        mockConnectionManager = {
            getConnection: jest.fn()
        } as unknown as ConnectionManager;
    });

    describe('getSchemasForDatabase', () => {
        it('should return normalized, unique schema names', async () => {
            runQueryRawMock.mockResolvedValue({
                columns: [{ name: 'SCHEMA' }],
                data: [['SALES']]
            });
            queryResultToRowsMock.mockReturnValue([
                { SCHEMA: 'sales' },
                { SCHEMA: 'SALES' },
                { SCHEMA: ' analytics ' },
                { SCHEMA: '' }
            ] as Record<string, unknown>[]);

            const result = await getSchemasForDatabase(
                mockContext,
                mockConnectionManager,
                'test-conn',
                'TESTDB'
            );

            expect(result).toEqual(['SALES', 'ANALYTICS']);
            expect(runQueryRawMock).toHaveBeenCalled();
        });

        it('should return empty array when no schema rows exist', async () => {
            runQueryRawMock.mockResolvedValue({
                columns: [{ name: 'SCHEMA' }],
                data: []
            });

            const result = await getSchemasForDatabase(
                mockContext,
                mockConnectionManager,
                'test-conn',
                'TESTDB'
            );

            expect(result).toEqual([]);
            expect(queryResultToRowsMock).not.toHaveBeenCalled();
        });
    });

    describe('buildVisualQueryBuilderData', () => {
        it('should mark foreign key columns and sort tables', async () => {
            getTablesInSchemaMock.mockResolvedValue([
                {
                    database: 'testdb',
                    schema: 'sales',
                    tableName: 'ORDERS',
                    fullName: 'testdb.sales.ORDERS',
                    primaryKeyColumns: ['ID'],
                    columns: [
                        { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                        { name: 'CUSTOMER_ID', dataType: 'INTEGER', isPrimaryKey: false, isForeignKey: false }
                    ]
                },
                {
                    database: 'testdb',
                    schema: 'sales',
                    tableName: 'CUSTOMERS',
                    fullName: 'testdb.sales.CUSTOMERS',
                    primaryKeyColumns: ['ID'],
                    columns: [
                        { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                        { name: 'NAME', dataType: 'VARCHAR(100)', isPrimaryKey: false, isForeignKey: false }
                    ]
                }
            ]);
            getForeignKeysForSchemaMock.mockResolvedValue([
                {
                    constraintName: 'FK_ORDERS_CUSTOMERS',
                    fromTable: 'SALES.ORDERS',
                    toTable: 'SALES.CUSTOMERS',
                    fromColumns: ['CUSTOMER_ID'],
                    toColumns: ['ID'],
                    onDelete: 'NO ACTION',
                    onUpdate: 'NO ACTION'
                }
            ]);

            const result = await buildVisualQueryBuilderData(
                mockContext,
                mockConnectionManager,
                'test-conn',
                'testdb',
                'sales'
            );

            expect(result.database).toBe('TESTDB');
            expect(result.schema).toBe('SALES');
            expect(result.tables.map(table => table.tableName)).toEqual(['CUSTOMERS', 'ORDERS']);
            expect(
                result.tables
                    .find(table => table.tableName === 'ORDERS')
                    ?.columns.find(column => column.name === 'CUSTOMER_ID')
                    ?.isForeignKey
            ).toBe(true);
            expect(result.relationships).toHaveLength(1);
        });
    });
});
