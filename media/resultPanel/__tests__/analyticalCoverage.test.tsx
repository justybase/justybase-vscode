// Coverage reporting for the Analytical view: when a rule cannot be evaluated (bounded work,
// approximate counts or non-numeric storage), the dataset says so and the view explains it.

import { computeGroupStatsSync, type GroupStatsInput } from '../analytical/computeGroupStats';
import { describeCoverageSkips } from '../analytical/coverage';
import { buildDiskGroupDataset } from '../analytical/diskAdapter';
import type { DiskGroupStatsResult } from '../types';

const COLUMNS: GroupStatsInput['columns'] = [
    { index: 0, name: 'REGION', role: 'dimension' },
    { index: 1, name: 'CODE', role: 'dimension' },
    { index: 2, name: 'AMOUNT', role: 'measure' },
];

const GROUP = [{ index: 0, name: 'REGION' }];

/** One group with more distinct values than the per-group cap, so dominance is marked approximate. */
function overflowingRows(): unknown[][] {
    const rows: unknown[][] = [];
    for (let i = 0; i < 200; i++) {
        // 100 distinct values among 200 rows: enough to overflow the per-group cap, but repeated
        // often enough that the column is not classified as an identifier and dropped.
        rows.push(['A', `CODE-${i % 100}`, i]);
    }
    return rows;
}

describe('Analytical coverage', () => {
    it('reports no skipped evaluation when the engine had full coverage', () => {
        const dataset = computeGroupStatsSync({
            columns: COLUMNS,
            rows: [['A', 'x', 1], ['A', 'y', 2], ['B', 'x', 3]],
            groupColumns: GROUP,
        });
        expect(dataset.coverage).toEqual({ quantiles: false });
        expect(describeCoverageSkips(dataset, index => `col${index}`)).toEqual([]);
    });

    it('marks dominance as approximate in memory when a group overflows the distinct cap', () => {
        const dataset = computeGroupStatsSync({ columns: COLUMNS, rows: overflowingRows(), groupColumns: GROUP });
        expect(dataset.coverage?.skipped).toEqual([
            { columnIndex: 1, rules: ['TOP_VALUE_DOMINANCE'], reason: 'approximate' },
        ]);
        const notices = describeCoverageSkips(dataset, index => COLUMNS[index].name);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('CODE');
        expect(notices[0]).toContain('Dominant value');
    });

    it('maps the host omissions onto the rules they feed and de-duplicates across batches', () => {
        const omitted: DiskGroupStatsResult['omitted'] = [
            { columnIndex: 1, field: 'topValues', reason: 'too-many-distinct' },
            { columnIndex: 1, field: 'categories', reason: 'too-many-distinct' },
            { columnIndex: 1, field: 'quartiles', reason: 'not-numeric' },
        ];
        const batch: DiskGroupStatsResult = {
            groupColumns: [0],
            totalRows: 3,
            totalGroups: 1,
            groups: [{ values: ['A'], count: 3, columns: [{ columnIndex: 1, nonNullCount: 3, distinctCount: 200, min: 'x', max: 'y' }] }],
            unlistedRows: 0,
            population: [{ columnIndex: 1, nonNullCount: 3, distinctCount: 200, min: 'x', max: 'y' }],
            omitted,
        };
        const dataset = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [batch, batch], quantiles: true });
        expect(dataset.coverage?.skipped).toEqual([
            { columnIndex: 1, rules: ['MEAN_SHIFT', 'RANGE_OUTLIER', 'HIGH_VARIABILITY'], reason: 'not-numeric' },
            { columnIndex: 1, rules: ['TOP_VALUE_DOMINANCE', 'MIX_SHIFT'], reason: 'too-many-distinct' },
        ]);
    });

    it('ignores a quartile omission when quartiles were not requested', () => {
        const batch: DiskGroupStatsResult = {
            groupColumns: [0],
            totalRows: 3,
            totalGroups: 1,
            groups: [{ values: ['A'], count: 3, columns: [{ columnIndex: 1, nonNullCount: 3, distinctCount: 2, min: 'x', max: 'y' }] }],
            unlistedRows: 0,
            population: [{ columnIndex: 1, nonNullCount: 3, distinctCount: 2, min: 'x', max: 'y' }],
            omitted: [{ columnIndex: 1, field: 'quartiles', reason: 'not-numeric' }],
        };
        const dataset = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [batch] });
        expect(dataset.coverage).toEqual({ quantiles: false });
    });
});
