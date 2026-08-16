/**
 * Result Panel Grid Init Benchmark
 *
 * Measures prepareColumns and auto-width initialization cost for large result sets.
 *
 * Run with:
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/resultPanelGridInitBenchmark.test.ts
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as gridModule from '../media/resultPanel/grid.js';

const ITERATIONS = 8;
const WARMUP_ITERATIONS = 2;

interface BenchmarkScenario {
    name: string;
    rowCount: number;
    columnCount: number;
}

interface BenchmarkResult {
    stage: string;
    scenario: string;
    rowCount: number;
    columnCount: number;
    medianMs: number;
    minMs: number;
    maxMs: number;
}

const SCENARIOS: BenchmarkScenario[] = [
    { name: 'Medium (10k x 10)', rowCount: 10_000, columnCount: 10 },
    { name: 'Large (50k x 20)', rowCount: 50_000, columnCount: 20 },
];

function benchmark(fn: () => void): { medianMs: number; minMs: number; maxMs: number } {
    for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
        fn();
    }

    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
        const startedAt = performance.now();
        fn();
        times.push(performance.now() - startedAt);
    }

    times.sort((a, b) => a - b);
    return {
        medianMs: times[Math.floor(times.length / 2)],
        minMs: times[0],
        maxMs: times[times.length - 1],
    };
}

function buildRows(rowCount: number, columnCount: number): string[][] {
    const rows: string[][] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row: string[] = [];
        for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
            row.push(`r${rowIndex}-c${colIndex}`);
        }
        rows.push(row);
    }
    return rows;
}

function buildScenario(scenario: BenchmarkScenario) {
    const columns = Array.from({ length: scenario.columnCount }, (_, index) => ({
        name: `COL_${index}`,
        type: 'varchar',
    }));
    const data = buildRows(scenario.rowCount, scenario.columnCount);
    return { columns, data, executionTimestamp: 'bench-ts' };
}

describe('Result Panel Grid Init Benchmark', () => {
    const results: BenchmarkResult[] = [];

    afterAll(() => {
        const outputPath = path.join(__dirname, 'resultPanelGridInit.results.md');
        const lines = [
            '# Result Panel Grid Init Benchmark Results',
            '',
            `> Generated: ${new Date().toISOString().slice(0, 10)}`,
            `> Iterations: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)`,
            '',
            '| Stage | Scenario | Rows | Cols | Median (ms) | Min (ms) | Max (ms) |',
            '|---|---|---:|---:|---:|---:|---:|',
        ];

        for (const result of results) {
            lines.push(
                `| ${result.stage} | ${result.scenario} | ${result.rowCount} | ${result.columnCount} | ${result.medianMs.toFixed(2)} | ${result.minMs.toFixed(2)} | ${result.maxMs.toFixed(2)} |`
            );
        }

        lines.push(
            '',
            '## Notes',
            '',
            '1. `prepare_columns` measures column metadata preparation without precomputing filter unique values.',
            '2. `auto_width_init` measures sampled auto-width calculation for the first 1000 rows per column.',
            ''
        );

        fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
    });

    it.each(SCENARIOS)('benchmarks prepareColumns for $name', (scenario) => {
        const resultSet = buildScenario(scenario);

        const stats = benchmark(() => {
            gridModule.prepareColumns(resultSet, 0);
        });

        results.push({
            stage: 'prepare_columns',
            scenario: scenario.name,
            rowCount: scenario.rowCount,
            columnCount: scenario.columnCount,
            ...stats,
        });

        expect(stats.medianMs).toBeGreaterThanOrEqual(0);
    });

    it.each(SCENARIOS)('benchmarks init auto-width for $name', (scenario) => {
        const resultSet = buildScenario(scenario);
        const columns = gridModule.prepareColumns(resultSet, 0);
        const measureText = (text: string) => String(text).length * 7;

        const stats = benchmark(() => {
            for (const column of columns) {
                gridModule.calculateAutoColumnWidth(
                    column,
                    resultSet.data.slice(0, Math.min(resultSet.data.length, gridModule.RESULT_GRID_INIT_AUTO_SIZE_ROWS)),
                    measureText,
                    { maxRows: Math.min(resultSet.data.length, gridModule.RESULT_GRID_INIT_AUTO_SIZE_ROWS) }
                );
            }
        });

        results.push({
            stage: 'auto_width_init',
            scenario: scenario.name,
            rowCount: scenario.rowCount,
            columnCount: scenario.columnCount,
            ...stats,
        });

        expect(stats.medianMs).toBeGreaterThanOrEqual(0);
    });
});
