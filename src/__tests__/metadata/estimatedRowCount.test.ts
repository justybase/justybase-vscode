import {
    appendEstimatedRowCount,
    formatEstimatedRowCount,
    normalizeEstimatedRowCount,
} from '../../metadata/estimatedRowCount';

describe('estimated row counts', () => {
    it('normalizes reltuples values and ignores negative sentinels', () => {
        expect(normalizeEstimatedRowCount(18484.4)).toBe(18484);
        expect(normalizeEstimatedRowCount('99')).toBe(99);
        expect(normalizeEstimatedRowCount(-1)).toBeUndefined();
        expect(normalizeEstimatedRowCount(undefined)).toBeUndefined();
        expect(normalizeEstimatedRowCount(null)).toBeUndefined();
    });

    it('formats the estimate with a tilde and k/m abbreviations', () => {
        expect(formatEstimatedRowCount(250)).toBe('~250');
        expect(formatEstimatedRowCount(999)).toBe('~999');
        expect(formatEstimatedRowCount(1_000)).toBe('~1k');
        expect(formatEstimatedRowCount(12_700)).toBe('~13k');
        expect(formatEstimatedRowCount(18_484)).toBe('~18k');
        expect(formatEstimatedRowCount(999_499)).toBe('~999k');
        expect(formatEstimatedRowCount(999_500)).toBe('~1m');
        expect(formatEstimatedRowCount(1_000_000)).toBe('~1m');
        expect(formatEstimatedRowCount(1_500_000)).toBe('~2m');
        expect(formatEstimatedRowCount(18_000_000)).toBe('~18m');
    });

    it('appends the estimate to an existing completion detail', () => {
        expect(appendEstimatedRowCount('Table (ADMIN)', 776)).toBe(
            'Table (ADMIN) · ~776 rows',
        );
    });

    it('uses the estimate alone when no detail exists', () => {
        expect(appendEstimatedRowCount(undefined, 776)).toBe('~776 rows');
    });

    it('leaves detail untouched when the estimate is missing or invalid', () => {
        expect(appendEstimatedRowCount('View', undefined)).toBe('View');
        expect(appendEstimatedRowCount('View', -1)).toBe('View');
        expect(appendEstimatedRowCount('View', Number.NaN)).toBe('View');
    });
});
