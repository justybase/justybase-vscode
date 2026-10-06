import {
    normalizeAndDeduplicateHeaders,
    normalizeImportedHeader,
} from '../import/importHeaderUtils';

describe('importHeaderUtils', () => {
    it('sanitizes empty and punctuation-only headers consistently', () => {
        expect(normalizeImportedHeader('')).toBe('COL_EMPTY');
        expect(normalizeImportedHeader('!!!')).toBe('COL_EMPTY');
    });

    it('replaces empty header cells with positional COLUMN_<n> placeholders', () => {
        expect(normalizeAndDeduplicateHeaders(['id', '', '  ', 'name'])).toEqual([
            'ID',
            'COLUMN_2',
            'COLUMN_3',
            'NAME',
        ]);
    });

    it('deduplicates headers case-insensitively', () => {
        expect(normalizeAndDeduplicateHeaders(['Name', 'name', 'NAME'])).toEqual([
            'NAME',
            'NAME_1',
            'NAME_2',
        ]);
    });
});
