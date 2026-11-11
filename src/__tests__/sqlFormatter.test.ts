import { formatNetezzaSql, formatSqlWithProfile, findProtectedFormatRanges } from '@justybase/sql-core';
import { getDatabaseSqlAuthoring } from '../core/sqlAuthoringRegistry';
import { formatSql } from '../services/sqlFormatting';

describe('sqlFormatter', () => {
    it('formats SELECT lists and keeps Netezza DB..TABLE notation', () => {
        const input = 'select a,b,c from JUST_DATA..DIMACCOUNT';
        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    a,',
                '    b,',
                '    c',
                'FROM JUST_DATA..DIMACCOUNT'
            ].join('\n')
        );
    });

    it('preserves comments and string literals exactly', () => {
        const input = "select col -- keep this comment\nfrom t where name = 'A  B' /*block comment*/";
        const output = formatSql(input, { keywordCase: 'upper' });

        expect(output).toContain('-- keep this comment');
        expect(output).toContain('/*block comment*/');
        expect(output).toContain("'A  B'");
    });

    it('supports configurable keyword case', () => {
        const input = 'select id from t where id=1';
        const upper = formatSql(input, { keywordCase: 'upper' });
        const lower = formatSql(input, { keywordCase: 'lower' });
        const preserve = formatSql(input, { keywordCase: 'preserve' });

        expect(upper).toContain('SELECT');
        expect(upper).toContain('FROM');
        expect(lower).toContain('select');
        expect(lower).toContain('from');
        expect(preserve).toContain('select');
    });

    it('respects linesBetweenQueries option', () => {
        const input = 'select 1; select 2;';
        const output = formatSql(input, { keywordCase: 'upper', linesBetweenQueries: 2 });

        expect(output).toMatch(/1;\n\nSELECT/);
        expect(output).toContain('2;');
    });

    it('formats CTEs (WITH clauses) correctly', () => {
        const input = 'WITH cte AS (select id from table1) select * from cte';
        const output = formatSql(input, { keywordCase: 'upper', tabWidth: 4 });

        expect(output).toBe(
            [
                'WITH cte AS',
                '(',
                '    SELECT id',
                '    FROM table1',
                ')',
                '',
                'SELECT',
                '    *',
                'FROM cte'
            ].join('\n')
        );
    });

    it('formats multiple CTEs with leading commas and blank lines', () => {
        const input = [
            'WITH CTE1 AS (SELECT 1 AS COL FROM JUST_DATA..DEPARTMENT),',
            'CTE2 AS (SELECT 1 AS COL FROM JUST_DATA..DEPARTMENT)',
            'SELECT * FROM CTE1 JOIN CTE2 ON 1 = 1'
        ].join(' ');

        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'WITH CTE1 AS',
                '(',
                '    SELECT 1 AS COL',
                '    FROM JUST_DATA..DEPARTMENT',
                ')',
                '',
                ',CTE2 AS',
                '(',
                '    SELECT 1 AS COL',
                '    FROM JUST_DATA..DEPARTMENT',
                ')',
                '',
                'SELECT',
                '    *',
                'FROM CTE1',
                'JOIN CTE2 ON 1 = 1'
            ].join('\n')
        );
    });

    it('formats LIMIT on a new line after WHERE', () => {
        const input = 'SELECT * FROM JUST_DATA_4..DIMACCOUNT_CPY_0109 X WHERE X.COL1 > 0 LIMIT 500';
        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    *',
                'FROM JUST_DATA_4..DIMACCOUNT_CPY_0109 X',
                'WHERE',
                '    X.COL1 > 0',
                'LIMIT 500'
            ].join('\n')
        );
    });

    it('formats GROUP BY, HAVING, and LIMIT on separate lines', () => {
        const input = 'SELECT col, COUNT(1) AS cnt FROM t WHERE col > 0 GROUP BY col HAVING COUNT(1) > 1 LIMIT 100';
        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    col,',
                '    COUNT(1) AS cnt',
                'FROM t',
                'WHERE',
                '    col > 0',
                'GROUP BY',
                '    col',
                'HAVING',
                '    COUNT(1) > 1',
                'LIMIT 100'
            ].join('\n')
        );
    });

    it('formats nested subqueries correctly', () => {
        const input = 'select id from (select id, name from users where age > 18) sub where sub.name = \'test\'';
        const output = formatSql(input, { keywordCase: 'upper', tabWidth: 4 });

        expect(output).toBe(
            [
                'SELECT',
                '    id',
                'FROM (',
                '    SELECT',
                '        id,',
                '        name',
                '    FROM users',
                '    WHERE',
                '        age > 18) sub',
                'WHERE',
                '    sub.name = \'test\''
            ].join('\n')
        );
    });

    it('formats CASE expressions correctly', () => {
        const input = 'select case when id = 1 then \'a\' else \'b\' end as val from t';
        const output = formatSql(input, { keywordCase: 'upper', tabWidth: 4 });

        expect(output).toBe(
            [
                'SELECT',
                '    CASE',
                '        WHEN id = 1 THEN \'a\'',
                '        ELSE \'b\'',
                '    END AS val',
                'FROM t'
            ].join('\n')
        );
    });

    it('handles unterminated strings gracefully', () => {
        const input = 'select id from t where name = \'unterminated';
        const output = formatSql(input, { keywordCase: 'upper', tabWidth: 4 });

        expect(output).toBe(
            [
                'SELECT',
                '    id',
                'FROM t',
                'WHERE',
                '    name = \'unterminated'
            ].join('\n')
        );
    });

    it('formats LEFT JOIN with inline ON and indented AND', () => {
        const input = [
            'SELECT D.CALENDARSEMESTER',
            'FROM JUST_DATA..DIMDATE D',
            'LEFT JOIN JUST_DATA..DIMDATE D1 ON D.DATEKEY = D1.DATEKEY AND D.CALENDARYEAR = D1.CALENDARYEAR'
        ].join(' ');

        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    D.CALENDARSEMESTER',
                'FROM JUST_DATA..DIMDATE D',
                'LEFT JOIN JUST_DATA..DIMDATE D1 ON D.DATEKEY = D1.DATEKEY',
                '    AND D.CALENDARYEAR = D1.CALENDARYEAR'
            ].join('\n')
        );
    });

    it('keeps LEFT OUTER JOIN prefix on one line', () => {
        const input = 'select a from t1 left outer join t2 on t1.id = t2.id';
        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    a',
                'FROM t1',
                'LEFT OUTER JOIN t2 ON t1.id = t2.id'
            ].join('\n')
        );
    });

    it('formats multiple JOINs before WHERE', () => {
        const input = 'select a from t1 left join t2 on t1.id = t2.id inner join t3 on t2.id = t3.id where a = 1';
        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    a',
                'FROM t1',
                'LEFT JOIN t2 ON t1.id = t2.id',
                'INNER JOIN t3 ON t2.id = t3.id',
                'WHERE',
                '    a = 1'
            ].join('\n')
        );
    });

    it('does not treat LEFT() function as a JOIN chain', () => {
        const input = 'select left(name, 3) from t';
        const output = formatSql(input, { tabWidth: 4, keywordCase: 'preserve' });

        expect(output).toBe(
            [
                'select',
                '    left(name, 3)',
                'from t'
            ].join('\n')
        );
    });

    it('keeps SELECT list columns on separate lines after function calls', () => {
        const input = [
            'SELECT oi.product_id, date_trunc(\'month\', o.order_date) AS order_month,',
            'oi.product_id, p.category_name, oi.quantity FROM dim_customer c'
        ].join(' ');

        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    oi.product_id,',
                '    date_trunc(\'month\', o.order_date) AS order_month,',
                '    oi.product_id,',
                '    p.category_name,',
                '    oi.quantity',
                'FROM dim_customer c'
            ].join('\n')
        );
    });

    it('keeps SELECT list columns on separate lines after window functions', () => {
        const input = [
            'SELECT customer_id, ROW_NUMBER() OVER (PARTITION BY order_month ORDER BY total_net_amount DESC) AS rn,',
            'SUM(total_net_amount) OVER (PARTITION BY customer_id ORDER BY order_month) AS running_total',
            'FROM monthly_customer_sales'
        ].join(' ');

        const output = formatSql(input, { tabWidth: 4, keywordCase: 'upper' });

        expect(output).toBe(
            [
                'SELECT',
                '    customer_id,',
                '    ROW_NUMBER() OVER (PARTITION BY order_month ORDER BY total_net_amount DESC) AS rn,',
                '    SUM(total_net_amount) OVER (PARTITION BY customer_id ORDER BY order_month) AS running_total',
                'FROM monthly_customer_sales'
            ].join('\n')
        );
    });
});

describe('sqlFormatting delegation parity with @justybase/sql-core', () => {
    const sql = 'select a,b from t where x=1';
    const options = { tabWidth: 4, keywordCase: 'upper' as const, linesBetweenQueries: 2 };

    it('routes netezza and unknown kinds through the shared Netezza formatter', () => {
        const expected = formatNetezzaSql(sql, options);
        expect(formatSql(sql, options)).toBe(expected);
        expect(formatSql(sql, { ...options, databaseKind: 'netezza' })).toBe(expected);
    });

    it.each([
        'postgresql',
        'mysql',
        'mssql',
        'oracle',
        'db2',
        'sqlite',
        'duckdb',
        'vertica',
        'snowflake',
        'clickhouse',
        'access',
        'file',
    ] as const)('delegates %s to the shared formatter with its registered profile', kind => {
        const profile = getDatabaseSqlAuthoring(kind).formatter;
        expect(formatSql(sql, { ...options, databaseKind: kind })).toBe(
            formatSqlWithProfile(sql, profile, options),
        );
    });
});

describe('formatting protection for non-reformattable statements', () => {
    const options = { tabWidth: 4, keywordCase: 'upper' as const, linesBetweenQueries: 2 };

    it('keeps a quoted NZPLSQL procedure body byte-for-byte', () => {
        const procedure = [
            'create or replace procedure ADMIN.P_TEST(v_id int)',
            'returns int',
            'language NZPLSQL',
            'as',
            "'BEGIN_PROC",
            'DECLARE',
            '    l_count integer;',
            'BEGIN',
            "    select count(*) into l_count from ADMIN.DIMACCOUNT where id = v_id;",
            '    RETURN l_count;',
            'END;',
            "END_PROC;'",
        ].join('\n');
        const sql = `select 1 from t;\n${procedure}\nselect 2 from t;`;

        const output = formatSql(sql, options);

        expect(output).toContain(procedure);
        expect(output).toContain('SELECT');
    });

    it('keeps an unquoted BEGIN_PROC body with inner semicolons intact', () => {
        const procedure = [
            'CREATE OR REPLACE PROCEDURE p()',
            'RETURNS INT',
            'LANGUAGE NZPLSQL',
            'AS BEGIN_PROC',
            'DECLARE a INT;',
            'BEGIN',
            '  a := 1;',
            '  RETURN a;',
            'END;',
            'END_PROC',
        ].join('\n');

        const output = formatSql(`-- leading comment\n${procedure}\nSELECT 1 FROM dual;`, options);

        expect(output).toContain(procedure);
    });

    it('keeps external table DDL unchanged', () => {
        const ddl = [
            'create external table admin.ext (id int, name varchar(10))',
            "USING (DATAOBJECT ('/data/ext' ) DELIMITER ',' QUOTEDVALUE 'DOUBLE' ESCAPECHAR '\\')",
        ].join('\n');

        const output = formatSql(`create external table admin.ext (id int, name varchar(10))\nUSING (DATAOBJECT ('/data/ext' ) DELIMITER ',' QUOTEDVALUE 'DOUBLE' ESCAPECHAR '\\');\nselect * from admin.ext;`, options);

        expect(output).toContain(ddl);
    });

    it('keeps dollar-quoted function bodies and inline literals unchanged', () => {
        const fn = [
            'create function f() returns int as $$',
            'declare x int;',
            'begin',
            '  x := 1;',
            '  return x;',
            'end;',
            '$$ language plpgsql;',
        ].join('\n');

        const output = formatSql(`select $tag$ a  b $tag$ as v;\n${fn}\nselect 2;`, options);

        expect(output).toContain('$tag$ a  b $tag$');
        expect(output).toContain(fn);
    });

    it('formats ordinary statements that only mention external words', () => {
        const output = formatSql('select external_id, name from ext_objects where external_id = 1', options);

        expect(output).toContain('SELECT');
        expect(output).toContain('FROM ext_objects');
        expect(output).toContain('external_id = 1');
        expect(output).not.toContain('select external_id');
    });

    it('reports protected ranges with their reason', () => {
        const sql = "select 1;\nselect $$body$$;\ncreate external table x (a int) using (dataobject ('/y'));";
        const ranges = findProtectedFormatRanges(sql);

        expect(ranges.map(range => range.reason)).toEqual(['dollarQuoted', 'externalTable']);
        expect(sql.slice(ranges[0].start, ranges[0].end)).toContain('$$body$$');
    });

    it('does not treat a string literal containing BEGIN_PROC as protected', () => {
        const ranges = findProtectedFormatRanges("select 'BEGIN_PROC' as note from t");

        expect(ranges).toEqual([]);
    });

    it('is idempotent when a string literal contains parentheses', () => {
        const once = formatSql("select ')' as a, b from t", options);
        const twice = formatSql(once, options);

        expect(twice).toBe(once);
        expect(once).toContain("')' AS a");
    });
});
