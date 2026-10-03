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

    describe('adversarial input', () => {
        it.each([
            'SELECT * INTO backup_orders FROM admin.orders',
            'WITH src AS (SELECT 1) SELECT * INTO backup FROM src',
            'SELECT * FROM admin.orders FOR UPDATE',
            'SELECT * FROM admin.orders FOR NO KEY UPDATE',
            'SELECT * FROM admin.orders FOR SHARE',
            'SELECT * FROM admin.orders FOR KEY SHARE',
        ])('rejects data-modifying or row-locking statements: %s', sql => {
            expect(() => buildSafeExplainSql(sql)).toThrow();
        });

        it('rejects a second statement smuggled after a comment terminator', () => {
            expect(() => buildSafeExplainSql('SELECT 1; -- ; harmless\nDELETE FROM t')).toThrow();
        });

        it('rejects a leading EXPLAIN hidden behind a comment', () => {
            expect(() => buildSafeExplainSql('/* c */ EXPLAIN SELECT 1')).toThrow();
        });

        it('keeps a semicolon that lives inside a string literal as one statement', () => {
            expect(buildSafeExplainSql("SELECT '; DROP TABLE t' AS payload"))
                .toBe("EXPLAIN SELECT '; DROP TABLE t' AS payload");
        });

        it('ignores mutation keywords that only appear in comments or strings', () => {
            expect(buildSafeExplainSql('SELECT 1 /* DELETE FROM t */')).toBe('EXPLAIN SELECT 1 /* DELETE FROM t */');
            expect(buildSafeExplainSql("SELECT 'DELETE FROM t'")).toBe("EXPLAIN SELECT 'DELETE FROM t'");
        });
    });
});
