import {
    buildColumnCacheKey,
    groupColumnRowsByTableKey,
    mapRawColumnRowToMetadata,
} from '../../metadata/columnRowMapping';

describe('columnRowMapping', () => {
    it('maps distribution key flag from batch column rows', () => {
        const mapped = mapRawColumnRowToMetadata({
            TABLENAME: 'ORDERS',
            DBNAME: 'DB1',
            SCHEMA: 'PUBLIC',
            ATTNAME: 'ID',
            FORMAT_TYPE: 'INT4',
            IS_PK: 1,
            IS_FK: 0,
            IS_DISTRIBUTION_KEY: 1,
        });

        expect(mapped.isPk).toBe(true);
        expect(mapped.isFk).toBe(false);
        expect(mapped.isDistributionKey).toBe(true);
    });

    it('groups rows by database schema and table key', () => {
        const grouped = groupColumnRowsByTableKey([
            {
                TABLENAME: 'ORDERS',
                DBNAME: 'DB1',
                SCHEMA: 'PUBLIC',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
            },
            {
                TABLENAME: 'ORDERS',
                DBNAME: 'DB1',
                SCHEMA: 'PUBLIC',
                ATTNAME: 'AMOUNT',
                FORMAT_TYPE: 'NUMERIC',
            },
        ]);

        expect(grouped.get('DB1.PUBLIC.ORDERS')).toHaveLength(2);
    });

    it('preserves quoted table names and uppercases unquoted identifiers', () => {
        const grouped = groupColumnRowsByTableKey([
            {
                TABLENAME: 'orders',
                DBNAME: 'db1',
                SCHEMA: 'public',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
            },
            {
                TABLENAME: 'ORDERS',
                DBNAME: 'db1',
                SCHEMA: 'public',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
            },
            {
                TABLENAME: 'lower_table',
                DBNAME: 'db1',
                SCHEMA: 'admin',
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INT4',
            },
        ]);

        expect(grouped.has('DB1.PUBLIC.ORDERS')).toBe(true);
        expect(grouped.get('DB1.PUBLIC.ORDERS')).toHaveLength(2);
        expect(grouped.has('DB1.ADMIN.LOWER_TABLE')).toBe(true);
        expect(buildColumnCacheKey('db1', 'public', 'orders')).toBe('DB1.PUBLIC.ORDERS');
        expect(buildColumnCacheKey('db1', 'public', 'ORDERS')).toBe('DB1.PUBLIC.ORDERS');
        expect(buildColumnCacheKey('db1', 'admin', 'lower_table')).toBe('DB1.ADMIN.LOWER_TABLE');
        expect(buildColumnCacheKey('db1', 'public', '"orders"')).toBe('DB1.PUBLIC.orders');
    });

    it('trims fixed-width catalog values before building cache keys', () => {
        const grouped = groupColumnRowsByTableKey([
            {
                TABLENAME: ' ORDERS   ',
                DBNAME: 'DB1   ',
                SCHEMA: ' PUBLIC   ',
                ATTNAME: ' ID ',
                FORMAT_TYPE: 'INT4',
            },
        ]);

        expect(grouped.get('DB1.PUBLIC.ORDERS')).toHaveLength(1);
        expect(buildColumnCacheKey(' DB1 ', ' PUBLIC ', ' ORDERS ')).toBe('DB1.PUBLIC.ORDERS');
    });

    it('maps ATTNOTNULL and COLDEFAULT into the cached column', () => {
        const notNull = mapRawColumnRowToMetadata({
            TABLENAME: 'ORDERS',
            DBNAME: 'DB1',
            SCHEMA: 'PUBLIC',
            ATTNAME: 'ID',
            FORMAT_TYPE: 'INT4',
            IS_NOT_NULL: 1,
        });
        expect(notNull.isNotNull).toBe(true);
        expect(notNull.colDefault).toBeUndefined();

        const withDefault = mapRawColumnRowToMetadata({
            TABLENAME: 'ORDERS',
            DBNAME: 'DB1',
            SCHEMA: 'PUBLIC',
            ATTNAME: 'STATUS',
            FORMAT_TYPE: 'VARCHAR(20)',
            IS_NOT_NULL: 0,
            COLDEFAULT: "  'OPEN'::text  ",
        });
        expect(withDefault.isNotNull).toBe(false);
        expect(withDefault.colDefault).toBe("'OPEN'::text");
    });

    it('omits nullability when the catalog column was never read', () => {
        const mapped = mapRawColumnRowToMetadata({
            TABLENAME: 'ORDERS',
            DBNAME: 'DB1',
            SCHEMA: 'PUBLIC',
            ATTNAME: 'AMOUNT',
            FORMAT_TYPE: 'NUMERIC',
        });

        // `undefined` marks an older/completion-only layer; it must not be
        // confused with an explicitly nullable column.
        expect(mapped).not.toHaveProperty('isNotNull');
        expect(mapped).not.toHaveProperty('colDefault');
    });
});
