/**
 * Unit tests for providers/linterRules.ts
 * Tests the SQL linting rules for Netezza
 */

// Import the actual linter rules
import {
    ruleNZ001,
    ruleNZ002,
    ruleNZ003,
    ruleNZ004,
    ruleNZ005,
    ruleNZ006,
    ruleNZ007,
    ruleNZ008,
    ruleNZ009,
    ruleNZ010,
    ruleNZ011,
    ruleNZ012,
    ruleNZ013
} from '../providers/linterRules';

describe('providers/linterRules', () => {
    describe('NZ001: SELECT * usage', () => {
        it('should detect SELECT *', () => {
            const sql = 'SELECT * FROM users';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ001');
        });

        it('should detect SELECT * in lowercase', () => {
            const sql = 'select * from users';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect multiple SELECT *', () => {
            const sql = 'SELECT * FROM t1; SELECT * FROM t2';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag explicit columns', () => {
            const sql = 'SELECT id, name FROM users';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag SELECT * in comment', () => {
            const sql = '-- SELECT * FROM users\nSELECT id FROM users';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag SELECT * in string literal', () => {
            const sql = "SELECT 'SELECT * FROM foo' as query FROM users";
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ002: DELETE without WHERE', () => {
        it('should detect DELETE without WHERE', () => {
            const sql = 'DELETE FROM users';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ002');
        });

        it('should not flag DELETE with WHERE', () => {
            const sql = 'DELETE FROM users WHERE id = 1';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect DELETE followed by semicolon without WHERE', () => {
            const sql = 'DELETE FROM users;';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should handle lowercase', () => {
            const sql = 'delete from users';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ003: UPDATE without WHERE', () => {
        it('should detect UPDATE without WHERE', () => {
            const sql = 'UPDATE users SET active = 0';
            const issues = ruleNZ003.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ003');
        });

        it('should not flag UPDATE with WHERE', () => {
            const sql = 'UPDATE users SET active = 0 WHERE id = 1';
            const issues = ruleNZ003.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect UPDATE followed by semicolon without WHERE', () => {
            const sql = 'UPDATE users SET name = "test";';
            const issues = ruleNZ003.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should handle lowercase', () => {
            const sql = 'update users set active = 1';
            const issues = ruleNZ003.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ004: CROSS JOIN detection', () => {
        it('should detect CROSS JOIN', () => {
            const sql = 'SELECT * FROM t1 CROSS JOIN t2';
            const issues = ruleNZ004.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ004');
        });

        it('should detect lowercase cross join', () => {
            const sql = 'SELECT * FROM t1 cross join t2';
            const issues = ruleNZ004.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag INNER JOIN', () => {
            const sql = 'SELECT * FROM t1 INNER JOIN t2 ON t1.id = t2.id';
            const issues = ruleNZ004.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ005: Leading wildcard LIKE', () => {
        it('should detect LIKE with leading %', () => {
            const sql = "SELECT * FROM users WHERE name LIKE '%test'";
            const issues = ruleNZ005.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ005');
        });

        it('should detect LIKE with leading % in middle of pattern', () => {
            const sql = "SELECT * FROM users WHERE name LIKE '%test%'";
            const issues = ruleNZ005.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag LIKE with trailing % only', () => {
            const sql = "SELECT * FROM users WHERE name LIKE 'test%'";
            const issues = ruleNZ005.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ006: ORDER BY without LIMIT', () => {
        it('should detect ORDER BY without LIMIT', () => {
            const sql = 'SELECT * FROM users ORDER BY name';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ006');
        });

        it('should not flag ORDER BY with LIMIT', () => {
            const sql = 'SELECT * FROM users ORDER BY name LIMIT 10';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag ORDER BY with FETCH', () => {
            const sql = 'SELECT * FROM users ORDER BY name FETCH FIRST 10 ROWS ONLY';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag ORDER BY inside window function OVER clause', () => {
            const sql = 'SELECT ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM users';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag ORDER BY inside WITHIN GROUP ordered-set aggregate', () => {
            const sql = `SELECT d.CALENDARQUARTER
, percentile_cont(0.4) WITHIN GROUP (ORDER BY D.CALENDARQUARTER) AS fortieth
FROM DIMDATE D GROUP BY d.CALENDARQUARTER`;
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should still flag top-level ORDER BY when query also has window ORDER BY', () => {
            const sql = 'SELECT ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn FROM users ORDER BY name';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].startOffset).toBe(sql.lastIndexOf('ORDER BY'));
        });

        it('should handle lowercase', () => {
            const sql = 'select * from users order by name';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ007: Inconsistent keyword casing', () => {
        it('should detect mixed case keywords', () => {
            const sql = 'Select * From users Where id = 1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBeGreaterThan(0);
            expect(issues[0].ruleId).toBe('NZ007');
        });

        it('should not flag all uppercase keywords', () => {
            const sql = 'SELECT * FROM USERS WHERE ID = 1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag all lowercase keywords', () => {
            const sql = 'select * from users where id = 1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect inconsistent case between uppercase and lowercase', () => {
            const sql = 'SELECT * from users WHERE id = 1';
            const issues = ruleNZ007.check(sql);
            // Should flag 'from' as inconsistent with dominant UPPER
            expect(issues.length).toBeGreaterThan(0);
        });

        it('should not flag keywords in comments', () => {
            const sql = '-- Select from users\nSELECT * FROM USERS';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag keywords in string literals', () => {
            const sql = "SELECT 'select from where' FROM USERS";
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag keywords inside SAS-like macro directives', () => {
            const sql = `%LET dim_table = JUST_DATA.ADMIN.DIMDATE;
%LET as_of_key = %SQL(
  SELECT MAX(DATEKEY)
  FROM &dim_table
);
%PUT As-of DATEKEY resolved from database: &as_of_key;`;

            const issues = ruleNZ007.check(sql);

            expect(issues).toEqual([]);
        });

        it('should not flag keywords inside %EXPORT directives', () => {
            const sql = `%EXPORT(
  format='xlsx',
  file='/tmp/out.xlsx',
  query=(
    SELECT DATEKEY
    FROM JUST_DATA.ADMIN.DIMDATE
  )
);`;

            const issues = ruleNZ007.check(sql);

            expect(issues).toEqual([]);
        });

        it('should still flag inconsistent SQL after macro directives', () => {
            const sql = `%PUT As-of DATEKEY resolved from database: &as_of_key;
SELECT * from JUST_DATA.ADMIN.DIMDATE;`;

            const issues = ruleNZ007.check(sql);

            expect(issues).toHaveLength(1);
            expect(issues[0].message).toContain("'from'");
        });

        it('should detect inconsistent TRUNCATE keyword casing', () => {
            const sql = 'TRUNCATE table DIMACCOUNT2;';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBeGreaterThan(0);
            expect(issues.some((issue) => issue.message.includes("'table'"))).toBe(true);
        });

        it('should flag lowercase TRUNCATE in predominantly uppercase SQL', () => {
            const sql = 'SELECT * FROM DIMACCOUNT2; truncate TABLE DIMACCOUNT2;';
            const issues = ruleNZ007.check(sql);
            expect(issues.some((issue) => issue.message.includes("'truncate'"))).toBe(true);
        });
    });

    describe('NZ008: TRUNCATE statement', () => {
        it('should detect TRUNCATE TABLE', () => {
            const sql = 'TRUNCATE TABLE users';
            const issues = ruleNZ008.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ008');
        });

        it('should detect lowercase truncate', () => {
            const sql = 'truncate table users';
            const issues = ruleNZ008.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect TRUNCATE without TABLE keyword', () => {
            const sql = 'TRUNCATE users';
            const issues = ruleNZ008.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ009: Multiple OR in WHERE', () => {
        it('should detect multiple OR conditions', () => {
            const sql = 'SELECT * FROM users WHERE status = 1 OR status = 2 OR status = 3';
            const issues = ruleNZ009.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ009');
        });

        it('should not flag single OR', () => {
            const sql = 'SELECT * FROM users WHERE status = 1 OR status = 2';
            const issues = ruleNZ009.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag without WHERE clause', () => {
            const sql = 'SELECT 1 OR 2';
            const issues = ruleNZ009.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ010: Missing table alias in JOIN', () => {
        it('should detect JOIN without alias', () => {
            const sql = 'SELECT * FROM t1 JOIN t2 ON t1.id = t2.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ010');
        });

        it('should not flag JOIN with alias', () => {
            const sql = 'SELECT * FROM t1 JOIN t2 t ON t1.id = t.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag JOIN with AS alias', () => {
            const sql = 'SELECT * FROM t1 JOIN t2 AS t ON t1.id = t.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect LEFT JOIN without alias', () => {
            const sql = 'SELECT * FROM t1 LEFT JOIN t2 ON t1.id = t2.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect INNER JOIN without alias', () => {
            const sql = 'SELECT * FROM t1 INNER JOIN t2 ON t1.id = t2.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect multiple JOINs without aliases', () => {
            const sql = 'SELECT * FROM t1 JOIN t2 ON t1.id = t2.id JOIN t3 ON t2.id = t3.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should handle lowercase', () => {
            const sql = 'select * from t1 join t2 on t1.id = t2.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ011: CTAS missing DISTRIBUTE ON', () => {
        it('should detect CREATE TABLE AS SELECT without DISTRIBUTE ON', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ011');
        });

        it('should not flag CTAS with DISTRIBUTE ON RANDOM', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table DISTRIBUTE ON RANDOM';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag CTAS with DISTRIBUTE ON column', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table DISTRIBUTE ON (id)';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect CREATE TABLE IF NOT EXISTS AS SELECT without DISTRIBUTE ON', () => {
            const sql = 'CREATE TABLE IF NOT EXISTS new_table AS SELECT * FROM old_table';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag regular CREATE TABLE', () => {
            const sql = 'CREATE TABLE new_table (id INT, name VARCHAR(100))';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle CTAS with parentheses', () => {
            const sql = 'CREATE TABLE new_table AS (SELECT * FROM old_table)';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should handle lowercase', () => {
            const sql = 'create table new_table as select * from old_table';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag when DISTRIBUTE ON appears later in statement', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table WHERE id > 0 DISTRIBUTE ON (id)';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ012: UPDATE with disallowed AS alias', () => {
        it('should detect UPDATE with AS alias', () => {
            const sql = 'UPDATE users AS u SET active = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ012');
        });

        it('should not flag UPDATE without AS', () => {
            const sql = 'UPDATE users u SET active = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag plain UPDATE', () => {
            const sql = 'UPDATE users SET active = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ013: Prefer UNION ALL over UNION', () => {
        it('should detect UNION', () => {
            const sql = 'SELECT * FROM t1 UNION SELECT * FROM t2';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ013');
        });

        it('should detect UNION DISTINCT', () => {
            const sql = 'SELECT * FROM t1 UNION DISTINCT SELECT * FROM t2';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag UNION ALL', () => {
            const sql = 'SELECT * FROM t1 UNION ALL SELECT * FROM t2';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple UNIONs', () => {
            const sql = 'SELECT 1 UNION SELECT 2 UNION ALL SELECT 3';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(1);
        });
    });
});
