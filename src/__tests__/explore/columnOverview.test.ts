import { computeColumnOverviews } from '../../../media/resultPanel/explore/columnOverview.js';
import type { ExploreColumnMeta } from '../../../media/resultPanel/explore/types.js';

describe('explore columnOverview', () => {
    it('computes measure stats and a histogram', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'AMOUNT', type: 'DECIMAL(10,2)', role: 'measure' },
        ];
        const rows = Array.from({ length: 100 }, (_, i) => [i + 1]);

        const [overview] = computeColumnOverviews(columns, rows, rows.length);

        expect(overview.role).toBe('measure');
        expect(overview.nullCount).toBe(0);
        expect(overview.min).toBe(1);
        expect(overview.max).toBe(100);
        expect(overview.avg).toBeCloseTo(50.5, 2);
        expect(overview.p25).toBe(26);
        expect(overview.p75).toBe(75);
        expect(overview.distinctCount).toBe(100);
        expect(overview.histogram).toBeDefined();
        expect(overview.histogram?.length).toBeGreaterThan(0);
        const binTotal = (overview.histogram ?? []).reduce((sum, bin) => sum + bin.count, 0);
        expect(binTotal).toBe(100);
    });

    it('counts nulls and excludes them from measure stats', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'VALUE', type: 'INT', role: 'measure' },
        ];
        const rows = [[1], [null], [3], [undefined], ['']];

        const [overview] = computeColumnOverviews(columns, rows, rows.length);

        expect(overview.nullCount).toBe(3);
        expect(overview.examinedRows).toBe(5);
        expect(overview.min).toBe(1);
        expect(overview.max).toBe(3);
    });

    it('handles a constant measure column with a single bin', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'CONST', type: 'INT', role: 'measure' },
        ];
        const rows = [[5], [5], [5]];

        const [overview] = computeColumnOverviews(columns, rows, rows.length);

        expect(overview.min).toBe(5);
        expect(overview.max).toBe(5);
        expect(overview.histogram).toEqual([{ min: 5, max: 5, count: 3 }]);
    });

    it('collects top values for dimensions and marks truncation', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'REGION', type: 'VARCHAR(20)', role: 'dimension' },
        ];
        const rows = Array.from({ length: 30 }, (_, i) => [`region-${i % 3}`]);

        const [overview] = computeColumnOverviews(columns, rows, rows.length);

        expect(overview.role).toBe('dimension');
        expect(overview.distinctCount).toBe(3);
        expect(overview.distinctTruncated).toBe(false);
        expect(overview.topValues).toHaveLength(3);
        expect(overview.topValues?.[0]).toEqual({ value: 'region-0', count: 10 });
    });

    it('computes min/max for date columns', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'ORDER_DATE', type: 'DATE', role: 'date' },
        ];
        const rows = [['2024-03-01'], ['2024-01-15'], ['2024-12-31'], [null]];

        const [overview] = computeColumnOverviews(columns, rows, rows.length);

        expect(overview.role).toBe('date');
        expect(overview.nullCount).toBe(1);
        expect(overview.minDate).toBe('2024-01-15');
        expect(overview.maxDate).toBe('2024-12-31');
        expect(overview.distinctCount).toBe(3);
    });

    it('handles empty rows without throwing', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'A', type: 'INT', role: 'measure' },
            { index: 1, name: 'B', type: 'VARCHAR(10)', role: 'dimension' },
            { index: 2, name: 'C', type: 'DATE', role: 'date' },
        ];
        const overviews = computeColumnOverviews(columns, [], 0);

        expect(overviews).toHaveLength(3);
        expect(overviews[0].histogram).toEqual([]);
        expect(overviews[1].topValues).toEqual([]);
        expect(overviews[2].minDate).toBeUndefined();
    });
});
