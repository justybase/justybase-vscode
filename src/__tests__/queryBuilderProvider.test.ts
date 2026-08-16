import * as vscode from 'vscode';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { getForeignKeysForSchema, getTablesInSchema } from '../schema/erdProvider';
import {
    buildVisualQueryBuilderData,
    buildVisualQueryBuilderDataForAllSchemas,
    getSchemasForDatabase
} from '../schema/queryBuilderProvider';
import { ConnectionManager } from '../core/connectionManager';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn()
}));

jest.mock('../schema/erdProvider', () => ({
    getForeignKeysForSchema: jest.fn(),
    getTablesInSchema: jest.fn()
}));

jest.mock('../core/connectionFactory', () => ({
    getDatabaseMetadataProvider: jest.fn()
}));

describe('schema/queryBuilderProvider', () => {
    const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
    const queryResultToRowsMock = queryResultToRows as jest.MockedFunction<typeof queryResultToRows>;
    const getForeignKeysForSchemaMock = getForeignKeysForSchema as jest.MockedFunction<typeof getForeignKeysForSchema>;
    const getTablesInSchemaMock = getTablesInSchema as jest.MockedFunction<typeof getTablesInSchema>;
    const getDatabaseMetadataProviderMock = getDatabaseMetadataProvider as jest.MockedFunction<typeof getDatabaseMetadataProvider>;

    let mockContext: vscode.ExtensionContext;
    let mockConnectionManager: ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            extensionUri: { fsPath: '/test' },
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        mockConnectionManager = {
            getConnection: jest.fn(),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza')
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

        it('loads File SQL tables and views from information_schema without Netezza catalog queries', async () => {
            const executedSql: string[] = [];
            (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue('file');
            getDatabaseMetadataProviderMock.mockReturnValue({
                buildListTablesQuery: jest.fn().mockReturnValue('FILE_TABLES'),
                buildListViewsQuery: jest.fn().mockReturnValue('FILE_VIEWS'),
                buildColumnsWithKeysQuery: jest.fn().mockReturnValue('FILE_COLUMNS')
            } as unknown as ReturnType<typeof getDatabaseMetadataProvider>);
            runQueryRawMock.mockImplementation(async (_context, sql) => {
                executedSql.push(sql);
                if (sql === 'FILE_TABLES') return { data: [[]], rows: [{ OBJNAME: 'sales_edit', OBJTYPE: 'TABLE', SCHEMA: 'main', DATABASE: 'memory' }] } as never;
                if (sql === 'FILE_VIEWS') return { data: [[]], rows: [{ OBJNAME: 'Sales', OBJTYPE: 'VIEW', SCHEMA: 'main', DATABASE: 'memory' }] } as never;
                return {
                    data: [[]],
                    rows: [
                        { TABLENAME: 'sales_edit', ATTNAME: 'id', FORMAT_TYPE: 'INTEGER', SCHEMA_NAME: 'main', DATABASE: 'memory', IS_PK: 1, IS_FK: 0 },
                        { TABLENAME: 'Sales', ATTNAME: 'amount', FORMAT_TYPE: 'DOUBLE', SCHEMA_NAME: 'main', DATABASE: 'memory', IS_PK: 0, IS_FK: 0 }
                    ]
                } as never;
            });
            queryResultToRowsMock.mockImplementation(result => (result as unknown as { rows: Record<string, unknown>[] }).rows);

            const result = await buildVisualQueryBuilderData(
                mockContext,
                mockConnectionManager,
                'file-connection',
                'memory',
                'main'
            );

            expect(executedSql).toEqual(expect.arrayContaining(['FILE_TABLES', 'FILE_VIEWS', 'FILE_COLUMNS']));
            expect(getDatabaseMetadataProviderMock().buildListTablesQuery).toHaveBeenCalledWith('', 'main');
            expect(getDatabaseMetadataProviderMock().buildListViewsQuery).toHaveBeenCalledWith('', 'main');
            expect(getDatabaseMetadataProviderMock().buildColumnsWithKeysQuery).toHaveBeenCalledWith('', {
                schema: 'main',
                objTypes: ['TABLE', 'VIEW']
            });
            expect(executedSql.join('\n')).not.toContain('_V_TABLE');
            expect(getForeignKeysForSchemaMock).not.toHaveBeenCalled();
            expect(result.relationships).toEqual([]);
            expect(result.database).toBe('memory');
            expect(result.tables).toEqual(expect.arrayContaining([
                expect.objectContaining({ tableName: 'Sales', objectType: 'VIEW' }),
                expect.objectContaining({ tableName: 'sales_edit', objectType: 'TABLE', primaryKeyColumns: ['id'] })
            ]));
        });

        it('loads all File SQL schemas without querying MEMORY.._V_TABLE', async () => {
            const executedSql: string[] = [];
            (mockConnectionManager.getConnectionDatabaseKind as jest.Mock).mockReturnValue('file');
            getDatabaseMetadataProviderMock.mockReturnValue({
                buildListSchemasQuery: jest.fn().mockReturnValue('FILE_SCHEMAS'),
                buildListTablesQuery: jest.fn().mockReturnValue('FILE_TABLES'),
                buildListViewsQuery: jest.fn().mockReturnValue('FILE_VIEWS'),
                buildColumnsWithKeysQuery: jest.fn().mockReturnValue('FILE_COLUMNS')
            } as unknown as ReturnType<typeof getDatabaseMetadataProvider>);
            runQueryRawMock.mockImplementation(async (_context, sql) => {
                executedSql.push(sql);
                if (sql === 'FILE_SCHEMAS') return { data: [[]], rows: [{ SCHEMA: 'main' }] } as never;
                if (sql === 'FILE_TABLES') return { data: [[]], rows: [] } as never;
                if (sql === 'FILE_VIEWS') return { data: [[]], rows: [{ OBJNAME: 'Sales', OBJTYPE: 'VIEW', SCHEMA: 'main', DATABASE: 'memory' }] } as never;
                return { data: [[]], rows: [{ TABLENAME: 'Sales', ATTNAME: 'amount', FORMAT_TYPE: 'DOUBLE', SCHEMA_NAME: 'main', DATABASE: 'memory' }] } as never;
            });
            queryResultToRowsMock.mockImplementation(result => (result as unknown as { rows: Record<string, unknown>[] }).rows);

            const result = await buildVisualQueryBuilderDataForAllSchemas(
                mockContext,
                mockConnectionManager,
                'file-connection',
                'memory'
            );

            expect(executedSql).toEqual(expect.arrayContaining(['FILE_SCHEMAS', 'FILE_TABLES', 'FILE_VIEWS', 'FILE_COLUMNS']));
            expect(getDatabaseMetadataProviderMock().buildListSchemasQuery).toHaveBeenCalledWith('');
            expect(executedSql.join('\n')).not.toContain('MEMORY.._V_TABLE');
            expect(result.allSchemas).toEqual(['main']);
            expect(result.database).toBe('memory');
            expect(result.tables).toEqual([expect.objectContaining({ tableName: 'Sales', objectType: 'VIEW' })]);
            expect(result.relationships).toEqual([]);
        });
    });
});
