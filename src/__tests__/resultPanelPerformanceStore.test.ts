import type * as vscode from 'vscode';
import { ResultPanelPerformanceStore } from '../services/perf/resultPanelPerformanceStore';

function createMockContext(initialValue?: unknown): vscode.ExtensionContext {
    const values = new Map<string, unknown>();
    if (initialValue !== undefined) {
        values.set('justybase.resultPanel.firstPaintTelemetry.v1', initialValue);
        values.set('netezza.resultPanel.firstPaintTelemetry.v1', initialValue);
    }

    return {
        globalState: {
            get: jest.fn((key: string, defaultValue?: unknown) => (
                values.has(key) ? values.get(key) : defaultValue
            )),
            update: jest.fn((key: string, value: unknown) => {
                values.set(key, value);
                return Promise.resolve();
            })
        }
    } as unknown as vscode.ExtensionContext;
}

describe('ResultPanelPerformanceStore', () => {
    it('aggregates persisted first-paint samples into a markdown report', async () => {
        const context = createMockContext();
        const store = new ResultPanelPerformanceStore(context);

        await store.recordFirstPaint({
            durationMs: 12.4,
            payloadBytes: 900,
            activeSource: 'file:///a.sql',
            resultSetCount: 1,
            totalRowCount: 200,
            executionState: 'success'
        });
        await store.recordFirstPaint({
            durationMs: 27.6,
            payloadBytes: 150_000,
            activeSource: 'file:///b.sql',
            resultSetCount: 2,
            totalRowCount: 1500,
            executionState: 'cancelled'
        });

        const snapshot = store.getSnapshot();
        expect(snapshot).toBeDefined();
        expect(snapshot?.sampleCount).toBe(2);
        expect(snapshot?.oldestSampleTimestamp).toBeDefined();
        expect(snapshot?.newestSampleTimestamp).toBeDefined();
        expect(snapshot?.p50DurationMs).toBe(12.4);
        expect(snapshot?.p95DurationMs).toBe(27.6);
        expect(snapshot?.payloadBuckets.xs).toBe(1);
        expect(snapshot?.payloadBuckets.l).toBe(1);
        expect(snapshot?.executionStates.success).toBe(1);
        expect(snapshot?.executionStates.cancelled).toBe(1);

        const report = store.renderReport();
        expect(report).toContain('# Result Panel Performance Stats');
        expect(report).toContain('Samples: 2');
        expect(report).toContain('Window start:');
        expect(report).toContain('Window end:');
        expect(report).toContain('| success | 1 |');
        expect(report).toContain('| cancelled | 1 |');
        expect(report).toContain('file:///b.sql');
    });

    it('keeps only the most recent rolling sample window', async () => {
        const context = createMockContext();
        const store = new ResultPanelPerformanceStore(context);

        for (let index = 0; index < 205; index++) {
            await store.recordFirstPaint({
                durationMs: index + 1,
                payloadBytes: undefined,
                activeSource: `file:///${index}.sql`,
                resultSetCount: 1,
                totalRowCount: index,
                executionState: 'success'
            });
        }

        const snapshot = store.getSnapshot();
        expect(snapshot?.sampleCount).toBe(200);
        expect(snapshot?.recentSamples[0]?.activeSource).toBe('file:///204.sql');
        expect(snapshot?.recentSamples[snapshot.recentSamples.length - 1]?.activeSource).toBe('file:///195.sql');
    });

    it('clears persisted first-paint samples', async () => {
        const context = createMockContext();
        const store = new ResultPanelPerformanceStore(context);

        await store.recordFirstPaint({
            durationMs: 10,
            payloadBytes: 10,
            activeSource: 'file:///sample.sql',
            resultSetCount: 1,
            totalRowCount: 1,
            executionState: 'success'
        });

        expect(store.getSnapshot()?.sampleCount).toBe(1);

        await store.clear();

        expect(store.getSnapshot()).toBeUndefined();
        expect(store.renderReport()).toBeUndefined();
    });
});
