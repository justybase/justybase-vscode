import { applyAnomalies, restBaseline } from '../analytical/anomalyRules';
import { computeGroupStatsSync } from '../analytical/computeGroupStats';
import { buildSchemaKey, sanitizeState } from '../analytical/analyticalState';
import { createDefaultAnalyticalState, type AnalyticalColumnStats } from '../analytical/types';

const COLUMNS = [
    { index: 0, name: 'REGION', role: 'dimension' as const },
    { index: 1, name: 'AMOUNT', role: 'measure' as const },
    { index: 2, name: 'CODE', role: 'dimension' as const },
];

/** Deterministic pseudo-random generator so the property-style checks are reproducible. */
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function numericColumn(values: readonly (number | null)[]) {
    const present = values.filter((value): value is number => value !== null);
    const count = present.length;
    const mean = present.reduce((sum, value) => sum + value, 0) / count;
    const stddev = Math.sqrt(present.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count);
    return { count, mean, stddev };
}

describe('restBaseline (leave-one-out)', () => {
    it('matches a brute-force recomputation of the rest of the result', () => {
        const random = seeded(42);
        for (let trial = 0; trial < 25; trial++) {
            const rows: unknown[][] = [];
            const groupCount = 3 + Math.floor(random() * 3);
            for (let i = 0; i < 200; i++) {
                const region = `R${Math.floor(random() * groupCount)}`;
                const amount = random() < 0.1 ? null : Math.round(random() * 1000) / 10;
                rows.push([region, amount, `C${Math.floor(random() * 4)}`]);
            }
            const dataset = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'REGION' }] });
            const population = dataset.population.find(column => column.columnIndex === 1);
            if (!population) continue;
            for (const group of dataset.groups) {
                const groupStats = group.columns.find(column => column.columnIndex === 1);
                if (!groupStats) continue;
                const restRows = rows.filter(row => `["${row[0]}"]` !== group.key && JSON.stringify([String(row[0])]) !== group.key);
                const restValues = restRows.map(row => row[1] as number | null);
                const expected = numericColumn(restValues);
                const actual = restBaseline(population, groupStats);
                if (expected.count < 10) {
                    expect(actual === null || actual.numeric === undefined).toBe(true);
                    continue;
                }
                expect(actual?.numeric?.count).toBe(expected.count);
                expect(actual?.numeric?.mean).toBeCloseTo(expected.mean, 9);
                expect(actual?.numeric?.stddev).toBeCloseTo(expected.stddev, 7);
            }
        }
    });

    it('returns no baseline when too few rows remain outside the group', () => {
        const population = { columnIndex: 1, name: 'AMOUNT', role: 'measure', rowCount: 12, nullCount: 0, nullRate: 0, distinctCount: 12, distinctApprox: false, topValues: [], numeric: { count: 12, min: 0, max: 1, mean: 0.5, stddev: 0.3, cv: 0.6 } } as AnalyticalColumnStats;
        const group = { ...population, rowCount: 5, numeric: { count: 5, min: 0, max: 1, mean: 0.5, stddev: 0.3, cv: 0.6 } } as AnalyticalColumnStats;
        expect(restBaseline(population, group)).toBeNull();
    });
});

describe('rest-of-result mode', () => {
    it('reports a larger effect than the whole result for a dominant group, with evidence naming the baseline', () => {
        const rows: unknown[][] = [];
        for (let i = 0; i < 60; i++) rows.push(['A', 100 + (i % 3), 'C1']);
        for (let i = 0; i < 60; i++) rows.push(['B', 1000 + (i % 3), 'C2']);
        for (let i = 0; i < 60; i++) rows.push(['C', 100 + (i % 3), 'C1']);
        const dataset = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'REGION' }] });

        const whole = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, mode: 'whole' });
        const rest = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, mode: 'rest' });
        const wholeMean = whole.groups.find(group => group.values[0] === 'B')?.flags.find(flag => flag.rule === 'MEAN_SHIFT');
        const restMean = rest.groups.find(group => group.values[0] === 'B')?.flags.find(flag => flag.rule === 'MEAN_SHIFT');

        expect(restMean).toBeDefined();
        expect(restMean?.evidence.baseline).toBe('rest');
        expect(restMean?.evidence.effectUnit).toBe('sigma');
        expect(wholeMean?.evidence.baseline).toBe('whole');
        expect(restMean!.evidence.effect!).toBeGreaterThan(wholeMean?.evidence.effect ?? 0);
    });

    it('attaches complete evidence to every flag it produces', () => {
        const rows: unknown[][] = [];
        for (let i = 0; i < 80; i++) rows.push([`G${i % 4}`, i % 4 === 3 ? 5000 + i : 100 + (i % 5), i % 4 === 3 ? 'C9' : 'C1']);
        const dataset = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'REGION' }] });
        for (const mode of ['whole', 'rest'] as const) {
            const scored = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, mode });
            for (const group of scored.groups) {
                for (const flag of group.flags) {
                    expect(flag.evidence.method.length).toBeGreaterThan(0);
                    expect(flag.evidence.sampleSize).toBeGreaterThan(0);
                    expect(flag.evidence.observedLabel.length).toBeGreaterThan(0);
                    expect(flag.evidence.expectedLabel.length).toBeGreaterThan(0);
                    expect(flag.evidence.baseline).toBe(mode);
                }
            }
        }
    });
});

describe('RARE_VALUE', () => {
    it('flags values that occur in exactly one group and at most three times, and nothing else', () => {
        const rows: unknown[][] = [];
        const shared = ['S1', 'S2', 'S3', 'S4'];
        for (let i = 0; i < 120; i++) {
            const region = ['G1', 'G2', 'G3'][i % 3];
            let code = shared[i % shared.length];
            if (region === 'G3' && i === 2) code = 'Z9';
            if (region === 'G3' && i === 5) code = 'Z9';
            if (region === 'G1' && i === 3) code = 'Y1';
            rows.push([region, 10, code]);
        }
        const dataset = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'REGION' }] });
        const scored = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5 });

        const g3 = scored.groups.find(group => group.values[0] === 'G3');
        const g1 = scored.groups.find(group => group.values[0] === 'G1');
        const g2 = scored.groups.find(group => group.values[0] === 'G2');
        const g3Rare = g3?.flags.find(flag => flag.rule === 'RARE_VALUE');
        expect(g3Rare?.message).toContain('Z9');
        expect(g3Rare?.evidence.observed).toBe(1);
        expect(g1?.flags.find(flag => flag.rule === 'RARE_VALUE')?.message).toContain('Y1');
        expect(g2?.flags.some(flag => flag.rule === 'RARE_VALUE')).toBe(false);
        // Rare values are informational by design and cannot make a group anomalous on their own.
        expect(g3Rare?.severity).toBe('info');
        expect(g3?.anomalous).toBe(false);
    });
});

describe('user options', () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 90; i++) rows.push([`G${i % 3}`, i % 3 === 2 ? 4000 : 100 + (i % 4), i % 3 === 2 ? 'C9' : 'C1']);
    const dataset = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: [{ index: 0, name: 'REGION' }] });

    it('removes a disabled rule from every group without recomputing the dataset', () => {
        const baseline = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5 });
        const withoutMean = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, disabledRules: ['MEAN_SHIFT'] });
        expect(baseline.groups.some(group => group.flags.some(flag => flag.rule === 'MEAN_SHIFT'))).toBe(true);
        expect(withoutMean.groups.some(group => group.flags.some(flag => flag.rule === 'MEAN_SHIFT'))).toBe(false);
        // The raw dataset is untouched, so re-enabling the rule restores the original result.
        expect(dataset.groups.every(group => group.flags.length === 0)).toBe(true);
    });

    it('drops excluded columns from the population and from every group', () => {
        const scored = applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, excludedColumns: [1] });
        expect(scored.population.map(column => column.columnIndex)).not.toContain(1);
        for (const group of scored.groups) {
            expect(group.columns.map(column => column.columnIndex)).not.toContain(1);
            expect(group.flags.every(flag => flag.columnIndex !== 1)).toBe(true);
        }
    });
});

describe('persisted state v2', () => {
    const schema = [
        { index: 0, name: 'REGION', type: 'varchar' },
        { index: 1, name: 'AMOUNT', type: 'numeric' },
        { index: 2, name: 'CODE', type: 'varchar' },
    ];
    const schemaKey = buildSchemaKey(schema);

    it('migrates a version 1 state to the v2 defaults and keeps its grouping', () => {
        const migrated = sanitizeState({
            version: 1,
            groupColumns: [{ index: 0, name: 'REGION' }],
            sensitivity: 'high',
            minGroupRows: 7,
        }, schemaKey, schema);
        expect(migrated.version).toBe(2);
        expect(migrated.groupColumns).toEqual([{ index: 0, name: 'REGION' }]);
        expect(migrated.sensitivity).toBe('high');
        expect(migrated.detection).toEqual({ mode: 'default' });
        expect(migrated.disabledRules).toEqual([]);
        expect(migrated.excludedColumns).toEqual([]);
    });

    it('keeps the new detection modes and a bounded reference key', () => {
        const state = sanitizeState({
            version: 2,
            groupColumns: [{ index: 0, name: 'REGION' }],
            detection: { mode: 'reference', referenceGroupKey: '["US"]' },
        }, schemaKey, schema);
        expect(state.detection).toEqual({ mode: 'reference', referenceGroupKey: '["US"]' });
        expect(sanitizeState({ version: 2, detection: { mode: 'auto' } }, schemaKey, schema).detection).toEqual({ mode: 'auto' });
    });

    it('drops unknown rule ids and invalid excluded columns from hostile input', () => {
        const state = sanitizeState({
            version: 2,
            groupColumns: [{ index: 0, name: 'REGION' }],
            detection: { mode: 'bogus', referenceGroupKey: 'x'.repeat(5000) },
            disabledRules: ['MEAN_SHIFT', 'NOT_A_RULE', 'MEAN_SHIFT'],
            excludedColumns: [
                { index: 1, name: 'AMOUNT' },
                { index: 1, name: 'AMOUNT' },
                { index: 0, name: 'REGION' },
                { index: 2, name: 'RENAMED' },
            ],
        }, schemaKey, schema);
        expect(state.detection).toEqual({ mode: 'default' });
        expect(state.disabledRules).toEqual(['MEAN_SHIFT']);
        expect(state.excludedColumns).toEqual([{ index: 1, name: 'AMOUNT' }]);
    });

    it('defaults the v2 fields when building a fresh state', () => {
        expect(createDefaultAnalyticalState()).toMatchObject({
            version: 2,
            detection: { mode: 'default' },
            disabledRules: [],
            excludedColumns: [],
        });
    });
});
