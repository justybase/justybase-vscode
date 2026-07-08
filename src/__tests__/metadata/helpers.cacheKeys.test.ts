import {
    buildDbSchemaCacheKey,
    normalizeDbSchemaLookupKey,
} from '../../metadata/helpers';
import {
    buildColumnCacheKey,
    normalizeColumnLookupKey,
} from '../../metadata/columnRowMapping';
import { getCachedColumnsFromMetadataCache } from '../../metadata/columnCacheLookup';
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
                key === 'DB1.ADMIN.ORDERS' ? columns : undefined,
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
});
