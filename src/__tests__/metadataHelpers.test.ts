/**
 * Unit tests for metadata/helpers.ts
 */

import {
    parseCacheKey,
    buildCacheKey,
    matchesConnection,
    extractLabel,
    inferObjectType,
    buildIdLookupKey
} from '../metadata/helpers';

describe('metadata/helpers', () => {
    describe('parseCacheKey', () => {
        it('should parse key with connection, db and schema', () => {
            const result = parseCacheKey('myconn|MYDB.MYSCHEMA');
            expect(result).toEqual({
                connectionName: 'myconn',
                dbName: 'MYDB',
                schemaName: 'MYSCHEMA'
            });
        });

        it('should parse key with double-dot pattern (no schema)', () => {
            const result = parseCacheKey('myconn|MYDB..');
            expect(result).toEqual({
                connectionName: 'myconn',
                dbName: 'MYDB',
                schemaName: undefined
            });
        });

        it('should parse key with empty schema', () => {
            const result = parseCacheKey('conn|DB.');
            expect(result).toEqual({
                connectionName: 'conn',
                dbName: 'DB',
                schemaName: undefined
            });
        });

        it('should return null for invalid key without pipe', () => {
            const result = parseCacheKey('invalid-key');
            expect(result).toBeNull();
        });

        it('should handle complex connection names', () => {
            const result = parseCacheKey('server@db:5480|TESTDB.ADMIN');
            expect(result).toEqual({
                connectionName: 'server@db:5480',
                dbName: 'TESTDB',
                schemaName: 'ADMIN'
            });
        });
    });

    describe('buildCacheKey', () => {
        it('should build key with schema', () => {
            const result = buildCacheKey('myconn', 'MYDB', 'MYSCHEMA');
            expect(result).toBe('myconn|MYDB.MYSCHEMA');
        });

        it('should build key without schema (double-dot)', () => {
            const result = buildCacheKey('myconn', 'MYDB');
            expect(result).toBe('myconn|MYDB..');
        });

        it('should build key with undefined schema', () => {
            const result = buildCacheKey('conn', 'DB', undefined);
            expect(result).toBe('conn|DB..');
        });
    });

    describe('matchesConnection', () => {
        it('should return true when connection matches', () => {
            expect(matchesConnection('myconn|MYDB.SCHEMA', 'myconn')).toBe(true);
        });

        it('should return false when connection does not match', () => {
            expect(matchesConnection('myconn|MYDB.SCHEMA', 'otherconn')).toBe(false);
        });

        it('should return true when connectionName is undefined', () => {
            expect(matchesConnection('myconn|MYDB.SCHEMA', undefined)).toBe(true);
        });

        it('should handle partial connection name match correctly', () => {
            // 'myconn' should not match 'myconnection'
            expect(matchesConnection('myconnection|MYDB.SCHEMA', 'myconn')).toBe(false);
        });
    });

    describe('extractLabel', () => {
        it('should return undefined for null item', () => {
            expect(extractLabel(null)).toBeUndefined();
        });

        it('should return undefined for undefined item', () => {
            expect(extractLabel(undefined)).toBeUndefined();
        });

        it('should extract string label', () => {
            expect(extractLabel({ label: 'MyTable' })).toBe('MyTable');
        });

        it('should extract nested label object', () => {
            expect(extractLabel({ label: { label: 'NestedLabel' } })).toBe('NestedLabel');
        });

        it('should handle empty object', () => {
            expect(extractLabel({})).toBeUndefined();
        });
    });

    describe('inferObjectType', () => {
        it('should return objType if present', () => {
            expect(inferObjectType({ objType: 'VIEW' })).toBe('VIEW');
            expect(inferObjectType({ objType: 'EXTERNAL TABLE' })).toBe('EXTERNAL TABLE');
        });

        it('should infer VIEW from kind 18', () => {
            expect(inferObjectType({ kind: 18 })).toBe('VIEW');
        });

        it('should infer TABLE from other kinds', () => {
            expect(inferObjectType({ kind: 6 })).toBe('TABLE');
            expect(inferObjectType({ kind: 7 })).toBe('TABLE');
            expect(inferObjectType({})).toBe('TABLE');
        });

        it('should prefer objType over kind', () => {
            expect(inferObjectType({ objType: 'PROCEDURE', kind: 18 })).toBe('PROCEDURE');
        });
    });

    describe('buildIdLookupKey', () => {
        it('should build key with schema', () => {
            expect(buildIdLookupKey('MYDB', 'MYSCHEMA', 'MYTABLE')).toBe('MYDB.MYSCHEMA.MYTABLE');
        });

        it('should build key without schema (double-dot)', () => {
            expect(buildIdLookupKey('MYDB', undefined, 'MYTABLE')).toBe('MYDB..MYTABLE');
        });

        it('should handle empty schema as no schema', () => {
            // Empty string is falsy, so it should produce double-dot
            expect(buildIdLookupKey('DB', '', 'TABLE')).toBe('DB..TABLE');
        });
    });
});
