import { MetadataCache } from '../metadata/cache/MetadataCache';
import {
    warmTableColumnsFromCatalog,
    type CatalogRowReader,
} from '../metadata/cache/columnCacheWarmup';
import { buildColumnCacheKey } from '../metadata/columnRowMapping';
import { hasTreeReadyColumnCache } from '../metadata/cache/schemaTreeDataSource';
import * as vscode from 'vscode';

jest.mock('vscode');

describe('columnCacheWarmup', () => {
    function createCache(): MetadataCache {
        return new MetadataCache({
            globalStorageUri: vscode.Uri.file('/tmp/column-cache-warmup'),
        } as vscode.ExtensionContext);
    }

    it('writes tree-ready columns for a single table', async () => {
        const cache = createCache();
        const readRows: CatalogRowReader = async () => [
            {
                TABLENAME: 'ORDERS',
                SCHEMA: 'ADMIN',
                DBNAME: 'JUST_DATA',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INTEGER',
                IS_PK: 1,
                IS_FK: 0,
                IS_DISTRIBUTION_KEY: 1,
            },
        ];

        await warmTableColumnsFromCatalog(
            cache,
            'CONN',
            { database: 'JUST_DATA', schema: 'ADMIN', table: 'ORDERS' },
            readRows,
        );

        const columns = cache.getColumns(
            'CONN',
            buildColumnCacheKey('JUST_DATA', 'ADMIN', 'ORDERS'),
        );
        expect(hasTreeReadyColumnCache(columns)).toBe(true);
        expect(columns?.[0]).toEqual(expect.objectContaining({
            ATTNAME: 'ID',
            FORMAT_TYPE: 'INTEGER',
            isPk: true,
            isFk: false,
            isDistributionKey: true,
        }));
    });

    it('does not throw when catalog returns no rows', async () => {
        const cache = createCache();
        const readRows: CatalogRowReader = async () => [];

        await expect(
            warmTableColumnsFromCatalog(
                cache,
                'CONN',
                { database: 'JUST_DATA', schema: 'ADMIN', table: 'MISSING' },
                readRows,
            ),
        ).resolves.toBeUndefined();

        expect(
            cache.getColumns('CONN', buildColumnCacheKey('JUST_DATA', 'ADMIN', 'MISSING')),
        ).toBeUndefined();
    });

    it('falls back to the external-table catalog when the main catalog has no row', async () => {
        const cache = createCache();
        const queries: string[] = [];
        const readRows: CatalogRowReader = async (sql) => {
            queries.push(sql);
            if (!sql.includes('_V_EXTERNAL')) {
                return [];
            }
            return [{
                TABLENAME: 'ET_ORDERS',
                SCHEMA: 'ADMIN',
                DBNAME: 'JUST_DATA',
                ATTNAME: 'EXTERNAL_ID',
                FORMAT_TYPE: 'VARCHAR(30)',
                IS_NOT_NULL: 1,
                IS_PK: 0,
                IS_FK: 0,
                IS_DISTRIBUTION_KEY: 0,
            }];
        };

        await warmTableColumnsFromCatalog(
            cache,
            'CONN',
            { database: 'JUST_DATA', schema: 'ADMIN', table: 'ET_ORDERS' },
            readRows,
        );

        expect(queries).toHaveLength(2);
        expect(queries[0]).not.toContain('_V_EXTERNAL');
        expect(queries[1]).toContain('_V_EXTERNAL');
        expect(cache.getColumns('CONN', 'JUST_DATA.ADMIN.ET_ORDERS')).toEqual([
            expect.objectContaining({ ATTNAME: 'EXTERNAL_ID', FORMAT_TYPE: 'VARCHAR(30)' }),
        ]);
    });

    it('does not throw when catalog query fails', async () => {
        const cache = createCache();
        const readRows: CatalogRowReader = async () => {
            throw new Error('catalog unavailable');
        };

        await expect(
            warmTableColumnsFromCatalog(
                cache,
                'CONN',
                { database: 'JUST_DATA', schema: 'ADMIN', table: 'ORDERS' },
                readRows,
            ),
        ).resolves.toBeUndefined();
    });
});
