import { ColumnAccumulator } from '../analytical/accumulators';
import { computeGroupStats, computeGroupStatsSync, GroupStatsRowLimitError } from '../analytical/computeGroupStats';
import { decodeGroupKey, encodeGroupKey, formatGroupLabel } from '../analytical/groupKey';
import { ANALYTICAL_MAX_IN_MEMORY_ROWS, type AnalyticalGroupColumnRef } from '../analytical/types';

const columns = [
    { index: 0, name: 'REGION', type: 'varchar', role: 'dimension' as const },
    { index: 1, name: 'AMOUNT', type: 'numeric', role: 'measure' as const },
    { index: 2, name: 'STATUS', type: 'varchar', role: 'dimension' as const },
    { index: 3, name: 'DAY', type: 'date', role: 'date' as const },
];

const groupByRegion: AnalyticalGroupColumnRef[] = [{ index: 0, name: 'REGION' }];

function sampleRows(): unknown[][] {
    return [
        ['EMEA', 10, 'OK', '2024-01-01'],
        ['EMEA', 20, 'OK', '2024-01-02'],
        ['EMEA', 30, 'ERR', '2024-01-03'],
        ['US', 100, 'OK', '2024-02-01'],
        ['US', null, 'OK', '2024-02-05'],
        [null, 5, 'OK', '2024-03-01'],
    ];
}

function oracleMean(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function oracleStddev(values: number[]): number {
    const mean = oracleMean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

describe('ColumnAccumulator', () => {
    it('matches a naive mean and population stddev (Welford)', () => {
        const values = [1, 2, 3, 4, 10, 20.5, -3];
        const acc = new ColumnAccumulator('measure', 100);
        values.forEach(value => acc.add(value));
        const stats = acc.toStats(1, 'AMOUNT');
        expect(stats.numeric?.mean).toBeCloseTo(oracleMean(values), 10);
        expect(stats.numeric?.stddev).toBeCloseTo(oracleStddev(values), 10);
        expect(stats.numeric?.min).toBe(-3);
        expect(stats.numeric?.max).toBe(20.5);
    });

    it('keeps variance stable for large offsets such as epoch or id values', () => {
        const base = 1_700_000_000_000;
        const values = [0, 1, 2, 3, 4].map(offset => base + offset);
        const acc = new ColumnAccumulator('measure', 100);
        values.forEach(value => acc.add(value));
        expect(acc.toStats(1, 'TS').numeric?.stddev).toBeCloseTo(oracleStddev(values), 4);
    });

    it('counts nulls and empty strings as null and ignores them for numeric moments', () => {
        const acc = new ColumnAccumulator('measure', 100);
        [null, undefined, '', 4, 6].forEach(value => acc.add(value));
        const stats = acc.toStats(1, 'AMOUNT');
        expect(stats.rowCount).toBe(5);
        expect(stats.nullCount).toBe(3);
        expect(stats.nullRate).toBeCloseTo(0.6);
        expect(stats.numeric?.count).toBe(2);
        expect(stats.numeric?.mean).toBe(5);
    });

    it('marks distinct tracking as approximate once the cap is hit', () => {
        const acc = new ColumnAccumulator('dimension', 2);
        ['a', 'b', 'c', 'a'].forEach(value => acc.add(value));
        const stats = acc.toStats(0, 'X');
        expect(stats.distinctApprox).toBe(true);
        expect(stats.distinctCount).toBe(2);
    });

    it('orders top values by count desc and then value asc', () => {
        const acc = new ColumnAccumulator('dimension', 100);
        ['b', 'a', 'b', 'c', 'c'].forEach(value => acc.add(value));
        expect(acc.topValues(3)).toEqual([
            { value: 'b', count: 2 },
            { value: 'c', count: 2 },
            { value: 'a', count: 1 },
        ]);
    });
});

describe('group keys', () => {
    it('round-trips parts including null and keeps empty string distinct from null', () => {
        const key = encodeGroupKey(['EMEA', null, '', 7]);
        expect(decodeGroupKey(key)).toEqual(['EMEA', null, '', '7']);
        expect(encodeGroupKey([null])).not.toBe(encodeGroupKey(['']));
    });

    it('labels null and empty parts visibly', () => {
        expect(formatGroupLabel(['EMEA', null, ''])).toBe('EMEA / (null) / (empty)');
    });
});

describe('computeGroupStatsSync', () => {
    it('partitions rows by group and matches brute-force group counts and means', () => {
        const rows = sampleRows();
        const dataset = computeGroupStatsSync({ columns, rows, groupColumns: groupByRegion });

        expect(dataset.totalRows).toBe(6);
        expect(dataset.totalGroups).toBe(3);
        const emea = dataset.groups.find(group => group.values[0] === 'EMEA');
        expect(emea?.rowCount).toBe(3);
        expect(emea?.share).toBeCloseTo(0.5);
        const amount = emea?.columns.find(column => column.columnIndex === 1);
        expect(amount?.numeric?.mean).toBeCloseTo(oracleMean([10, 20, 30]), 10);
        expect(amount?.numeric?.stddev).toBeCloseTo(oracleStddev([10, 20, 30]), 10);
    });

    it('keeps null group keys as their own group and labels them', () => {
        const dataset = computeGroupStatsSync({ columns, rows: sampleRows(), groupColumns: groupByRegion });
        const nullGroup = dataset.groups.find(group => group.values[0] === null);
        expect(nullGroup?.rowCount).toBe(1);
        expect(nullGroup?.label).toBe('(null)');
    });

    it('composes multi-column keys and excludes group columns from the analysis', () => {
        const dataset = computeGroupStatsSync({
            columns,
            rows: sampleRows(),
            groupColumns: [{ index: 0, name: 'REGION' }, { index: 2, name: 'STATUS' }],
        });
        expect(dataset.groups.map(group => group.label).sort()).toEqual(
            ['(null) / OK', 'EMEA / ERR', 'EMEA / OK', 'US / OK'].sort(),
        );
        expect(dataset.excludedColumns).toEqual(expect.arrayContaining([0, 2]));
        expect(dataset.groups[0].columns.map(column => column.columnIndex)).not.toContain(2);
    });

    it('lists only the largest groups and counts the rest as unlisted', () => {
        const rows: unknown[][] = [];
        for (let i = 0; i < 10; i++) rows.push([`g${i}`, i, 'x', '2024-01-01']);
        for (let i = 0; i < 6; i++) rows.push(['big', i, 'x', '2024-01-01']);
        const dataset = computeGroupStatsSync({ columns, rows, groupColumns: groupByRegion, maxGroups: 2 });

        expect(dataset.groups).toHaveLength(2);
        expect(dataset.groups[0].label).toBe('big');
        // Ties at size 1 break on key asc, so g0 is listed and g1..g9 are unlisted.
        expect(dataset.groups[1].label).toBe('g0');
        expect(dataset.totalGroups).toBe(11);
        expect(dataset.unlistedRows).toBe(9);
        expect(dataset.groupsTruncated).toBe(true);
    });

    it('excludes identifier-like columns from the population and groups', () => {
        const rows: unknown[][] = [];
        for (let i = 0; i < 20; i++) rows.push([i % 2 === 0 ? 'A' : 'B', 1000 + i, 'x', '2024-01-01']);
        const dataset = computeGroupStatsSync({
            columns: [
                { index: 0, name: 'GROUP', role: 'dimension' },
                { index: 1, name: 'ID', role: 'dimension' },
            ],
            rows,
            groupColumns: [{ index: 0, name: 'GROUP' }],
        });
        expect(dataset.population.map(column => column.name)).not.toContain('ID');
        expect(dataset.excludedColumns).toContain(1);
    });

    it('returns no groups when no grouping columns are chosen', () => {
        const dataset = computeGroupStatsSync({ columns, rows: sampleRows(), groupColumns: [] });
        expect(dataset.groups).toHaveLength(0);
        expect(dataset.totalGroups).toBe(0);
        expect(dataset.population.length).toBeGreaterThan(0);
    });

    it('refuses results above the in-browser row limit', () => {
        const rows = { length: ANALYTICAL_MAX_IN_MEMORY_ROWS + 1 } as unknown as unknown[][];
        expect(() => computeGroupStatsSync({ columns, rows, groupColumns: groupByRegion })).toThrow(GroupStatsRowLimitError);
    });
});

describe('computeGroupStats (cooperative)', () => {
    it('matches the synchronous engine when run in small chunks', async () => {
        const rows = sampleRows();
        const sync = computeGroupStatsSync({ columns, rows, groupColumns: groupByRegion });
        const async = await computeGroupStats({ columns, rows, groupColumns: groupByRegion }, { chunkRows: 2 });
        expect(async).toEqual(sync);
    });

    it('yields between chunks and stops without a result when cancelled', async () => {
        const rows = sampleRows();
        let yields = 0;
        let cancelled = false;
        const result = await computeGroupStats({ columns, rows, groupColumns: groupByRegion }, {
            chunkRows: 2,
            yieldToUi: async () => {
                yields += 1;
                if (yields === 2) cancelled = true;
            },
            isCancelled: () => cancelled,
        });
        expect(yields).toBeGreaterThan(0);
        expect(result).toBeNull();
    });
});
