/**
 * Unit tests for export/resultExporter.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportResultSetToFile, ExportOptions } from '../export/resultExporter';
import { ResultSet } from '../types';

function makeTempFile(ext: string): string {
    return path.join(os.tmpdir(), `test_export_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
}

function makeResultSet(overrides: Partial<ResultSet> = {}): ResultSet {
    return {
        columns: [
            { name: 'ID', type: 'integer' },
            { name: 'NAME', type: 'varchar' },
            { name: 'VALUE', type: 'decimal' }
        ],
        data: [
            [1, 'Alice', 100.5],
            [2, 'Bob', null],
            [3, 'Charlie "C"', 300]
        ],
        rowCount: 3,
        ...overrides
    } as unknown as ResultSet;
}

async function exportToTempFile(resultSet: ResultSet, options: ExportOptions): Promise<string> {
    const ext = '.' + options.format;
    const filePath = makeTempFile(ext);
    try {
        await exportResultSetToFile(resultSet, filePath, options);
        return fs.readFileSync(filePath, 'utf8');
    } finally {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
}

describe('export/resultExporter', () => {
    describe('CSV export', () => {
        it('should export all rows with headers', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'csv' });

            expect(content).toContain('ID,NAME,VALUE');
            expect(content).toContain('1,Alice,100.5');
            expect(content).toContain('2,Bob,');
            expect(content).toContain('3,');
        });

        it('should quote CSV values containing commas or quotes', async () => {
            const resultSet = makeResultSet();
            const content = await exportToTempFile(resultSet, { format: 'csv' });

            // 'Charlie "C"' should be escaped in CSV
            expect(content).toContain('"Charlie ""C"""');
        });

        it('should export only selected rows', async () => {
            const content = await exportToTempFile(makeResultSet(), {
                format: 'csv',
                rowIndices: [0, 2]
            });

            expect(content).toContain('Alice');
            expect(content).toContain('Charlie');
            expect(content).not.toContain('Bob');
        });

        it('should export only selected columns', async () => {
            const content = await exportToTempFile(makeResultSet(), {
                format: 'csv',
                columnIds: ['0', '1']
            });

            expect(content).toContain('ID,NAME');
            expect(content).not.toContain('VALUE');
            expect(content).not.toContain('100.5');
        });

        it('should handle empty data set', async () => {
            const resultSet = makeResultSet({ data: [] });
            const content = await exportToTempFile(resultSet, { format: 'csv' });

            expect(content.trim()).toBe('ID,NAME,VALUE');
        });

        it('should escape values containing newlines', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'NOTES', type: 'varchar' }],
                data: [['line1\nline2']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'csv' });
            expect(content).toContain('"line1\nline2"');
        });

        it('should escape values containing carriage returns', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'NOTES', type: 'varchar' }],
                data: [['a\rb']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'csv' });
            expect(content).toContain('"a\rb"');
        });

        it('should export formatted numeric display values when requested', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'TOTAL', type: 'numeric', scale: 4 }],
                data: [[123456], ['987654.3000']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, {
                format: 'csv',
                formatting: {
                    useFormattedValues: true,
                    payload: {
                        global: {
                            integer: { useGrouping: true, groupSeparator: ' ' },
                            decimal: {
                                useGrouping: true,
                                groupSeparator: ' ',
                                decimalSeparator: '.',
                                scale: 4,
                                preserveTrailingZeros: true,
                                roundingMode: 'half-up'
                            },
                            useFormattedValuesForExport: true
                        },
                        columnOverrides: {}
                    }
                }
            });

            expect(content).toContain('123 456.0000');
            expect(content).toContain('987 654.3000');
        });

        it('should keep floating point exports decimal when type scale is zero', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'RND', type: 'real', scale: 0 }],
                data: [[0.123456789]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, {
                format: 'csv',
                formatting: {
                    useFormattedValues: true,
                    payload: {
                        global: {
                            integer: { useGrouping: true, groupSeparator: ' ' },
                            decimal: {
                                useGrouping: true,
                                groupSeparator: ' ',
                                decimalSeparator: '.',
                                scale: 4,
                                preserveTrailingZeros: true,
                                roundingMode: 'half-up'
                            },
                            useFormattedValuesForExport: true
                        },
                        columnOverrides: {}
                    }
                }
            });

            expect(content).toContain('0.1235');
            expect(content).not.toContain('\n0\n');
            expect(content).not.toContain('\n1\n');
        });

        it('should treat scale-zero exact numerics as integer-like during export formatting', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'AMOUNT', type: 'numeric', scale: 0 }],
                data: [[1234567]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, {
                format: 'csv',
                formatting: {
                    useFormattedValues: true,
                    payload: {
                        global: {
                            integer: { useGrouping: false, groupSeparator: ' ' },
                            decimal: {
                                useGrouping: true,
                                groupSeparator: '_',
                                decimalSeparator: '.',
                                scale: 4,
                                preserveTrailingZeros: true,
                                roundingMode: 'half-up'
                            },
                            useFormattedValuesForExport: true
                        },
                        columnOverrides: {}
                    }
                }
            });

            expect(content).toContain('1234567');
            expect(content).not.toContain('1_234_567');
        });

        it('should keep Oracle and Db2 decimal-float aliases decimal when scale is zero', async () => {
            const resultSet = makeResultSet({
                columns: [
                    { name: 'ORA_FLOAT', type: 'binary_double', scale: 0 },
                    { name: 'DB2_FLOAT', type: 'decfloat', scale: 0 }
                ],
                data: [[0.123456789, '1234.5']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, {
                format: 'csv',
                formatting: {
                    useFormattedValues: true,
                    payload: {
                        global: {
                            integer: { useGrouping: true, groupSeparator: ' ' },
                            decimal: {
                                useGrouping: true,
                                groupSeparator: ' ',
                                decimalSeparator: '.',
                                scale: 4,
                                preserveTrailingZeros: true,
                                roundingMode: 'half-up'
                            },
                            useFormattedValuesForExport: true
                        },
                        columnOverrides: {}
                    }
                }
            });

            expect(content).toContain('0.1235');
            expect(content).toContain('1 234.5000');
        });
    });

    describe('JSON export', () => {
        it('should export valid JSON array', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'json' });

            const parsed = JSON.parse(content);
            expect(Array.isArray(parsed)).toBe(true);
            expect(parsed).toHaveLength(3);
            expect(parsed[0]).toEqual({ ID: 1, NAME: 'Alice', VALUE: 100.5 });
        });

        it('should handle null values in JSON', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'json' });

            const parsed = JSON.parse(content);
            expect(parsed[1].VALUE).toBeNull();
        });

        it('should export empty array for no data', async () => {
            const resultSet = makeResultSet({ data: [] });
            const content = await exportToTempFile(resultSet, { format: 'json' });

            const parsed = JSON.parse(content);
            expect(parsed).toEqual([]);
        });

        it('should serialize bigint values correctly', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'BIG', type: 'bigint' }],
                data: [[BigInt(9007199254740991)], [BigInt('99999999999999999999')]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'json' });
            expect(content).toContain('9007199254740991');
            // Large bigint should become string
            expect(content).toContain('"99999999999999999999"');
        });

        it('should handle Date values in JSON', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'DT', type: 'date' }],
                data: [[new Date('2024-03-15T00:00:00.000Z')]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'json' });
            expect(content).toContain('2024-03-15');
        });

        it('should export only selected rows and columns', async () => {
            const content = await exportToTempFile(makeResultSet(), {
                format: 'json',
                rowIndices: [0],
                columnIds: ['0', '1']
            });

            const parsed = JSON.parse(content);
            expect(parsed).toHaveLength(1);
            expect(parsed[0]).toHaveProperty('ID');
            expect(parsed[0]).toHaveProperty('NAME');
            expect(parsed[0]).not.toHaveProperty('VALUE');
        });
    });

    describe('XML export', () => {
        it('should export valid XML with row elements', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'xml' });

            expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
            expect(content).toContain('<results>');
            expect(content).toContain('<row>');
            expect(content).toContain('<ID>1</ID>');
            expect(content).toContain('<NAME>Alice</NAME>');
            expect(content).toContain('</results>');
        });

        it('should escape XML special characters', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'DESC', type: 'varchar' }],
                data: [['a & b < c > d "e" \'f\'']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'xml' });
            expect(content).toContain('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
        });

        it('should sanitize tag names with invalid characters', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'COL NAME', type: 'varchar' }],
                data: [['val']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'xml' });
            expect(content).toContain('<COL_NAME>');
        });

        it('should handle null values as empty in XML', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'xml' });
            // null VALUE for row 2 should produce empty tag
            expect(content).toContain('<VALUE></VALUE>');
        });
    });

    describe('SQL export', () => {
        it('should generate INSERT statements', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'sql' });

            expect(content).toContain('INSERT INTO EXPORT_TABLE');
            expect(content).toContain('VALUES');
            // Numeric should not be quoted
            expect(content).toMatch(/VALUES \(1,/);
        });

        it('should quote string values in SQL', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'sql' });
            expect(content).toContain("'Alice'");
        });

        it('should output NULL for null values in SQL', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'sql' });
            expect(content).toContain('NULL');
        });

        it('should output TRUE/FALSE for boolean type', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'FLAG', type: 'boolean' }],
                data: [[true], [false]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'sql' });
            expect(content).toContain('TRUE');
            expect(content).toContain('FALSE');
        });

        it('should escape single quotes in string values', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'NAME', type: 'varchar' }],
                data: [["O'Brien"]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'sql' });
            expect(content).toContain("'O''Brien'");
        });

        it('should handle numeric types without quotes', async () => {
            const resultSet = makeResultSet({
                columns: [
                    { name: 'A', type: 'INTEGER' },
                    { name: 'B', type: 'BIGINT' },
                    { name: 'C', type: 'NUMERIC' },
                    { name: 'D', type: 'DOUBLE PRECISION' }
                ],
                data: [[1, 2, 3.14, 2.71]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'sql' });
            expect(content).toMatch(/VALUES \(1, 2, 3\.14, 2\.71\)/);
        });
    });

    describe('Markdown export', () => {
        it('should generate markdown table with header and separator', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'markdown' });

            expect(content).toContain('| ID | NAME | VALUE |');
            expect(content).toContain('| --- | --- | --- |');
            expect(content).toContain('| 1 | Alice | 100.5 |');
        });

        it('should escape pipe characters in markdown', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'COL|NAME', type: 'varchar' }],
                data: [['a|b']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'markdown' });
            expect(content).toContain('COL\\|NAME');
            expect(content).toContain('a\\|b');
        });

        it('should replace newlines in markdown cell values', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'NOTES', type: 'varchar' }],
                data: [['line1\nline2']]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'markdown' });
            // Newlines should be replaced with space
            expect(content).not.toContain('line1\nline2');
            expect(content).toContain('line1 line2');
        });

        it('should handle null values as empty in markdown', async () => {
            const content = await exportToTempFile(makeResultSet(), { format: 'markdown' });
            // Row 2: Bob has null value - should produce empty cell
            expect(content).toContain('| 2 | Bob |  |');
        });
    });

    describe('formatValue edge cases', () => {
        it('should format date type correctly', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'DT', type: 'date' }],
                data: [[new Date('2024-06-15T12:00:00.000Z')]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'csv' });
            expect(content).toContain('2024-06-15');
        });

        it('should format timestamp type correctly', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'TS', type: 'timestamp' }],
                data: [[new Date('2024-06-15T12:30:45.000Z')]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'csv' });
            expect(content).toContain('2024-06-15 12:30:45');
        });

        it('should format time object with hours/minutes/seconds', async () => {
            const resultSet = makeResultSet({
                columns: [{ name: 'T', type: 'time' }],
                data: [[{ hours: 9, minutes: 5, seconds: 3 }]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'csv' });
            expect(content).toContain('09:05:03');
        });

        it('should return custom toString for non-standard objects', async () => {
            const obj = { toString: () => 'custom_value' };
            const resultSet = makeResultSet({
                columns: [{ name: 'X', type: 'varchar' }],
                data: [[obj]]
            } as unknown as Partial<ResultSet>);

            const content = await exportToTempFile(resultSet, { format: 'csv' });
            expect(content).toContain('custom_value');
        });
    });
});
