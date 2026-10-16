import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteResultStore } from '../../../core/resultDataProvider/sqliteResultStore';
import type { DiskGroupStatsResult } from '../../../core/resultDataProvider/types';
import { applyAnomalies } from '../../../../media/resultPanel/analytical/anomalyRules';
import { buildDiskGroupDataset, DISK_STAT_BATCH_COLUMNS, type AnalysisColumn } from '../../../../media/resultPanel/analytical/diskAdapter';
import { computeGroupStatsSync } from '../../../../media/resultPanel/analytical/computeGroupStats';
import type { AnalyticalColumnStats, AnalyticalDataset } from '../../../../media/resultPanel/analytical/types';

function isNodeSqliteAvailable(): boolean {
    try {
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

/** Same column order as the store; roles are fixed here because classification is covered elsewhere. */
const COLUMNS: AnalysisColumn[] = [
    { index: 0, name: 'region', role: 'dimension' },
    { index: 1, name: 'amount', role: 'measure' },
    { index: 2, name: 'status', role: 'dimension' },
    { index: 3, name: 'epoch', role: 'measure' },
    { index: 4, name: 'day', role: 'dimension' },
];
const COLUMN_TYPES = ['VARCHAR', 'NUMERIC', 'VARCHAR', 'BIGINT', 'VARCHAR'];
const GROUP = [{ index: 0, name: 'region' }];

function buildRows(): unknown[][] {
    const rows: unknown[][] = [];
    const regions: Array<string | null> = ['EMEA', 'US', 'APAC', null];
    for (let i = 0; i < 400; i++) {
        const spike = i % 17 === 0 && regions[i % regions.length] === 'US';
        rows.push([
            regions[i % regions.length],
            spike ? 5000 + (i % 5) : ((i * 37) % 101),
            i % 5 === 0 ? 'ERR' : (i % 3 === 0 ? 'WARN' : 'OK'),
            1_700_000_000_000 + (i % 11),
            `2024-01-${String(1 + (i % 9)).padStart(2, '0')}`,
        ]);
    }
    return rows;
}

/** Runs the real SQL path exactly as the webview does: column batches, merged by the adapter. */
function oracleStddev(values: number[]): number {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function diskDatasetFor(store: SqliteResultStore): AnalyticalDataset {
    const statColumns = COLUMNS.filter(column => !GROUP.some(ref => ref.name === column.name)).map(column => column.index);
    const batches: DiskGroupStatsResult[] = [];
    for (let start = 0; start < statColumns.length; start += DISK_STAT_BATCH_COLUMNS) {
        const batch = statColumns.slice(start, start + DISK_STAT_BATCH_COLUMNS);
        batches.push(store.queryGroupStats({
            groupColumns: [0],
            statColumns: batch,
            limit: 500,
            topColumns: batch.filter(index => COLUMNS[index].role === 'dimension'),
            topLimit: 8,
        }));
    }
    return buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches });
}

describeIfSqlite('disk-backed analysis equals the in-memory engine', () => {
    const tempPaths: string[] = [];
    let store: SqliteResultStore | undefined;
    let rows: unknown[][];

    beforeEach(() => {
        rows = buildRows();
        const dbPath = path.join(os.tmpdir(), `justybase-equivalence-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
        tempPaths.push(dbPath);
        store = SqliteResultStore.create(
            COLUMN_TYPES.map((type, index) => ({ name: COLUMNS[index].name, type })),
            1000,
            dbPath,
        );
        store.insertRows(rows);
        store.finalizeBulkInsert();
    });

    afterEach(() => {
        store?.dispose();
        store = undefined;
        for (const tempPath of tempPaths.splice(0)) {
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch {
                // ignore cleanup failures
            }
        }
    });

    it('produces the same groups, population and per-group statistics', () => {
        const memory = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: GROUP });
        const disk = diskDatasetFor(store!);

        expect(disk.totalRows).toBe(memory.totalRows);
        expect(disk.totalGroups).toBe(memory.totalGroups);
        expect(disk.groups.map(group => [group.key, group.rowCount])).toEqual(
            memory.groups.map(group => [group.key, group.rowCount]),
        );
        expect(disk.population.map(column => column.columnIndex)).toEqual(memory.population.map(column => column.columnIndex));

        for (const [position, group] of memory.groups.entries()) {
            const diskGroup = disk.groups[position];
            expect(diskGroup.columns.map(column => column.columnIndex)).toEqual(group.columns.map(column => column.columnIndex));
            for (const [columnPosition, column] of group.columns.entries()) {
                const other = diskGroup.columns[columnPosition];
                expect(other.rowCount - other.nullCount).toBe(column.rowCount - column.nullCount);
                // The in-memory engine caps distinct tracking per group (approximate past the cap);
                // the disk path counts exactly, so it can only be larger when memory is approximate.
                if (column.distinctApprox) {
                    expect(other.distinctCount).toBeGreaterThanOrEqual(column.distinctCount);
                } else {
                    expect(other.distinctCount).toBe(column.distinctCount);
                }
                if (column.numeric) {
                    // Oracle on exact integer differences from the first value of the group. Magnitudes around
                    // 1.7e12 have a double spacing of about 2e-4, so the absolute tolerances reflect that floor.
                    const values = rows
                        .filter(row => JSON.stringify([row[0] === null ? null : String(row[0])]) === group.key)
                        .map(row => Number(row[column.columnIndex]));
                    const base = values[0];
                    const deltas = values.map(value => value - base);
                    const deltaMean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
                    expect(other.numeric?.mean).toBeCloseTo(base + deltaMean, 0);
                    expect(Math.abs((other.numeric?.mean ?? NaN) - (base + deltaMean))).toBeLessThan(1e-3);
                    expect(Math.abs((column.numeric.mean) - (base + deltaMean))).toBeLessThan(1e-3);
                    const expectedStddev = oracleStddev(deltas);
                    // The disk path shifts by the population mean and is tight; the in-memory Welford update is looser.
                    expect(other.numeric?.stddev).toBeCloseTo(expectedStddev, 6);
                    expect(column.numeric.stddev).toBeCloseTo(expectedStddev, 4);
                }
            }
        }
    });

    it('produces the same anomaly flags and scores for every group', () => {
        const memory = applyAnomalies(computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: GROUP }), {
            sensitivity: 'normal',
            minGroupRows: 5,
        });
        const disk = applyAnomalies(diskDatasetFor(store!), { sensitivity: 'normal', minGroupRows: 5 });

        const summarize = (dataset: AnalyticalDataset) => dataset.groups.map(group => ({
            key: group.key,
            score: group.score,
            anomalous: group.anomalous,
            rules: group.flags.map(flag => `${flag.rule}:${flag.columnIndex ?? '-'}`).sort(),
        }));
        expect(summarize(disk)).toEqual(summarize(memory));
        expect(disk.groups.some(group => group.anomalous)).toBe(true);
    });

    it('lists the same groups when the size limit cuts through a tie', () => {
        // Four groups of equal size make the cut depend purely on the tie-break, which must match.
        const memory = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: GROUP, maxGroups: 2 });
        const batch = store!.queryGroupStats({ groupColumns: [0], statColumns: [], limit: 2 });
        const disk = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [batch] });
        expect(disk.groups.map(group => group.key)).toEqual(memory.groups.map(group => group.key));
        expect(disk.unlistedRows).toBe(memory.unlistedRows);
    });

    it('merges column batches the same way whichever batch arrives first', () => {
        const first = store!.queryGroupStats({ groupColumns: [0], statColumns: [1, 3], limit: 500 });
        const second = store!.queryGroupStats({ groupColumns: [0], statColumns: [2, 4], limit: 500 });
        const forward = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [first, second] });
        const backward = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [second, first] });

        expect(backward.groups.map(group => group.key)).toEqual(forward.groups.map(group => group.key));
        const columnsOf = (dataset: AnalyticalDataset) => dataset.groups.map(group => group.columns
            .map(column => column.columnIndex)
            .sort((a, b) => a - b));
        expect(columnsOf(backward)).toEqual(columnsOf(forward));
    });

    it('computes the same quartiles and category distributions as the in-memory engine', () => {
        const memory = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: GROUP, quantiles: true });
        const statColumns = [1, 2, 3, 4];
        const batches: DiskGroupStatsResult[] = [];
        for (let start = 0; start < statColumns.length; start += DISK_STAT_BATCH_COLUMNS) {
            const batch = statColumns.slice(start, start + DISK_STAT_BATCH_COLUMNS);
            batches.push(store!.queryGroupStats({
                groupColumns: [0],
                statColumns: batch,
                limit: 500,
                quantileColumns: batch.filter(index => COLUMNS[index].role === 'measure'),
                categoryColumns: batch.filter(index => COLUMNS[index].role === 'dimension'),
            }));
        }
        const disk = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches, quantiles: true });
        expect(disk.coverage).toEqual({ quantiles: true });

        const quartilesOf = (stats: AnalyticalColumnStats | undefined) => stats?.numeric?.quartiles;
        const categoriesOf = (stats: AnalyticalColumnStats | undefined) => stats?.categories
            ? Object.fromEntries(stats.categories.map(entry => [String(entry.value), entry.count]))
            : undefined;
        let quartileChecks = 0;
        for (const column of memory.population) {
            const other = disk.population.find(item => item.columnIndex === column.columnIndex);
            expect(quartilesOf(other)).toEqual(quartilesOf(column));
            expect(categoriesOf(other)).toEqual(categoriesOf(column));
            if (quartilesOf(column)) quartileChecks += 1;
        }
        expect(quartileChecks).toBeGreaterThan(0);
        for (const group of memory.groups) {
            const diskGroup = disk.groups.find(item => item.key === group.key)!;
            for (const column of group.columns) {
                const other = diskGroup.columns.find(item => item.columnIndex === column.columnIndex)!;
                expect(quartilesOf(other)).toEqual(quartilesOf(column));
                expect(categoriesOf(other)).toEqual(categoriesOf(column));
            }
        }
    });

    it('scores robust and category-shift flags identically on memory and disk', () => {
        const memory = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: GROUP, quantiles: true });
        const batches: DiskGroupStatsResult[] = [];
        for (const batch of [[1, 2, 3, 4]]) {
            batches.push(store!.queryGroupStats({
                groupColumns: [0],
                statColumns: batch,
                limit: 500,
                quantileColumns: batch.filter(index => COLUMNS[index].role === 'measure'),
                categoryColumns: batch.filter(index => COLUMNS[index].role === 'dimension'),
            }));
        }
        const disk = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches, quantiles: true });
        const summarize = (dataset: AnalyticalDataset) => applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, mode: 'robust' }).groups.map(group => ({
            key: group.key,
            score: group.score,
            flags: group.flags.map(flag => [flag.rule, flag.columnIndex, flag.severity, flag.message]),
        }));
        expect(summarize(disk)).toEqual(summarize(memory));

        // Rest of result and reference mode are judged from the same population moments and group statistics.
        const referenceKey = memory.groups[0].key;
        const summaryFor = (dataset: AnalyticalDataset, options: { mode: 'rest' } | { mode: 'reference'; referenceGroupKey: string }) => (
            applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, ...options }).groups.map(group => ({
                key: group.key,
                anomalous: group.anomalous,
                flags: group.flags.map(flag => [flag.rule, flag.columnIndex, flag.severity]),
            }))
        );
        expect(summaryFor(disk, { mode: 'rest' })).toEqual(summaryFor(memory, { mode: 'rest' }));
        expect(summaryFor(disk, { mode: 'reference', referenceGroupKey: referenceKey }))
            .toEqual(summaryFor(memory, { mode: 'reference', referenceGroupKey: referenceKey }));

        const mixOf = (dataset: AnalyticalDataset) => applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5 }).groups.map(group => (
            group.flags.filter(flag => flag.rule === 'MIX_SHIFT').map(flag => [flag.columnIndex, flag.message])
        ));
        expect(mixOf(disk)).toEqual(mixOf(memory));
    });

    it('keeps top values for columns whose distribution came from categories when another column is counted separately', () => {
        const memory = computeGroupStatsSync({ columns: COLUMNS, rows, groupColumns: GROUP });
        // status (2) gets its top values from the category pass; day (4) goes through the separate top-values pass.
        const batch = store!.queryGroupStats({
            groupColumns: [0],
            statColumns: [2, 4],
            limit: 500,
            topColumns: [2, 4],
            topLimit: 8,
            categoryColumns: [2],
        });
        const disk = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [batch] });
        for (const group of memory.groups) {
            const diskGroup = disk.groups.find(item => item.key === group.key)!;
            for (const columnIndex of [2, 4]) {
                const expected = group.columns.find(column => column.columnIndex === columnIndex)!.topValues;
                const actual = diskGroup.columns.find(column => column.columnIndex === columnIndex)!.topValues;
                expect(actual.length).toBeGreaterThan(0);
                expect(actual.map(entry => [entry.value, entry.count])).toEqual(expected.map(entry => [entry.value, entry.count]));
            }
        }
    });

    it('treats empty strings as null-like on both the memory and the disk path', () => {
        const emptyRows: unknown[][] = [];
        for (let i = 0; i < 60; i++) {
            const status = i % 3 === 0 ? '' : (i % 3 === 1 ? 'OK' : null);
            emptyRows.push([i % 2 === 0 ? 'A' : 'B', i, status, 1_700_000_000_000 + (i % 11), '2024-01-01']);
        }
        const dbPath = path.join(os.tmpdir(), `justybase-empty-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
        tempPaths.push(dbPath);
        const emptyStore = SqliteResultStore.create(
            COLUMN_TYPES.map((type, index) => ({ name: COLUMNS[index].name, type })),
            1000,
            dbPath,
        );
        try {
            emptyStore.insertRows(emptyRows);
            emptyStore.finalizeBulkInsert();
            const memory = computeGroupStatsSync({ columns: COLUMNS, rows: emptyRows, groupColumns: GROUP });
            const batch = emptyStore.queryGroupStats({
                groupColumns: [0],
                statColumns: [2],
                limit: 500,
                topColumns: [2],
                topLimit: 8,
            });
            const disk = buildDiskGroupDataset({ columns: COLUMNS, groupColumns: GROUP, batches: [batch] });

            const nullsOf = (dataset: AnalyticalDataset) => dataset.groups.map(group => [
                group.key,
                group.columns.find(column => column.columnIndex === 2)?.nullCount,
            ]);
            // nullCount includes empty strings on both paths, so the null-rate rules agree.
            expect(nullsOf(disk)).toEqual(nullsOf(memory));
            const popMemory = memory.population.find(column => column.columnIndex === 2);
            const popDisk = disk.population.find(column => column.columnIndex === 2);
            expect(popDisk?.nullCount).toBe(popMemory?.nullCount);
            expect(popDisk?.distinctCount).toBe(popMemory?.distinctCount);
            expect(popMemory?.topValues?.some(entry => entry.value === '')).toBe(false);
            expect(popDisk?.topValues?.some(entry => entry.value === '')).toBe(false);
        } finally {
            emptyStore.dispose();
        }
    });

    it('scores peer groups identically on memory and disk when there are enough groups', () => {
        // Ten groups of 40 rows; the last one deviates, so the peer comparison has something to report.
        const peerRows: unknown[][] = [];
        for (let g = 0; g < 10; g++) {
            for (let i = 0; i < 40; i++) {
                const deviant = g === 9;
                peerRows.push([
                    `R${g}`,
                    deviant ? 500 + i : 100 + (i % 5),
                    i % 4 === 0 ? 'ERR' : 'OK',
                    1_700_000_000_000 + (i % 11),
                    `2024-01-${String(1 + (i % 9)).padStart(2, '0')}`,
                ]);
            }
        }
        const dbPath = path.join(os.tmpdir(), `justybase-peer-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
        tempPaths.push(dbPath);
        const peerStore = SqliteResultStore.create(
            COLUMN_TYPES.map((type, index) => ({ name: COLUMNS[index].name, type })),
            1000,
            dbPath,
        );
        try {
            peerStore.insertRows(peerRows);
            peerStore.finalizeBulkInsert();
            const memory = computeGroupStatsSync({ columns: COLUMNS, rows: peerRows, groupColumns: GROUP });
            const disk = diskDatasetFor(peerStore);
            const summary = (dataset: AnalyticalDataset) => applyAnomalies(dataset, { sensitivity: 'normal', minGroupRows: 5, mode: 'peer' }).groups.map(group => ({
                key: group.key,
                score: group.score,
                flags: group.flags.map(flag => [flag.rule, flag.columnIndex, flag.severity]),
            }));
            const expected = summary(memory);
            expect(expected.find(group => group.key === '["R9"]')?.flags.some(flag => flag[0] === 'MEAN_SHIFT')).toBe(true);
            expect(summary(disk)).toEqual(expected);
        } finally {
            peerStore.dispose();
        }
    });
});
