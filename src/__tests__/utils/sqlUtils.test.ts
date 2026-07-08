import {
    escapeSqlIdentifier,
    escapeSqlLiteral,
    buildSafeWhereClause,
    buildSchemaFilter,
    buildDatabaseFilter,
    buildSafeInClause
} from '../../utils/sqlUtils';

describe('sqlUtils', () => {

    describe('escapeSqlIdentifier', () => {
        it('should wrap identifier in double quotes', () => {
            expect(escapeSqlIdentifier('my_table')).toBe('"my_table"');
        });

        it('should escape internal double quotes by doubling them', () => {
            expect(escapeSqlIdentifier('my_"table"')).toBe('"my_""table"""');
        });

        it('should throw error if identifier is empty or falsy', () => {
            expect(() => escapeSqlIdentifier('')).toThrow('Identifier cannot be empty');
            expect(() => escapeSqlIdentifier(null as unknown as string)).toThrow('Identifier cannot be empty');
        });
    });

    describe('escapeSqlLiteral', () => {
        it('should format string literal wrapped in single quotes', () => {
            expect(escapeSqlLiteral('hello')).toBe("'hello'");
        });

        it('should escape internal single quotes by doubling them', () => {
            expect(escapeSqlLiteral("O'Connor")).toBe("'O''Connor'");
            expect(escapeSqlLiteral("'''")).toBe("''''''''");
        });

        it('should handle null or undefined by returning "NULL"', () => {
            expect(escapeSqlLiteral(null as unknown as string)).toBe('NULL');
            expect(escapeSqlLiteral(undefined as unknown as string)).toBe('NULL');
        });
    });

    describe('buildSafeWhereClause', () => {
        it('should build where clause with equal operator', () => {
            const conditions = { id: 1, name: 'test' };
            expect(buildSafeWhereClause(conditions)).toBe('"id" = 1 AND "name" = \'test\'');
        });

        it('should build where clause with IS NULL for null/undefined values', () => {
            const conditions = { id: null, name: undefined as unknown as string };
            expect(buildSafeWhereClause(conditions)).toBe('"id" IS NULL AND "name" IS NULL');
        });

        it('should use specified operator', () => {
            const conditions = { name: '%test%' };
            expect(buildSafeWhereClause(conditions, 'LIKE')).toBe('"name" LIKE \'%test%\'');
        });

        it('should build empty string for empty conditions', () => {
            expect(buildSafeWhereClause({})).toBe('');
        });
    });

    describe('buildSchemaFilter', () => {
        it('should build safe schema filter', () => {
            expect(buildSchemaFilter('public')).toBe("AND SCHEMA = 'public'");
        });

        it('should allow custom column alias', () => {
            expect(buildSchemaFilter('public', 'SCH')).toBe("AND SCH = 'public'");
        });

        it('should handle null/undefined schema name by returning empty string', () => {
            expect(buildSchemaFilter(null)).toBe('');
            expect(buildSchemaFilter(undefined)).toBe('');
            expect(buildSchemaFilter('')).toBe('');
        });
    });

    describe('buildDatabaseFilter', () => {
        it('should build safe database filter', () => {
            expect(buildDatabaseFilter('mydb')).toBe("DBNAME = 'mydb'");
        });

        it('should allow custom column alias', () => {
            expect(buildDatabaseFilter('mydb', 'DB')).toBe("DB = 'mydb'");
        });
    });

    describe('buildSafeInClause', () => {
        it('should build IN clause with string values', () => {
            const values = ['A', 'B', "O'Connor"];
            expect(buildSafeInClause('status', values)).toBe(`"status" IN ('A', 'B', 'O''Connor')`);
        });

        it('should build IN clause with number values', () => {
            const values = [1, 2, 3];
            expect(buildSafeInClause('id', values)).toBe(`"id" IN (1, 2, 3)`);
        });

        it('should build IN clause with mixed string/number values', () => {
            const values = [1, 'A'];
            expect(buildSafeInClause('mixed', values)).toBe(`"mixed" IN (1, 'A')`);
        });

        it('should throw error for empty array', () => {
            expect(() => buildSafeInClause('id', [])).toThrow('IN clause requires at least one value');
        });
    });

});
