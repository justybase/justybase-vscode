import { computeGroupStatsSync, type GroupStatsInput } from '../analytical/computeGroupStats';
import { applyAnomalies, restBaseline } from '../analytical/anomalyRules';
import { PEER_MIN_GROUPS, categoryShift, peerMetric, peerZ } from '../analytical/modeRules';
import { quartileRanks, quartilesFromRanks, quartilesSorted } from '../analytical/quantiles';
import type { AnalyticalDataset, AnalyticalColumnStats, AnomalyFlag } from '../analytical/types';

const COLUMNS: GroupStatsInput['columns'] = [
    { index: 0, name: 'GROUP', role: 'dimension' },
    { index: 1, name: 'AMOUNT', role: 'measure' },
    { index: 2, name: 'CATEGORY', role: 'dimension' },
];

type Row = [string, number, string];

/** Deterministic pseudo-random generator, so every run sees the same numbers. */
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function datasetOf(rows: Row[], quantiles = false): AnalyticalDataset {
    return computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'GROUP' }], quantiles });
}

function flagsOf(dataset: AnalyticalDataset, groupKey: string, rule: AnomalyFlag['rule']): AnomalyFlag[] {
    const group = dataset.groups.find(item => item.key === groupKey);
    return group ? group.flags.filter(flag => flag.rule === rule) : [];
}

/** Independent type-7 quantile, written directly from the definition. */
function oracleQuantile(sorted: readonly number[], p: number): number {
    const h = (sorted.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

describe('type-7 quartiles', () => {
    it('match the definition for random samples, including ties and tiny sizes', () => {
        const random = seeded(7);
        for (let trial = 0; trial < 300; trial++) {
            const n = 1 + Math.floor(random() * 60);
            const values = Array.from({ length: n }, () => Math.round(random() * 20) / 2);
            const sorted = [...values].sort((a, b) => a - b);
            const quartiles = quartilesSorted(sorted);
            expect(quartiles).not.toBeNull();
            expect(quartiles!.q1).toBeCloseTo(oracleQuantile(sorted, 0.25), 12);
            expect(quartiles!.median).toBeCloseTo(oracleQuantile(sorted, 0.5), 12);
            expect(quartiles!.q3).toBeCloseTo(oracleQuantile(sorted, 0.75), 12);
        }
    });

    it('read only the ranks they are told to, which is what the disk path selects', () => {
        for (let n = 1; n <= 40; n++) {
            const sorted = Array.from({ length: n }, (_, i) => i * 3 + 1);
            const ranks = new Set(quartileRanks(n));
            const fromRanks = quartilesFromRanks(n, index => {
                expect(ranks.has(index)).toBe(true);
                return sorted[index];
            });
            expect(fromRanks).toEqual(quartilesSorted(sorted));
        }
    });

    it('returns null for an empty sample', () => {
        expect(quartilesSorted([])).toBeNull();
    });
});

describe('engine quartiles and categories', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 120; i++) {
        rows.push([i % 2 === 0 ? 'A' : 'B', (i * 37) % 101, i % 3 === 0 ? 'X' : 'Y']);
    }

    it('computes quartiles for the population and each group only when asked', () => {
        const without = datasetOf(rows);
        expect(without.coverage?.quantiles).toBe(false);
        expect(without.population.find(stats => stats.columnIndex === 1)?.numeric?.quartiles).toBeUndefined();

        const withQuartiles = datasetOf(rows, true);
        expect(withQuartiles.coverage?.quantiles).toBe(true);
        const population = withQuartiles.population.find(stats => stats.columnIndex === 1)!;
        const sorted = rows.map(row => row[1]).sort((a, b) => a - b);
        expect(population.numeric?.quartiles?.median).toBeCloseTo(oracleQuantile(sorted, 0.5), 12);
        for (const group of withQuartiles.groups) {
            const values = rows.filter(row => row[0] === group.values[0]).map(row => row[1]).sort((a, b) => a - b);
            const stats = group.columns.find(column => column.columnIndex === 1)!;
            expect(stats.numeric?.quartiles?.q1).toBeCloseTo(oracleQuantile(values, 0.25), 12);
            expect(stats.numeric?.quartiles?.q3).toBeCloseTo(oracleQuantile(values, 0.75), 12);
        }
    });

    it('keeps full category distributions for small dimension columns only', () => {
        const dataset = datasetOf(rows);
        const category = dataset.population.find(stats => stats.columnIndex === 2)!;
        expect(category.categories?.map(entry => entry.count).reduce((a, b) => a + b, 0)).toBe(rows.length);
        expect(dataset.population.find(stats => stats.columnIndex === 1)?.categories).toBeUndefined();
    });

    it('drops categories when a dimension has more distinct values than the limit', () => {
        const wide: Row[] = Array.from({ length: 200 }, (_, i) => ['A', i % 2, `V${i}`] as unknown as Row);
        const dataset = datasetOf(wide);
        expect(dataset.population.find(stats => stats.columnIndex === 2)?.categories).toBeUndefined();
    });
});

describe('robust mode', () => {
    it('flags a group whose median moved, measured against whole-result quartiles', () => {
        const rows: Row[] = [];
        // The base group is large so the whole-result median stays with it; the shifted group is judged against that.
        for (let i = 0; i < 400; i++) rows.push(['BASE', 100 + (i % 20), 'X']);
        for (let i = 0; i < 100; i++) rows.push(['SHIFT', 150 + (i % 20), 'Y']);
        const dataset = applyAnomalies(datasetOf(rows, true), { sensitivity: 'normal', minGroupRows: 5, mode: 'robust' });
        const flags = flagsOf(dataset, '["SHIFT"]', 'MEAN_SHIFT');
        expect(flags.length).toBe(1);
        expect(flags[0].evidence.method).toContain('median');
        expect(flags[0].evidence.baseline).toBe('robust');
    });

    it('flags nothing without a robust scale (zero IQR)', () => {
        const rows: Row[] = [];
        for (let i = 0; i < 100; i++) rows.push([i < 50 ? 'A' : 'B', 42, 'X']);
        const dataset = applyAnomalies(datasetOf(rows, true), { sensitivity: 'high', minGroupRows: 5, mode: 'robust' });
        for (const group of dataset.groups) {
            expect(group.flags.filter(flag => flag.rule === 'MEAN_SHIFT' || flag.rule === 'RANGE_OUTLIER')).toHaveLength(0);
        }
    });
});

describe('peer mode', () => {
    function peerRows(groups: number, deviant: boolean): Row[] {
        const rows: Row[] = [];
        for (let g = 0; g < groups; g++) {
            for (let i = 0; i < 30; i++) {
                const isDeviant = deviant && g === groups - 1;
                rows.push([`G${g}`, isDeviant ? 500 + i : 100 + (i % 5), 'X']);
            }
        }
        return rows;
    }

    it('judges a deviant group against the typical group', () => {
        const dataset = applyAnomalies(datasetOf(peerRows(PEER_MIN_GROUPS, true)), { sensitivity: 'normal', minGroupRows: 5, mode: 'peer' });
        const deviant = flagsOf(dataset, '["G7"]', 'MEAN_SHIFT');
        expect(deviant.length).toBe(1);
        expect(deviant[0].evidence.baseline).toBe('peer');
        expect(deviant[0].evidence.baselineSize).toBe(PEER_MIN_GROUPS);
        expect(flagsOf(dataset, '["G0"]', 'MEAN_SHIFT')).toHaveLength(0);
    });

    it('does not run without enough qualifying groups', () => {
        const dataset = applyAnomalies(datasetOf(peerRows(PEER_MIN_GROUPS - 1, true)), { sensitivity: 'normal', minGroupRows: 5, mode: 'peer' });
        for (const group of dataset.groups) {
            expect(group.flags.filter(flag => flag.rule === 'MEAN_SHIFT' || flag.rule === 'RANGE_OUTLIER')).toHaveLength(0);
        }
    });

    it('uses a scale floor, so a tight peer set cannot make every group an outlier', () => {
        const metric = peerMetric([10, 10, 10, 10, 10, 10, 10, 10], 0);
        expect(metric).not.toBeNull();
        expect(metric!.scale).toBeGreaterThan(0);
        expect(peerZ(10.2, metric!)).toBeLessThan(3.5);
        expect(peerMetric([1, 2, 3], 0)).toBeNull();
    });
});

describe('reference mode', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 60; i++) rows.push(['REF', 100 + (i % 10), 'X']);
    for (let i = 0; i < 60; i++) rows.push(['SIMILAR', 100 + (i % 10), 'X']);
    for (let i = 0; i < 60; i++) rows.push(['SHIFTED', 300 + (i % 10), 'X']);

    it('scores every group against the chosen group and never scores the reference itself', () => {
        const dataset = applyAnomalies(datasetOf(rows), { sensitivity: 'normal', minGroupRows: 5, mode: 'reference', referenceGroupKey: '["REF"]' });
        const reference = dataset.groups.find(group => group.key === '["REF"]')!;
        expect(reference.isReference).toBe(true);
        expect(reference.flags).toHaveLength(0);
        expect(reference.anomalous).toBe(false);

        const shifted = flagsOf(dataset, '["SHIFTED"]', 'MEAN_SHIFT');
        expect(shifted.length).toBe(1);
        expect(shifted[0].evidence.baseline).toBe('reference');
        expect(flagsOf(dataset, '["SIMILAR"]', 'MEAN_SHIFT')).toHaveLength(0);
    });

    it('scores nothing until a reference group is chosen', () => {
        const dataset = applyAnomalies(datasetOf(rows), { sensitivity: 'normal', minGroupRows: 5, mode: 'reference' });
        for (const group of dataset.groups) {
            expect(group.flags).toHaveLength(0);
            expect(group.isReference).toBe(false);
        }
    });
});

describe('category shift (MIX_SHIFT)', () => {
    it('reports nothing when the shares match, and something when they clearly differ', () => {
        const even = new Map([['a', 0.5], ['b', 0.5]]);
        const same = categoryShift(even, 100, even);
        expect(same.tvd).toBe(0);
        expect(same.tvd - same.floor).toBeLessThan(0.25);

        const skewed = new Map([['a', 0.9], ['b', 0.1]]);
        const shifted = categoryShift(skewed, 100, even);
        expect(shifted.tvd).toBeCloseTo(0.4, 12);
        expect(shifted.tvd - shifted.floor).toBeGreaterThanOrEqual(0.25);
        expect(shifted.largest?.value === 'a' || shifted.largest?.value === 'b').toBe(true);
    });

    it('flags a group whose category mix differs, with the largest shift as a note', () => {
        const rows: Row[] = [];
        for (let i = 0; i < 90; i++) rows.push(['MIXED', 1, 'ALPHA']);
        for (let i = 0; i < 90; i++) rows.push(['PLAIN', 1, i % 2 === 0 ? 'ALPHA' : 'BETA']);
        for (let i = 0; i < 90; i++) rows.push(['OTHER', 1, i % 2 === 0 ? 'ALPHA' : 'BETA']);
        const dataset = applyAnomalies(datasetOf(rows), { sensitivity: 'normal', minGroupRows: 5 });
        const flags = flagsOf(dataset, '["MIXED"]', 'MIX_SHIFT');
        expect(flags.length).toBe(1);
        expect(flags[0].evidence.notes?.[0]).toContain('largest shift');
        expect(flagsOf(dataset, '["PLAIN"]', 'MIX_SHIFT')).toHaveLength(0);
    });

    it('is switched off by the rule toggle without touching other flags', () => {
        const rows: Row[] = [];
        for (let i = 0; i < 90; i++) rows.push(['MIXED', 1, 'ALPHA']);
        for (let i = 0; i < 90; i++) rows.push(['PLAIN', 1, i % 2 === 0 ? 'ALPHA' : 'BETA']);
        for (let i = 0; i < 90; i++) rows.push(['OTHER', 1, i % 2 === 0 ? 'ALPHA' : 'BETA']);
        const dataset = datasetOf(rows);
        const withRule = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5 });
        const withoutRule = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, disabledRules: ['MIX_SHIFT'] });
        const others = (flags: AnomalyFlag[]): AnomalyFlag[] => flags.filter(flag => flag.rule !== 'MIX_SHIFT');
        expect(others(withoutRule.groups[0].flags)).toEqual(others(withRule.groups[0].flags));
        expect(withoutRule.groups.flatMap(group => group.flags).some(flag => flag.rule === 'MIX_SHIFT')).toBe(false);
        expect(withRule.groups.flatMap(group => group.flags).some(flag => flag.rule === 'MIX_SHIFT')).toBe(true);
    });
});

describe('rest of result and categories', () => {
    it('subtracts the group counts from the population distribution', () => {
        const rows: Row[] = [];
        for (let i = 0; i < 30; i++) rows.push(['G', 1, 'ALPHA']);
        for (let i = 0; i < 30; i++) rows.push(['H', 1, 'BETA']);
        for (let i = 0; i < 10; i++) rows.push(['H', 1, 'ALPHA']);
        const dataset = datasetOf(rows);
        const population = dataset.population.find(stats => stats.columnIndex === 2)!;
        const group = dataset.groups.find(item => item.key === '["G"]')!;
        const groupCategory = group.columns.find(stats => stats.columnIndex === 2)!;
        const baseline = restBaseline(population, groupCategory);
        const counts = Object.fromEntries((baseline?.categories ?? []).map(entry => [entry.value, entry.count]));
        expect(counts).toEqual({ ALPHA: 10, BETA: 30 });
    });

    it('never inherits the population distribution when the group distribution is unknown', () => {
        const population = { columnIndex: 2, rowCount: 20, nullCount: 0, nullRate: 0, categories: [{ value: 'A', count: 20 }] } as AnalyticalColumnStats;
        const group = { columnIndex: 2, rowCount: 5, nullCount: 0, nullRate: 0 } as AnalyticalColumnStats;
        expect(restBaseline(population, group)?.categories).toBeUndefined();
    });
});
