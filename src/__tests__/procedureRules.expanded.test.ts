/**
 * Expanded tests for providers/procedureRules.ts
 * Focused on rules NZP014-NZP030 and public helper APIs.
 */

jest.unmock('chevrotain');

jest.mock('vscode', () => ({
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
    }
}), { virtual: true });

import * as parsingRuntime from '../sqlParser/parsingRuntime';
import {
    ruleNZP007,
    ruleNZP011,
    ruleNZP013,
    ruleNZP014,
    ruleNZP015,
    ruleNZP016,
    ruleNZP017,
    ruleNZP018,
    ruleNZP019,
    ruleNZP020,
    ruleNZP022,
    ruleNZP023,
    ruleNZP024,
    ruleNZP025,
    ruleNZP026,
    ruleNZP027,
    ruleNZP028,
    ruleNZP029,
    ruleNZP030,
    procedureRules,
    lintNetezzaProcedure,
    getProcedureRuleById
} from '../providers/procedureRules';

function buildProcedure(
    body: string,
    params: string = 'p_id INTEGER',
    executeAs?: 'OWNER' | 'CALLER',
    returnsClause: string = 'RETURNS INT4'
): string {
    const executeAsLine = executeAs ? `EXECUTE AS ${executeAs}\n` : '';
    const returnsLine = returnsClause ? `${returnsClause}\n` : '';
    return `CREATE OR REPLACE PROCEDURE test_proc(${params})
${executeAsLine}${returnsLine}LANGUAGE NZPLSQL AS
BEGIN_PROC
${body}
END_PROC;`;
}

describe('procedureRules expanded coverage', () => {
    describe('NZP007 - Missing semicolon (embedded SELECT)', () => {
        it('does not flag SELECT inside WHERE IN subquery', () => {
            const sql = buildProcedure(`BEGIN
DELETE FROM t WHERE id IN (SELECT id FROM t2);
RETURN 1;
END;`);
            expect(ruleNZP007.check(sql)).toHaveLength(0);
        });

        it('does not flag SELECT in WITH CTE', () => {
            const sql = buildProcedure(`BEGIN
INSERT INTO t
WITH cte AS (
    SELECT 1 AS id
)
SELECT id FROM cte;
RETURN 1;
END;`);
            expect(ruleNZP007.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP011 - Missing INTO (CST migration)', () => {
        it('defers standalone SELECT without INTO to SQL037 when parse succeeds', () => {
            const sql = buildProcedure(`BEGIN
SELECT 1;
RETURN 1;
END;`);
            expect(ruleNZP011.check(sql)).toHaveLength(0);
        });

        it('flags standalone SELECT without INTO when parse fails', () => {
            const sql = `${buildProcedure(`BEGIN
SELECT 1;
RETURN 1;
END;`)}
@@@`;
            const issues = ruleNZP011.check(sql);
            expect(issues.some((issue) => issue.ruleId === 'NZP011')).toBe(true);
        });
    });

    describe('NZP011 - Missing INTO (embedded SELECT)', () => {
        it('does not flag SELECT in WHERE IN subquery', () => {
            const sql = buildProcedure(`BEGIN
DELETE FROM t WHERE id IN (SELECT id FROM t2);
RETURN 1;
END;`);
            expect(ruleNZP011.check(sql)).toHaveLength(0);
        });

        it('does not flag SELECT in CURSOR FOR declaration', () => {
            const sql = buildProcedure(`DECLARE
cur CURSOR FOR SELECT id FROM t;
BEGIN
OPEN cur;
CLOSE cur;
RETURN 1;
END;`);
            expect(ruleNZP011.check(sql)).toHaveLength(0);
        });

        it('does not flag SELECT in WITH CTE before INSERT', () => {
            const sql = buildProcedure(`BEGIN
INSERT INTO t
WITH cte AS (
    SELECT 1 AS id FROM src
)
SELECT id FROM cte;
RETURN 1;
END;`);
            expect(ruleNZP011.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP013 - Missing THEN', () => {
        it('accepts single-line IF with THEN', () => {
            const sql = buildProcedure(`BEGIN
IF p_id = 1 THEN RETURN 1; END IF;
RETURN 0;
END;`);
            expect(ruleNZP013.check(sql)).toHaveLength(0);
        });

        it('accepts multi-line IF condition with THEN', () => {
            const sql = buildProcedure(`BEGIN
IF
    p_id = 1
THEN
    RETURN 1;
END IF;
RETURN 0;
END;`);
            expect(ruleNZP013.check(sql)).toHaveLength(0);
        });

        it('flags IF without THEN before END IF', () => {
            const sql = buildProcedure(`BEGIN
IF p_id = 1
    RETURN 1;
END IF;
RETURN 0;
END;`);
            const issues = ruleNZP013.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP013');
        });
    });

    describe('NZP014 - Unconditional EXIT', () => {
        it('flags EXIT without WHEN', () => {
            const sql = buildProcedure(`BEGIN
LOOP
    EXIT;
END LOOP;
RETURN 1;
END;`);
            const issues = ruleNZP014.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP014');
        });

        it('does not flag EXIT WHEN', () => {
            const sql = buildProcedure(`BEGIN
LOOP
    EXIT WHEN p_id > 10;
END LOOP;
RETURN 1;
END;`);
            expect(ruleNZP014.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP015 - Parameter naming convention', () => {
        it('flags parameter without expected prefix', () => {
            const sql = buildProcedure('RETURN 1;', 'value INTEGER');
            const issues = ruleNZP015.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].message).toContain('value');
        });

        it('accepts prefixed parameter names', () => {
            const sql = buildProcedure('RETURN 1;', 'p_value INTEGER, in_flag BOOLEAN');
            expect(ruleNZP015.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP016 - Variable naming convention', () => {
        it('flags variable without v_ prefix', () => {
            const sql = buildProcedure(`DECLARE
counter INTEGER;
BEGIN
counter := 1;
RETURN counter;
END;`);
            const issues = ruleNZP016.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].message).toContain('counter');
        });

        it('accepts v_ prefixed variables', () => {
            const sql = buildProcedure(`DECLARE
v_counter INTEGER;
BEGIN
v_counter := 1;
RETURN v_counter;
END;`);
            expect(ruleNZP016.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP017 - CASE matching', () => {
        it('flags unmatched CASE', () => {
            const sql = buildProcedure(`SELECT CASE WHEN 1 = 1 THEN 1;
RETURN 1;`);
            const issues = ruleNZP017.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP017');
        });

        it('accepts matched CASE ... END', () => {
            const sql = buildProcedure(`SELECT CASE WHEN 1 = 1 THEN 1 END;
RETURN 1;`);
            expect(ruleNZP017.check(sql)).toHaveLength(0);
        });

        it('does not treat procedural BEGIN...END as CASE terminator', () => {
            const sql = buildProcedure(`BEGIN
SELECT CASE WHEN 1 = 1 THEN 1;
RETURN 1;
END;`);
            const issues = ruleNZP017.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP017');
        });

        it('accepts CASE END AS in CTAS', () => {
            const sql = buildProcedure(`BEGIN
CREATE TEMP TABLE tt AS (
    SELECT CASE WHEN 1 = 2 THEN 1 ELSE 0 END AS col2 FROM t
);
RETURN 1;
END;`);
            expect(ruleNZP017.check(sql)).toHaveLength(0);
        });
    });

    describe('string-body procedure extraction', () => {
        it('runs NZP024 on AS string body procedures', () => {
            const sql = `CREATE OR REPLACE PROCEDURE test_proc()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
RETURN 1;
END;';`;
            expect(ruleNZP024.check(sql)).toHaveLength(0);
        });

        it('defers missing RETURN in parseable string-body to SQL038', () => {
            const sql = `CREATE OR REPLACE PROCEDURE test_proc()
RETURNS INT4
LANGUAGE NZPLSQL AS
'BEGIN
SELECT 1;
END;';`;
            expect(ruleNZP024.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP018 - SQL injection risk', () => {
        it('flags EXECUTE IMMEDIATE with concatenation', () => {
            const sql = buildProcedure(
                `EXECUTE IMMEDIATE 'SELECT * FROM ' || p_table;
RETURN 1;`,
                'p_table VARCHAR'
            );
            const issues = ruleNZP018.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP018');
        });

        it('accepts EXECUTE IMMEDIATE with USING clause', () => {
            const sql = buildProcedure(
                `EXECUTE IMMEDIATE 'SELECT * FROM t WHERE id = ?' USING p_id;
RETURN 1;`
            );
            expect(ruleNZP018.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP019 - Default for optional params', () => {
        it('flags missing DEFAULT on last parameter', () => {
            const sql = buildProcedure('RETURN 1;', 'p_id INTEGER, p_name VARCHAR');
            const issues = ruleNZP019.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP019');
        });

        it('accepts DEFAULT on last parameter', () => {
            const sql = buildProcedure('RETURN 1;', `p_id INTEGER, p_name VARCHAR DEFAULT 'x'`);
            expect(ruleNZP019.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP020 - Implicit type conversion', () => {
        it('flags implicit string/number concatenation pattern', () => {
            const sql = buildProcedure(`v_sql := VARCHAR || 100;
RETURN 1;`);
            const issues = ruleNZP020.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP020');
        });

        it('does not flag explicit CAST usage', () => {
            const sql = buildProcedure(`v_sql := CAST(100 AS VARCHAR) || 'x';
RETURN 1;`);
            expect(ruleNZP020.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP022 - OUT parameter assignment', () => {
        it('flags OUT parameter that is never assigned when parse fails', () => {
            const sql = `${buildProcedure('RETURN 1;', 'OUT out_value INTEGER')}
@@@`;
            const issues = ruleNZP022.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP022');
        });

        it('accepts OUT parameter assignment', () => {
            const sql = buildProcedure(`out_value := 10;
RETURN 1;`, 'OUT out_value INTEGER');
            expect(ruleNZP022.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP023 - Cursor close checks (deprecated)', () => {
        it('does not flag OPEN without CLOSE (NZPLSQL uses FOR ... IN SELECT)', () => {
            const sql = buildProcedure(`OPEN cur_1;
RETURN 1;`);
            expect(ruleNZP023.check(sql)).toHaveLength(0);
        });

        it('remains a no-op for OPEN/CLOSE pairs', () => {
            const sql = buildProcedure(`OPEN cur_1;
CLOSE cur_1;
RETURN 1;`);
            expect(ruleNZP023.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP024 - Missing RETURN', () => {
        it('flags procedure with RETURNS but no RETURN when parse fails', () => {
            const sql = `${buildProcedure('SELECT 1;')}
-- force parse failure for regex fallback
@@@`;
            const issues = ruleNZP024.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP024');
        });

        it('does not flag procedure without RETURNS clause', () => {
            const sql = buildProcedure('SELECT 1;', 'p_id INTEGER', undefined, '');
            expect(ruleNZP024.check(sql)).toHaveLength(0);
        });

        it('does not flag parseable dynamic NZPLSQL wrapper with RETURN', () => {
            const sql = `CREATE OR REPLACE PROCEDURE exec_nzplsql_block(text) RETURNS BOOLEAN
LANGUAGE NZPLSQL AS
BEGIN_PROC
    DECLARE lRet BOOLEAN;
    DECLARE sid INTEGER;
    DECLARE nm varchar;
    DECLARE cr varchar;
BEGIN
    sid := current_sid;
    nm := 'any_block' || sid || '()';
    cr = 'CREATE OR REPLACE PROCEDURE ' || nm ||
        ' RETURNS BOOL LANGUAGE NZPLSQL AS BEGIN_PROC '
        || $1 || ' END_PROC';
    EXECUTE IMMEDIATE cr;
    EXECUTE IMMEDIATE 'SELECT ' || nm;
    EXECUTE IMMEDIATE 'DROP PROCEDURE ' || nm;
    RETURN TRUE;
END;
END_PROC;`;

            expect(ruleNZP024.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP025 - Transaction control in procedure', () => {
        it('flags COMMIT inside procedure', () => {
            const sql = buildProcedure(`COMMIT;
RETURN 1;`);
            const issues = ruleNZP025.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].message).toContain('COMMIT');
        });

        it('does not flag ROLLBACK TO SAVEPOINT', () => {
            const sql = buildProcedure(`ROLLBACK TO SAVEPOINT sp1;
RETURN 1;`);
            expect(ruleNZP025.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP026 - Prefer PERFORM', () => {
        it('flags SELECT function call without INTO', () => {
            const sql = buildProcedure(`SELECT do_work();
RETURN 1;`);
            const issues = ruleNZP026.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP026');
        });

        it('does not flag SELECT ... INTO function call', () => {
            const sql = buildProcedure(`SELECT do_work() INTO v_result;
RETURN 1;`);
            expect(ruleNZP026.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP027 - EXECUTE AS clause', () => {
        it('flags missing EXECUTE AS clause', () => {
            const sql = buildProcedure('RETURN 1;');
            const issues = ruleNZP027.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP027');
        });

        it('does not flag when EXECUTE AS is present', () => {
            const sql = buildProcedure('RETURN 1;', 'p_id INTEGER', 'CALLER');
            expect(ruleNZP027.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP028 - VARRAY EXTEND', () => {
        it('flags VARRAY assignment without EXTEND', () => {
            const sql = buildProcedure(`DECLARE
v_arr VARRAY;
BEGIN
v_arr(1) := 10;
RETURN 1;
END;`);
            const issues = ruleNZP028.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP028');
        });

        it('does not flag VARRAY assignment with EXTEND', () => {
            const sql = buildProcedure(`DECLARE
v_arr VARRAY;
BEGIN
v_arr.EXTEND(1);
v_arr(1) := 10;
RETURN 1;
END;`);
            expect(ruleNZP028.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP029 - Deep exception nesting', () => {
        it('flags very deep BEGIN nesting', () => {
            const sql = buildProcedure(`BEGIN
BEGIN
BEGIN
BEGIN
    NULL;
END;
END;
END;
END;
RETURN 1;`);
            const issues = ruleNZP029.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].ruleId).toBe('NZP029');
        });

        it('does not flag shallow nesting', () => {
            const sql = buildProcedure(`BEGIN
BEGIN
    NULL;
END;
END;
RETURN 1;`);
            expect(ruleNZP029.check(sql)).toHaveLength(0);
        });
    });

    describe('NZP030 - Named exception recommendation', () => {
        it('flags SQLSTATE that has a named exception', () => {
            const sql = buildProcedure(`BEGIN
NULL;
EXCEPTION
    WHEN SQLSTATE '02000' THEN
        RETURN 0;
END;`);
            const issues = ruleNZP030.check(sql);
            expect(issues).toHaveLength(1);
            expect(issues[0].message).toContain('NO_DATA_FOUND');
        });

        it('does not flag unknown SQLSTATE values', () => {
            const sql = buildProcedure(`BEGIN
NULL;
EXCEPTION
    WHEN SQLSTATE '99999' THEN
        RETURN 0;
END;`);
            expect(ruleNZP030.check(sql)).toHaveLength(0);
        });
    });

    describe('public helpers', () => {
        it('lintNetezzaProcedure returns issues sorted by offset', () => {
            const sql = buildProcedure(`SELECT do_work();
COMMIT;`);
            const issues = lintNetezzaProcedure(sql);
            expect(issues.length).toBeGreaterThan(1);
            for (let i = 1; i < issues.length; i++) {
                expect(issues[i].startOffset).toBeGreaterThanOrEqual(issues[i - 1].startOffset);
            }
        });

        it('getProcedureRuleById returns rule or undefined', () => {
            expect(getProcedureRuleById('NZP030')?.id).toBe('NZP030');
            expect(getProcedureRuleById('NZP999')).toBeUndefined();
        });

        it('procedureRules contains unique identifiers', () => {
            const ids = procedureRules.map(rule => rule.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toContain('NZP014');
            expect(ids).toContain('NZP030');
        });

        it('marks procedure style and heuristic rules as on-demand only', () => {
            const onDemandIds = procedureRules
                .filter(rule => rule.onDemandOnly)
                .map(rule => rule.id);

            expect(onDemandIds).toEqual(expect.arrayContaining([
                'NZP007',
                'NZP009',
                'NZP014',
                'NZP015',
                'NZP016',
                'NZP018',
                'NZP019',
                'NZP020',
                'NZP025',
                'NZP026',
                'NZP027',
                'NZP028',
                'NZP029',
                'NZP030',
            ]));
        });

        it('lintNetezzaProcedure parses procedure gate once per pass', () => {
            const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
            const sql = buildProcedure(`BEGIN
RETURN 1;
END;`);

            lintNetezzaProcedure(sql);

            expect(parseSpy).toHaveBeenCalledTimes(1);
            parseSpy.mockRestore();
        });
    });
});
