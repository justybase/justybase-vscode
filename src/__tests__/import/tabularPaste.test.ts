import { describeTabularPaste, detectTabularPaste } from '../../import/tabularPaste';

describe('detectTabularPaste', () => {
    it('detects an Excel-style clipboard block with consistent tabs', () => {
        const text = ['col1\tcol2', '0\t0', '1\t0', '2\t0'].join('\r\n');
        expect(detectTabularPaste(text)).toEqual({ lines: 4, columns: 2 });
        expect(describeTabularPaste({ lines: 4, columns: 2 })).toBe(
            '4 tab-separated lines with 2 columns',
        );
    });

    it('ignores trailing tabs and blank lines', () => {
        const text = 'A\tB\t\n1\t2\t\n3\t4\t\n\n';
        expect(detectTabularPaste(text)).toEqual({ lines: 3, columns: 2 });
    });

    it('rejects SQL scripts and ragged indentation', () => {
        expect(
            detectTabularPaste('SELECT 1\nFROM ADMIN.T\nWHERE ID = 1'),
        ).toBeNull();
        expect(detectTabularPaste('SELECT\t1\nFROM\tADMIN.T\nWHERE\tID = 1')).toBeNull();
        expect(detectTabularPaste('A\tB\n1\t2\t3\n4\t5')).toBeNull();
    });

    it('rejects short or single-column blocks', () => {
        expect(detectTabularPaste('A\tB\n1\t2')).toBeNull();
        expect(detectTabularPaste('A\nB\nC')).toBeNull();
        expect(detectTabularPaste('A\tB\n\n1\t2')).toBeNull();
    });
});
