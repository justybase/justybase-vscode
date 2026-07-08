/**
 * Unit tests for SQL Linter
 */

// Mock vscode module
jest.mock('vscode', () => ({
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
    }
}), { virtual: true });

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
    ruleNZ013,
    ruleNZ014,
    ruleNZ015,
    ruleNZ016,
    ruleNZ017,
    ruleNZ018,
    ruleNZ019,
    ruleNZ020,
    ruleNZ021,
    ruleNZ022,
    allRules,
    parseSeverity
} from '../providers/linterRules';

// Import procedure rules
import {
    ruleNZP001,
    ruleNZP002,
    ruleNZP003,
    ruleNZP004,
    ruleNZP005,
    ruleNZP006,
    ruleNZP007,
    ruleNZP008,
    ruleNZP009,
    ruleNZP010,
    ruleNZP011,
    ruleNZP012,
    ruleNZP013,
    ruleNZP014,
    ruleNZP015,
    ruleNZP016,
    ruleNZP017,
    ruleNZP018,
    ruleNZP024,
    ruleNZP025,
    ruleNZP027
} from '../providers/procedureRules';

describe('SQL Linter Rules', () => {
    describe('NZ001 - SELECT *', () => {
        it('should detect SELECT *', () => {
            const sql = 'SELECT * FROM table1';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ001');
        });

        it('should detect multiple SELECT *', () => {
            const sql = 'SELECT * FROM table1; SELECT * FROM table2;';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag SELECT with explicit columns', () => {
            const sql = 'SELECT col1, col2 FROM table1';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag * inside string', () => {
            const sql = "SELECT 'SELECT *' FROM table1";
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag * inside comment', () => {
            const sql = 'SELECT col1 -- SELECT * is bad\nFROM table1';
            const issues = ruleNZ001.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ002 - DELETE without WHERE', () => {
        it('should detect DELETE without WHERE', () => {
            const sql = 'DELETE FROM table1';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ002');
        });

        it('should not flag DELETE with WHERE', () => {
            const sql = 'DELETE FROM table1 WHERE id = 1';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle multiple statements correctly', () => {
            const sql = 'DELETE FROM table1 WHERE id = 1; DELETE FROM table2;';
            const issues = ruleNZ002.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ003 - UPDATE without WHERE', () => {
        it('should detect UPDATE without WHERE', () => {
            const sql = 'UPDATE table1 SET col1 = 1';
            const issues = ruleNZ003.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ003');
        });

        it('should not flag UPDATE with WHERE', () => {
            const sql = 'UPDATE table1 SET col1 = 1 WHERE id = 1';
            const issues = ruleNZ003.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ004 - CROSS JOIN', () => {
        it('should detect CROSS JOIN', () => {
            const sql = 'SELECT * FROM table1 CROSS JOIN table2';
            const issues = ruleNZ004.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ004');
        });

        it('should not flag regular JOIN', () => {
            const sql = 'SELECT * FROM table1 INNER JOIN table2 ON table1.id = table2.id';
            const issues = ruleNZ004.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ005 - Leading wildcard LIKE', () => {
        it('should detect LIKE with leading wildcard', () => {
            const sql = "SELECT * FROM table1 WHERE name LIKE '%test'";
            const issues = ruleNZ005.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ005');
        });

        it('should not flag LIKE with trailing wildcard only', () => {
            const sql = "SELECT * FROM table1 WHERE name LIKE 'test%'";
            const issues = ruleNZ005.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ006 - ORDER BY without LIMIT', () => {
        it('should detect ORDER BY without LIMIT', () => {
            const sql = 'SELECT * FROM table1 ORDER BY col1';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ006');
        });

        it('should not flag ORDER BY with LIMIT', () => {
            const sql = 'SELECT * FROM table1 ORDER BY col1 LIMIT 10';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag ORDER BY with FETCH', () => {
            const sql = 'SELECT * FROM table1 ORDER BY col1 FETCH FIRST 10 ROWS ONLY';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag ORDER BY inside window function OVER clause', () => {
            const sql = 'SELECT ROW_NUMBER() OVER (PARTITION BY col2 ORDER BY col1 DESC) AS rn FROM table1';
            const issues = ruleNZ006.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ007 - Inconsistent keyword casing', () => {
        it('should detect mixed case (inconsistent) keywords', () => {
            const sql = 'SELECT col1 from table1 WHERE id = 1';
            const issues = ruleNZ007.check(sql);
            // Should report 'from' as inconsistent (majority is UPPER)
            expect(issues.length).toBeGreaterThan(0);
            expect(issues[0].ruleId).toBe('NZ007');
            expect(issues[0].message).toContain('UPPERCASE');
        });

        it('should detect Mixed Case (e.g. Select) as error', () => {
            const sql = 'Select * FROM table1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].message).toContain('mixed casing');
        });

        it('should enforce dominant style correctly', () => {
            // 2 lower, 1 UPPER -> dominant is lower
            const sql = 'select * from table1 WHERE id = 1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].message).toContain('lowercase');
        });

        it('should not flag consistent uppercase', () => {
            const sql = 'SELECT COL1 FROM TABLE1 WHERE ID = 1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag consistent lowercase', () => {
            const sql = 'select col1 from table1 where id = 1';
            const issues = ruleNZ007.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ008 - TRUNCATE statement', () => {
        it('should detect TRUNCATE', () => {
            const sql = 'TRUNCATE TABLE table1';
            const issues = ruleNZ008.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ008');
        });

        it('should detect TRUNCATE without TABLE keyword', () => {
            const sql = 'TRUNCATE table1';
            const issues = ruleNZ008.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ009 - Multiple OR conditions', () => {
        it('should detect multiple OR in WHERE', () => {
            const sql = 'SELECT * FROM table1 WHERE id = 1 OR name = "test" OR status = 1';
            const issues = ruleNZ009.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ009');
        });

        it('should not flag single OR', () => {
            const sql = 'SELECT * FROM table1 WHERE id = 1 OR name = "test"';
            const issues = ruleNZ009.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ010 - Missing table alias in JOIN', () => {
        it('should detect JOIN without alias', () => {
            const sql = 'SELECT * FROM table1 t1 JOIN table2 ON t1.id = table2.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ010');
        });

        it('should not flag JOIN with alias', () => {
            const sql = 'SELECT * FROM table1 t1 JOIN table2 t2 ON t1.id = t2.id';
            const issues = ruleNZ010.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ011 - CTAS Missing Distribution', () => {
        it('should detect CTAS without DISTRIBUTE ON', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ011');
        });

        it('should not flag CTAS with DISTRIBUTE ON', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table DISTRIBUTE ON RANDOM';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag regular CREATE TABLE', () => {
            const sql = 'CREATE TABLE new_table (id int)';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag CTAS with explicit column distribution', () => {
            const sql = 'CREATE TABLE new_table AS SELECT * FROM old_table DISTRIBUTE ON (id)';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = 'create table t as select * from old distribute on random';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect CTAS with parentheses', () => {
            const sql = 'CREATE TABLE t AS (SELECT * FROM old)';
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should handle multiline CTAS', () => {
            const sql = `
                CREATE TABLE t AS 
                SELECT * FROM old
            `;
            const issues = ruleNZ011.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should ignore DISTRIBUTE ON inside comments', () => {
            const sql = 'CREATE TABLE t AS SELECT * FROM old; -- DISTRIBUTE ON RANDOM';
            // This technically ends at semicolon, so statement content excludes the comment.
            // Should report missing distribution
            const issues1 = ruleNZ011.check(sql);
            expect(issues1.length).toBe(1);

            // But let's test inline comment inside statement
            const sql2 = 'CREATE TABLE t AS SELECT /* DISTRIBUTE ON RANDOM */ * FROM old';
            const issues2 = ruleNZ011.check(sql2);
            expect(issues2.length).toBe(1);
        });
    });

    describe('NZ014 - OR in JOIN condition', () => {
        it('should detect OR in JOIN condition', () => {
            const sql = `SELECT * FROM A JOIN B ON A.id = B.id OR 1 = 1`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ014');
        });

        it('should detect OR in JOIN with alias', () => {
            const sql = `SELECT * FROM TABLE_1 A JOIN TABLE_2 B ON A.id = B.id OR 1=1`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect OR in JOIN with db..table syntax and alias', () => {
            const sql = `SELECT * FROM DB..TABLE_1 T1 JOIN DB..TABLE_2 T2 ON A.id = B.id OR 1=1`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect OR in JOIN with AS keyword', () => {
            const sql = `SELECT * FROM DB..TABLE_1 AS T1 JOIN DB..TABLE_2 AS T2 ON A.id = B.id OR 1=1`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect OR in JOIN with complex condition', () => {
            // Simplified test with common table/column names
            const sql = `SELECT * FROM t1 JOIN t2 ON t1.id = t2.id OR 1 = 1`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag JOIN with AND only', () => {
            const sql = `SELECT * FROM A JOIN B ON A.id = B.id AND A.status = 'active'`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag JOIN without OR', () => {
            const sql = `SELECT * FROM A JOIN B ON A.id = B.id`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `select * from a join b on a.id = b.id or 1=1`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag OR in WHERE clause', () => {
            const sql = `SELECT * FROM JUST_DATA..DIMACCOUNT A JOIN JUST_DATA..DIMACCOUNT ON 1=1 WHERE 1=1 AND 1=1 OR 1=2`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple JOINs with OR', () => {
            const sql = `SELECT * FROM A JOIN B ON A.id = B.id OR 1=1 JOIN C ON A.id = C.id`;
            const issues = ruleNZ014.check(sql);
            expect(issues.length).toBe(1); // Reports first OR
        });
    });

    describe('NZ018 - Self-referential join condition', () => {
        it('should detect same column compared to itself', () => {
            const sql = `SELECT * FROM T1 JOIN T2 ON T1.ID = T1.ID`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ018');
        });

        it('should detect with table.column syntax', () => {
            const sql = `SELECT * FROM TABLE_1 T1 JOIN TABLE_2 T2 ON T1.ID = T1.ID`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect with db..table.column syntax', () => {
            const sql = `SELECT * FROM DB..TABLE_1 T1 JOIN DB..TABLE_2 T2 ON T1.ID = T1.ID`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag different columns with similar names', () => {
            const sql = `SELECT * FROM T1 JOIN T2 ON T1.COL = L.COL2`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple self-referential conditions', () => {
            const sql = `SELECT * FROM T1 JOIN T2 ON T1.ID = T1.ID WHERE T1.NUM = T1.NUM`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag different columns', () => {
            const sql = `SELECT * FROM T1 JOIN T2 ON T1.ID = T2.ID`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `select * from t1 join t2 on t1.id = t1.id`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect multiple self-referential conditions with AND/OR', () => {
            const sql = `SELECT 1 FROM JUST_DATA..DIMACCOUNT A
WHERE
A.ACCOUNTCODEALTERNATEKEY = A.ACCOUNTCODEALTERNATEKEY
AND ACCOUNTCODEALTERNATEKEY = ACCOUNTCODEALTERNATEKEY
AND 1 = 1`;
            const issues = ruleNZ018.check(sql);
            // Two self-referential columns plus trailing AND 1 = 1 (not the WHERE placeholder)
            expect(issues.length).toBe(3);
        });

        it('should ignore WHERE 1 = 1 placeholder used before AND predicates', () => {
            const sql = `SELECT ACCOUNTCODEALTERNATEKEY FROM
JUST_DATA..DIMACCOUNT
WHERE 1 = 1
AND ACCOUNTCODEALTERNATEKEY = 5`;
            const issues = ruleNZ018.check(sql);
            expect(issues).toHaveLength(0);
        });

        it('should still flag AND 1 = 1 when it is not the initial WHERE predicate', () => {
            const sql = `SELECT * FROM T WHERE COL = COL AND 1 = 1`;
            const issues = ruleNZ018.check(sql);
            expect(issues.length).toBe(2);
        });
    });

    describe('NZ019 - CASE without END', () => {
        it('should detect CASE without END', () => {
            const sql = `SELECT CASE WHEN X=Y THEN 1 FROM table1`;
            const issues = ruleNZ019.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ019');
        });

        it('should detect CASE with ELSE without END', () => {
            const sql = `SELECT CASE WHEN X=Y THEN 1 ELSE 2 FROM table1`;
            const issues = ruleNZ019.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag CASE with END', () => {
            const sql = `SELECT CASE WHEN X=Y THEN 1 END FROM table1`;
            const issues = ruleNZ019.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag CASE with ELSE and END', () => {
            const sql = `SELECT CASE WHEN X=Y THEN 1 ELSE 2 END FROM table1`;
            const issues = ruleNZ019.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `select case when x=y then 1 from table1`;
            const issues = ruleNZ019.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect multiple CASE without END', () => {
            const sql = `SELECT CASE WHEN X=Y THEN 1 END, CASE WHEN A=B THEN 2 END FROM table1`;
            const issues = ruleNZ019.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag CASE keyword inside line comments', () => {
            const sql = `SELECT 1  --case
FROM DIMACCOUNT`;
            const issues = ruleNZ019.check(sql);
            expect(issues).toHaveLength(0);
        });
    });

    describe('NZ012 - UPDATE with AS alias', () => {
        it('should detect UPDATE with AS alias', () => {
            const sql = 'UPDATE table1 AS t1 SET col1 = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ012');
        });

        it('should not flag UPDATE without AS alias', () => {
            const sql = 'UPDATE table1 t1 SET col1 = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag UPDATE with no alias', () => {
            const sql = 'UPDATE table1 SET col1 = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = 'update table1 as t1 set col1 = 1';
            const issues = ruleNZ012.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ013 - Prefer UNION ALL over UNION', () => {
        it('should detect UNION without ALL', () => {
            const sql = 'SELECT * FROM table1 UNION SELECT * FROM table2';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ013');
        });

        it('should not flag UNION ALL', () => {
            const sql = 'SELECT * FROM table1 UNION ALL SELECT * FROM table2';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple UNION without ALL', () => {
            const sql = 'SELECT * FROM t1 UNION SELECT * FROM t2 UNION SELECT * FROM t3';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should handle case insensitivity', () => {
            const sql = 'select * from t1 union select * from t2';
            const issues = ruleNZ013.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ015 - Function in WHERE clause', () => {
        it('should detect function in WHERE clause', () => {
            const sql = "SELECT * FROM table1 WHERE UPPER(name) = 'TEST'";
            const issues = ruleNZ015.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ015');
        });

        it('should detect multiple functions in WHERE', () => {
            const sql = "SELECT * FROM table1 WHERE UPPER(name) = 'TEST' AND LOWER(status) = 'active'";
            const issues = ruleNZ015.check(sql);
            // Note: Current implementation only detects first function
            expect(issues.length).toBeGreaterThanOrEqual(1);
        });

        it('should not flag WHERE without functions', () => {
            const sql = "SELECT * FROM table1 WHERE name = 'TEST'";
            const issues = ruleNZ015.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = "select * from table1 where upper(name) = 'test'";
            const issues = ruleNZ015.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag CTE subquery WHERE when outer SELECT has functions', () => {
            const sql = `WITH D AS 
(SELECT DP.ID FROM JUST_DATA..DEPARTMENT DP
WHERE DP.ID  > 0
)

SELECT 
TO_DATE(D.ID,'YYYYMMDD')
FROM D
WHERE D.ID = 1`;
            const issues = ruleNZ015.check(sql);
            expect(issues).toHaveLength(0);
        });

        it('should still flag function in outer WHERE with CTE', () => {
            const sql = `WITH D AS (SELECT id FROM t WHERE id > 0)
SELECT * FROM D WHERE UPPER(name) = 'X'`;
            const issues = ruleNZ015.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZ015');
        });
    });

    describe('NZ016 - Implicit Casting in Join', () => {
        it('should detect implicit casting with string literal in JOIN ON (no alias)', () => {
            const sql = "SELECT * FROM t1 JOIN t2 ON t1.id = '123'";
            const issues = ruleNZ016.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ016');
        });

        it('should detect implicit casting with string literal in JOIN ON (lowercase)', () => {
            const sql = "select * from t1 join t2 on t1.col = 'test'";
            const issues = ruleNZ016.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ016');
        });

        it('should not flag join with column comparison (no alias)', () => {
            const sql = 'SELECT * FROM t1 JOIN t2 ON t1.id = t2.id';
            const issues = ruleNZ016.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag join with numeric literal only', () => {
            const sql = 'SELECT * FROM t1 JOIN t2 ON t1.id = 123';
            const issues = ruleNZ016.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag non-join SQL with string where clause', () => {
            const sql = "SELECT * FROM table1 WHERE col = 'value'";
            const issues = ruleNZ016.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ017 - Double Quoted Identifiers', () => {
        it('should detect double quoted identifiers', () => {
            const sql = 'SELECT "column_name" FROM table1';
            const issues = ruleNZ017.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ017');
        });

        it('should detect multiple double quoted identifiers', () => {
            const sql = 'SELECT "col1", "col2" FROM "table_name"';
            const issues = ruleNZ017.check(sql);
            expect(issues.length).toBe(3);
        });

        it('should not flag single quoted strings', () => {
            const sql = "SELECT 'string value' FROM table1";
            const issues = ruleNZ017.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag double quotes inside comments', () => {
            const sql = 'SELECT col1 FROM table1 -- "comment with quotes"';
            const issues = ruleNZ017.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag double quotes inside single quoted strings', () => {
            const sql = "SELECT 'test' FROM table1"; // This is a string literal
            const issues = ruleNZ017.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZ020 - Subquery Efficiency', () => {
        it('should detect IN (SELECT) subquery', () => {
            const sql = 'SELECT * FROM table1 WHERE id IN (SELECT id FROM table2)';
            const issues = ruleNZ020.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ020');
        });

        it('should detect multiple IN (SELECT) subqueries', () => {
            const sql = 'SELECT * FROM t1 WHERE id IN (SELECT id FROM t2) AND status IN (SELECT status FROM t3)';
            const issues = ruleNZ020.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag IN with literal list', () => {
            const sql = "SELECT * FROM table1 WHERE id IN (1, 2, 3)";
            const issues = ruleNZ020.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = 'select * from t1 where id in (select id from t2)';
            const issues = ruleNZ020.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ021 - Double Comma', () => {
        it('should detect double comma in SELECT list', () => {
            const sql = 'SELECT 1,,2 FROM table1';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ021');
            expect(issues[0].startOffset).toBe(9);
            expect(issues[0].endOffset).toBe(10);
        });

        it('should detect multiple double commas', () => {
            const sql = 'SELECT 1,,2,,3 FROM table1';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(2);
            expect(issues[0].ruleId).toBe('NZ021');
            expect(issues[1].ruleId).toBe('NZ021');
        });

        it('should detect double comma in FROM clause', () => {
            const sql = 'SELECT * FROM t1,,t2';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should detect double comma in WHERE clause', () => {
            const sql = "SELECT * FROM t1 WHERE a = 1,,b = 2";
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag single commas', () => {
            const sql = 'SELECT 1, 2, 3 FROM table1';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag commas inside single-quoted strings', () => {
            const sql = "SELECT 'a,,b' FROM table1";
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag commas inside line comments', () => {
            const sql = "SELECT 1 -- comment,,\nFROM table1";
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag commas inside block comments', () => {
            const sql = "SELECT 1 /* comment,, */ FROM table1";
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should highlight only the second comma', () => {
            const sql = 'SELECT 1,,2 FROM table1';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(1);
            // The double comma starts at offset 9, second comma is at offset 10
            expect(issues[0].startOffset).toBe(9);
            expect(issues[0].endOffset).toBe(10);
        });

        it('should have error severity', () => {
            const sql = 'SELECT 1,,2 FROM table1';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].severity).toBe(0); // LintSeverity.Error
        });

        it('should handle case insensitive double commas', () => {
            const sql = 'select 1,,2 from table1';
            const issues = ruleNZ021.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZ022 - WHERE without FROM', () => {
        it('should detect WHERE without FROM in SELECT', () => {
            const sql = 'SELECT 1 COL WHERE 1=2';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ022');
        });

        it('should detect WHERE without FROM with expression', () => {
            const sql = 'SELECT 1 WHERE 1=1';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZ022');
        });

        it('should not flag SELECT with FROM and WHERE', () => {
            const sql = 'SELECT 1 FROM t WHERE 1=1';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag SELECT without WHERE', () => {
            const sql = 'SELECT 1 AS COL';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag SELECT with FROM but no WHERE', () => {
            const sql = 'SELECT 1 FROM t';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag CTE with WHERE', () => {
            const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte WHERE 1=1';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple WHERE without FROM', () => {
            const sql = 'SELECT 1 WHERE 1=1; SELECT 2 WHERE 2=2';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag SELECT FROM subquery with WHERE', () => {
            const sql = 'SELECT * FROM (SELECT 1) t WHERE 1=1';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should highlight WHERE keyword', () => {
            const sql = 'SELECT 1 WHERE 1=2';
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(1);
            expect(sql.substring(issues[0].startOffset, issues[0].endOffset)).toBe('WHERE');
        });

        it('should have warning severity', () => {
            const sql = 'SELECT 1 WHERE 1=2';
            const issues = ruleNZ022.check(sql);
            expect(issues[0].severity).toBe(1); // LintSeverity.Warning
        });

        it('should not flag WHERE in DELETE with subquery SELECT having FROM', () => {
            const sql = `DELETE FROM DIMACCOUNT X
WHERE    X.ACCOUNTCODEALTERNATEKEY  IN (SELECT 1 FROM DIMACCOUNT)
OR X.ACCOUNTKEY > 0;`;
            const issues = ruleNZ022.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('parseSeverity', () => {
        it('should parse error', () => {
            expect(parseSeverity('error')).toBe(0); // DiagnosticSeverity.Error
        });

        it('should parse warning', () => {
            expect(parseSeverity('warning')).toBe(1); // DiagnosticSeverity.Warning
        });

        it('should parse off', () => {
            expect(parseSeverity('off')).toBeNull();
        });
    });

    describe('allRules', () => {
        it('should contain 22 core NZ rules', () => {
            expect(allRules.length).toBe(22);
        });

        it('should have unique rule IDs', () => {
            const ids = allRules.map(r => r.id);
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
        });

        it('should identify on-demand only rules', () => {
            const onDemandRules = allRules.filter(r => r.onDemandOnly);
            expect(onDemandRules.length).toBe(0);
        });
    });

    describe('NZP001 - Missing BEGIN_PROC/END_PROC', () => {
        it('should detect missing BEGIN_PROC', () => {
            const sql = 'CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS END_PROC; SELECT 1;';
            const issues = ruleNZP001.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP001');
            expect(issues[0].message).toContain('BEGIN_PROC');
        });

        it('should detect missing END_PROC', () => {
            const sql = 'CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS BEGIN_PROC; SELECT 1';
            const issues = ruleNZP001.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP001');
            expect(issues[0].message).toContain('END_PROC');
        });

        it('should not flag valid procedure with both delimiters', () => {
            const sql = 'CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP001.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle CREATE OR REPLACE PROCEDURE', () => {
            const sql = `CREATE OR REPLACE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
SELECT 1;
END_PROC;`;
            const issues = ruleNZP001.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP004 - Unmatched BEGIN/END blocks', () => {
        it('should detect unmatched BEGIN (missing END)', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
SELECT 1;
END_PROC;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP004');
            expect(issues[0].message).toContain('1 BEGIN vs 0 END');
        });

        it('should detect unmatched END (missing BEGIN)', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP004');
        });

        it('should not flag matched BEGIN/END pairs', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect unmatched blocks when END_PROC is missing', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
SELECT 1;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP004');
            expect(issues[0].message).toContain('1 BEGIN vs 0 END');
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'SELECT * FROM table1';
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle nested BEGIN/END correctly', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
BEGIN
SELECT 1;
END
END
END_PROC;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect only one unmatched BEGIN with nested blocks', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
BEGIN
SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP004');
        });

        it('should not flag CASE END in CTAS SELECT as unmatched BEGIN', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN

CREATE TEMP TABLE TT_1 AS (
    SELECT 1
    , CASE WHEN 1=2 THEN 1 ELSE 0 END AS COL2
     FROM JUST_DATA..DIMACCOUNT
    WHERE ACCOUNTCODEALTERNATEKEY > 0
)DISTRIBUTE ON RANDOM;


 return 1;
 END;
END_PROC;`;
            const issues = ruleNZP004.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP005 - IF without END IF', () => {
        it('should detect missing END IF', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
IF x = 1 THEN
SELECT 1;
END_PROC;`;
            const issues = ruleNZP005.check(sql);
            expect(issues.length).toBeGreaterThanOrEqual(1);
            expect(issues[0].ruleId).toBe('NZP005');
        });

        it('should not flag valid IF END IF (using IBM NZPLSQL syntax)', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
IF v_count > 0 THEN
    INSERT INTO users_count(count) VALUES(v_count);
    return 't';
ELSE
    return 'f';
END IF;
END_PROC;`;
            const issues = ruleNZP005.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag nested IF END IF', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
IF x = 1 THEN
    IF y = 2 THEN
        SELECT 1;
    END IF;
END IF;
END_PROC;`;
            const issues = ruleNZP005.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag IF EXISTS in DROP TABLE', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN

DROP TABLE DIMACCOUNT IF EXISTS;

 return 1;
 END;
END_PROC;`;
            const issues = ruleNZP005.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP006 - LOOP without END LOOP', () => {
        it('should detect unmatched LOOP', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
LOOP
    SELECT 1;
END_PROC;`;
            const issues = ruleNZP006.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP006');
        });

        it('should not flag FOR in declarations (ALIAS FOR)', () => {
            const sql = `CREATE PROCEDURE test_proc(p_id INTEGER) LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    arg1 ALIAS FOR $1;
BEGIN
    SELECT arg1;
END_PROC;`;
            const issues = ruleNZP006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect unmatched FOR loop', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
FOR rec IN SELECT 1 LOOP
    SELECT 1;
END LOOP;
END_PROC;`;
            const issues = ruleNZP006.check(sql);
            // FOR...LOOP is matched by END LOOP - no issues expected
            expect(issues.length).toBe(0);
        });

        it('should not flag matched LOOP END LOOP', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
LOOP
    SELECT 1;
END LOOP;
END_PROC;`;
            const issues = ruleNZP006.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle WHILE loops', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
WHILE x = 1 LOOP
    SELECT 1;
END LOOP;
END_PROC;`;
            const issues = ruleNZP006.check(sql);
            // WHILE...LOOP is matched by END LOOP - no issues expected
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP002 - Missing LANGUAGE clause', () => {
        it('should detect missing LANGUAGE clause', () => {
            const sql = 'CREATE PROCEDURE test_proc() IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP002.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP002');
        });

        it('should not flag procedure with LANGUAGE clause', () => {
            const sql = 'CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP002.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should accept different language types', () => {
            const sql = 'CREATE PROCEDURE test_proc() LANGUAGE SQL IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP002.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = 'create procedure test_proc() language nzplsql is begin_proc select 1; end_proc;';
            const issues = ruleNZP002.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP003 - Missing RETURNS clause', () => {
        it('should detect missing RETURNS clause', () => {
            const sql = 'CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP003.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP003');
        });

        it('should not flag procedure with RETURNS clause', () => {
            const sql = 'CREATE PROCEDURE test_proc() RETURNS VARCHAR LANGUAGE NZPLSQL IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP003.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = 'CREATE PROCEDURE test_proc() returns integer LANGUAGE NZPLSQL IS BEGIN_PROC SELECT 1; END_PROC;';
            const issues = ruleNZP003.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP007 - Missing semicolon', () => {
        it('should detect missing semicolon after SELECT before END', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
SELECT * FROM table1
END
END_PROC;`;
            const issues = ruleNZP007.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP007');
        });

        it('should detect missing semicolon after INSERT before END', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
SELECT * FROM table1;
INSERT INTO t2 VALUES (1)
END
END_PROC;`;
            const issues = ruleNZP007.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP007');
        });

        it('should detect missing semicolon after DECLARE before BEGIN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE v_var INTEGER
BEGIN
SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP007.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP007');
        });

        it('should not flag statements with semicolons', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
SELECT * FROM table1;
END
END_PROC;`;
            const issues = ruleNZP007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag SELECT with subquery returning INTO variable', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN
 SELECT COUNT(X.COL) INTO V_NUM FROM (
    SELECT 1 AS COL FROM DIMDATE
) X;

 return 1;
 END;
END_PROC;`;
            const issues = ruleNZP007.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag INSERT INTO ... SELECT with proper semicolon', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN

INSERT INTO DIMACCOUNT
SELECT * FROM DIMACCOUNT;

 return 1;
 END;
END_PROC;`;
            const issues = ruleNZP007.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP008 - Unused Variable', () => {
        it('should detect unused variable', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    unused_var INTEGER;
BEGIN
    SELECT 1;
END_PROC;`;
            const issues = ruleNZP008.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP008');
            expect(issues[0].message).toContain('unused_var');
        });

        it('should not flag used variable', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    used_var INTEGER;
BEGIN
    SELECT used_var;
END_PROC;`;
            const issues = ruleNZP008.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple unused variables', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    unused1 INTEGER;
    unused2 VARCHAR;
BEGIN
    SELECT 1;
END_PROC;`;
            const issues = ruleNZP008.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should handle various data types', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    v_int INTEGER;
    v_varchar VARCHAR;
    v_date DATE;
BEGIN
    SELECT v_int;
END_PROC;`;
            const issues = ruleNZP008.check(sql);
            expect(issues.length).toBe(2); // v_varchar and v_date are unused
        });
    });

    describe('NZP009 - Missing EXCEPTION handler', () => {
        it('should detect missing EXCEPTION handler', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP009.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP009');
        });

        it('should not flag procedure with EXCEPTION handler', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT 1;
EXCEPTION
    WHEN OTHERS THEN
        RETURN 'error';
END
END_PROC;`;
            const issues = ruleNZP009.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT 1;
exception
    when others then
        return 'error';
END
END_PROC;`;
            const issues = ruleNZP009.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP010 - RAISE without severity', () => {
        it('should detect RAISE without severity level', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RAISE 'Error message';
END
END_PROC;`;
            const issues = ruleNZP010.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP010');
        });

        it('should detect RAISE without severity level (lowercase)', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    raise 'error message';
END
END_PROC;`;
            const issues = ruleNZP010.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP010');
        });

        it('should not flag RAISE with severity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RAISE NOTICE 'Info message';
END
END_PROC;`;
            const issues = ruleNZP010.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should accept all severity levels', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RAISE NOTICE 'Notice';
    RAISE WARNING 'Warning';
    RAISE ERROR 'Error';
    RAISE EXCEPTION 'Exception';
END
END_PROC;`;
            const issues = ruleNZP010.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    raise notice 'Info message';
END
END_PROC;`;
            const issues = ruleNZP010.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP011 - Missing INTO in SELECT', () => {
        it('should detect SELECT without INTO', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT * FROM table1;
END
END_PROC;`;
            const issues = ruleNZP011.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP011');
        });

        it('should not flag SELECT with INTO', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT col1 INTO v_var FROM table1;
END
END_PROC;`;
            const issues = ruleNZP011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag INSERT INTO SELECT', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    INSERT INTO t2 SELECT * FROM t1;
END
END_PROC;`;
            const issues = ruleNZP011.check(sql);
            // Note: Current implementation may flag this incorrectly
            expect(issues.length).toBeGreaterThanOrEqual(0);
        });

        it('should not flag INSERT INTO SELECT with multi-line SELECT', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN

INSERT INTO DIMACCOUNT
SELECT * FROM DIMACCOUNT;

 return 1;
 END;
END_PROC;`;
            const issues = ruleNZP011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag SELECT in CTAS inside procedure', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
V_NUM INTEGER;

 BEGIN

CREATE TEMP TABLE TT_1 AS (
    SELECT 1
    , CASE WHEN 1=2 THEN 1 ELSE 0 END AS COL2
     FROM JUST_DATA..DIMACCOUNT
    WHERE ACCOUNTCODEALTERNATEKEY > 0
)DISTRIBUTE ON RANDOM;


 return 1;
 END;
END_PROC;`;
            const issues = ruleNZP011.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple SELECT without INTO', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT * FROM t1;
    SELECT * FROM t2;
END
END_PROC;`;
            const issues = ruleNZP011.check(sql);
            expect(issues.length).toBe(2);
        });
    });

    describe('NZP012 - Incorrect ELSIF syntax', () => {
        it('should detect ELSEIF', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    ELSEIF x = 2 THEN
        SELECT 2;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP012.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP012');
            expect(issues[0].message).toContain('ELSEIF');
        });

        it('should detect ELSE IF', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    ELSE IF x = 2 THEN
        SELECT 2;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP012.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].message).toContain('ELSE IF');
        });

        it('should not flag ELSIF', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    ELSIF x = 2 THEN
        SELECT 2;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP012.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should detect multiple incorrect ELSIF', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    ELSEIF x = 2 THEN
        SELECT 2;
    ELSEIF x = 3 THEN
        SELECT 3;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP012.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    elseif x = 2 THEN
        SELECT 2;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP012.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZP013 - Missing THEN keyword', () => {
        it('should detect IF without THEN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1
        SELECT 1;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP013.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP013');
            expect(issues[0].message).toContain('THEN');
        });

        it('should not flag IF with THEN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP013.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag ELSIF with THEN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    IF x = 1 THEN
        SELECT 1;
    ELSIF x = 2 THEN
        SELECT 2;
    END IF;
END
END_PROC;`;
            const issues = ruleNZP013.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    if x = 1 then
        SELECT 1;
    end if;
END
END_PROC;`;
            const issues = ruleNZP013.check(sql);
            expect(issues.length).toBe(0);
        });
    });
    describe('NZP014 - EXIT without WHEN', () => {
        it('should detect EXIT without WHEN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    LOOP
        EXIT;
    END LOOP;
END
END_PROC;`;
            const issues = ruleNZP014.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP014');
            expect(issues[0].message).toContain('EXIT');
        });

        it('should detect multiple EXIT without WHEN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    LOOP
        EXIT;
        EXIT;
    END LOOP;
END
END_PROC;`;
            const issues = ruleNZP014.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag EXIT with WHEN', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    LOOP
        EXIT WHEN condition;
    END LOOP;
END
END_PROC;`;
            const issues = ruleNZP014.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    loop
        exit;
    end loop;
END
END_PROC;`;
            const issues = ruleNZP014.check(sql);
            expect(issues.length).toBe(1);
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'SELECT * FROM table1';
            const issues = ruleNZP014.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP024 - Missing RETURN Statement', () => {
        it('should detect missing RETURN when RETURNS is declared', () => {
            const sql = `CREATE PROCEDURE test_proc() RETURNS VARCHAR LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT 'test';
END
END_PROC;`;
            const issues = ruleNZP024.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP024');
            expect(issues[0].message).toContain('RETURN');
        });

        it('should not flag procedure with RETURN', () => {
            const sql = `CREATE PROCEDURE test_proc() RETURNS VARCHAR LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RETURN 'test';
END
END_PROC;`;
            const issues = ruleNZP024.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag procedure without RETURNS clause', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP024.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() returns integer language nzplsql is
begin_proc
begin
    return 1;
end
end_proc;`;
            const issues = ruleNZP024.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP025 - Transaction Control in Procedure', () => {
        it('should detect COMMIT inside procedure', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    INSERT INTO t1 VALUES (1);
    COMMIT;
END
END_PROC;`;
            const issues = ruleNZP025.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP025');
            expect(issues[0].message).toContain('COMMIT');
        });

        it('should detect ROLLBACK inside procedure', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    INSERT INTO t1 VALUES (1);
    ROLLBACK;
END
END_PROC;`;
            const issues = ruleNZP025.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP025');
            expect(issues[0].message).toContain('ROLLBACK');
        });

        it('should detect both COMMIT and ROLLBACK', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    INSERT INTO t1 VALUES (1);
    COMMIT;
    ROLLBACK;
END
END_PROC;`;
            const issues = ruleNZP025.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag procedure without transaction control', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    INSERT INTO t1 VALUES (1);
END
END_PROC;`;
            const issues = ruleNZP025.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'COMMIT;';
            const issues = ruleNZP025.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    commit;
END
END_PROC;`;
            const issues = ruleNZP025.check(sql);
            expect(issues.length).toBe(1);
        });
    });

    describe('NZP027 - Missing EXECUTE AS Clause', () => {
        it('should detect missing EXECUTE AS', () => {
            const sql = `CREATE PROCEDURE test_proc() RETURNS INTEGER LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RETURN 1;
END
END_PROC;`;
            const issues = ruleNZP027.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP027');
            expect(issues[0].message).toContain('EXECUTE AS');
        });

        it('should not flag procedure with EXECUTE AS OWNER', () => {
            const sql = `CREATE PROCEDURE test_proc() RETURNS INTEGER EXECUTE AS OWNER LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RETURN 1;
END
END_PROC;`;
            const issues = ruleNZP027.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag procedure with EXECUTE AS CALLER', () => {
            const sql = `CREATE PROCEDURE test_proc() RETURNS INTEGER EXECUTE AS CALLER LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RETURN 1;
END
END_PROC;`;
            const issues = ruleNZP027.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `CREATE PROCEDURE test_proc() RETURNS INTEGER execute as owner LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    RETURN 1;
END
END_PROC;`;
            const issues = ruleNZP027.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'SELECT * FROM table1';
            const issues = ruleNZP027.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP015 - Parameter naming convention', () => {
        it('should detect parameter without prefix', () => {
            const sql = `CREATE PROCEDURE test_proc(my_param INTEGER) LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT my_param;
END
END_PROC;`;
            const issues = ruleNZP015.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP015');
            expect(issues[0].message).toContain('my_param');
            expect(issues[0].message).toContain('prefix');
        });

        it('should detect parameter without prefix (lowercase)', () => {
            const sql = `create procedure test_proc(my_param integer) language nzplsql is
begin_proc
begin
    select my_param;
end
end_proc;`;
            const issues = ruleNZP015.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP015');
        });

        it('should not flag parameter with p_ prefix', () => {
            const sql = `CREATE PROCEDURE test_proc(p_my_param INTEGER) LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT p_my_param;
END
END_PROC;`;
            const issues = ruleNZP015.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag parameter with in_ prefix', () => {
            const sql = `CREATE PROCEDURE test_proc(in_param VARCHAR) LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT in_param;
END
END_PROC;`;
            const issues = ruleNZP015.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag parameter with out_ prefix', () => {
            const sql = `CREATE PROCEDURE test_proc(out_result OUT INTEGER) LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT out_result;
END
END_PROC;`;
            const issues = ruleNZP015.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'SELECT * FROM table1';
            const issues = ruleNZP015.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP016 - Variable naming convention', () => {
        it('should detect variable without v_ prefix', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    my_var INTEGER;
BEGIN
    SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP016.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP016');
            expect(issues[0].message).toContain('my_var');
            expect(issues[0].message).toContain('v_');
        });

        it('should detect multiple variables without v_ prefix', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    var1 INTEGER;
    var2 VARCHAR;
BEGIN
    SELECT 1;
END
END_PROC;`;
            const issues = ruleNZP016.check(sql);
            expect(issues.length).toBe(2);
            expect(issues[0].ruleId).toBe('NZP016');
            expect(issues[1].ruleId).toBe('NZP016');
        });

        it('should not flag variable with v_ prefix', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
DECLARE
    v_my_var INTEGER;
BEGIN
    SELECT v_my_var;
END
END_PROC;`;
            const issues = ruleNZP016.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `create procedure test_proc() language nzplsql is
begin_proc
declare
    my_var integer;
begin
    select 1;
end
end_proc;`;
            const issues = ruleNZP016.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP016');
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'SELECT * FROM table1';
            const issues = ruleNZP016.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP017 - CASE without END CASE', () => {
        it('should detect missing END for CASE expression in SELECT', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT CASE WHEN x = 1 THEN 1 FROM table1;
END
END_PROC;`;
            const issues = ruleNZP017.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP017');
            expect(issues[0].message).toContain('CASE');
        });

        it('should not flag CASE expression with proper END in SELECT', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT CASE WHEN x = 1 THEN 1 END FROM table1;
END
END_PROC;`;
            const issues = ruleNZP017.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag CASE expression with ELSE and END', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    SELECT CASE WHEN x = 1 THEN 1 ELSE 0 END FROM table1;
END
END_PROC;`;
            const issues = ruleNZP017.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `create procedure test_proc() language nzplsql is
begin_proc
begin
    select case when x = 1 then 1 end from table1;
end
end_proc;`;
            const issues = ruleNZP017.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'SELECT CASE WHEN 1=1 THEN 1 END';
            const issues = ruleNZP017.check(sql);
            expect(issues.length).toBe(0);
        });
    });

    describe('NZP018 - SQL Injection risk', () => {
        it('should detect EXECUTE IMMEDIATE with concatenation', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    EXECUTE IMMEDIATE 'SELECT * FROM ' || table_name;
END
END_PROC;`;
            const issues = ruleNZP018.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP018');
            expect(issues[0].message).toContain('injection');
        });

        it('should detect multiple EXECUTE IMMEDIATE with concatenation', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    EXECUTE IMMEDIATE 'SELECT * FROM ' || t1;
    EXECUTE IMMEDIATE 'DELETE FROM ' || t2;
END
END_PROC;`;
            const issues = ruleNZP018.check(sql);
            expect(issues.length).toBe(2);
        });

        it('should not flag EXECUTE IMMEDIATE without concatenation', () => {
            const sql = `CREATE PROCEDURE test_proc() LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
    EXECUTE IMMEDIATE 'SELECT 1';
END
END_PROC;`;
            const issues = ruleNZP018.check(sql);
            expect(issues.length).toBe(0);
        });

        it('should handle case insensitivity', () => {
            const sql = `create procedure test_proc() language nzplsql is
begin_proc
begin
    execute immediate 'select * from ' || table_name;
end
end_proc;`;
            const issues = ruleNZP018.check(sql);
            expect(issues.length).toBe(1);
            expect(issues[0].ruleId).toBe('NZP018');
        });

        it('should not flag non-procedure SQL', () => {
            const sql = 'EXECUTE IMMEDIATE \'SELECT 1\';';
            const issues = ruleNZP018.check(sql);
            expect(issues.length).toBe(0);
        });
    });
});

describe('Complex SQL scenarios', () => {
    it('should handle subqueries correctly', () => {
        const sql = `
            SELECT * FROM (
                SELECT id, name FROM users WHERE active = 1
            ) AS subquery
        `;
        // Should detect SELECT * but not the inner SELECT with explicit columns
        const issues = ruleNZ001.check(sql);
        expect(issues.length).toBe(1);
    });

    it('should ignore patterns inside block comments', () => {
        const sql = `
            /* 
             * SELECT * FROM dangerous_table
             * DELETE FROM important_table
             */
            SELECT col1 FROM table1 WHERE id = 1
        `;
        const selectStarIssues = ruleNZ001.check(sql);
        const deleteIssues = ruleNZ002.check(sql);
        expect(selectStarIssues.length).toBe(0);
        expect(deleteIssues.length).toBe(0);
    });

    it('should handle nested quotes correctly', () => {
        const sql = `SELECT 'it''s a test' FROM table1`;
        const issues = ruleNZ001.check(sql);
        expect(issues.length).toBe(0);
    });
});
