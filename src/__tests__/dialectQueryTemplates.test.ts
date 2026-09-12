import {
    buildExplainQuery,
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
