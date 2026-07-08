import {
    buildDatabaseFilter,
    buildSafeInClause,
    buildSafeWhereClause,
    buildSchemaFilter,
    escapeSqlIdentifier,
    escapeSqlLiteral
} from '../utils/sqlUtils';

describe('sqlUtils', () => {
    describe('escapeSqlIdentifier', () => {
        it('escapes identifier and wraps with double quotes', () => {
            expect(escapeSqlIdentifier('table_name')).toBe('"table_name"');
            expect(escapeSqlIdentifier('na"me')).toBe('"na""me"');
        });

        it('throws for empty identifier', () => {
            expect(() => escapeSqlIdentifier('')).toThrow('Identifier cannot be empty');
        });
    });

    describe('escapeSqlLiteral', () => {
        it('escapes literal and wraps with single quotes', () => {
            expect(escapeSqlLiteral('John')).toBe("'John'");
            expect(escapeSqlLiteral("O'Connor")).toBe("'O''Connor'");
        });

        it('returns NULL for nullish values', () => {
            expect(escapeSqlLiteral(undefined as unknown as string)).toBe('NULL');
            expect(escapeSqlLiteral(null as unknown as string)).toBe('NULL');
        });
    });

    describe('buildSafeWhereClause', () => {
        it('builds WHERE clause for mixed value types', () => {
            const clause = buildSafeWhereClause({
                id: 1,
                name: "O'Neil",
                deleted_at: null
            });

            expect(clause).toContain('"id" = 1');
            expect(clause).toContain('"name" = \'O\'\'Neil\'');
            expect(clause).toContain('"deleted_at" IS NULL');
            expect(clause.split(' AND ').length).toBe(3);
        });

        it('supports LIKE operator', () => {
            const clause = buildSafeWhereClause({ name: '%john%' }, 'LIKE');
            expect(clause).toBe('"name" LIKE \'%john%\'');
        });
    });

    describe('buildSchemaFilter', () => {
        it('returns empty filter when schema name is not provided', () => {
            expect(buildSchemaFilter(undefined)).toBe('');
            expect(buildSchemaFilter(null)).toBe('');
            expect(buildSchemaFilter('')).toBe('');
        });

        it('builds schema filter with escaped literal', () => {
            expect(buildSchemaFilter("pub'lic")).toBe("AND SCHEMA = 'pub''lic'");
            expect(buildSchemaFilter('sales', 'O.SCHEMA')).toBe("AND O.SCHEMA = 'sales'");
        });
    });

    describe('buildDatabaseFilter', () => {
        it('builds database filter with default and custom aliases', () => {
            expect(buildDatabaseFilter("db'name")).toBe("DBNAME = 'db''name'");
            expect(buildDatabaseFilter('analytics', 'D.NAME')).toBe("D.NAME = 'analytics'");
        });
    });

    describe('buildSafeInClause', () => {
        it('builds IN clause for mixed values', () => {
            const clause = buildSafeInClause('status', ['NEW', 'DONE', 3]);
            expect(clause).toBe('"status" IN (\'NEW\', \'DONE\', 3)');
        });

        it('throws for empty values list', () => {
            expect(() => buildSafeInClause('id', [])).toThrow('IN clause requires at least one value');
        });
    });
});
