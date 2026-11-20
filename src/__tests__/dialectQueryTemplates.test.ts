import {
    buildExplainQuery,
    buildLimitedSelectQuery,
    buildTopRowsQuery,
    formatQueryObjectName,
    formatQuerySchemaName,
} from '@justybase/dialect-utils';

const target = { database: 'DB1', schema: 'PUBLIC', objectName: 'Orders' } as const;

describe('dialect query templates', () => {
    it.each([
        ['netezza', '"DB1"."PUBLIC"."Orders"'],
        ['postgresql', '"PUBLIC"."Orders"'],
        ['db2', '"DB1"."PUBLIC"."Orders"'],
        ['oracle', '"PUBLIC"."Orders"'],
        ['mssql', '[DB1].[PUBLIC].[Orders]'],
        ['clickhouse', '`DB1`.`Orders`'],
    ] as const)('formats %s object references', (kind, expected) => {
        expect(formatQueryObjectName(target, kind)).toBe(expected);
    });

    it('preserves Netezza DB..TABLE notation when schema metadata is absent', () => {
        expect(formatQueryObjectName({ database: 'DB1', objectName: 'Orders' }, 'netezza')).toBe('"DB1".."Orders"');
    });

    it('formats schema nodes without creating a fake object segment', () => {
        expect(formatQuerySchemaName('DB1', 'PUBLIC', 'netezza')).toBe('"DB1"."PUBLIC"');
        expect(formatQuerySchemaName('DB1', 'PUBLIC', 'postgresql')).toBe('"PUBLIC"');
        expect(formatQuerySchemaName('DB1', 'PUBLIC', 'clickhouse')).toBe('`DB1`');
    });

    it.each([
        ['netezza', 'LIMIT 1000'],
        ['postgresql', 'LIMIT 1000'],
        ['clickhouse', 'LIMIT 1000'],
        ['db2', 'FETCH FIRST 1000 ROWS ONLY'],
        ['oracle', 'WHERE ROWNUM <= 1000'],
        ['mssql', 'SELECT TOP 1000 *'],
    ] as const)('builds the %s top-row query', (kind, expected) => {
        expect(buildTopRowsQuery(target, kind)).toContain(expected);
    });

    it.each([
        ['netezza', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['postgresql', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['mysql', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['clickhouse', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['snowflake', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['vertica', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['duckdb', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['sqlite', 'SELECT * FROM DB1.PUBLIC.Orders LIMIT 100'],
        ['db2', 'SELECT * FROM DB1.PUBLIC.Orders FETCH FIRST 100 ROWS ONLY'],
        ['oracle', 'SELECT * FROM DB1.PUBLIC.Orders FETCH FIRST 100 ROWS ONLY'],
        ['mssql', 'SELECT TOP (100) * FROM DB1.PUBLIC.Orders'],
        ['access', 'SELECT TOP 100 * FROM DB1.PUBLIC.Orders'],
    ] as const)('builds the %s bounded SELECT with native row-limit syntax', (kind, expected) => {
        expect(buildLimitedSelectQuery({ from: 'DB1.PUBLIC.Orders', limit: 100, kind })).toBe(expected);
    });

    it('places projections, filters, and ordering inside the dialect row limit', () => {
        expect(buildLimitedSelectQuery({
            selectList: 'id, name',
            from: 'public.users',
            where: 'id > 10',
            orderBy: 'name DESC',
            limit: 50,
            kind: 'mssql',
        })).toBe('SELECT TOP (50) id, name FROM public.users WHERE id > 10 ORDER BY name DESC');

        expect(buildLimitedSelectQuery({
            from: 'HR.EMPLOYEES',
            where: 'salary > 1000',
            orderBy: 'salary DESC',
            limit: 25,
            kind: 'oracle',
        })).toBe('SELECT * FROM HR.EMPLOYEES WHERE salary > 1000 ORDER BY salary DESC FETCH FIRST 25 ROWS ONLY');
    });

    it('validates bounded SELECT input', () => {
        expect(() => buildLimitedSelectQuery({ from: 'T', limit: 0 })).toThrow('positive');
        expect(() => buildLimitedSelectQuery({ from: '  ', limit: 10 })).toThrow('cannot be empty');
    });

    it.each([
        ['netezza', 'EXPLAIN VERBOSE SELECT 1'],
        ['postgresql', 'EXPLAIN (VERBOSE, COSTS, FORMAT TEXT) SELECT 1'],
        ['db2', 'EXPLAIN PLAN FOR SELECT 1'],
        ['oracle', 'EXPLAIN PLAN FOR SELECT 1'],
        ['clickhouse', 'EXPLAIN PLAN SELECT 1'],
        ['mssql', 'SET SHOWPLAN_TEXT ON;\nGO\nSELECT 1;\nGO\nSET SHOWPLAN_TEXT OFF;\nGO'],
    ] as const)('builds the %s explain query', (kind, expected) => {
        expect(buildExplainQuery('SELECT 1', kind)).toBe(expected);
    });

    it('rejects explain for Access instead of emitting invalid SQL', () => {
        expect(() => buildExplainQuery('SELECT 1', 'access')).toThrow('not available');
    });

    it('validates preview limits and SQL input', () => {
        expect(() => buildTopRowsQuery(target, 'postgresql', 0)).toThrow('positive');
        expect(() => buildTopRowsQuery(target, 'postgresql', 1.5)).toThrow('positive');
        expect(() => buildExplainQuery('  ', 'postgresql')).toThrow('required');
    });
});
