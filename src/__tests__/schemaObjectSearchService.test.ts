import { SchemaObjectSearchService } from '../services/schemaObjectSearchService';
import { MockNzConnection } from '../__mocks__/mockNzConnection';
import { createConnectedDatabaseConnectionFromDetails, getDatabaseMetadataProvider } from '../core/connectionFactory';
import { queryResultToRows } from '../core/queryRunner';

jest.mock('../core/connectionFactory', () => ({
    ...jest.requireActual('../core/connectionFactory'),
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

describe('SchemaObjectSearchService', () => {
    it('mock connection returns object search rows', async () => {
        const mockDbConnection = new MockNzConnection();
        mockDbConnection.setMockData('UNION ALL', [
            {
                NAME: 'CUSTOMER_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'DB1',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME',
            },
        ]);

        const sql = getDatabaseMetadataProvider('netezza').buildObjectSearchQuery('DB1', '%CUSTOMER%');
        const cmd = mockDbConnection.createCommand(sql);
        const reader = await cmd.executeReader();
        const columns: Array<{ name: string }> = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            columns.push({ name: reader.getName(i) });
        }
        const data: Array<Array<unknown>> = [];
        while (await reader.read()) {
            const row: Array<unknown> = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                row.push(reader.getValue(i));
            }
            data.push(row);
        }
        await reader.close();

        const rows = queryResultToRows<Record<string, string>>({ columns, data, limitReached: false, sql });
        expect(rows).toHaveLength(1);
        expect(rows[0].NAME).toBe('CUSTOMER_TABLE');
    });

    it('searches object metadata through the connected database command API', async () => {
        const mockDbConnection = new MockNzConnection();
        mockDbConnection.setMockData('UNION ALL', [
            {
                NAME: 'CUSTOMER_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'DB1',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME',
            },
        ]);
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(mockDbConnection);

        const service = new SchemaObjectSearchService(
            { } as never,
            {
                tableCache: new Map(),
                columnCache: new Map(),
            } as never,
            {
                getConnection: jest.fn().mockResolvedValue({
                    host: 'host',
                    database: 'TEST_DB',
                    user: 'user',
                    password: 'password',
                }),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            } as never,
        );

        const results = await service.searchDatabase('CUSTOMER', 'test-connection', {
            databases: ['DB1'],
        });

        expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalled();
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ NAME: 'CUSTOMER_TABLE', DATABASE: 'DB1' }),
            ]),
        );
    });
});
