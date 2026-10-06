import {
    normalizeDateValue,
    normalizeImportedLiteralValue,
    normalizeTimestampValue,
    normalizeTimestampWithTimeZoneValue,
    truncateNumeric,
} from '../import/batchImportSupport';

describe('batchImportSupport value normalization', () => {
    it('normalizes ISO and local date values', () => {
        expect(normalizeDateValue('2024-2-3')).toBe('2024-02-03');
        expect(normalizeDateValue('03.02.2024')).toBe('2024-02-03');
        expect(normalizeDateValue('3/2/2024')).toBe('2024-02-03');
        expect(normalizeDateValue('not-a-date')).toBe('not-a-date');
    });

    it('normalizes ISO and local timestamp values', () => {
        expect(normalizeTimestampValue('2024-02-03T09:00:00')).toBe('2024-02-03 09:00:00');
        expect(normalizeTimestampValue('2024-02-03')).toBe('2024-02-03 00:00:00');
        expect(normalizeTimestampValue('03.02.2024 09:00')).toBe('2024-02-03 09:00:00');
        expect(normalizeTimestampValue('nope')).toBe('nope');
    });

    it('normalizes timestamps with time zones', () => {
        expect(normalizeTimestampWithTimeZoneValue('2024-02-03 09:00:00Z')).toBe('2024-02-03 09:00:00 +00:00');
        expect(normalizeTimestampWithTimeZoneValue('2024-02-03 09:00:00+0200')).toBe('2024-02-03 09:00:00 +02:00');
        expect(normalizeTimestampWithTimeZoneValue('2024-02-03 09:00:00.5+02:00')).toBe('2024-02-03 09:00:00.5 +02:00');
        expect(normalizeTimestampWithTimeZoneValue('plain')).toBe('plain');
    });

    it('truncates numeric values to the declared scale', () => {
        expect(truncateNumeric('', 2, '.')).toBe('');
        expect(truncateNumeric('12.345', -1, '.')).toBe('12.345');
        expect(truncateNumeric('12.345', 2, '.')).toBe('12.34');
        expect(truncateNumeric('12', 2, '.')).toBe('12');
        expect(truncateNumeric('12,34', 4, ',')).toBe('12.34');
    });

    it('normalizes imported literals for each target type family', () => {
        expect(normalizeImportedLiteralValue('', 'BIGINT', 'BIGINT', '.')).toBeNull();
        expect(normalizeImportedLiteralValue('-', 'BIGINT', 'BIGINT', '.')).toBe('0');
        expect(normalizeImportedLiteralValue('-', 'NVARCHAR(10)', 'NVARCHAR(10)', '.')).toBe('-');
        expect(normalizeImportedLiteralValue('true', 'BOOLEAN', 'BOOLEAN', '.')).toBe('1');
        expect(normalizeImportedLiteralValue('n', 'BOOL', 'BIT', '.')).toBe('0');
        expect(normalizeImportedLiteralValue('maybe', 'BOOLEAN', 'BOOLEAN', '.')).toBe('maybe');
        expect(normalizeImportedLiteralValue('03.02.2024', 'DATE', 'DATE', '.')).toBe('2024-02-03');
        expect(normalizeImportedLiteralValue('2024-02-03T09:00:00', 'DATETIME', 'DATETIME', '.')).toBe('2024-02-03 09:00:00');
        expect(normalizeImportedLiteralValue('2024-02-03 09:00:00Z', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH TIME ZONE', '.')).toBe('2024-02-03 09:00:00 +00:00');
        expect(normalizeImportedLiteralValue('1 234,56', 'NUMERIC', 'DECIMAL(10,2)', ',')).toBe('1234.56');
        expect(normalizeImportedLiteralValue('12,345', 'NUMERIC', 'DECIMAL(10,2)', ',')).toBe('12.34');
        expect(normalizeImportedLiteralValue('plain', 'NVARCHAR(10)', 'NVARCHAR(10)', '.')).toBe('plain');
    });
});
