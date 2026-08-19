import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DATA_GRID_PERFORMANCE_SUITE_VERSION,
    type BenchmarkEnvironment,
    type DataGridBaselineFile,
    type DataGridBenchmarkRecord,
    type DataGridBenchmarkReport,
} from './contract';

export const DATA_GRID_BASELINE_PATH = path.join(__dirname, '..', 'baselines', 'data-grid.v1.json');

function baselineKey(record: Pick<DataGridBenchmarkRecord, 'operation' | 'stage' | 'caseId' | 'gridMode' | 'format'>): string {
    return [record.operation, record.stage, record.caseId, record.gridMode, record.format ?? ''].join('/');
}

function baselineEnvironmentMatches(
    environment: BenchmarkEnvironment,
    baseline: DataGridBaselineFile,
): boolean {
    const expected = baseline.environment;
    return (expected.runtime === undefined || expected.runtime === environment.runtime)
        && (expected.nodeMajor === undefined || expected.nodeMajor === environment.nodeMajor)
        && (expected.platform === undefined || expected.platform === environment.platform)
        && (expected.arch === undefined || expected.arch === environment.arch)
        && (expected.workerCount === undefined || expected.workerCount === environment.workerCount)
        && (expected.chromiumMajor === undefined || expected.chromiumMajor === environment.chromiumMajor);
}

export function readDataGridBaseline(filePath = DATA_GRID_BASELINE_PATH): DataGridBaselineFile | undefined {
    try {
        const baseline = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DataGridBaselineFile;
        if (baseline.suiteVersion !== DATA_GRID_PERFORMANCE_SUITE_VERSION || !Array.isArray(baseline.results)) {
            return undefined;
        }
        return baseline;
    } catch {
        return undefined;
    }
}

export function applyBaselineStatus(
    record: DataGridBenchmarkRecord,
    baseline: DataGridBaselineFile | undefined,
): DataGridBenchmarkRecord {
    if (record.status === 'SKIP' || !record.validation.ok) {
        return record;
    }
    if (!baseline) {
        return { ...record, status: 'BASELINE_PENDING', baseline: { compatible: false, reason: 'Baseline file is unavailable.' } };
    }
    if (!baselineEnvironmentMatches(record.environment, baseline)) {
        return {
            ...record,
            status: 'BASELINE_PENDING',
            baseline: { compatible: false, reason: 'Baseline environment does not match this run.' },
        };
    }

    const entry = baseline.results.find((candidate) => baselineKey({ ...record, ...candidate }) === baselineKey(record));
    if (!entry) {
        return { ...record, status: 'BASELINE_PENDING', baseline: { compatible: false, reason: 'Case is not present in the baseline.' } };
    }

    const medianDeltaRatio = entry.medianMs > 0 ? (record.medianMs - entry.medianMs) / entry.medianMs : 0;
    const p95DeltaRatio = entry.p95Ms > 0 ? (record.p95Ms - entry.p95Ms) / entry.p95Ms : 0;
    const warn = medianDeltaRatio > 0.20 || p95DeltaRatio > 0.25;
    return {
        ...record,
        status: warn ? 'WARN' : 'PASS',
        baseline: {
            compatible: true,
            baselineMedianMs: entry.medianMs,
            baselineP95Ms: entry.p95Ms,
            medianDeltaRatio,
            p95DeltaRatio,
        },
    };
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : '—';
}

export function writeDataGridBenchmarkReport(
    records: readonly DataGridBenchmarkRecord[],
    environment: BenchmarkEnvironment,
    options: { jsonPath?: string; markdownPath?: string; baselinePath?: string } = {},
): DataGridBenchmarkReport {
    const baseline = readDataGridBaseline(options.baselinePath ?? DATA_GRID_BASELINE_PATH);
    const finalized = records.map((record) => applyBaselineStatus(record, baseline));
    const report: DataGridBenchmarkReport = {
        suiteVersion: DATA_GRID_PERFORMANCE_SUITE_VERSION,
        generatedAt: new Date().toISOString(),
        enforced: process.env.DATA_GRID_PERF_ENFORCE === '1',
        environment,
        results: finalized,
    };

    const jsonPath = options.jsonPath ?? path.join(__dirname, '..', 'data-grid.v1.results.json');
    const markdownPath = options.markdownPath ?? path.join(__dirname, '..', 'data-grid.v1.results.md');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const lines = [
        '# Data Grid Performance Benchmark Results',
        '',
        `- Suite: \`${report.suiteVersion}\``,
        `- Generated: ${report.generatedAt}`,
        `- Runtime: ${environment.runtime}`,
        `- Node: ${environment.node}`,
        `- Platform: ${environment.platform} ${environment.osRelease} (${environment.arch})`,
        `- CPU: ${environment.cpuModel} × ${environment.cpuCount}`,
        `- Commit: ${environment.commit ?? 'unknown'}`,
        '',
        '| Operation | Stage | Case | Rows | Cols | Mode | Format | Median ms | P95 ms | Rows/s | Bytes/s | Status |',
        '|---|---|---|---:|---:|---|---|---:|---:|---:|---:|---|',
    ];
    for (const record of finalized) {
        lines.push(`| ${record.operation} | ${record.stage} | ${record.caseId} | ${record.rowCount} | ${record.columnCount} | ${record.gridMode} | ${record.format ?? '—'} | ${formatNumber(record.medianMs)} | ${formatNumber(record.p95Ms)} | ${record.rowsPerSecond ? formatNumber(record.rowsPerSecond) : '—'} | ${record.bytesPerSecond ? formatNumber(record.bytesPerSecond) : '—'} | ${record.status} |`);
    }
    lines.push('', '## Validation', '');
    for (const record of finalized) {
        const validation = record.validation;
        lines.push(`- \`${record.operation}/${record.stage}/${record.caseId}\`: ${validation.ok ? 'OK' : 'FAILED'}${validation.message ? ` — ${validation.message}` : ''}`);
    }
    lines.push('', 'Warnings are reported but do not fail the run unless `DATA_GRID_PERF_ENFORCE=1` is set.', '');
    fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');

    if (process.env.DATA_GRID_PERF_ENFORCE === '1') {
        const warnings = finalized.filter((record) => record.status === 'WARN');
        if (warnings.length > 0) {
            throw new Error(`Data Grid performance baseline exceeded for ${warnings.length} case(s). See ${markdownPath}.`);
        }
    }
    return report;
}
