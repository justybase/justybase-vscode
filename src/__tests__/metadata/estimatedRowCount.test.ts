import { formatEstimatedRowCount, normalizeEstimatedRowCount } from '../../metadata/estimatedRowCount';

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
});
