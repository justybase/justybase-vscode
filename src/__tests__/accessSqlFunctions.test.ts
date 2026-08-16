import { translateAccessFunctions } from '../../extensions/access/src/accessSqlFunctions';

describe('accessSqlFunctions', () => {
    it('rewrites simple string functions', () => {
        expect(translateAccessFunctions('UCASE(name)')).toBe('upper(name)');
        expect(translateAccessFunctions('lcase(name)')).toBe('lower(name)');
        expect(translateAccessFunctions('trim(name)')).toBe('trim(name)');
        expect(translateAccessFunctions('Len(name)')).toBe('length(name)');
        expect(translateAccessFunctions('Left(name, 3)')).toBe('left(name, 3)');
        expect(translateAccessFunctions('RIGHT(name, 2)')).toBe('right(name, 2)');
        expect(translateAccessFunctions('MID(name, 2, 3)')).toBe('substr(name, 2, 3)');
        expect(translateAccessFunctions('Mid(name, 2)')).toBe('substr(name, 2)');
        expect(translateAccessFunctions('InStr(name, "x")')).toBe('instr(name, "x")');
        expect(translateAccessFunctions('strReverse(name)')).toBe('reverse(name)');
        expect(translateAccessFunctions('Chr(65)')).toBe('chr(65)');
        expect(translateAccessFunctions('Space(3)')).toBe("repeat(' ', 3)");
    });

    it('rewrites numeric and date functions', () => {
        expect(translateAccessFunctions('Abs(x)')).toBe('abs(x)');
        expect(translateAccessFunctions('Sqr(x)')).toBe('sqrt(x)');
        expect(translateAccessFunctions('Int(x)')).toBe('floor(x)');
        expect(translateAccessFunctions('Fix(x)')).toBe('trunc(x)');
        expect(translateAccessFunctions('Year(d)')).toBe('year(d)');
        expect(translateAccessFunctions('Month(d)')).toBe('month(d)');
        expect(translateAccessFunctions('Day(d)')).toBe('day(d)');
        expect(translateAccessFunctions('Now()')).toBe('now()');
        expect(translateAccessFunctions('Date()')).toBe('current_date');
        expect(translateAccessFunctions('DateAdd("d", 5, d)')).toBe("(d) + INTERVAL (5) day");
        expect(translateAccessFunctions('DateDiff("yyyy", d1, d2)')).toBe("date_diff('year', d1, d2)");
        expect(translateAccessFunctions('DatePart("q", d)')).toBe("date_part('quarter', d)");
    });

    it('uses Access weekday numbering and interval semantics', () => {
        expect(translateAccessFunctions('Weekday(d)')).toBe('(dayofweek(d) + 1)');
        expect(translateAccessFunctions('Weekday(d, 2)')).toContain('dayofweek(d) - ((CASE WHEN CAST(2 AS INTEGER) = 0');
        expect(translateAccessFunctions('DatePart("w", d)')).toBe("(date_part('dayofweek', d) + 1)");
        expect(translateAccessFunctions('DateAdd("w", 1, d)')).toBe('(d) + INTERVAL (1) day');
    });

    it('repeats the Access String character argument', () => {
        const translated = translateAccessFunctions('String(5, "A")');
        expect(translated).toContain('repeat(CASE WHEN typeof("A")');
        expect(translated).toContain('END, 5)');
        expect(translated).not.toContain('repeat(chr(5)');
    });

    it('reverses the search text for InStrRev', () => {
        expect(translateAccessFunctions('InStrRev("abcabc", "bc")'))
            .toBe('length("abcabc") - instr(reverse("abcabc"), reverse("bc")) - length("bc") + 2');
    });

    it('rewrites conditional and null functions', () => {
        expect(translateAccessFunctions('IIF(a > 1, 10, 20)')).toBe('if(a > 1, 10, 20)');
        expect(translateAccessFunctions('IIf(a, 1)')).toBe('if(a, 1, NULL)');
        expect(translateAccessFunctions('NZ(x)')).toBe("coalesce(x, '')");
        expect(translateAccessFunctions('Nz(x, 0)')).toBe('coalesce(x, 0)');
        expect(translateAccessFunctions('IsNull(x)')).toBe('(x) IS NULL');
        expect(translateAccessFunctions('IsDate(x)')).toBe('try_cast(x AS TIMESTAMP) IS NOT NULL');
    });

    it('leaves non-Access functions untouched', () => {
        expect(translateAccessFunctions('COUNT(*)')).toBe('count(*)');
        expect(translateAccessFunctions('SUM(x)')).toBe('sum(x)');
        expect(translateAccessFunctions('AVG(x)')).toBe('avg(x)');
        expect(translateAccessFunctions('MIN(x)')).toBe('min(x)');
        expect(translateAccessFunctions('MAX(x)')).toBe('max(x)');
        expect(translateAccessFunctions('substr(x, 1, 2)')).toBe('substr(x, 1, 2)');
    });

    it('handles nested function calls', () => {
        expect(translateAccessFunctions('IIF(IsNull(x), 0, Len(x))')).toBe('if((x) IS NULL, 0, length(x))');
        expect(translateAccessFunctions('Nz(Trim(name), "?")')).toBe('coalesce(trim(name), "?")');
    });

    it('does not touch function-like text inside string literals', () => {
        // literals are protected before this stage in the real pipeline;
        // here we verify the expansion does not break on quotes
        expect(translateAccessFunctions('Left(name, InStr(name, "(") - 1)')).toBe('left(name, instr(name, "(") - 1)');
    });

    it('does not use a marker that can collide with an identifier', () => {
        expect(translateAccessFunctions('left__JB__(name)')).toBe('left__JB__(name)');
    });
});
