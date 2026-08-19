import {
    buildDbSchemaCacheKey,
    buildNetezzaDatabaseCacheKey,
    normalizeDbSchemaLookupKey,
} from '../../metadata/helpers';
import {
    buildColumnCacheKey,
    normalizeColumnLookupKey,
} from '../../metadata/columnRowMapping';
import {
    getCachedColumnsFromMetadataCache,
    getCachedColumnsFromMetadataCacheAsync,
} from '../../metadata/columnCacheLookup';
import type { MetadataCache } from '../../metadataCache';

describe('cache key normalization helpers', () => {
    it('builds uppercase db.schema keys', () => {
        expect(buildDbSchemaCacheKey('db1', 'public')).toBe('DB1.PUBLIC');
        expect(buildDbSchemaCacheKey('db1')).toBe('DB1..');
    });

    it('normalizes mixed-case db.schema lookup keys', () => {
        expect(normalizeDbSchemaLookupKey('db1.public')).toBe('DB1.PUBLIC');
        expect(normalizeDbSchemaLookupKey('db1..')).toBe('DB1..');
    });

    it('normalizes mixed-case column lookup keys', () => {
        expect(normalizeColumnLookupKey('db1.public.orders')).toBe('DB1.PUBLIC.ORDERS');
        expect(normalizeColumnLookupKey('db1.public.ORDERS')).toBe('DB1.PUBLIC.ORDERS');
        expect(buildColumnCacheKey('db1', 'public', 'orders')).toBe('DB1.PUBLIC.ORDERS');
        expect(buildColumnCacheKey('db1', 'public', 'ORDERS')).toBe('DB1.PUBLIC.ORDERS');
    });

    it('reads column cache with normalized keys for netezza', () => {
        const columns = [{ ATTNAME: 'ID', FORMAT_TYPE: 'INT4', label: 'ID', kind: 5, detail: 'INT4' }];
        const cache = {
            getColumns: jest.fn((_connectionName: string, key: string) =>
                key === `${buildNetezzaDatabaseCacheKey('DB1')}.ADMIN.ORDERS` ? columns : undefined,
            ),
            getColumnsAnySchema: jest.fn(),
        } as unknown as MetadataCache;

        expect(
            getCachedColumnsFromMetadataCache(
                cache,
                'conn1',
                'db1',
                'admin',
                'orders',
                'netezza',
            ),
        ).toEqual(columns);
    });

    it('hydrates the same exact Netezza key used by the synchronous quoted lookup', async () => {
        const exactKey = `${buildNetezzaDatabaseCacheKey('"just_data"')}.admin.lower_table`;
        const columns = [{ ATTNAME: 'id', FORMAT_TYPE: 'INT4', label: 'id', kind: 5, detail: 'INT4' }];
        const cache = {
            ensureColumnsLoadedForTableKey: jest.fn().mockResolvedValue(undefined),
            getColumns: jest.fn((_connectionName: string, key: string) =>
                key === exactKey ? columns : undefined,
            ),
            getColumnsAnySchema: jest.fn(),
        } as unknown as MetadataCache;

        await expect(
            getCachedColumnsFromMetadataCacheAsync(
                cache,
                'conn1',
                '"just_data"',
                '"admin"',
                '"lower_table"',
                'netezza',
            ),
        ).resolves.toEqual(columns);
        expect(cache.ensureColumnsLoadedForTableKey).toHaveBeenCalledWith('conn1', exactKey);
    });
});
