import {
    appendEstimatedRowCount,
    carryForwardRowCounts,
    formatEstimatedRowCount,
    normalizeEstimatedRowCount,
} from '../../metadata/estimatedRowCount';

describe('estimated row counts', () => {
    it('normalizes reltuples values and ignores negative sentinels', () => {
        expect(normalizeEstimatedRowCount(18484.4)).toBe(18484);
        expect(normalizeEstimatedRowCount('99')).toBe(99);
        expect(normalizeEstimatedRowCount('  4213 ')).toBe(4213);
        expect(normalizeEstimatedRowCount(18484n)).toBe(18484);
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

    describe('carryForwardRowCounts', () => {
        type Row = { name: string; rowCount?: number };
        const identity = (row: Row) => row.name.toUpperCase();

        it('keeps a known estimate when the refreshed row has none', () => {
            const previous: Row[] = [{ name: 'DIMDATE', rowCount: 4213 }];
            const refreshed: Row[] = [{ name: 'DIMDATE' }];
            expect(carryForwardRowCounts(previous, refreshed, identity)).toEqual([
                { name: 'DIMDATE', rowCount: 4213 },
            ]);
        });

        it('lets a real estimate replace the previous one', () => {
            const previous: Row[] = [{ name: 'DIMDATE', rowCount: 4213 }];
            const refreshed: Row[] = [{ name: 'DIMDATE', rowCount: 99 }];
            expect(carryForwardRowCounts(previous, refreshed, identity)).toEqual([
                { name: 'DIMDATE', rowCount: 99 },
            ]);
        });

        it('does not invent estimates for new rows', () => {
            const previous: Row[] = [{ name: 'DIMDATE', rowCount: 4213 }];
            const refreshed: Row[] = [{ name: 'DIMDATE' }, { name: 'NEW_TABLE' }];
            expect(carryForwardRowCounts(previous, refreshed, identity)).toEqual([
                { name: 'DIMDATE', rowCount: 4213 },
                { name: 'NEW_TABLE' },
            ]);
        });

        it('returns the incoming rows untouched when nothing is carried', () => {
            const refreshed: Row[] = [{ name: 'A' }, { name: 'B' }];
            expect(carryForwardRowCounts([], refreshed, identity)).toBe(refreshed);
            expect(carryForwardRowCounts([{ name: 'Z', rowCount: 1 }], refreshed, identity)).toBe(refreshed);
        });
    });
});
