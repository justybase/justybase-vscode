import { translateAccessSql } from '../../extensions/access/src/accessDuckDbMirror';
import { serializeAccessComplexValue } from '../../packages/access-file/src/complexValues';

describe('translateAccessSql (Faza 3)', () => {
    it('rewrites DISTINCTROW and IIF/NZ', () => {
        expect(translateAccessSql('SELECT DISTINCTROW x FROM t')).toBe('SELECT DISTINCT x FROM t');
        expect(translateAccessSql('SELECT IIF(a>1, 1, 0) FROM t')).toBe('SELECT if(a>1, 1, 0) FROM t');
        expect(translateAccessSql('SELECT NZ(a, 0) FROM t')).toBe('SELECT coalesce(a, 0) FROM t');
    });

    it('translates VBA string functions', () => {
        expect(translateAccessSql("SELECT UCASE(name) FROM t")).toBe("SELECT upper(name) FROM t");
        expect(translateAccessSql("SELECT MID(name, 2, 3) FROM t")).toBe("SELECT substr(name, 2, 3) FROM t");
        expect(translateAccessSql("SELECT LEN(name) FROM t")).toBe("SELECT length(name) FROM t");
        expect(translateAccessSql("SELECT TRIM(name) FROM t")).toBe("SELECT trim(name) FROM t");
    });

    it('translates date functions and serial arithmetic', () => {
        expect(translateAccessSql("SELECT YEAR(d) FROM t")).toBe("SELECT year(d) FROM t");
        expect(translateAccessSql('SELECT DateAdd("d", 5, d) FROM t')).toBe("SELECT (d) + INTERVAL (5) day FROM t");
        expect(translateAccessSql('SELECT DateDiff("yyyy", d1, d2) FROM t')).toBe("SELECT date_diff('year', d1, d2) FROM t");
    });

    it('translates & concatenation to NULL-safe concat()', () => {
        expect(translateAccessSql("SELECT a & b FROM t")).toBe("SELECT concat(a, b) FROM t");
        expect(translateAccessSql("SELECT 'x' & name & 'y' FROM t")).toBe("SELECT concat('x', name, 'y') FROM t");
        expect(translateAccessSql("SELECT a & 5 FROM t")).toBe("SELECT concat(a, 5) FROM t");
    });

    it('translates ampersands whose operands are arbitrary expressions', () => {
        expect(translateAccessSql("SELECT upper(name) & '!' FROM t")).toBe("SELECT concat(upper(name), '!') FROM t");
        expect(translateAccessSql('SELECT (a + b) & c FROM t')).toBe('SELECT concat((a + b), c) FROM t');
    });

    it('keeps numeric addition and makes mixed Access + expressions nullable instead of bind errors', () => {
        expect(translateAccessSql('SELECT 1 + 2 FROM t')).toBe('SELECT 1 + 2 FROM t');
        expect(translateAccessSql("SELECT name + '-' + id FROM t")).toBe("SELECT try_cast(name AS DOUBLE) + try_cast('-' AS DOUBLE) + try_cast(id AS DOUBLE) FROM t");
    });

    it('rewrites LIKE patterns with wildcards to SIMILAR TO', () => {
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE 'A*'")).toBe("SELECT * FROM t WHERE name SIMILAR TO '(?i)A.*'");
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE 'A?'")).toBe("SELECT * FROM t WHERE name SIMILAR TO '(?i)A.'");
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE '[A-Z]*'")).toBe("SELECT * FROM t WHERE name SIMILAR TO '(?i)[A-Z].*'");
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE '[!0-9]*'")).toBe("SELECT * FROM t WHERE name SIMILAR TO '(?i)[^0-9].*'");
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE '#%'")).toBe("SELECT * FROM t WHERE name SIMILAR TO '(?i)[0-9].*'");
    });

    it('keeps simple LIKE patterns as LIKE', () => {
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE 'abc'")).toBe("SELECT * FROM t WHERE name LIKE 'abc'");
        // % and _ are standard SQL wildcards, DuckDB LIKE supports them natively
        expect(translateAccessSql("SELECT * FROM t WHERE name LIKE 'ab%'")).toBe("SELECT * FROM t WHERE name LIKE 'ab%'");
    });

    it('keeps functions inside string literals intact', () => {
        expect(translateAccessSql("SELECT 'len(x)' FROM t")).toBe("SELECT 'len(x)' FROM t");
    });

    it('handles TOP', () => {
        expect(translateAccessSql('SELECT TOP 10 * FROM t')).toBe('SELECT * FROM t LIMIT 10');
    });

    it('translates date literals', () => {
        expect(translateAccessSql("SELECT * FROM t WHERE d = #2020-01-01#")).toBe("SELECT * FROM t WHERE d = TIMESTAMP '2020-01-01'");
        expect(translateAccessSql('SELECT * FROM t WHERE d = #01/20/2024 1:02:03 PM#')).toBe("SELECT * FROM t WHERE d = TIMESTAMP '2024-01-20 13:02:03'");
    });

    it('applies Access NULL ordering to simple ORDER BY clauses', () => {
        expect(translateAccessSql('SELECT a FROM t ORDER BY a')).toBe('SELECT a FROM t ORDER BY a NULLS FIRST');
        expect(translateAccessSql('SELECT a FROM t ORDER BY a DESC')).toBe('SELECT a FROM t ORDER BY a DESC NULLS LAST');
        expect(translateAccessSql('SELECT a FROM t ORDER BY a ASC, b DESC')).toBe('SELECT a FROM t ORDER BY a ASC NULLS FIRST, b DESC NULLS LAST');
        expect(translateAccessSql('SELECT a FROM t ORDER BY a NULLS LAST')).toBe('SELECT a FROM t ORDER BY a NULLS LAST');
    });

    it('leaves complex ORDER BY expressions untouched', () => {
        expect(translateAccessSql('SELECT a FROM t ORDER BY substr(a, 1, 2)')).toBe('SELECT a FROM t ORDER BY substr(a, 1, 2)');
    });

    it('strips PARAMETERS declarations', () => {
        expect(translateAccessSql('PARAMETERS [p] Long; SELECT * FROM t WHERE id = [p]')).toBe('SELECT * FROM t WHERE id = "p"');
    });

    it('rewrites TRANSFORM/PIVOT crosstab to DuckDB PIVOT', () => {
        expect(
            translateAccessSql('TRANSFORM SUM(amount) SELECT year FROM sales GROUP BY year PIVOT region'),
        ).toBe('SELECT * FROM (PIVOT (SELECT * FROM sales) ON region USING sum(amount) GROUP BY year)');
    });

    it('rewrites TRANSFORM/PIVOT with WHERE and IN list', () => {
        expect(
            translateAccessSql('TRANSFORM Sum(amount) SELECT year FROM sales WHERE year > 2019 GROUP BY year PIVOT region IN ("E", "W")'),
        ).toBe("SELECT * FROM (PIVOT (SELECT * FROM sales WHERE year > 2019) ON region IN ('E', 'W') USING sum(amount) GROUP BY year)");
    });

    it('serializes version values with the C# record property names', () => {
        const json = JSON.parse(serializeAccessComplexValue([{
            value: 'revision',
            modified: new Date('2024-01-02T03:04:05.000Z'),
        }]));
        expect(json).toEqual({
            Kind: 'version',
            Values: [{ Value: 'revision', Modified: '2024-01-02T03:04:05.000Z' }],
        });
    });
});
