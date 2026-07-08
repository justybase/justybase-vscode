/**
 * Unit tests for pure functions extracted from SchemaProvider
 * These tests verify the testable functions without VS Code dependencies
 */

import {
    generateAutoTableNameFromDbInfo,
    buildObjectTypeQuery,
    buildTypeGroupsQuery,
    filterObjectsByType,
    buildInsertText,
    isExpandableType,
    normalizeInlineTreeMetadata,
    getColumnTypeIndicator,
    getTypeGroupInlineDescription,
    getTypeGroupContextValue,
    getSchemaObjectContextValue,
    buildInlineTreeDescription,
} from '../providers/schemaProvider';

describe('SchemaProvider pure functions', () => {
    describe('generateAutoTableNameFromDbInfo', () => {
        it('should return null when dbInfo is undefined', () => {
            expect(generateAutoTableNameFromDbInfo(undefined)).toBeNull();
        });

        it('should generate table name with default values', () => {
            const dbInfo = { CURRENT_CATALOG: 'TESTDB', CURRENT_SCHEMA: 'PUBLIC' };
            const fixedDate = new Date('2026-02-22T12:00:00Z');
            const fixedRandom = 1234;

            const result = generateAutoTableNameFromDbInfo(
                dbInfo,
                undefined,
                () => fixedDate,
                () => fixedRandom,
            );

            expect(result).toBe('TESTDB.PUBLIC.IMPORT_20260222_1234');
        });

        it('should use SYSTEM as default database', () => {
            const dbInfo = { CURRENT_SCHEMA: 'ADMIN' };
            const fixedDate = new Date('2026-01-15T00:00:00Z');
            const fixedRandom = 1;

            const result = generateAutoTableNameFromDbInfo(
                dbInfo,
                undefined,
                () => fixedDate,
                () => fixedRandom,
            );

            expect(result).toBe('SYSTEM.ADMIN.IMPORT_20260115_0001');
        });

        it('should use ADMIN as default schema', () => {
            const dbInfo = { CURRENT_CATALOG: 'MYDB' };
            const fixedDate = new Date('2026-12-31T23:59:59Z');
            const fixedRandom = 9999;

            const result = generateAutoTableNameFromDbInfo(
                dbInfo,
                undefined,
                () => fixedDate,
                () => fixedRandom,
            );

            expect(result).toBe('MYDB.ADMIN.IMPORT_20261231_9999');
        });

        it('should pad random number with zeros', () => {
            const dbInfo = { CURRENT_CATALOG: 'DB', CURRENT_SCHEMA: 'SCH' };
            const fixedDate = new Date('2026-06-15T00:00:00Z');
            const fixedRandom = 42;

            const result = generateAutoTableNameFromDbInfo(
                dbInfo,
                undefined,
                () => fixedDate,
                () => fixedRandom,
            );

            expect(result).toBe('DB.SCH.IMPORT_20260615_0042');
        });

        it('should generate lowercase auto table names for PostgreSQL', () => {
            const dbInfo = { CURRENT_CATALOG: 'appdb', CURRENT_SCHEMA: 'public' };
            const fixedDate = new Date('2026-03-21T00:00:00Z');
            const fixedRandom = 5750;

            const result = generateAutoTableNameFromDbInfo(
                dbInfo,
                'postgresql',
                () => fixedDate,
                () => fixedRandom,
            );

            expect(result).toBe('appdb.public.import_20260321_5750');
        });
    });

    describe('buildObjectTypeQuery', () => {
        it('should build PROCEDURE query with PROCEDURESIGNATURE', () => {
            const query = buildObjectTypeQuery('TESTDB', 'PROCEDURE');

            expect(query).toContain('PROCEDURESIGNATURE AS OBJNAME');
            expect(query).toContain('_V_PROCEDURE');
            expect(query).toContain("DATABASE = 'TESTDB'");
        });

        it('should build TABLE query with _V_OBJECT_DATA', () => {
            const query = buildObjectTypeQuery('TESTDB', 'TABLE');

            expect(query).toContain('_V_OBJECT_DATA');
            expect(query).toContain("DBNAME = 'TESTDB'");
            expect(query).toContain("OBJTYPE = 'TABLE'");
        });

        it('should build VIEW query', () => {
            const query = buildObjectTypeQuery('MYDB', 'VIEW');

            expect(query).toContain("OBJTYPE = 'VIEW'");
            expect(query).toContain("DBNAME = 'MYDB'");
        });

        it('should include DESCRIPTION and OWNER columns', () => {
            const query = buildObjectTypeQuery('TESTDB', 'TABLE');

            expect(query).toContain('DESCRIPTION');
            expect(query).toContain('OWNER');
        });
    });

    describe('buildTypeGroupsQuery', () => {
        it('should build query for distinct OBJTYPE', () => {
            const query = buildTypeGroupsQuery('TESTDB');

            expect(query).toContain('SELECT DISTINCT OBJTYPE');
            expect(query).toContain('ORDER BY OBJTYPE');
        });

        it('should filter by database name', () => {
            const query = buildTypeGroupsQuery('MYDB');

            expect(query).toContain("DBNAME = 'MYDB'");
        });
    });

    describe('filterObjectsByType', () => {
        const cachedObjects = [
            { item: { objType: 'TABLE', kind: 7, detail: 'TABLE' }, schema: 'PUBLIC', objId: 1 },
            { item: { objType: 'VIEW', kind: 18, detail: 'VIEW' }, schema: 'PUBLIC', objId: 2 },
            { item: { objType: 'TABLE', kind: 7, detail: 'TABLE' }, schema: 'ADMIN', objId: 3 },
            { item: { objType: 'EXTERNAL TABLE', kind: 7, detail: 'EXTERNAL TABLE' }, schema: 'PUBLIC', objId: 4 },
        ];

        it('should filter by objType TABLE', () => {
            const result = filterObjectsByType(cachedObjects, 'TABLE');

            expect(result).toHaveLength(2);
            expect(result.every((obj) => obj.item.objType === 'TABLE')).toBe(true);
        });

        it('should filter by objType VIEW', () => {
            const result = filterObjectsByType(cachedObjects, 'VIEW');

            expect(result).toHaveLength(1);
            expect(result[0].item.objType).toBe('VIEW');
        });

        it('should filter by objType EXTERNAL TABLE', () => {
            const result = filterObjectsByType(cachedObjects, 'EXTERNAL TABLE');

            expect(result).toHaveLength(1);
            expect(result[0].item.objType).toBe('EXTERNAL TABLE');
        });

        it('should fallback to kind check for legacy cache (VIEW)', () => {
            const legacyObjects = [
                { item: { kind: 18, detail: 'VIEW' }, schema: 'PUBLIC' },
                { item: { kind: 7, detail: 'TABLE' }, schema: 'PUBLIC' },
            ];

            const result = filterObjectsByType(legacyObjects, 'VIEW');

            expect(result).toHaveLength(1);
            expect(result[0].item.kind).toBe(18);
        });

        it('should fallback to detail check for EXTERNAL TABLE', () => {
            const legacyObjects = [
                { item: { kind: 7, detail: 'EXTERNAL TABLE' }, schema: 'PUBLIC' },
                { item: { kind: 7, detail: 'TABLE' }, schema: 'PUBLIC' },
            ];

            const result = filterObjectsByType(legacyObjects, 'EXTERNAL TABLE');

            expect(result).toHaveLength(1);
            expect(result[0].item.detail).toBe('EXTERNAL TABLE');
        });

        it('should return empty array for non-matching type', () => {
            const result = filterObjectsByType(cachedObjects, 'PROCEDURE');

            expect(result).toHaveLength(0);
        });
    });

    describe('buildInsertText', () => {
        it('should return label only when no schema or dbName', () => {
            expect(buildInsertText('MYTABLE')).toBe('MYTABLE');
        });

        it('should include schema when provided', () => {
            expect(buildInsertText('MYTABLE', 'PUBLIC')).toBe('PUBLIC.MYTABLE');
        });

        it('should include database and schema when both provided', () => {
            expect(buildInsertText('MYTABLE', 'PUBLIC', 'TESTDB')).toBe('TESTDB.PUBLIC.MYTABLE');
        });

        it('should handle database without schema with double dot', () => {
            expect(buildInsertText('MYTABLE', undefined, 'TESTDB')).toBe('TESTDB..MYTABLE');
        });

        it('should use sqlite catalog.table notation for sqlite items', () => {
            expect(buildInsertText('MYTABLE', undefined, 'main', 'sqlite')).toBe('main.MYTABLE');
        });

        it('should quote lowercase object name', () => {
            expect(buildInsertText('lower_case_name', 'PUBLIC', 'TESTDB')).toBe('TESTDB.PUBLIC."lower_case_name"');
        });
    });

    describe('isExpandableType', () => {
        it('should return true for TABLE', () => {
            expect(isExpandableType('TABLE')).toBe(true);
        });

        it('should return true for VIEW', () => {
            expect(isExpandableType('VIEW')).toBe(true);
        });

        it('should return true for NICKNAME', () => {
            expect(isExpandableType('NICKNAME')).toBe(true);
        });

        it('should return true for ALIAS', () => {
            expect(isExpandableType('ALIAS')).toBe(true);
        });

        it('should return true for SYNONYM', () => {
            expect(isExpandableType('SYNONYM')).toBe(true);
        });

        it('should return true for EXTERNAL TABLE', () => {
            expect(isExpandableType('EXTERNAL TABLE')).toBe(true);
        });

        it('should return true for SYSTEM VIEW', () => {
            expect(isExpandableType('SYSTEM VIEW')).toBe(true);
        });

        it('should return true for SYSTEM TABLE', () => {
            expect(isExpandableType('SYSTEM TABLE')).toBe(true);
        });

        it('should return false for PROCEDURE', () => {
            expect(isExpandableType('PROCEDURE')).toBe(false);
        });

        it('should return false for FUNCTION', () => {
            expect(isExpandableType('FUNCTION')).toBe(false);
        });

        it('should return false for undefined', () => {
            expect(isExpandableType(undefined)).toBe(false);
        });

        it('should return false for unknown type', () => {
            expect(isExpandableType('UNKNOWN')).toBe(false);
        });
    });

    describe('normalizeInlineTreeMetadata', () => {
        it('should collapse multiline descriptions into a single line', () => {
            expect(normalizeInlineTreeMetadata('  first line\n second\tline  ')).toBe('first line second line');
        });

        it('should return empty string for undefined descriptions', () => {
            expect(normalizeInlineTreeMetadata(undefined)).toBe('');
        });
    });

    describe('getTypeGroupInlineDescription', () => {
        it('should mark DB2 schema-scoped groups explicitly', () => {
            expect(getTypeGroupInlineDescription('FUNCTION', 'db2')).toBe('schema-scoped');
            expect(getTypeGroupInlineDescription('NICKNAME', 'db2')).toBe('schema-scoped');
        });

        it('should mark DB2 global federated groups explicitly', () => {
            expect(getTypeGroupInlineDescription('SERVER', 'db2')).toBe('global federated');
            expect(getTypeGroupInlineDescription('WRAPPER OPTION', 'db2')).toBe('global federated');
        });

        it('should return empty string for non-DB2 kinds', () => {
            expect(getTypeGroupInlineDescription('TABLE', 'netezza')).toBe('');
        });
    });

    describe('provider-specific context values', () => {
        it('should scope Snowflake dynamic table groups to a Snowflake-only context value', () => {
            expect(getTypeGroupContextValue('DYNAMIC TABLE', 'snowflake')).toBe('typeGroup:DYNAMIC TABLE:snowflake');
        });

        it('should keep non-Snowflake type group context values generic', () => {
            expect(getTypeGroupContextValue('TABLE', 'snowflake')).toBe('typeGroup:TABLE');
            expect(getTypeGroupContextValue('DYNAMIC TABLE', 'netezza')).toBe('typeGroup:DYNAMIC TABLE');
        });

        it('should scope Snowflake dynamic table objects to a Snowflake-only context value', () => {
            expect(getSchemaObjectContextValue('DYNAMIC TABLE', 'snowflake')).toBe(
                'netezza:DYNAMIC TABLE:snowflake',
            );
        });

        it('should keep non-Snowflake object context values generic', () => {
            expect(getSchemaObjectContextValue('TABLE', 'snowflake')).toBe('netezza:TABLE');
            expect(getSchemaObjectContextValue('DYNAMIC TABLE', 'netezza')).toBe('netezza:DYNAMIC TABLE');
        });
    });

    describe('getColumnTypeIndicator', () => {
        it('should classify numeric types', () => {
            expect(getColumnTypeIndicator('NUMERIC(12,2)')).toBe('123');
        });

        it('should classify text types', () => {
            expect(getColumnTypeIndicator('VARCHAR(255)')).toBe('txt');
        });

        it('should classify date and time types', () => {
            expect(getColumnTypeIndicator('TIMESTAMP')).toBe('📅');
        });

        it('should return empty string for unsupported types', () => {
            expect(getColumnTypeIndicator('BOOLEAN')).toBe('');
        });
    });

    describe('buildInlineTreeDescription', () => {
        it('should use inline descriptions for type groups', () => {
            expect(buildInlineTreeDescription('typeGroup:SERVER', undefined, 'global federated')).toBe(
                'global federated',
            );
        });

        it('should combine schema and object description for schema objects', () => {
            expect(buildInlineTreeDescription('netezza:TABLE', 'PUBLIC', 'User accounts')).toBe(
                '(PUBLIC) - User accounts',
            );
        });

        it('should combine datatype indicators and descriptions for columns', () => {
            expect(buildInlineTreeDescription('column', undefined, 'Total amount', 'DECIMAL(12,2)')).toBe(
                '123 - Total amount',
            );
        });

        it('should keep the datatype indicator when no column description is present', () => {
            expect(buildInlineTreeDescription('column', undefined, undefined, 'VARCHAR(100)')).toBe('txt');
        });
    });
});
