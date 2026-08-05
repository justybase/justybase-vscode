import { formatInListPaste } from '../commands/inListPasteFormatter';
import { classifySqlDataType } from '../sqlParser/visitor/typeComparisonUtils';

describe('formatInListPaste', () => {
    it('formats numeric values and removes whitespace', () => {
        expect(formatInListPaste('2005 01 03\n20050104\n', { type: 'numeric' }))
            .toBe('20050103\n,20050104');
    });

    it('formats text while preserving whitespace and escaping quotes', () => {
        expect(formatInListPaste("  left  \nO'Reilly\n", { type: 'string' }))
            .toBe("'  left  '\n,'O''Reilly'");
    });

    it('formats date and timestamp as text literals', () => {
        expect(formatInListPaste('2024-01-01\n2024-01-02', { type: 'datetime' }))
            .toBe("'2024-01-01'\n,'2024-01-02'");
    });

    it('normalizes decimal comma and rejects invalid numeric data', () => {
        expect(formatInListPaste('3,14\n2,5', { type: 'numeric' })).toBe('3.14\n,2.5');
        expect(formatInListPaste('3,14\nnot-a-number', { type: 'numeric' })).toBeUndefined();
    });

    it('uses numeric fallback for unknown types', () => {
        expect(formatInListPaste('1\n2', { type: 'unknown' })).toBe('1\n,2');
        expect(formatInListPaste('1\ntext', { type: 'unknown' })).toBeUndefined();
    });

    it('converts a single-column Markdown table into values', () => {
        const table = [
            '| DATEKEY |',
            '| --- |',
            '| 2005 01 04 |',
            '| 2005 01 05 |',
            '| 2005 01 06 |',
        ].join('\n');
        expect(formatInListPaste(table, { type: 'numeric' }))
            .toBe('20050104\n,20050105\n,20050106');
    });

    it('does not convert multi-column Markdown tables', () => {
        const table = '| DATEKEY | NAME |\n| --- | --- |\n| 1 | A |\n| 2 | B |';
        expect(formatInListPaste(table, { type: 'numeric' })).toBeUndefined();
    });

    it('converts a Markdown table with one data row', () => {
        expect(formatInListPaste('| DATEKEY |\n| --- |\n| 2005 01 04 |', { type: 'numeric' }))
            .toBe('20050104');
    });

    it('classifies common cross-dialect SQL types', () => {
        expect(classifySqlDataType('INT')).toBe('numeric');
        expect(classifySqlDataType('NUMBER(10,2)')).toBe('numeric');
        expect(classifySqlDataType('VARCHAR2(20)')).toBe('string');
        expect(classifySqlDataType('DATETIME')).toBe('datetime');
        expect(classifySqlDataType('BIT')).toBe('boolean');
    });

    it('does not format single-line or tabular input', () => {
        expect(formatInListPaste('1', { type: 'numeric' })).toBeUndefined();
        expect(formatInListPaste('1\tA\n2\tB', { type: 'numeric' })).toBeUndefined();
    });
});
