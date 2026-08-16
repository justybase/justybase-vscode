/**
 * Result Panel Hydration Benchmark
 *
 * Measures a synthetic but repeatable large-result pipeline for the result panel:
 * 1. host-side hydrate payload preparation
 * 2. webview-side MessagePack decode
 * 3. a lightweight first-paint simulation over decoded result sets
 *
 * Run with:
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/resultPanelHydrationBenchmark.test.ts
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { encode, decode } from '@msgpack/msgpack';
import { MessagePackEncoder } from '../src/core/streaming/MessagePackEncoder';
import { ResultStateManager } from '../src/state/resultStateManager';
import { ResultSet } from '../src/types';

const ITERATIONS = 10;
const WARMUP_ITERATIONS = 2;

interface BenchmarkScenario {
    name: string;
    rowCount: number;
    stringWidth: number;
}

interface BenchmarkResult {
    stage: string;
    scenario: string;
    rowCount: number;
    payloadBytes: number;
    medianMs: number;
    minMs: number;
    maxMs: number;
    p95Ms: number;
}

interface PreparedScenario {
    scenario: BenchmarkScenario;
    payloadBytes: number;
    encoded: Uint8Array;
}

const SCENARIOS: BenchmarkScenario[] = [
    { name: 'Small (1k rows)', rowCount: 1_000, stringWidth: 32 },
    { name: 'Medium (5k rows)', rowCount: 5_000, stringWidth: 48 },
    { name: 'Large (15k rows)', rowCount: 15_000, stringWidth: 72 }
];

function benchmark(fn: () => void): { medianMs: number; minMs: number; maxMs: number; p95Ms: number } {
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
        p95Ms: times[Math.floor(times.length * 0.95)]
    };
}

function buildString(prefix: string, width: number, index: number): string {
    const base = `${prefix}-${index.toString().padStart(6, '0')}-`;
    const fillerWidth = Math.max(0, width - base.length);
    return `${base}${'x'.repeat(fillerWidth)}`;
}

function buildScenarioResultSets(scenario: BenchmarkScenario): ResultSet[] {
    const midpoint = Math.ceil(scenario.rowCount / 2);
    const activeRows = Array.from({ length: midpoint }, (_, index) => [
        index + 1,
        buildString('customer', scenario.stringWidth, index),
        buildString('region', Math.max(16, Math.floor(scenario.stringWidth / 2)), index),
        (index % 97) * 10,
        `2026-04-${String((index % 28) + 1).padStart(2, '0')}`
    ]);
    const backgroundRows = Array.from({ length: scenario.rowCount - midpoint }, (_, index) => [
        midpoint + index + 1,
        buildString('job', scenario.stringWidth, midpoint + index),
        index % 5 === 0 ? 'done' : index % 3 === 0 ? 'running' : 'queued',
        100 + (index % 250),
        `batch-${(index % 12) + 1}`
    ]);

    return [
        {
            name: 'Customers',
            sql: 'SELECT * FROM benchmark_customers',
            columns: [
                { name: 'id', type: 'INT4' },
                { name: 'customer_name', type: `VARCHAR(${scenario.stringWidth})` },
                { name: 'region', type: 'VARCHAR(24)' },
                { name: 'score', type: 'INT4' },
                { name: 'created_on', type: 'DATE' }
            ],
            data: activeRows
        } as ResultSet,
        {
            name: 'Jobs',
            sql: 'SELECT * FROM benchmark_jobs',
            columns: [
                { name: 'job_id', type: 'INT4' },
                { name: 'job_name', type: `VARCHAR(${scenario.stringWidth})` },
                { name: 'status', type: 'VARCHAR(16)' },
                { name: 'duration_ms', type: 'INT4' },
                { name: 'batch', type: 'VARCHAR(16)' }
            ],
            data: backgroundRows
        } as ResultSet
    ];
}

function prepareScenario(scenario: BenchmarkScenario): PreparedScenario {
    const stateManager = new ResultStateManager();
    const encoder = new MessagePackEncoder();
    const sourceUri = `file:///benchmark/${scenario.rowCount}.sql`;
    stateManager.startExecution(sourceUri);
    const execution = stateManager.logExecutionStart(sourceUri, 'SELECT * FROM benchmark', 'benchmark');
    const resultSets = buildScenarioResultSets(scenario);
    stateManager.updateResults(resultSets, sourceUri, false);
    stateManager.logExecutionEnd(execution.id, scenario.rowCount, 'success');

    const activeSource = stateManager.activeSourceUri;
    const activeResultSets = activeSource ? stateManager.resultsMap.get(activeSource) || [] : [];
    const encoded = encode(encoder.sanitizeForMessagePack(activeResultSets)) as Uint8Array;
    return {
        scenario,
        payloadBytes: encoded.byteLength,
        encoded
    };
}

function inferExecutionStateFromDecoded(resultSets: unknown[]): string {
    const typed = Array.isArray(resultSets) ? resultSets as Array<{ isLog?: boolean; isError?: boolean; isCancelled?: boolean; data?: unknown[][] }> : [];
    const nonLog = typed.filter(resultSet => !resultSet?.isLog);
    if (nonLog.some(resultSet => resultSet?.isError)) {
        return 'error';
    }
    if (nonLog.some(resultSet => resultSet?.isCancelled)) {
        return 'cancelled';
    }
    return nonLog.length > 0 ? 'success' : 'idle';
}

function simulateFirstPaint(encoded: Uint8Array): void {
    const decoded = decode(encoded) as Array<{ data?: unknown[][] }>;
    let cellVisits = 0;
    const totalRows = decoded.reduce((sum, resultSet) => sum + (Array.isArray(resultSet?.data) ? resultSet.data.length : 0), 0);
    const executionState = inferExecutionStateFromDecoded(decoded);

    for (const resultSet of decoded) {
        if (!Array.isArray(resultSet?.data)) {
            continue;
        }
        for (const row of resultSet.data) {
            if (!Array.isArray(row)) {
                continue;
            }
            for (const cell of row) {
                cellVisits += String(cell ?? '').length;
            }
        }
    }

    if (totalRows <= 0 || executionState !== 'success' || cellVisits <= 0) {
        throw new Error('Invalid first-paint simulation output');
    }
}

function saveResultsFile(results: BenchmarkResult[]): void {
    const lines: string[] = [];
    lines.push('# Result Panel Hydration Benchmark Results');
    lines.push('');
    lines.push(`> Iterations: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)`);
    lines.push('');
    lines.push('## Scenarios');
    lines.push('');
    lines.push('| Scenario | Total Rows | Approx Payload |');
    lines.push('|---|---:|---:|');
    for (const scenario of SCENARIOS) {
        const scenarioResults = results.find(result => result.scenario === scenario.name);
        lines.push(`| ${scenario.name} | ${scenario.rowCount.toLocaleString()} | ${(scenarioResults?.payloadBytes ?? 0).toLocaleString()} bytes |`);
    }
    lines.push('');
    lines.push('## Results (median ms)');
    lines.push('');
    lines.push('| Stage | Small (1k rows) | Medium (5k rows) | Large (15k rows) |');
    lines.push('|---|---:|---:|---:|');

    for (const stage of ['host_prepare_hydrate', 'webview_decode_msgpack', 'webview_first_paint_simulated']) {
        const stageResults = SCENARIOS.map(
            scenario => results.find(result => result.stage === stage && result.scenario === scenario.name)?.medianMs.toFixed(2) ?? '-'
        );
        lines.push(`| ${stage} | ${stageResults.join(' | ')} |`);
    }

    lines.push('');
    lines.push('## Detailed Results');
    lines.push('');
    for (const stage of ['host_prepare_hydrate', 'webview_decode_msgpack', 'webview_first_paint_simulated']) {
        lines.push(`### ${stage}`);
        lines.push('');
        lines.push('| Scenario | Payload Bytes | Min (ms) | Median (ms) | Max (ms) | P95 (ms) |');
        lines.push('|---|---:|---:|---:|---:|---:|');
        for (const result of results.filter(entry => entry.stage === stage)) {
            lines.push(
                `| ${result.scenario} | ${result.payloadBytes.toLocaleString()} | ${result.minMs.toFixed(2)} | ${result.medianMs.toFixed(2)} | ${result.maxMs.toFixed(2)} | ${result.p95Ms.toFixed(2)} |`
            );
        }
        lines.push('');
    }

    lines.push('## Notes');
    lines.push('');
    lines.push('1. `host_prepare_hydrate` measures `ResultPanelView` payload preparation and MessagePack serialization.');
    lines.push('2. `webview_decode_msgpack` measures raw MessagePack decode cost.');
    lines.push('3. `webview_first_paint_simulated` is a synthetic proxy for post-decode row walking and status derivation, not a full browser paint benchmark.');
    lines.push('4. Use runtime `result_panel.first_paint` telemetry to compare real webview behavior release-to-release.');

    const outPath = path.join(__dirname, 'resultPanelHydration.results.md');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`Benchmark results saved to ${outPath}`);
}

describe('Result Panel Hydration Benchmark', () => {
    const allResults: BenchmarkResult[] = [];
    const preparedScenarios = new Map<string, PreparedScenario>();

    beforeAll(() => {
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        for (const scenario of SCENARIOS) {
            preparedScenarios.set(scenario.name, prepareScenario(scenario));
        }
    });

    afterAll(() => {
        saveResultsFile(allResults);
        jest.restoreAllMocks();
    });

    describe('host_prepare_hydrate', () => {
        it.each(SCENARIOS)('%s', scenario => {
            const result = benchmark(() => {
                prepareScenario(scenario);
            });
            const prepared = preparedScenarios.get(scenario.name)!;
            allResults.push({
                stage: 'host_prepare_hydrate',
                scenario: scenario.name,
                rowCount: scenario.rowCount,
                payloadBytes: prepared.payloadBytes,
                ...result
            });
        });
    });

    describe('webview_decode_msgpack', () => {
        it.each(SCENARIOS)('%s', scenario => {
            const prepared = preparedScenarios.get(scenario.name)!;
            const result = benchmark(() => {
                decode(prepared.encoded);
            });
            allResults.push({
                stage: 'webview_decode_msgpack',
                scenario: scenario.name,
                rowCount: scenario.rowCount,
                payloadBytes: prepared.payloadBytes,
                ...result
            });
        });
    });

    describe('webview_first_paint_simulated', () => {
        it.each(SCENARIOS)('%s', scenario => {
            const prepared = preparedScenarios.get(scenario.name)!;
            const result = benchmark(() => {
                simulateFirstPaint(prepared.encoded);
            });
            allResults.push({
                stage: 'webview_first_paint_simulated',
                scenario: scenario.name,
                rowCount: scenario.rowCount,
                payloadBytes: prepared.payloadBytes,
                ...result
            });
        });
    });
});
