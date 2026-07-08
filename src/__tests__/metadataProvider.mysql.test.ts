import * as vscode from 'vscode';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import type { ConnectionManager } from '../core/connectionManager';
import { registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import type { MetadataCache } from '../metadataCache';
import { MetadataProvider } from '../providers/providers/metadataProvider';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(),
}));

type RunQueryRawResult = Awaited<ReturnType<typeof runQueryRaw>>;

describe('MetadataProvider MySQL quoted column lookup', () => {
    let provider: MetadataProvider;
    let metadataCache: jest.Mocked<
        Pick<MetadataCache, 'getColumns' | 'getColumnsAnySchema' | 'setColumns' | 'findTableId' | 'findObjectWithType' | 'triggerFullColumnPrefetch' | 'isDatabaseDead' | 'markDatabaseDead' | 'ensureColumnsLoaded' | 'whenConnectionMetadataHydrated'>
    >;
    let connectionManager: jest.Mocked<Pick<ConnectionManager, 'ensureFullyLoaded' | 'getConnectionDatabaseKind'>>;
    let runQueryRawMock: jest.MockedFunction<typeof runQueryRaw>;
    let queryResultToRowsMock: jest.MockedFunction<typeof queryResultToRows>;

    beforeEach(() => {
        jest.clearAllMocks();
        resetDatabaseDialectTestingState();
        registerDatabaseDialect(mysqlDialect);

        metadataCache = {
            getColumns: jest.fn(),
            getColumnsAnySchema: jest.fn(),
            ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
            whenConnectionMetadataHydrated: jest.fn().mockResolvedValue(undefined),
            setColumns: jest.fn(),
            findTableId: jest.fn(),
            findObjectWithType: jest.fn(),
            triggerFullColumnPrefetch: jest.fn(),
            isDatabaseDead: jest.fn().mockReturnValue(false),
            markDatabaseDead: jest.fn(),
        };

        connectionManager = {
            ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('mysql'),
        };

        provider = new MetadataProvider(
            {} as vscode.ExtensionContext,
            metadataCache as unknown as MetadataCache,
            connectionManager as unknown as ConnectionManager,
        );

        runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
        queryResultToRowsMock = queryResultToRows as jest.MockedFunction<typeof queryResultToRows>;

        runQueryRawMock.mockImplementation(async (...args: Parameters<typeof runQueryRaw>) => {
            return { query: args[1] } as unknown as RunQueryRawResult;
        });

        queryResultToRowsMock.mockReturnValue([
            { ATTNAME: 'id', FORMAT_TYPE: 'int' },
            { ATTNAME: 'first_name', FORMAT_TYPE: 'varchar(255)' },
        ]);
    });

    afterEach(() => {
        resetDatabaseDialectTestingState();
    });

    it('strips MySQL backticks before lookup-column queries and cache keys', async () => {
        const buildLookupColumnsQuery = jest.fn(() => 'SELECT MYSQL LOOKUP COLUMNS');
        (provider as unknown as {
            getMetadataProvider: () => { buildLookupColumnsQuery: (params: unknown) => string; mirroredSystemCatalog?: undefined }
        }).getMetadataProvider = jest.fn(() => ({
            buildLookupColumnsQuery,
        }));

        const columns = await provider.getTableColumnsMetadata('MySQL Conn', '`salesdb`', undefined, '`employees`');

        expect(columns.map(column => column.ATTNAME)).toEqual(['id', 'first_name']);
        expect(buildLookupColumnsQuery).toHaveBeenCalledWith({
            database: 'salesdb',
            schema: undefined,
            tableName: 'employees',
            objectId: undefined,
        });
        expect(runQueryRawMock).toHaveBeenCalledWith(
            expect.anything(),
            'SELECT MYSQL LOOKUP COLUMNS',
            true,
            connectionManager,
            'MySQL Conn',
            undefined,
            undefined,
            undefined,
            undefined,
            false,
        );
        expect(metadataCache.setColumns).toHaveBeenCalledWith(
            'MySQL Conn',
            'salesdb..employees',
            expect.arrayContaining([
                expect.objectContaining({ ATTNAME: 'id', FORMAT_TYPE: 'int' }),
                expect.objectContaining({ ATTNAME: 'first_name', FORMAT_TYPE: 'varchar(255)' }),
            ]),
        );
    });
});
