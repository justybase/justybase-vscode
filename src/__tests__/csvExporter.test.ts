/**
 * Unit tests for export/csvExporter.ts
 * Tests the escapeCsvField function
 */

import { escapeCsvField } from '../export/csvExporter';

describe('export/csvExporter', () => {
    describe('escapeCsvField', () => {
        describe('null and undefined handling', () => {
            it('should return empty string for null', () => {
                expect(escapeCsvField(null)).toBe('');
            });

            it('should return empty string for undefined', () => {
                expect(escapeCsvField(undefined)).toBe('');
            });
        });

        describe('simple values', () => {
            it('should convert string as-is when no escaping needed', () => {
                expect(escapeCsvField('hello')).toBe('hello');
            });

            it('should convert number to string', () => {
                expect(escapeCsvField(123)).toBe('123');
                expect(escapeCsvField(123.45)).toBe('123.45');
            });

            it('should convert boolean to string', () => {
                expect(escapeCsvField(true)).toBe('true');
                expect(escapeCsvField(false)).toBe('false');
            });
        });

        describe('escaping special characters', () => {
            it('should escape field containing comma', () => {
                expect(escapeCsvField('hello,world')).toBe('"hello,world"');
            });

            it('should escape field containing double quote', () => {
                expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
            });

            it('should escape field containing newline', () => {
                expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
            });

            it('should escape field containing carriage return', () => {
                expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
            });

            it('should escape field with mixed special characters', () => {
                expect(escapeCsvField('he said, "hi"\n')).toBe('"he said, ""hi""\n"');
            });
        });

        describe('special types', () => {
            it('should handle BigInt within safe integer range', () => {
                expect(escapeCsvField(BigInt(123))).toBe('123');
            });

            it('should handle BigInt outside safe integer range', () => {
                const bigNum = BigInt('9999999999999999999');
                expect(escapeCsvField(bigNum)).toBe('9999999999999999999');
            });

            it('should format Date as ISO string', () => {
                const date = new Date('2024-01-15T10:30:00.000Z');
                expect(escapeCsvField(date)).toBe('2024-01-15T10:30:00.000Z');
            });

            it('should handle Buffer as hex string', () => {
                const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
                expect(escapeCsvField(buffer)).toBe('48656c6c6f');
            });

            it('should stringify objects as JSON', () => {
                const obj = { name: 'test', value: 123 };
                const result = escapeCsvField(obj);
                // JSON contains quotes and possibly commas, so should be escaped
                expect(result).toBe('"{\\"name\\":\\"test\\",\\"value\\":123}"'.replace(/\\"/g, '""'));
            });

            it('should stringify arrays as JSON', () => {
                const arr = [1, 2, 3];
                const result = escapeCsvField(arr);
                // Array contains commas, so should be wrapped
                expect(result).toBe('"[1,2,3]"');
            });
        });
    });
});
