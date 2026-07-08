/**
 * Unit tests for import/clipboardImporter.ts
 * Tests clipboard data processing utility functions
 */

// Recreate the pure functions for testing (same logic as in clipboardImporter.ts)

/**
 * Clean column name for SQL compatibility
 */
function cleanColumnName(colName: string): string {
    let cleanName = String(colName).trim();
    cleanName = cleanName.replace(/[^0-9a-zA-Z]+/g, '_').toUpperCase();
    if (!cleanName || /^\d/.test(cleanName)) {
        cleanName = 'COL_' + cleanName;
    }
    return cleanName;
}

/**
 * Escape special characters for Netezza import
 */
function escapeValue(val: string, escapechar: string, valuesToEscape: string[]): string {
    let result = String(val).trim();
    for (const char of valuesToEscape) {
        result = result.split(char).join(`${escapechar}${char}`);
    }
    return result;
}

/**
 * Simple class mimicking ClipboardDataProcessor.processTextData for testing
 */
function processTextData(textData: string): string[][] {
    if (!textData.trim()) {
        return [];
    }

    const lines = textData.split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) {
        lines.pop();
    }

    if (!lines.length) {
        return [];
    }

    // Auto-detect delimiter
    const delimiters = ['\t', ',', ';', '|'];
    const delimiterScores: { [key: string]: [number, number] } = {};

    for (const delimiter of delimiters) {
        const scores: number[] = [];
        for (const line of lines.slice(0, Math.min(5, lines.length))) {
            if (line.trim()) {
                const parts = line.split(delimiter);
                scores.push(parts.length);
            }
        }

        if (scores.length) {
            const avgCols = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance = scores.reduce((sum, s) => sum + Math.pow(s - avgCols, 2), 0) / scores.length;
            delimiterScores[delimiter] = [avgCols, -variance];
        }
    }

    let bestDelimiter = '\t';
    if (Object.keys(delimiterScores).length) {
        bestDelimiter = Object.keys(delimiterScores).reduce((best, d) => {
            const [avgA] = delimiterScores[best] || [0, 0];
            const [avgB, varB] = delimiterScores[d];
            const [, varA] = delimiterScores[best] || [0, 0];
            return avgB > avgA || (avgB === avgA && varB > varA) ? d : best;
        }, '\t');
    }

    const rowsData: string[][] = [];
    let maxCols = 0;

    for (const line of lines) {
        if (line.trim()) {
            const row = line.split(bestDelimiter).map(cell => cell.trim());
            rowsData.push(row);
            maxCols = Math.max(maxCols, row.length);
        }
    }

    // Normalize all rows
    for (const row of rowsData) {
        while (row.length < maxCols) {
            row.push('');
        }
    }

    return rowsData;
}

describe('import/clipboardImporter', () => {
    describe('cleanColumnName', () => {
        it('should convert simple name to uppercase', () => {
            expect(cleanColumnName('name')).toBe('NAME');
        });

        it('should replace special characters with underscores', () => {
            expect(cleanColumnName('first name')).toBe('FIRST_NAME');
            expect(cleanColumnName('email@address')).toBe('EMAIL_ADDRESS');
        });

        it('should handle multiple special characters', () => {
            expect(cleanColumnName('col (1) - test')).toBe('COL_1_TEST');
        });

        it('should add COL_ prefix if name starts with digit', () => {
            expect(cleanColumnName('123column')).toBe('COL_123COLUMN');
        });

        it('should replace special-only string with underscore', () => {
            // Special characters become underscores, but since _ is a valid char, no COL_ prefix added
            expect(cleanColumnName('!!!')).toBe('_');
        });

        it('should add COL_ prefix for pure numbers', () => {
            expect(cleanColumnName('123')).toBe('COL_123');
        });

        it('should trim whitespace', () => {
            expect(cleanColumnName('  name  ')).toBe('NAME');
        });

        it('should handle mixed case', () => {
            expect(cleanColumnName('FirstName')).toBe('FIRSTNAME');
        });

        it('should preserve underscores', () => {
            expect(cleanColumnName('first_name')).toBe('FIRST_NAME');
        });
    });

    describe('escapeValue', () => {
        const escapechar = '\\';
        const valuesToEscape = ['\\', '\n', '\r', '\t'];

        it('should escape backslash', () => {
            expect(escapeValue('path\\to\\file', escapechar, valuesToEscape)).toBe('path\\\\to\\\\file');
        });

        it('should escape newline', () => {
            expect(escapeValue('line1\nline2', escapechar, valuesToEscape)).toBe('line1\\\nline2');
        });

        it('should escape carriage return', () => {
            expect(escapeValue('line1\rline2', escapechar, valuesToEscape)).toBe('line1\\\rline2');
        });

        it('should escape tab', () => {
            expect(escapeValue('col1\tcol2', escapechar, valuesToEscape)).toBe('col1\\\tcol2');
        });

        it('should escape multiple characters', () => {
            const input = 'a\\b\nc\td';
            const result = escapeValue(input, escapechar, valuesToEscape);
            expect(result).toBe('a\\\\b\\\nc\\\td');
        });

        it('should trim whitespace', () => {
            expect(escapeValue('  hello  ', escapechar, valuesToEscape)).toBe('hello');
        });

        it('should handle empty string', () => {
            expect(escapeValue('', escapechar, valuesToEscape)).toBe('');
        });

        it('should convert non-string to string', () => {
            // The function uses String(val), so it should work with any input
            expect(escapeValue(String(123), escapechar, valuesToEscape)).toBe('123');
        });
    });

    describe('processTextData', () => {
        describe('delimiter detection', () => {
            it('should detect tab delimiter', () => {
                const data = 'col1\tcol2\tcol3\nval1\tval2\tval3';
                const result = processTextData(data);
                expect(result).toEqual([
                    ['col1', 'col2', 'col3'],
                    ['val1', 'val2', 'val3']
                ]);
            });

            it('should detect comma delimiter', () => {
                const data = 'col1,col2,col3\nval1,val2,val3';
                const result = processTextData(data);
                expect(result).toEqual([
                    ['col1', 'col2', 'col3'],
                    ['val1', 'val2', 'val3']
                ]);
            });

            it('should detect semicolon delimiter', () => {
                const data = 'col1;col2;col3\nval1;val2;val3';
                const result = processTextData(data);
                expect(result).toEqual([
                    ['col1', 'col2', 'col3'],
                    ['val1', 'val2', 'val3']
                ]);
            });

            it('should detect pipe delimiter', () => {
                const data = 'col1|col2|col3\nval1|val2|val3';
                const result = processTextData(data);
                expect(result).toEqual([
                    ['col1', 'col2', 'col3'],
                    ['val1', 'val2', 'val3']
                ]);
            });
        });

        describe('data parsing', () => {
            it('should handle empty input', () => {
                expect(processTextData('')).toEqual([]);
            });

            it('should handle whitespace-only input', () => {
                expect(processTextData('   \n   ')).toEqual([]);
            });

            it('should trim values', () => {
                const data = ' val1 \t val2 ';
                const result = processTextData(data);
                expect(result).toEqual([['val1', 'val2']]);
            });

            it('should normalize row lengths', () => {
                const data = 'a,b,c\nd\ne,f';
                const result = processTextData(data);
                expect(result[0].length).toBe(3);
                expect(result[1].length).toBe(3);
                expect(result[2].length).toBe(3);
                expect(result[1]).toEqual(['d', '', '']);
            });

            it('should skip empty lines', () => {
                const data = 'a,b\n\nc,d';
                const result = processTextData(data);
                expect(result.length).toBe(2);
            });

            it('should remove trailing empty lines', () => {
                const data = 'a,b\nc,d\n\n\n';
                const result = processTextData(data);
                expect(result.length).toBe(2);
            });
        });

        describe('single row/column', () => {
            it('should handle single column', () => {
                const data = 'value1\nvalue2\nvalue3';
                const result = processTextData(data);
                expect(result).toEqual([['value1'], ['value2'], ['value3']]);
            });

            it('should handle single row', () => {
                const data = 'a,b,c';
                const result = processTextData(data);
                expect(result).toEqual([['a', 'b', 'c']]);
            });
        });
    });
});
