/**
 * Unit tests for metadata/search.ts
 */

import { searchCache } from '../metadata/search';
import { MetadataCache } from '../metadataCache';

describe('metadata/search', () => {
    let storage: MetadataCache;

    beforeEach(() => {
        storage = new MetadataCache({} as unknown as import('vscode').ExtensionContext);
    });

    describe('searchCache - Tables', () => {
        beforeEach(() => {
            // Setup test data
            const tables = [
                { label: 'CUSTOMERS', objType: 'TABLE', kind: 6 },
                { label: 'CUSTOMER_ORDERS', objType: 'TABLE', kind: 6 },
                { label: 'ORDERS', objType: 'TABLE', kind: 6 },
                { label: 'PRODUCTS_VIEW', objType: 'VIEW', kind: 18 }
            ];
            const idMap = new Map<string, number>();
            idMap.set('MYDB.ADMIN.CUSTOMERS', 1001);
            idMap.set('MYDB.ADMIN.CUSTOMER_ORDERS', 1002);
            idMap.set('MYDB.ADMIN.ORDERS', 1003);
            idMap.set('MYDB.ADMIN.PRODUCTS_VIEW', 1004);

            storage.setTables('conn1', 'MYDB.ADMIN', tables, idMap);
        });

        it('should return empty array when no matches', () => {
            const results = searchCache(storage, 'NONEXISTENT');
            expect(results).toEqual([]);
        });

        it('should find tables by exact name match', () => {
            const results = searchCache(storage, 'ORDERS');
            expect(results.length).toBeGreaterThan(0);
            expect(results.some(r => r.name === 'ORDERS')).toBe(true);
        });

        it('should find tables by partial match', () => {
            const results = searchCache(storage, 'CUSTOMER');
            expect(results.length).toBe(2);
            expect(results.map(r => r.name)).toContain('CUSTOMERS');
            expect(results.map(r => r.name)).toContain('CUSTOMER_ORDERS');
        });

        it('should be case-insensitive', () => {
            const results = searchCache(storage, 'customer');
            expect(results.length).toBe(2);
        });

        it('should include database name in results', () => {
            const results = searchCache(storage, 'ORDERS');
            expect(results.every(r => r.database === 'MYDB')).toBe(true);
        });

        it('should include schema name in results', () => {
            const results = searchCache(storage, 'ORDERS');
            expect(results.every(r => r.schema === 'ADMIN')).toBe(true);
        });

        it('should distinguish TABLE from VIEW type', () => {
            const results = searchCache(storage, 'PRODUCTS_VIEW');
            expect(results.length).toBe(1);
            expect(results[0].type).toBe('VIEW');
        });

        it('should preserve SYNONYM type in cached search results', () => {
            storage.setTables(
                'conn1',
                'MYDB.ADMIN',
                [{ label: 'CUSTOMERS_SYNONYM', objType: 'SYNONYM', kind: 6 }],
                new Map([['MYDB.ADMIN.CUSTOMERS_SYNONYM', 1005]])
            );

            const results = searchCache(storage, 'CUSTOMERS_SYNONYM');
            expect(results).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'CUSTOMERS_SYNONYM', type: 'SYNONYM' })
                ])
            );
        });
    });

    describe('searchCache - Columns', () => {
        beforeEach(() => {
            // Setup column data
            const columns = [
                { label: 'CUSTOMER_ID', detail: 'INTEGER', ATTNAME: 'CUSTOMER_ID', FORMAT_TYPE: 'INTEGER' },
                { label: 'CUSTOMER_NAME', detail: 'VARCHAR(100)', ATTNAME: 'CUSTOMER_NAME', FORMAT_TYPE: 'VARCHAR(100)' },
                { label: 'EMAIL', detail: 'VARCHAR(255)', ATTNAME: 'EMAIL', FORMAT_TYPE: 'VARCHAR(255)' },
                { label: 'CREATED_DATE', detail: 'DATE', ATTNAME: 'CREATED_DATE', FORMAT_TYPE: 'DATE' }
            ];
            storage.setColumns('conn1', 'MYDB.ADMIN.CUSTOMERS', columns);
        });

        it('should find columns by partial match', () => {
            const results = searchCache(storage, 'CUSTOMER_');
            expect(results.length).toBe(2);
            expect(results.map(r => r.name)).toContain('CUSTOMER_ID');
            expect(results.map(r => r.name)).toContain('CUSTOMER_NAME');
        });

        it('should mark column results with type COLUMN', () => {
            const results = searchCache(storage, 'EMAIL');
            expect(results.length).toBe(1);
            expect(results[0].type).toBe('COLUMN');
        });

        it('should include parent table name for columns', () => {
            const results = searchCache(storage, 'EMAIL');
            expect(results[0].parent).toBe('CUSTOMERS');
        });

        it('should include database and schema for columns', () => {
            const results = searchCache(storage, 'EMAIL');
            expect(results[0].database).toBe('MYDB');
            expect(results[0].schema).toBe('ADMIN');
        });
    });

    describe('searchCache - Connection filtering', () => {
        beforeEach(() => {
            // Setup data for multiple connections
            const tables1 = [{ label: 'USERS', objType: 'TABLE', kind: 6 }];
            const tables2 = [{ label: 'USERS', objType: 'TABLE', kind: 6 }];
            const emptyIdMap = new Map<string, number>();

            storage.setTables('conn1', 'DB1.SCHEMA1', tables1, emptyIdMap);
            storage.setTables('conn2', 'DB2.SCHEMA2', tables2, emptyIdMap);
        });

        it('should search across all connections when no filter', () => {
            const results = searchCache(storage, 'USERS');
            expect(results.length).toBe(2);
        });

        it('should filter by connection name', () => {
            const results = searchCache(storage, 'USERS', 'conn1');
            expect(results.length).toBe(1);
            expect(results[0].database).toBe('DB1');
        });

        it('should filter by connection name case-insensitively and preserve source connection', () => {
            const results = searchCache(storage, 'USERS', 'CONN1');
            expect(results.length).toBe(1);
            expect(results[0].database).toBe('DB1');
            expect(results[0].connectionName).toBe('conn1');
        });

        it('should return empty when connection has no matches', () => {
            const results = searchCache(storage, 'USERS', 'conn3');
            expect(results).toEqual([]);
        });
    });

    describe('searchCache - Mixed results', () => {
        beforeEach(() => {
            // Add both tables and columns
            const tables = [{ label: 'USERS', objType: 'TABLE', kind: 6 }];
            const columns = [
                { label: 'USER_ID', detail: 'INTEGER', ATTNAME: 'USER_ID', FORMAT_TYPE: 'INTEGER' },
                { label: 'USERNAME', detail: 'VARCHAR(50)', ATTNAME: 'USERNAME', FORMAT_TYPE: 'VARCHAR(50)' }
            ];
            const emptyIdMap = new Map<string, number>();

            storage.setTables('conn1', 'MYDB.ADMIN', tables, emptyIdMap);
            storage.setColumns('conn1', 'MYDB.ADMIN.USERS', columns);
        });

        it('should return both tables and columns matching term', () => {
            const results = searchCache(storage, 'USER');

            const tableResults = results.filter(r => r.type === 'TABLE');
            const columnResults = results.filter(r => r.type === 'COLUMN');

            expect(tableResults.length).toBe(1);
            expect(columnResults.length).toBe(2);
        });
    });

    describe('searchCache - Edge cases', () => {
        it('should handle empty search term', () => {
            const tables = [{ label: 'USERS', objType: 'TABLE', kind: 6 }];
            storage.setTables('conn1', 'MYDB.ADMIN', tables, new Map());

            const results = searchCache(storage, '');
            expect(results).toEqual([]);
        });

        it('should find tables by object description', () => {
            storage.setTables(
                'conn1',
                'MYDB.ADMIN',
                [{ label: 'DIM_X', objType: 'TABLE', kind: 6, DESCRIPTION: 'Account dimension table' }],
                new Map(),
            );

            const results = searchCache(storage, 'account');
            expect(results).toEqual([
                expect.objectContaining({
                    name: 'DIM_X',
                    matchType: 'OBJ_DESC',
                    description: 'Account dimension table',
                }),
            ]);
        });

        it('should find columns by documentation', () => {
            const columns = [
                {
                    label: 'AMOUNT',
                    ATTNAME: 'AMOUNT',
                    FORMAT_TYPE: 'NUMERIC',
                    documentation: 'Monthly billing total',
                },
            ];
            storage.setColumns('conn1', 'MYDB.ADMIN.FACT_BILLING', columns);

            const results = searchCache(storage, 'billing');
            expect(results).toEqual([
                expect.objectContaining({
                    name: 'AMOUNT',
                    type: 'COLUMN',
                    parent: 'FACT_BILLING',
                    matchType: 'COL_DESC',
                }),
            ]);
        });

        it('should handle special regex characters in search term', () => {
            // The search uses toLowerCase().includes() so it's safe
            const results = searchCache(storage, 'USER.*');
            expect(results).toEqual([]);
        });

        it('should handle items with object-style labels', () => {
            const tables = [{ label: { label: 'NESTED_TABLE' }, objType: 'TABLE', kind: 6 }];
            storage.setTables('conn1', 'MYDB.ADMIN', tables, new Map());

            const results = searchCache(storage, 'NESTED');
            expect(results.length).toBe(1);
            expect(results[0].name).toBe('NESTED_TABLE');
        });
    });
});
