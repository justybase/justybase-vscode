import { describe, expect, it } from '@jest/globals';
import {
    formatCellsAsInList,
    formatCellsAsInsert,
    formatCellsAsJson,
    INSERT_TARGET_PLACEHOLDER,
} from '../selection/copyFormats.js';
import type { CopyFormatCell } from '../selection/copyFormats.js';

const text = (value: string | null, display = value ?? 'NULL'): CopyFormatCell => ({ text: display, kind: 'text', rawValue: value });
const num = (value: string, display = value): CopyFormatCell => ({ text: display, kind: 'number', numericValue: value, rawValue: value });

describe('copy formats', () => {
    it('renders JSON objects from raw values, not the display text', () => {
        const json = formatCellsAsJson(['ID', 'NAME', 'AMOUNT'], [
            [num('1'), text("O'Brien"), num('1234.5', '1 234,50')],
            [num('2'), text(null), num('99999999999999999999.01')],
        ]);

        expect(JSON.parse(json)).toEqual([
            { ID: 1, NAME: "O'Brien", AMOUNT: 1234.5 },
            // Keeps the exact digits when a JS number would round them.
            { ID: 2, NAME: null, AMOUNT: '99999999999999999999.01' },
        ]);
    });

    it('keeps duplicate column names apart in JSON', () => {
        const json = formatCellsAsJson(['ID', 'ID', ''], [[num('1'), num('2'), text('x')]]);

        expect(JSON.parse(json)).toEqual([{ ID: 1, ID_2: 2, column_3: 'x' }]);
    });

    it('renders one INSERT per row with escaped literals and NULL', () => {
        const sql = formatCellsAsInsert(['ID', 'Last Name'], [
            [num('1'), text("O'Brien")],
            [num('2'), text(null)],
        ], { db: 'DEV', schema: 'ADMIN', table: 'PEOPLE' });

        expect(sql).toBe([
            `INSERT INTO DEV.ADMIN.PEOPLE (ID, "Last Name") VALUES (1, 'O''Brien');`,
            `INSERT INTO DEV.ADMIN.PEOPLE (ID, "Last Name") VALUES (2, NULL);`,
        ].join('\n'));
    });

    it('uses a placeholder target when the result has no single source table', () => {
        const sql = formatCellsAsInsert(['FLAG'], [[{ text: 'true', kind: 'text', rawValue: true }]], null);

        expect(sql).toBe(`INSERT INTO ${INSERT_TARGET_PLACEHOLDER} (FLAG) VALUES (TRUE);`);
    });

    it('renders an IN list with bare numbers, escaped text, no NULLs and no duplicates', () => {
        expect(formatCellsAsInList([
            [num('1001', '1 001')],
            [num('1002')],
            [num('1001')],
            [num('1003')],
        ])).toBe('IN (1001, 1002, 1003)');
        expect(formatCellsAsInList([[text("O'Brien"), text(null)], [text('A'), text("O'Brien")]]))
            .toBe("IN ('O''Brien', 'A')");
    });

    it('wraps long IN lists ten values per line', () => {
        const rows = Array.from({ length: 23 }, (_, index) => [num(String(index + 1))]);

        expect(formatCellsAsInList(rows)).toBe([
            'IN (',
            '    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,',
            '    11, 12, 13, 14, 15, 16, 17, 18, 19, 20,',
            '    21, 22, 23',
            ')',
        ].join('\n'));
    });

    it('renders an IN list that matches nothing when only NULLs are selected', () => {
        expect(formatCellsAsInList([[text(null)], [text(null)]])).toBe('IN (NULL)');
    });
});
