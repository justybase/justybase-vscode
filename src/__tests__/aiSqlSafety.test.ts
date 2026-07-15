import { buildSafeExplainSql } from '../services/copilotTools/aiSqlSafety';

describe('AI EXPLAIN safety policy', () => {
    it.each(['SELECT * FROM admin.orders', 'WITH orders AS (SELECT * FROM admin.orders) SELECT * FROM orders'])(
        'accepts a single planner-safe query',
        sql => expect(buildSafeExplainSql(sql, true)).toBe(`EXPLAIN VERBOSE ${sql}`)
    );

    it.each([
        'SELECT 1; SELECT 2',
        'DELETE FROM admin.orders',
        'CREATE TABLE t (id INT)',
        'EXPLAIN SELECT * FROM admin.orders'
    ])('rejects unsafe or pre-wrapped input: %s', sql => {
        expect(() => buildSafeExplainSql(sql)).toThrow();
    });
});
