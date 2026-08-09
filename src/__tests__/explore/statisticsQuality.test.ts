import { computeColumnStatistics } from '../../../media/resultPanel/explore/statistics.js';
import { computeQualityAlerts, computeMeasureCorrelations } from '../../../media/resultPanel/explore/quality.js';
import { rowMatchesExploreFilters, filterExploreRows } from '../../../media/resultPanel/explore/filtering.js';
import type { ExploreColumnMeta, ExploreColumnOverview, ExploreFilterModel } from '../../../media/resultPanel/explore/types.js';

describe('explore statistics', () => {
    it('computes full descriptive statistics', () => {
        const rows = Array.from({ length: 10 }, (_, i) => [i + 1]);
        const stats = computeColumnStatistics(rows, 0);
        expect(stats.count).toBe(10);
        expect(stats.distinct).toBe(10);
        expect(stats.sum).toBe(55);
        expect(stats.avg).toBe(5.5);
        expect(stats.median).toBe(6);
        expect(stats.min).toBe(1);
        expect(stats.max).toBe(10);
        expect(stats.p25).toBe(3);
        expect(stats.p75).toBe(8);
        expect(stats.stddev).toBeGreaterThan(2.8);
        expect(stats.stddev).toBeLessThan(3.1);
        expect(stats.variance).toBeGreaterThan(8);
    });

    it('counts nulls separately', () => {
        const rows = [[1], [null], [3], [undefined], ['']];
        const stats = computeColumnStatistics(rows, 0);
        expect(stats.count).toBe(2);
        expect(stats.nullCount).toBe(3);
        expect(stats.sum).toBe(4);
    });

    it('handles empty columns', () => {
        const stats = computeColumnStatistics([], 0);
        expect(stats.count).toBe(0);
        expect(stats.sum).toBeUndefined();
    });
});

describe('explore quality alerts', () => {
    const meta = (role: ExploreColumnMeta['role'], index: number): ExploreColumnMeta => ({
        index,
        name: `COL${index}`,
        type: 'VARCHAR(10)',
        role,
    });

    const overview = (over: Partial<ExploreColumnOverview>): ExploreColumnOverview => ({
        index: 0,
        name: 'COL0',
        type: 'VARCHAR(10)',
        role: 'dimension',
        examinedRows: 100,
        nullCount: 0,
        distinctCount: 5,
        distinctTruncated: false,
        ...over,
    });

    it('flags high null rates', () => {
        const alerts = computeQualityAlerts(
            [meta('dimension', 0)],
            [overview({ nullCount: 40 })],
        );
        expect(alerts).toHaveLength(1);
        expect(alerts[0].severity).toBe('warn');
        expect(alerts[0].message).toBe('40% null values');
    });

    it('flags constant and all-unique dimensions', () => {
        const constant = computeQualityAlerts(
            [meta('dimension', 0)],
            [overview({ distinctCount: 1 })],
        );
        expect(constant.some(alert => alert.message === 'Constant value — no analytical value')).toBe(true);

        const unique = computeQualityAlerts(
            [meta('dimension', 0)],
            [overview({ distinctCount: 100 })],
        );
        expect(unique.some(alert => alert.message === 'All values unique (high cardinality)')).toBe(true);
    });

    it('does not alert on healthy columns', () => {
        const alerts = computeQualityAlerts(
            [meta('dimension', 0), meta('measure', 1)],
            [overview({ nullCount: 2, distinctCount: 10 }), overview({ index: 1, name: 'COL1', role: 'measure', examinedRows: 100, nullCount: 2, distinctCount: 50 })],
        );
        expect(alerts).toHaveLength(0);
    });
});

describe('explore correlations', () => {
    it('computes Pearson r for correlated measures', () => {
        const columns: ExploreColumnMeta[] = [
            { index: 0, name: 'A', type: 'INT', role: 'measure' },
            { index: 1, name: 'B', type: 'INT', role: 'measure' },
            { index: 2, name: 'C', type: 'VARCHAR(10)', role: 'dimension' },
        ];
        const rows = Array.from({ length: 50 }, (_, i) => [i, i * 2, 'x']);
        const correlations = computeMeasureCorrelations(columns, rows);
        expect(correlations).toHaveLength(1);
        expect(correlations[0].firstIndex).toBe(0);
        expect(correlations[0].secondIndex).toBe(1);
        expect(correlations[0].r).toBeGreaterThan(0.99);
    });

    it('returns nothing for uncorrelated or single measures', () => {
        const single: ExploreColumnMeta[] = [{ index: 0, name: 'A', type: 'INT', role: 'measure' }];
        expect(computeMeasureCorrelations(single, [[1], [2]])).toHaveLength(0);

        const uncorrelated: ExploreColumnMeta[] = [
            { index: 0, name: 'A', type: 'INT', role: 'measure' },
            { index: 1, name: 'B', type: 'INT', role: 'measure' },
        ];
        const rows = Array.from({ length: 50 }, (_, i) => [Math.sin(i), Math.cos(i)]);
        expect(computeMeasureCorrelations(uncorrelated, rows)).toHaveLength(0);
    });
});

describe('explore filtering (client)', () => {
    const FILTERS: ExploreFilterModel = {
        dimensions: [{ columnIndex: 0, values: ['EU'] }],
        dates: [{ columnIndex: 1, grain: 'month', from: '2024-01-01', to: '2024-06-30' }],
        measures: [{ columnIndex: 2, min: 10, max: 20 }],
    };

    it('matches rows against all filter kinds', () => {
        expect(rowMatchesExploreFilters(['EU', '2024-03-01', 15], FILTERS)).toBe(true);
        expect(rowMatchesExploreFilters(['US', '2024-03-01', 15], FILTERS)).toBe(false);
        expect(rowMatchesExploreFilters(['EU', '2024-09-01', 15], FILTERS)).toBe(false);
        expect(rowMatchesExploreFilters(['EU', '2024-03-01', 25], FILTERS)).toBe(false);
        expect(rowMatchesExploreFilters(['EU', '2024-03-01', null], FILTERS)).toBe(false);
    });

    it('filters row lists in place of empty filters', () => {
        const rows = [[1], [2], [3]];
        expect(filterExploreRows(rows, { dimensions: [], dates: [], measures: [] })).toEqual(rows);
        expect(filterExploreRows(rows, { dimensions: [{ columnIndex: 0, values: ['2'] }], dates: [], measures: [] })).toEqual([[2]]);
    });
});
