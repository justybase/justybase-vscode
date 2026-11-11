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

    it('formats the estimate with a tilde and grouping', () => {
        expect(formatEstimatedRowCount(18484)).toBe('~18,484');
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
