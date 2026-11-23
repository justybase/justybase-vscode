import {
    buildAccessCheckConstraints,
    buildAccessZeroLengthCheck,
    translateAccessValidationRule,
} from '../../extensions/access/src/accessValidationRules';

describe('translateAccessValidationRule', () => {
    it('translates implicit-operand rules against the owning column', () => {
        expect(translateAccessValidationRule('>0', { columnName: 'num', columnNames: ['num'] }))
            .toBe('("num" > 0)');
        expect(translateAccessValidationRule('Between 1 And 100', { columnName: 'num', columnNames: ['num'] }))
            .toBe('("num" BETWEEN 1 AND 100)');
        expect(translateAccessValidationRule('In (1,2,3)', { columnName: 'num', columnNames: ['num'] }))
            .toBe('("num" IN (1, 2, 3))');
    });

    it('translates explicit Access rules with bracketed identifiers', () => {
        expect(translateAccessValidationRule('Is Null Or [num] > 3', { columnName: 'num', columnNames: ['num'] }))
            .toBe('(("num" IS NULL) OR ("num" > 3))');
        expect(translateAccessValidationRule('Not ([num] = 7)', { columnNames: ['num'] }))
            .toBe('(NOT (("num" = 7)))');
        // Verified against DAO: Access SQL treats "a1" as a string literal, so
        // this rule evaluates a text-to-number cast and always fails.  Only
        // bracketed names address a column.
        expect(translateAccessValidationRule('CLng("a1")>2', { columnNames: ['a1'] }))
            .toBe("(CAST('a1' AS BIGINT) > 2)");
    });

    it('translates cast helpers, boolean literals and IS [NOT] NULL', () => {
        expect(translateAccessValidationRule('CInt([n]) >= 1', { columnNames: ['n'] }))
            .toBe('(CAST("n" AS SMALLINT) >= 1)');
        expect(translateAccessValidationRule('[flag] = True', { columnNames: ['flag'] }))
            .toBe('("flag" = TRUE)');
        expect(translateAccessValidationRule('IsNull([n]) Or [n] > 0', { columnNames: ['n'] }))
            .toBe('(("n" IS NULL) OR ("n" > 0))');
        expect(translateAccessValidationRule('[n] Is Not Null', { columnNames: ['n'] }))
            .toBe('("n" IS NOT NULL)');
    });

    it('keeps double quotes as the string literals Access evaluates them as', () => {
        // DAO rejects every value for `CLng("a1")>2` because Access casts the
        // text "a1" instead of the column; the translation must keep that.
        expect(translateAccessValidationRule('[code] <> "x"', { columnNames: ['code'] }))
            .toBe('("code" <> \'x\')');
    });

    it('translates conjunctions and parenthesised rules', () => {
        expect(translateAccessValidationRule('[num] > 0 And [num] < 10', { columnNames: ['num'] }))
            .toBe('(("num" > 0) AND ("num" < 10))');
        expect(translateAccessValidationRule('([num] > 0)', { columnNames: ['num'] }))
            .toBe('(("num" > 0))');
    });

    it('refuses rules outside the supported subset instead of guessing', () => {
        expect(translateAccessValidationRule(undefined)).toBeUndefined();
        expect(translateAccessValidationRule('')).toBeUndefined();
        expect(translateAccessValidationRule('DLookup("x", "t") <> "y"', { columnNames: ['x'] }))
            .toBeUndefined();
        expect(translateAccessValidationRule('[a] Like "x*"', { columnNames: ['a'] }))
            .toBeUndefined();
        expect(translateAccessValidationRule('Len([a]) > 0', { columnNames: ['a'] }))
            .toBeUndefined();
        // A bracketed name that is not a column of this table cannot be
        // translated: it may reference another table or a VBA-only field,
        // and turning it into a literal would enforce the wrong rule.
        expect(translateAccessValidationRule('[other] > 0', { columnName: 'num', columnNames: ['num'] }))
            .toBeUndefined();
    });
});

describe('buildAccessCheckConstraints', () => {
    it('collects column and table rules', () => {
        expect(buildAccessCheckConstraints(
            [
                { name: 'num', validationRule: '>0' },
                { name: 'code' },
                { name: 'plain', validationRule: 'Is Null Or [plain] > 3' },
            ],
            'Not ([num] = 7)',
        )).toEqual([
            '("num" > 0)',
            '(("plain" IS NULL) OR ("plain" > 3))',
            '(NOT (("num" = 7)))',
        ]);
    });

    it('returns no clauses when nothing is translatable', () => {
        expect(buildAccessCheckConstraints([{ name: 'a', validationRule: 'DLookup("x","t")' }], undefined))
            .toEqual([]);
    });
});

describe('buildAccessZeroLengthCheck', () => {
    it('rejects empty strings while leaving NULL alone', () => {
        expect(buildAccessZeroLengthCheck('code')).toBe('("code" <> \'\')');
    });
});
