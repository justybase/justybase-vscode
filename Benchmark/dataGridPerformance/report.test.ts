import {
    DATA_GRID_PERFORMANCE_SUITE_VERSION,
    createEmptyBenchmarkRecord,
    type BenchmarkEnvironment,
    type DataGridBaselineFile,
} from './contract';
import { applyBaselineStatus } from './report';

function environment(runtime: BenchmarkEnvironment['runtime']): BenchmarkEnvironment {
    return {
        runtime,
        node: 'v22.12.0',
        nodeMajor: 22,
        platform: 'linux',
        osRelease: 'test',
        arch: 'x64',
        cpuModel: 'test cpu',
        cpuCount: 1,
        memoryBytes: 1,
        workerCount: 1,
    };
}

describe('data-grid performance baseline compatibility', () => {
    it('does not compare Chromium timings with a Node baseline', () => {
        const chromiumEnvironment = environment('chromium');
        const record = {
            ...createEmptyBenchmarkRecord({
                operation: 'render',
                stage: 'first_grid_render',
                caseId: 'inline/first-paint',
                rowCount: 10,
                columnCount: 2,
                gridMode: 'inline',
            }, chromiumEnvironment, 'PASS'),
            medianMs: 10,
            p95Ms: 12,
            validation: { ok: true },
            status: 'PASS' as const,
        };
        const nodeBaseline: DataGridBaselineFile = {
            suiteVersion: DATA_GRID_PERFORMANCE_SUITE_VERSION,
            description: 'Node baseline',
            environment: {
                runtime: 'node',
                nodeMajor: 22,
                platform: 'linux',
                arch: 'x64',
                workerCount: 1,
            },
            results: [],
        };

        const result = applyBaselineStatus(record, nodeBaseline);

        expect(result.status).toBe('BASELINE_PENDING');
        expect(result.baseline).toEqual({
            compatible: false,
            reason: 'Baseline environment does not match this run.',
        });
    });
});
