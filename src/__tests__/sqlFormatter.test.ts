import { formatSql } from '../services/sqlFormatter';

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
