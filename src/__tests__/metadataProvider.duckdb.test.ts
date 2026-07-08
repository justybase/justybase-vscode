import * as vscode from 'vscode';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
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

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('MetadataProvider DuckDB column lookup', () => {
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
        registerDatabaseDialect(duckdbDialect);

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
            getConnectionDatabaseKind: jest.fn().mockReturnValue('duckdb'),
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

        queryResultToRowsMock.mockImplementation((result: unknown) => {
            const query = (result as { query?: string }).query || '';
            if (!query.includes('information_schema.columns')) {
                return [];
            }

            return [
                { ATTNAME: 'id', FORMAT_TYPE: 'INTEGER' },
                { ATTNAME: 'name', FORMAT_TYPE: 'VARCHAR' },
            ];
        });
    });

    afterEach(() => {
        resetDatabaseDialectTestingState();
    });

    it('returns columns for DuckDB tables when completion lookup has no explicit schema', async () => {
        const columns = await provider.getTableColumnsMetadata('DuckDB Bridge', 'justybase-duckdb-bridge', undefined, 'results');

        expect(columns.map(column => column.ATTNAME)).toEqual(['id', 'name']);

        const executedQuery = compactSql(runQueryRawMock.mock.calls[0][1]);
        expect(executedQuery).toContain('column_name AS ATTNAME');
        expect(executedQuery).toContain('data_type AS FORMAT_TYPE');
        expect(executedQuery).toContain("table_catalog = 'justybase-duckdb-bridge'");
        expect(executedQuery).toContain("table_schema = 'main'");
        expect(executedQuery).toContain("table_name = 'results'");

        expect(metadataCache.setColumns).toHaveBeenCalledWith(
            'DuckDB Bridge',
            'justybase-duckdb-bridge..results',
            expect.arrayContaining([
                expect.objectContaining({ ATTNAME: 'id', FORMAT_TYPE: 'INTEGER' }),
                expect.objectContaining({ ATTNAME: 'name', FORMAT_TYPE: 'VARCHAR' }),
            ]),
        );
    });
});
