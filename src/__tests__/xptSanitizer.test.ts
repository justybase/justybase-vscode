/**
 * Tests for SAS name/label sanitizer (xptSanitizer.ts).
 */

import { sanitizeSasName, sanitizeSasLabel, resolveSasColumnNames } from '../export/xptSanitizer';

describe('xptSanitizer', () => {
    describe('sanitizeSasName', () => {
        it('truncates long names to 8 characters, keeps underscores', () => {
            // 'CUSTOMER_ID' is 11 chars → truncated to first 8: 'CUSTOMER'
            const { name, warnings } = sanitizeSasName('CUSTOMER_ID');
            expect(name).toBe('CUSTOMER');
            expect(warnings).toHaveLength(1);
            expect(warnings[0].type).toBe('truncated');
        });

        it('uppercases and truncates', () => {
            const { name } = sanitizeSasName('customerName');
            expect(name).toBe('CUSTOMER');
            expect(name.length).toBeLessThanOrEqual(8);
        });

        it('removes invalid characters and truncates', () => {
            const { name, warnings } = sanitizeSasName('my-column#1');
            // After cleaning: 'MYCOLUMN1' (9 chars) → truncated to 8: 'MYCOLUMN'
            expect(name).toBe('MYCOLUMN');
            expect(name.length).toBeLessThanOrEqual(8);
            expect(warnings).toHaveLength(2);
            expect(warnings[0].type).toBe('cleaned');
            expect(warnings[1].type).toBe('truncated');
        });

        it('truncates names longer than 8 characters', () => {
            const { name, warnings } = sanitizeSasName('very_long_column_name');
            expect(name).toBe('VERY_LON');
            expect(name.length).toBeLessThanOrEqual(8);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].type).toBe('truncated');
        });

        it('prefixes digit-starting names with underscore', () => {
            const { name } = sanitizeSasName('123abc');
            expect(name).toBe('_123ABC');
        });

        it('handles empty name by providing a default', () => {
            const { name } = sanitizeSasName('');
            expect(name.length).toBeGreaterThan(0);
        });
    });

    describe('sanitizeSasLabel', () => {
        it('keeps short labels unchanged', () => {
            expect(sanitizeSasLabel('Short')).toBe('Short');
        });

        it('truncates labels longer than 40 characters', () => {
            const longLabel = 'A'.repeat(50);
            const result = sanitizeSasLabel(longLabel);
            expect(result).toBe('A'.repeat(40));
            expect(result.length).toBe(40);
        });
    });

    describe('resolveSasColumnNames', () => {
        it('resolves a simple list of names', () => {
            const { names, warnings } = resolveSasColumnNames(['ID', 'NAME', 'VALUE']);
            expect(names).toEqual(['ID', 'NAME', 'VALUE']);
            expect(warnings).toHaveLength(0);
        });

        it('deduplicates conflicting names with numeric suffixes', () => {
            const { names, warnings } = resolveSasColumnNames(['FOO', 'FOO', 'FOO']);
            expect(names).toEqual(['FOO', 'FOO1', 'FOO2']);
            expect(names.every(n => n.length <= 8)).toBe(true);
            // Two warnings: one for FOO→FOO1 rename, one for FOO→FOO2 rename
            expect(warnings.length).toBe(2);
        });

        it('handles names that become identical after cleaning', () => {
            const { names } = resolveSasColumnNames(['my-col', 'my-col!']);
            // Both clean to "MYCOL"
            expect(names[0]).toBe('MYCOL');
            expect(names[1]).toMatch(/^MYCOL/);
            expect(names[0]).not.toBe(names[1]);
        });

        it('truncates and deduplicates long names', () => {
            const { names } = resolveSasColumnNames(
                Array.from({ length: 5 }, (_, i) => `very_long_column_${i}`)
            );
            expect(names.every(n => n.length <= 8)).toBe(true);
            const unique = new Set(names);
            expect(unique.size).toBe(names.length);
        });
    });
});
