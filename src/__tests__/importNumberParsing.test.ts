import {
    detectImportDecimalDelimiter,
    isDashZeroImportCell,
    mapDashZeroImportCell,
    normalizeImportNumberForDb,
    parseFormattedImportNumber,
} from '@justybase/database-utils/importNumberParsing';
import { transliterateImportHeader } from '@justybase/database-utils/importColumnNameUtils';
import { ColumnTypeChooser } from '@justybase/database-utils/importTypeMapping';
import { valueLooksLikePesel } from '@justybase/database-utils/importTypeInferenceUtils';

describe('importNumberParsing (PL/EN clipboard formats)', () => {
    describe('parseFormattedImportNumber', () => {
        it.each([
            [' 123 456,78   ', ',', '123456.78'],
            ['123 456,78', ',', '123456.78'],
            ['1.234,56', ',', '1234.56'],
            ["1'234,56", ',', '1234.56'],
            ['1’234,56', ',', '1234.56'],
            ['123,456.78', '.', '123456.78'],
            // Dual-separator cells decide per-cell by last separator,
            // even when the global delimiter disagrees.
            ['123,456.78', ',', '123456.78'],
            ['1.234,56', '.', '1234.56'],
        ])('parses %p (global %p) as %p', (raw, decimal, expected) => {
            expect(parseFormattedImportNumber(raw, decimal)?.plain).toBe(expected);
        });

        it('handles NBSP and narrow NBSP thousand separators', () => {
            expect(parseFormattedImportNumber('1 234,56', ',')?.plain).toBe('1234.56');
            expect(parseFormattedImportNumber('1 234,56', ',')?.plain).toBe('1234.56');
            expect(parseFormattedImportNumber('1 234.56', '.')?.plain).toBe('1234.56');
        });

        it.each([
            ['-123 456,78', ',', '-123456.78'],
            ['−123 456,78', ',', '-123456.78'],
            ['(123 456,78)', ',', '-123456.78'],
            ['(123,456.78)', '.', '-123456.78'],
            ['($123,456.78)', '.', '-123456.78'],
        ])('parses negative %p as %p', (raw, decimal, expected) => {
            expect(parseFormattedImportNumber(raw, decimal)?.plain).toBe(expected);
        });

        it.each([
            ['123 456,78 zł', ',', '123456.78'],
            ['123 457 zł', ',', '123457'],
            ['£123,456.78', '.', '123456.78'],
            ['$123,456.78', '.', '123456.78'],
            ['123 456,8 kg', ',', '123456.8'],
            ['123,5 tys.', ',', '123.5'],
        ])('strips currency/units from %p -> %p', (raw, decimal, expected) => {
            expect(parseFormattedImportNumber(raw, decimal)?.plain).toBe(expected);
        });

        it('keeps the display value for percents (no /100)', () => {
            expect(parseFormattedImportNumber('12,8%', ',')?.plain).toBe('12.8');
            expect(parseFormattedImportNumber('12.75%', '.')?.plain).toBe('12.75');
        });

        it.each([
            ['123 457 zł', ','],
            ['123 457 zł.', ','],
            ['$123,457', '.'],
            ['£123,456.78', '.'],
            ['123€', ','],
            ['123,457 PLN', '.'],
        ])('flags %p as currency-marked', (raw, decimal) => {
            const parsed = parseFormattedImportNumber(raw, decimal);
            expect(parsed?.wasCurrency).toBe(true);
            expect(parsed?.plain).toMatch(/^-?\d+(\.\d+)?$/);
        });

        it.each([
            ['123 456,8 kg', ','],
            ['123,5 tys.', ','],
            ['12,8%', ','],
            ['1,23E+05', ','],
        ])('does not flag %p as currency', (raw, decimal) => {
            expect(parseFormattedImportNumber(raw, decimal)?.wasCurrency).toBe(false);
        });

        it.each([
            ['1,23E+05', ',', '123000'],
            ['1.23E+05', '.', '123000'],
            ['1,23E-02', ',', '0.0123'],
        ])('expands scientific notation %p -> %p', (raw, decimal, expected) => {
            expect(parseFormattedImportNumber(raw, decimal)?.plain).toBe(expected);
        });

        it('rejects exponents that would expand without bound', () => {
            expect(parseFormattedImportNumber('1E+2147483648', '.')).toBeNull();
            expect(parseFormattedImportNumber('1E-2147483648', '.')).toBeNull();
            expect(parseFormattedImportNumber('1E+9999999', '.')).toBeNull();
            expect(parseFormattedImportNumber('1E+100', '.')).toBeNull();
            expect(parseFormattedImportNumber('1E-40', '.')).toBeNull();
            expect(parseFormattedImportNumber('1E+38', '.')?.plain).toBe(`1${'0'.repeat(38)}`);
        });

        it('returns null for non-numeric and lone dashes', () => {
            expect(parseFormattedImportNumber('abc', ',')).toBeNull();
            expect(parseFormattedImportNumber('', ',')).toBeNull();
            expect(parseFormattedImportNumber('-', ',')).toBeNull();
            expect(parseFormattedImportNumber('–', ',')).toBeNull();
        });
    });

    describe('dash-zero cells', () => {
        it.each(['-', '–', '—', '−'])('treats %p as dash-zero', (raw) => {
            expect(isDashZeroImportCell(raw)).toBe(true);
        });

        it('maps dash to 0 in numeric columns and keeps the dash in text columns', () => {
            expect(mapDashZeroImportCell('-', true)).toBe('0');
            expect(mapDashZeroImportCell('-', false)).toBe('-');
            expect(mapDashZeroImportCell('–', false)).toBe('–');
            expect(mapDashZeroImportCell('12', true)).toBeUndefined();
        });
    });

    describe('normalizeImportNumberForDb', () => {
        it('truncates to scale after normalization', () => {
            expect(normalizeImportNumberForDb('1 234,5678', ',', 2)).toBe('1234.56');
            expect(normalizeImportNumberForDb('1,234.5678', '.', 2)).toBe('1234.56');
        });
    });

    describe('detectImportDecimalDelimiter', () => {
        it('detects Polish comma decimals (incl. currency/parens)', () => {
            expect(
                detectImportDecimalDelimiter(['123 456,78', '1 234,56', '123 456,78 zł', '(1 234,56)'])
            ).toBe(',');
        });

        it('detects Anglo-Saxon dot decimals', () => {
            expect(
                detectImportDecimalDelimiter(['123,456.78', '1,234.56', '$1,234.56'])
            ).toBe('.');
        });

        it('ignores lone dashes and abstains on ambiguous 3-digit groups', () => {
            expect(detectImportDecimalDelimiter(['-', '–'])).toBe('.');
            expect(detectImportDecimalDelimiter(['1,234', '5,678'])).toBe('.');
        });

        it('does not let dotted dates or times vote for a dot delimiter', () => {
            expect(detectImportDecimalDelimiter(['07.06.2024', '1 234,56'])).toBe(',');
            expect(detectImportDecimalDelimiter(['07.06.2024', '2024-07-06'])).toBe('.');
            expect(detectImportDecimalDelimiter(['12:30:45.1234', '1 234,56'])).toBe(',');
        });

        it('ignores IPs, versions and multi-separator thousands', () => {
            expect(detectImportDecimalDelimiter(['192.168.0.1', '1.2.3', '1.234.567'])).toBe('.');
            expect(detectImportDecimalDelimiter(['192.168.0.1', '1 234,56'])).toBe(',');
        });

        it('weighs cells carrying both separators by their last separator', () => {
            expect(detectImportDecimalDelimiter(['1.234.567,89'])).toBe(',');
            expect(detectImportDecimalDelimiter(['1,234,567.89'])).toBe('.');
        });
    });
});

describe('PESEL-like columns infer as text (value-based, header-independent)', () => {
    it.each([
        '44051401359',
        '92071314764',
        '02070803628',
        '55030101193',
        // Century-offset month encodings: 2000s (+20), 1800s (+80), 2100s (+40).
        '02221401352',
        '02810101359',
        '02410101357',
    ])(
        'validates PESEL %p',
        (value) => {
            expect(valueLooksLikePesel(value)).toBe(true);
        }
    );

    it.each(['12345678901', '55030101239', '1234567890', '123456789012', '', '4405140135a'])(
        'rejects non-PESEL %p',
        (value) => {
            expect(valueLooksLikePesel(value)).toBe(false);
        }
    );

    it.each([
        ['44131401350', 'month 13'],
        ['44053401357', 'day 34'],
        ['44023001356', 'February 30'],
    ])('rejects checksum-valid %p with %s', (value) => {
        expect(valueLooksLikePesel(value)).toBe(false);
    });

    it('treats a column of TOP3 PESEL values as text', () => {
        const chooser = new ColumnTypeChooser(',');
        expect(chooser.refreshCurrentType('44051401359').dbType).toBe('NVARCHAR');
        expect(chooser.refreshCurrentType('92071314764').dbType).toBe('NVARCHAR');
        expect(chooser.refreshCurrentType('55030101193').dbType).toBe('NVARCHAR');
    });

    it('keeps leading-zero PESEL values as text', () => {
        const chooser = new ColumnTypeChooser(',');
        expect(chooser.refreshCurrentType('02070803628').dbType).toBe('NVARCHAR');
        expect(chooser.refreshCurrentType('44051401359').dbType).toBe('NVARCHAR');
        expect(chooser.refreshCurrentType('55030101193').dbType).toBe('NVARCHAR');
    });

    it('keeps the column as text once PESEL detection succeeded', () => {
        const chooser = new ColumnTypeChooser(',');
        chooser.refreshCurrentType('44051401359');
        chooser.refreshCurrentType('92071314764');
        chooser.refreshCurrentType('55030101193');
        expect(chooser.refreshCurrentType('123').dbType).toBe('NVARCHAR');
    });

    it('keeps non-PESEL 11-digit values as plain numeric', () => {
        const chooser = new ColumnTypeChooser(',');
        expect(chooser.refreshCurrentType('12345678901').dbType).toBe('BIGINT');
    });

    it('keeps dotted dates as DATETIME under a comma decimal delimiter', () => {
        expect(new ColumnTypeChooser(',').refreshCurrentType('17.06.2024').dbType).toBe('DATETIME');
        expect(new ColumnTypeChooser(',').refreshCurrentType('1.234,56').dbType).toBe('NUMERIC');
    });

    it('infers integer currency values as NUMERIC', () => {
        expect(new ColumnTypeChooser(',').refreshCurrentType('123 457 zł').toString()).toBe('NUMERIC(16,0)');
        expect(new ColumnTypeChooser('.').refreshCurrentType('£123,457').toString()).toBe('NUMERIC(16,0)');
        expect(new ColumnTypeChooser(',').refreshCurrentType('123 457').dbType).toBe('BIGINT');
    });

    it('infers a currency column with decimals as NUMERIC with scale', () => {
        const chooser = new ColumnTypeChooser('.');
        expect(chooser.refreshCurrentType('£123,456.78').toString()).toBe('NUMERIC(16,2)');
        expect(chooser.refreshCurrentType('£123,457').dbType).toBe('NUMERIC');
    });

    it('falls back to text for a leading-zero code after the TOP3 sample fails', () => {
        const chooser = new ColumnTypeChooser(',');
        // Not valid PESELs (checksum) — the sample fails on the first value.
        chooser.refreshCurrentType('12345678901');
        chooser.refreshCurrentType('22345678901');
        expect(chooser.refreshCurrentType('01234567890').dbType).toBe('NVARCHAR');
    });
});

describe('transliterateImportHeader', () => {
    it.each([
        ['Śląsk', 'Slask'],
        ['Zażółć gęślą jaźń', 'Zazolc gesla jazn'],
        ['Łódź', 'Lodz'],
        ['ĄĆĘŁŃÓŚŹŻ', 'ACELNOSZZ'],
        ['élève naïve', 'eleve naive'],
    ])('transliterates %p -> %p', (raw, expected) => {
        expect(transliterateImportHeader(raw)).toBe(expected);
    });
});
