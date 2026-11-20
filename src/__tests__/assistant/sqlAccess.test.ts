import {
    buildSafeExplainSql,
    classifySqlStatement,
    destructiveTarget,
    splitSingleStatement
} from '../../core/assistant/sqlAccess';

describe('assistant SQL access policy', () => {
    describe('splitSingleStatement', () => {
        it('accepts one statement and strips the trailing semicolon', () => {
            expect(splitSingleStatement('  SELECT 1;  ')).toBe('SELECT 1');
        });

        it('ignores comment-only trailing segments', () => {
            expect(splitSingleStatement('SELECT 1; -- note')).toBe('SELECT 1');
            expect(splitSingleStatement('SELECT 1; /* note */')).toBe('SELECT 1');
        });

        it.each([
            '',
            '   ',
            'SELECT 1; SELECT 2'
        ])('rejects empty or multi-statement input: %s', sql => {
            expect(() => splitSingleStatement(sql)).toThrow();
        });
    });

    describe('buildSafeExplainSql', () => {
        it.each([
            'SELECT * FROM admin.orders',
            'WITH orders AS (SELECT * FROM admin.orders) SELECT * FROM orders',
            '  select 1'
        ])('accepts a single planner-safe query: %s', sql => {
            expect(buildSafeExplainSql(sql)).toBe(`EXPLAIN ${sql.trim()}`);
        });

        it('adds VERBOSE for verbose plans', () => {
            expect(buildSafeExplainSql('SELECT 1', true)).toBe('EXPLAIN VERBOSE SELECT 1');
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
            "COPY t FROM 'file.csv'",
            'GRANT SELECT ON t TO PUBLIC',
            'REVOKE SELECT ON t FROM PUBLIC',
            'EXPLAIN SELECT * FROM admin.orders',
            'SELECT * INTO backup FROM admin.orders',
            'SELECT * FROM admin.orders FOR UPDATE'
        ])('rejects unsafe or pre-wrapped input: %s', sql => {
            expect(() => buildSafeExplainSql(sql)).toThrow();
        });
    });

    describe('classifySqlStatement', () => {
        it.each([
            'SELECT * FROM admin.orders',
            'WITH x AS (SELECT 1) SELECT * FROM x',
            '  select 1  '
        ])('classifies %s as read', sql => {
            expect(classifySqlStatement(sql).kind).toBe('read');
        });

        it.each([
            'INSERT INTO t VALUES (1)',
            'UPDATE t SET a = 1',
            'DELETE FROM t',
            'MERGE INTO t USING s ON t.id = s.id',
            'CREATE TABLE t (id INT)',
            'ALTER TABLE t ADD COLUMN x INT',
            'COMMENT ON TABLE t IS \'x\'',
            "COPY t FROM 'file.csv'",
            'SET search_path TO admin',
            'SELECT * INTO backup FROM admin.orders',
            'SELECT * FROM admin.orders FOR UPDATE'
        ])('classifies %s as write', sql => {
            expect(classifySqlStatement(sql).kind).toBe('write');
        });

        it.each([
            'DROP TABLE t',
            'TRUNCATE TABLE t',
            'GRANT SELECT ON t TO PUBLIC',
            'REVOKE SELECT ON t FROM PUBLIC',
            'ALTER TABLE t DROP COLUMN x',
            'CALL my_proc(1)',
            'EXEC my_proc(1)'
        ])('classifies %s as destructive', sql => {
            expect(classifySqlStatement(sql).kind).toBe('destructive');
        });

        it('fails closed for unknown statements', () => {
            expect(classifySqlStatement('FROBNICATE t').kind).toBe('write');
        });
    });

    describe('destructiveTarget', () => {
        it.each([
            ['DROP TABLE ADMIN.ORDERS', 'ORDERS'],
            ['DROP TABLE IF EXISTS "ADMIN"."ORDERS"', 'ORDERS'],
            ['DROP TABLE DB..ORDERS', 'ORDERS'],
            ['DROP SCHEMA ADMIN', 'ADMIN'],
            ['DROP DATABASE DWH', 'DWH'],
            ['DROP SEQUENCE ADMIN.SEQ_ORDERS', 'SEQ_ORDERS'],
            ['TRUNCATE TABLE ADMIN.ORDERS', 'ORDERS'],
            ['TRUNCATE ADMIN.ORDERS', 'ORDERS'],
            ['CALL ADMIN.P(1)', 'P'],
            ['EXECUTE ADMIN.P(1)', 'P'],
            ['ALTER TABLE ADMIN.ORDERS DROP COLUMN X', 'ORDERS'],
            ['GRANT SELECT ON TABLE ADMIN.ORDERS TO PUBLIC', 'ORDERS'],
            ['REVOKE SELECT ON ADMIN.ORDERS FROM PUBLIC', 'ORDERS'],
            ['-- note\nDROP TABLE ADMIN.ORDERS', 'ORDERS']
        ])('extracts the short name from %s', (sql, expected) => {
            expect(destructiveTarget(sql)).toBe(expected);
        });

        it('returns undefined for non-drop statements', () => {
            expect(destructiveTarget('DELETE FROM ADMIN.ORDERS')).toBeUndefined();
            expect(destructiveTarget('EXECUTE IMMEDIATE \'DROP TABLE ADMIN.ORDERS\'')).toBeUndefined();
        });
    });
});
