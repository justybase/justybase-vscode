import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

/** Versioned contract for desktop Result Panel and Import Wizard performance runs. */
export const DATA_GRID_PERFORMANCE_SUITE_VERSION = 'data-grid.v1';

export type DataGridBenchmarkOperation = 'import' | 'export' | 'search' | 'render';
export type DataGridBenchmarkStatus = 'PASS' | 'WARN' | 'SKIP' | 'BASELINE_PENDING';
export type DataGridMode = 'inline' | 'worker' | 'sqlite';
export type BenchmarkRuntime = 'node' | 'chromium';

export type ImportBenchmarkFormat = 'csv' | 'xlsx' | 'xlsb';
export type ExportBenchmarkFormat =
    | 'csv'
    | 'csv.gz'
    | 'csv.zst'
    | 'json'
    | 'xlsx'
    | 'xlsb'
    | 'xml'
    | 'sql'
    | 'markdown'
    | 'parquet'
    | 'xpt';

export interface BenchmarkValidation {
    ok: boolean;
    expectedRows?: number;
    actualRows?: number;
    expectedColumns?: number;
    actualColumns?: number;
    message?: string;
}

export interface BenchmarkEnvironment {
    runtime: BenchmarkRuntime;
    node: string;
    nodeMajor: number;
    platform: string;
    osRelease: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    memoryBytes: number;
    chromium?: string;
    chromiumMajor?: number;
    viewport?: { width: number; height: number };
    workerCount?: number;
    commit?: string;
}

export interface BaselineComparison {
    compatible: boolean;
    baselineMedianMs?: number;
    baselineP95Ms?: number;
    medianDeltaRatio?: number;
    p95DeltaRatio?: number;
    reason?: string;
}

export interface DataGridBenchmarkRecord {
    suiteVersion: typeof DATA_GRID_PERFORMANCE_SUITE_VERSION;
    operation: DataGridBenchmarkOperation;
    stage: string;
    caseId: string;
    rowCount: number;
    columnCount: number;
    gridMode: DataGridMode;
    format?: ImportBenchmarkFormat | ExportBenchmarkFormat | string;
    sampleMs: number[];
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    rowsPerSecond?: number;
    bytesPerSecond?: number;
    inputBytes?: number;
    outputBytes?: number;
    validation: BenchmarkValidation;
    status: DataGridBenchmarkStatus;
    environment: BenchmarkEnvironment;
    baseline?: BaselineComparison;
    notes?: string[];
}

export interface DataGridBenchmarkReport {
    suiteVersion: typeof DATA_GRID_PERFORMANCE_SUITE_VERSION;
    generatedAt: string;
    enforced: boolean;
    environment: BenchmarkEnvironment;
    results: DataGridBenchmarkRecord[];
}

export interface DataGridBaselineEntry {
    operation: DataGridBenchmarkOperation;
    stage: string;
    caseId: string;
    rowCount: number;
    columnCount: number;
    gridMode: DataGridMode;
    format?: string;
    medianMs: number;
    p95Ms: number;
}

export interface DataGridBaselineFile {
    suiteVersion: typeof DATA_GRID_PERFORMANCE_SUITE_VERSION;
    description: string;
    environment: Partial<BenchmarkEnvironment>;
    results: DataGridBaselineEntry[];
}

function parseNodeMajor(version: string): number {
    const match = version.match(/^(?:v)?(\d+)/);
    return match ? Number(match[1]) : 0;
}

function resolveCommit(): string | undefined {
    if (process.env.GIT_COMMIT?.trim()) {
        return process.env.GIT_COMMIT.trim();
    }

    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

export function createBenchmarkEnvironment(
    runtime: BenchmarkRuntime,
    overrides: Partial<BenchmarkEnvironment> = {},
): BenchmarkEnvironment {
    const node = process.version;
    const cpus = os.cpus();
    return {
        runtime,
        node,
        nodeMajor: parseNodeMajor(node),
        platform: os.platform(),
        osRelease: os.release(),
        arch: os.arch(),
        cpuModel: cpus[0]?.model ?? 'unknown',
        cpuCount: cpus.length,
        memoryBytes: os.totalmem(),
        commit: resolveCommit(),
        ...overrides,
    };
}

export function createEmptyBenchmarkRecord(
    input: Pick<DataGridBenchmarkRecord, 'operation' | 'stage' | 'caseId' | 'rowCount' | 'columnCount' | 'gridMode'>
        & Partial<Pick<DataGridBenchmarkRecord, 'format' | 'inputBytes' | 'outputBytes' | 'notes'>>,
    environment: BenchmarkEnvironment,
    status: DataGridBenchmarkStatus = 'SKIP',
): DataGridBenchmarkRecord {
    return {
        suiteVersion: DATA_GRID_PERFORMANCE_SUITE_VERSION,
        ...input,
        sampleMs: [],
        medianMs: 0,
        p95Ms: 0,
        minMs: 0,
        maxMs: 0,
        validation: { ok: status === 'SKIP', message: status === 'SKIP' ? 'Not measured in this phase.' : undefined },
        status,
        environment,
    };
}
