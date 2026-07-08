import * as vscode from 'vscode';
import { runQueryRaw } from '../core/queryRunner';
import { MetadataProvider } from '../providers/providers/metadataProvider';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import type { ColumnMetadata } from '../metadata/types';
import { resetMetadataQueryLimiterForTests } from '../metadata/metadataQueryLimiter';

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn((result: { columns: { name: string }[]; data: unknown[][] }) => {
        if (!result?.columns || !result.data) {
            return [];
        }
        return result.data.map((row) => {
            const obj: Record<string, unknown> = {};
            result.columns.forEach((col, index) => {
                obj[col.name] = row[index];
            });
            return obj;
        });
    }),
}));

jest.mock('../providers/tableMetadataProvider', () => ({
    buildColumnMetadataQuery: jest.fn(() => 'SELECT PER TABLE COLUMN METADATA'),
    parseColumnMetadata: jest.fn(() => [
        {
            attname: 'ID',
            formatType: 'INT4',
            isPk: false,
            isFk: false,
            isDistributionKey: false,
            description: '',
        },
    ]),
}));

describe('MetadataProvider column fetch deduplication', () => {
    let metadataCache: jest.Mocked<MetadataCache>;
    let provider: MetadataProvider;
    let runQueryRawMock: jest.MockedFunction<typeof runQueryRaw>;

    beforeEach(() => {
        jest.clearAllMocks();
        resetMetadataQueryLimiterForTests();

        metadataCache = {
            getColumns: jest.fn().mockReturnValue(undefined),
            getColumnsAnySchema: jest.fn().mockReturnValue(undefined),
            ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
            ensureColumnsLoadedForTableKey: jest.fn().mockResolvedValue(undefined),
            setColumns: jest.fn(),
            findTableId: jest.fn(),
            findObjectWithType: jest.fn().mockReturnValue({ objType: 'TABLE', schema: 'PUBLIC' }),
            whenConnectionMetadataHydrated: jest.fn().mockResolvedValue(undefined),
            hasConnectionPrefetchTriggered: jest.fn().mockReturnValue(true),
            isConnectionPrefetchFresh: jest.fn().mockReturnValue(true),
            prefetchColumnsForDatabase: jest.fn().mockResolvedValue(undefined),
            triggerConnectionPrefetch: jest.fn(),
            isDatabaseDead: jest.fn().mockReturnValue(false),
            markDatabaseDead: jest.fn(),
        } as unknown as jest.Mocked<MetadataCache>;

        provider = new MetadataProvider(
            {} as vscode.ExtensionContext,
            metadataCache,
            {
                ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            } as unknown as ConnectionManager,
        );

        runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
        runQueryRawMock.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve({
                                columns: [{ name: 'ATTNAME' }, { name: 'FORMAT_TYPE' }],
                                data: [['ID', 'INT4']],
                            } as never),
                        10,
                    ),
                ),
        );
    });

    it('coalesces concurrent getTableColumnsMetadata calls for the same table', async () => {
        const results = await Promise.all([
            provider.getTableColumnsMetadata('CONN', 'DB1', 'PUBLIC', 'ORDERS'),
            provider.getTableColumnsMetadata('CONN', 'DB1', 'PUBLIC', 'ORDERS'),
            provider.getTableColumnsMetadata('CONN', 'DB1', 'PUBLIC', 'ORDERS'),
        ]);

        expect(runQueryRawMock).toHaveBeenCalledTimes(1);
        expect(results[0]).toEqual(results[1]);
        expect(results[1]).toEqual(results[2]);
        expect(metadataCache.setColumns).toHaveBeenCalledTimes(1);
    });

    it('returns cached columns without querying the database', async () => {
        const cached: ColumnMetadata[] = [
            {
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
                label: 'ID',
                kind: 5,
                detail: 'INT4',
            },
        ];
        metadataCache.getColumns.mockReturnValue(cached);

        const result = await provider.getTableColumnsMetadata('CONN', 'DB1', 'PUBLIC', 'ORDERS');

        expect(runQueryRawMock).not.toHaveBeenCalled();
        expect(result).toBe(cached);
    });

    it('resolves DB.. table columns from schema-specific disk cache before querying', async () => {
        const cached: ColumnMetadata[] = [
            {
                ATTNAME: 'PRODUCT_ID',
                FORMAT_TYPE: 'INTEGER',
                label: 'PRODUCT_ID',
                isPk: false,
            },
        ];
        metadataCache.getColumns.mockImplementation((_connectionName, key) => (
            key === 'JUST_DATA_2.PUBLIC.FACT_SALES_2' ? cached : undefined
        ));

        const result = await provider.getTableColumnsMetadata(
            'CONN',
            'JUST_DATA_2',
            undefined,
            'FACT_SALES_2',
        );

        expect(metadataCache.whenConnectionMetadataHydrated).toHaveBeenCalledWith('CONN');
        expect(metadataCache.ensureColumnsLoadedForTableKey).toHaveBeenCalledWith(
            'CONN',
            'JUST_DATA_2.PUBLIC.FACT_SALES_2',
        );
        expect(metadataCache.setColumns).toHaveBeenCalledWith(
            'CONN',
            'JUST_DATA_2..FACT_SALES_2',
            cached,
        );
        expect(runQueryRawMock).not.toHaveBeenCalled();
        expect(result).toBe(cached);
    });

    it('warmDatabaseColumns awaits database prefetch even when connection prefetch is cold', async () => {
        metadataCache.isConnectionPrefetchFresh.mockReturnValue(false);

        await provider.warmDatabaseColumns('CONN', ['DB1', 'DB2']);

        expect(metadataCache.prefetchColumnsForDatabase).toHaveBeenCalledTimes(2);
        expect(metadataCache.prefetchColumnsForDatabase).toHaveBeenCalledWith(
            'CONN',
            'DB1',
            expect.any(Function),
        );
        expect(metadataCache.triggerConnectionPrefetch).toHaveBeenCalledWith(
            'CONN',
            expect.any(Function),
        );
    });

    it('resolves schema from cache and stores column descriptions', async () => {
        const { parseColumnMetadata } = jest.requireMock('../providers/tableMetadataProvider') as {
            parseColumnMetadata: jest.Mock;
        };
        parseColumnMetadata.mockReturnValue([
            {
                attname: 'PRODUCT_ID',
                formatType: 'INTEGER',
                isPk: false,
                isFk: false,
                isDistributionKey: false,
                description: 'Foreign key to DIMPRODUCT',
            },
        ]);

        const result = await provider.getTableColumnsMetadata(
            'CONN',
            'JUST_DATA_2',
            undefined,
            'FACT_SALES_2',
        );

        expect(metadataCache.findObjectWithType).toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].documentation).toBe('Foreign key to DIMPRODUCT');
    });
});
