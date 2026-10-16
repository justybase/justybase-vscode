import { applyAnomalies, SCORE_DIVISOR, severityForStrength } from '../analytical/anomalyRules';
import {
    addGroupColumn,
    buildSchemaKey,
    reconcileSelection,
    removeGroupColumn,
    sanitizeState,
    sortGroups,
    suggestGroupColumns,
} from '../analytical/analyticalState';
import {
    ANALYTICAL_MAX_GROUP_COLUMNS,
    ANALYTICAL_SCORE_ANOMALOUS,
    type AnalyticalColumnStats,
    type AnalyticalDataset,
    type AnalyticalGroup,
    type AnalyticalPersistedState,
    createDefaultAnalyticalState,
} from '../analytical/types';

type StatsOverrides = Partial<AnalyticalColumnStats>;

function stats(columnIndex: number, role: AnalyticalColumnStats['role'], overrides: StatsOverrides = {}): AnalyticalColumnStats {
    return {
        columnIndex,
        name: `C${columnIndex}`,
        role,
        rowCount: 100,
        nullCount: 0,
        nullRate: 0,
        distinctCount: 10,
        distinctApprox: false,
        topValues: [],
        ...overrides,
    };
}

function group(key: string, rowCount: number, columns: AnalyticalColumnStats[]): AnalyticalGroup {
    return {
        key,
        values: [key],
        label: key,
        rowCount,
        share: 0,
        columns,
        flags: [],
        score: 0,
        anomalous: false,
    };
}

function dataset(population: AnalyticalColumnStats[], groups: AnalyticalGroup[]): AnalyticalDataset {
    return {
        mode: 'memory',
        groupColumns: [{ index: 9, name: 'G' }],
        totalRows: groups.reduce((sum, item) => sum + item.rowCount, 0),
        examinedRows: groups.reduce((sum, item) => sum + item.rowCount, 0),
        population,
        groups,
        totalGroups: groups.length,
        unlistedRows: 0,
        groupsTruncated: false,
        analyzedColumnsTruncated: false,
        excludedColumns: [9],
    };
}

const measurePopulation = stats(1, 'measure', {
    numeric: { count: 1000, min: 70, max: 130, mean: 100, stddev: 10, cv: 0.1 },
});

function flagsFor(result: AnalyticalDataset, key: string) {
    return result.groups.find(item => item.key === key)?.flags ?? [];
}

describe('numeric anomaly rules', () => {
    it('flags a far group with mean shift and range outlier, and not a close group', () => {
        const far = group('far', 50, [stats(1, 'measure', {
            numeric: { count: 50, min: 150, max: 250, mean: 200, stddev: 10, cv: 0.05 },
        })]);
        const close = group('close', 50, [stats(1, 'measure', {
            numeric: { count: 50, min: 80, max: 120, mean: 101, stddev: 10, cv: 0.1 },
        })]);
        const result = applyAnomalies(dataset([measurePopulation], [far, close]), { sensitivity: 'normal', minGroupRows: 5 });

        const farRules = flagsFor(result, 'far').map(item => item.rule);
        expect(farRules).toEqual(expect.arrayContaining(['MEAN_SHIFT', 'RANGE_OUTLIER']));
        expect(flagsFor(result, 'close')).toEqual([]);
    });

    it('flags high variability when the coefficient of variation is at least 3x and 0.5', () => {
        const spread = group('spread', 50, [stats(1, 'measure', {
            numeric: { count: 50, min: 100, max: 100, mean: 100, stddev: 60, cv: 0.6 },
        })]);
        const result = applyAnomalies(dataset([measurePopulation], [spread]), { sensitivity: 'normal', minGroupRows: 5 });
        expect(flagsFor(result, 'spread').map(item => item.rule)).toContain('HIGH_VARIABILITY');
    });

    it('applies sensitivity to the mean-shift effect size threshold', () => {
        // effect size 0.8 sigma: below the normal threshold (1.0) but above the high threshold (0.67).
        const mild = group('mild', 50, [stats(1, 'measure', {
            numeric: { count: 50, min: 90, max: 110, mean: 108, stddev: 10, cv: 0.09 },
        })]);
        const normal = applyAnomalies(dataset([measurePopulation], [mild]), { sensitivity: 'normal', minGroupRows: 5 });
        const high = applyAnomalies(dataset([measurePopulation], [mild]), { sensitivity: 'high', minGroupRows: 5 });
        expect(flagsFor(normal, 'mild').map(item => item.rule)).not.toContain('MEAN_SHIFT');
        expect(flagsFor(high, 'mild').map(item => item.rule)).toContain('MEAN_SHIFT');
    });
});

describe('null rate and constant rules', () => {
    it('flags a null-rate delta and treats a near-all-null group against a mostly filled population as strongest', () => {
        const population = stats(2, 'dimension', { nullRate: 0.1 });
        const nullHeavy = group('n', 50, [stats(2, 'dimension', { nullRate: 0.97, nullCount: 48, rowCount: 50 })]);
        const result = applyAnomalies(dataset([population], [nullHeavy]), { sensitivity: 'normal', minGroupRows: 5 });
        const flag = flagsFor(result, 'n').find(item => item.rule === 'NULL_RATE_DELTA');
        expect(flag?.strength).toBe(1);
        expect(flag?.severity).toBe('high');
    });

    it('flags a constant group when population has at least three distinct values', () => {
        const population = stats(3, 'dimension', { distinctCount: 3 });
        const constant = group('c', 20, [stats(3, 'dimension', { rowCount: 20, distinctCount: 1, topValues: [{ value: 'OK', count: 20 }] })]);
        const small = group('s', 5, [stats(3, 'dimension', { rowCount: 5, distinctCount: 1, topValues: [{ value: 'OK', count: 5 }] })]);
        const result = applyAnomalies(dataset([population], [constant, small]), { sensitivity: 'normal', minGroupRows: 5 });
        expect(flagsFor(result, 'c').map(item => item.rule)).toContain('CONSTANT_IN_GROUP');
        expect(flagsFor(result, 's').map(item => item.rule)).not.toContain('CONSTANT_IN_GROUP');
    });
});

describe('dominance and date rules', () => {
    it('flags a dominant value only when its lift over the population clears the scaled threshold', () => {
        // group share 0.9 vs population 0.6 -> lift 0.3: below normal (0.4), above high (0.268).
        const population = stats(4, 'dimension', {
            rowCount: 1000,
            nullCount: 0,
            distinctCount: 3,
            topValues: [{ value: 'OK', count: 600 }, { value: 'ERR', count: 400 }],
        });
        const dominant = group('d', 100, [stats(4, 'dimension', {
            rowCount: 100,
            distinctCount: 2,
            topValues: [{ value: 'OK', count: 90 }, { value: 'ERR', count: 10 }],
        })]);
        const normal = applyAnomalies(dataset([population], [dominant]), { sensitivity: 'normal', minGroupRows: 5 });
        const high = applyAnomalies(dataset([population], [dominant]), { sensitivity: 'high', minGroupRows: 5 });
        expect(flagsFor(normal, 'd').map(item => item.rule)).not.toContain('TOP_VALUE_DOMINANCE');
        expect(flagsFor(high, 'd').map(item => item.rule)).toContain('TOP_VALUE_DOMINANCE');
    });

    it('flags date windows that end early or start late relative to the population span', () => {
        const population = stats(5, 'date', { date: { min: '2024-01-01', max: '2024-12-31' } });
        const early = group('early', 20, [stats(5, 'date', { date: { min: '2024-01-01', max: '2024-03-01' } })]);
        const late = group('late', 20, [stats(5, 'date', { date: { min: '2024-10-01', max: '2024-12-31' } })]);
        const typical = group('typical', 20, [stats(5, 'date', { date: { min: '2024-01-01', max: '2024-12-31' } })]);
        const result = applyAnomalies(dataset([population], [early, late, typical]), { sensitivity: 'normal', minGroupRows: 5 });
        expect(flagsFor(result, 'early')[0]?.message).toContain('ends early');
        expect(flagsFor(result, 'late')[0]?.message).toContain('starts late');
        expect(flagsFor(result, 'typical')).toEqual([]);
    });
});

describe('group size rules and scoring', () => {
    it('flags a group far smaller than the median listed group', () => {
        const groups = [20, 20, 20, 20, 20, 1].map((size, index) => group(`g${index}`, size, []));
        const result = applyAnomalies(dataset([], groups), { sensitivity: 'normal', minGroupRows: 1 });
        expect(flagsFor(result, 'g5').map(item => item.rule)).toContain('SMALL_GROUP');
        expect(flagsFor(result, 'g0').map(item => item.rule)).not.toContain('SMALL_GROUP');
    });

    it('does not evaluate rules for groups below the minimum group size', () => {
        const far = group('tiny', 3, [stats(1, 'measure', {
            rowCount: 3,
            numeric: { count: 3, min: 900, max: 1000, mean: 950, stddev: 10, cv: 0.01 },
        })]);
        const result = applyAnomalies(dataset([measurePopulation], [far]), { sensitivity: 'normal', minGroupRows: 5 });
        expect(result.groups[0].flags).toEqual([]);
        expect(result.groups[0].score).toBe(0);
        expect(result.groups[0].anomalous).toBe(false);
    });

    it('marks a group anomalous only at or above the score threshold, and sorts flags by strength', () => {
        const weak = group('weak', 50, [stats(1, 'measure', {
            rowCount: 50,
            numeric: { count: 50, min: 80, max: 120, mean: 100, stddev: 10, cv: 0.1 },
        })]);
        const weakResult = applyAnomalies(dataset([measurePopulation], [weak]), { sensitivity: 'normal', minGroupRows: 5 });
        expect(weakResult.groups[0].anomalous).toBe(false);
        expect(ANALYTICAL_SCORE_ANOMALOUS).toBe(25);

        const strong = group('strong', 50, [
            stats(1, 'measure', { rowCount: 50, numeric: { count: 50, min: 150, max: 250, mean: 200, stddev: 10, cv: 0.05 } }),
            stats(2, 'dimension', { rowCount: 50, nullRate: 1, nullCount: 50 }),
        ]);
        const strongResult = applyAnomalies(
            dataset([measurePopulation, stats(2, 'dimension', { nullRate: 0 })], [strong]),
            { sensitivity: 'normal', minGroupRows: 5 },
        );
        const strongGroup = strongResult.groups[0];
        expect(strongGroup.anomalous).toBe(true);
        expect(strongGroup.score).toBeGreaterThanOrEqual(ANALYTICAL_SCORE_ANOMALOUS);
        const strengths = strongGroup.flags.map(item => item.strength);
        expect(strengths).toEqual([...strengths].sort((a, b) => b - a));
    });

    it('saturates the score with diminishing returns', () => {
        const info = severityForStrength(0.25);
        expect(info).toBe('info');
        expect(severityForStrength(0.4)).toBe('warn');
        expect(severityForStrength(0.8)).toBe('high');
        expect(SCORE_DIVISOR).toBe(6);
    });
});

describe('group suggestions', () => {
    const columns = [
        { index: 0, name: 'REGION', role: 'dimension' as const },
        { index: 1, name: 'ID', role: 'dimension' as const },
        { index: 2, name: 'AMOUNT', role: 'measure' as const },
        { index: 3, name: 'STATUS', role: 'dimension' as const },
    ];

    it('suggests low-cardinality dimensions ordered by cardinality, skipping near-unique and measures', () => {
        const sample: unknown[][] = [];
        for (let i = 0; i < 40; i++) {
            sample.push([i % 2 === 0 ? 'EMEA' : 'US', `row-${i}`, i, i % 4 === 0 ? 'OK' : 'ERR']);
        }
        const suggestions = suggestGroupColumns(columns, sample).map(column => column.name);
        // Both have two distinct values; the tie breaks on column index, and the ID column is near-unique.
        expect(suggestions).toEqual(['REGION', 'STATUS']);
    });

    it('falls back to role-based candidates when the sample is too small', () => {
        const suggestions = suggestGroupColumns(columns, []).map(column => column.name);
        expect(suggestions).toEqual(['REGION', 'ID', 'STATUS']);
    });
});

describe('persisted state', () => {
    const columns = [
        { index: 0, name: 'REGION', type: 'varchar' },
        { index: 1, name: 'AMOUNT', type: 'numeric' },
        { index: 2, name: 'STATUS', type: 'varchar' },
        { index: 3, name: 'DAY', type: 'date' },
    ];
    const schemaKey = buildSchemaKey(columns);

    it('falls back to defaults for unknown or malformed raw state', () => {
        expect(sanitizeState(undefined, schemaKey, columns)).toEqual({ ...createDefaultAnalyticalState(), schemaKey });
        expect(sanitizeState({ version: 2 }, schemaKey, columns).groupColumns).toEqual([]);
    });

    it('drops group columns whose index or name no longer match the schema', () => {
        const raw = {
            version: 1,
            groupColumns: [
                { index: 0, name: 'REGION' },
                { index: 1, name: 'RENAMED' },
                { index: 0, name: 'REGION' },
            ],
            sort: { key: 'score', desc: false },
            sensitivity: 'high',
            minGroupRows: 7,
            anomaliesOnly: true,
        };
        const state = sanitizeState(raw, schemaKey, columns);
        expect(state.groupColumns).toEqual([{ index: 0, name: 'REGION' }]);
        expect(state.sort).toEqual({ key: 'score', desc: false });
        expect(state.sensitivity).toBe('high');
        expect(state.minGroupRows).toBe(7);
        expect(state.anomaliesOnly).toBe(true);
    });

    it('rejects out-of-range enums and row thresholds', () => {
        const state = sanitizeState({ version: 1, sort: { key: 'evil' }, sensitivity: 'extreme', minGroupRows: 1e9 }, schemaKey, columns);
        expect(state.sort.key).toBe('size');
        expect(state.sensitivity).toBe('normal');
        expect(state.minGroupRows).toBe(5);
    });

    it('caps grouping at the maximum number of columns and removes by index', () => {
        let state: AnalyticalPersistedState = createDefaultAnalyticalState();
        for (const column of columns) {
            state = addGroupColumn(state, column);
        }
        expect(state.groupColumns).toHaveLength(ANALYTICAL_MAX_GROUP_COLUMNS);
        expect(state.groupColumns.map(ref => ref.index)).toEqual([0, 1, 2]);
        state = removeGroupColumn(state, 1);
        expect(state.groupColumns.map(ref => ref.index)).toEqual([0, 2]);
    });

    it('keeps the selection only while the group still exists, otherwise the first listed group', () => {
        const groups = [group('a', 10, []), group('b', 5, [])];
        expect(reconcileSelection('b', groups)).toBe('b');
        expect(reconcileSelection('gone', groups)).toBe('a');
        expect(reconcileSelection('a', [])).toBeUndefined();
    });

    it('sorts by size, score and name with stable tie breaks', () => {
        const a = { ...group('a', 10, []), score: 40, label: 'b-label' };
        const b = { ...group('b', 30, []), score: 10, label: 'a-label' };
        const c = { ...group('c', 10, []), score: 40, label: 'a-label' };
        const bySize = sortGroups([a, b, c], { key: 'size', desc: true }).map(item => item.key);
        expect(bySize).toEqual(['b', 'a', 'c']);
        const byScore = sortGroups([a, b, c], { key: 'score', desc: true }).map(item => item.key);
        expect(byScore).toEqual(['a', 'c', 'b']);
        const byName = sortGroups([a, b, c], { key: 'name', desc: false }).map(item => item.key);
        expect(byName).toEqual(['b', 'c', 'a']);
    });
});
