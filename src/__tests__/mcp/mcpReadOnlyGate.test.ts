import { buildSafeExplainForMcp } from '../../mcp/mcpReadOnlyGate';

describe('MCP read-only gate', () => {
    it.each([
        'SELECT * FROM admin.orders',
        'WITH orders AS (SELECT * FROM admin.orders) SELECT * FROM orders',
        '  select 1'
    ])('accepts a single planner-safe query: %s', sql => {
        expect(buildSafeExplainForMcp(sql)).toBe(`EXPLAIN ${sql.trim()}`);
    });

    it('adds VERBOSE for verbose plans', () => {
        expect(buildSafeExplainForMcp('SELECT 1', true)).toBe('EXPLAIN VERBOSE SELECT 1');
    });

    it.each([
        'SELECT 1; SELECT 2',
        'DELETE FROM admin.orders',
        'INSERT INTO t VALUES (1)',
        'UPDATE t SET a = 1',
        'MERGE INTO t USING s ON t.id = s.id',
        'CREATE TABLE t (id INT)',
        'ALTER TABLE t ADD COLUMN x INT',
        'DROP TABLE t',
        'TRUNCATE TABLE t',
        'CALL my_proc(1)',
        'COPY t FROM \'file.csv\'',
        'GRANT SELECT ON t TO PUBLIC',
        'REVOKE SELECT ON t FROM PUBLIC',
        'EXPLAIN SELECT * FROM admin.orders'
    ])('rejects unsafe or pre-wrapped input: %s', sql => {
        expect(() => buildSafeExplainForMcp(sql)).toThrow();
    });
});
