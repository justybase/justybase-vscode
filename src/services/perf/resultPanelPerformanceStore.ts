import * as vscode from 'vscode';
import type { ResultPanelHydrationMetricsPayload } from '../../contracts/webview';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from '../../compatibility/state';
import { bucketizePayloadSize, PayloadSizeBucket } from './performanceEvents';

const MAX_FIRST_PAINT_SAMPLES = 200;

export interface ResultPanelFirstPaintSample {
    timestamp: string;
    durationMs: number;
    payloadBytes?: number;
    payloadSizeBucket: PayloadSizeBucket;
    activeSource: string | null;
    resultSetCount: number;
    totalRowCount: number;
    executionState: ResultPanelHydrationMetricsPayload['executionState'];
}

export interface ResultPanelPerformanceSnapshot {
    sampleCount: number;
    oldestSampleTimestamp: string;
    newestSampleTimestamp: string;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    maxDurationMs: number;
    avgResultSetCount: number;
    avgTotalRowCount: number;
    payloadBuckets: Record<PayloadSizeBucket, number>;
    executionStates: Record<ResultPanelHydrationMetricsPayload['executionState'], number>;
    recentSamples: ResultPanelFirstPaintSample[];
}

function roundMetric(value: number): number {
    return Math.round(value * 10) / 10;
}

function getPercentile(values: number[], percentile: number): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
    );
    return sorted[index];
}

export class ResultPanelPerformanceStore {
    constructor(private readonly _context: vscode.ExtensionContext) { }

    public async recordFirstPaint(metrics: ResultPanelHydrationMetricsPayload): Promise<void> {
        const sample: ResultPanelFirstPaintSample = {
            timestamp: new Date().toISOString(),
            durationMs: roundMetric(Math.max(0, metrics.durationMs)),
            payloadBytes: metrics.payloadBytes,
            payloadSizeBucket: bucketizePayloadSize(metrics.payloadBytes),
            activeSource: metrics.activeSource,
            resultSetCount: metrics.resultSetCount,
            totalRowCount: metrics.totalRowCount,
            executionState: metrics.executionState
        };

        const current = this._readSamples();
        const next = [...current, sample].slice(-MAX_FIRST_PAINT_SAMPLES);
        await updateMementoValue(
            this._context.globalState,
            compatibilityStateKeys.resultPanelFirstPaintTelemetry,
            next
        );
    }

    public getSnapshot(): ResultPanelPerformanceSnapshot | undefined {
        const samples = this._readSamples();
        if (samples.length === 0) {
            return undefined;
        }

        const durations = samples.map(sample => sample.durationMs);
        const payloadBuckets: ResultPanelPerformanceSnapshot['payloadBuckets'] = {
            none: 0,
            xs: 0,
            s: 0,
            m: 0,
            l: 0,
            xl: 0
        };
        const executionStates: ResultPanelPerformanceSnapshot['executionStates'] = {
            idle: 0,
            loading: 0,
            success: 0,
            error: 0,
            cancelled: 0,
            retrying: 0
        };

        let totalResultSetCount = 0;
        let totalRowCount = 0;

        for (const sample of samples) {
            payloadBuckets[sample.payloadSizeBucket]++;
            executionStates[sample.executionState]++;
            totalResultSetCount += sample.resultSetCount;
            totalRowCount += sample.totalRowCount;
        }

        return {
            sampleCount: samples.length,
            oldestSampleTimestamp: samples[0].timestamp,
            newestSampleTimestamp: samples[samples.length - 1].timestamp,
            avgDurationMs: roundMetric(durations.reduce((sum, value) => sum + value, 0) / durations.length),
            p50DurationMs: roundMetric(getPercentile(durations, 50)),
            p95DurationMs: roundMetric(getPercentile(durations, 95)),
            maxDurationMs: roundMetric(Math.max(...durations)),
            avgResultSetCount: roundMetric(totalResultSetCount / samples.length),
            avgTotalRowCount: roundMetric(totalRowCount / samples.length),
            payloadBuckets,
            executionStates,
            recentSamples: samples.slice(-10).reverse()
        };
    }

    public renderReport(): string | undefined {
        const snapshot = this.getSnapshot();
        if (!snapshot) {
            return undefined;
        }

        const lines: string[] = [
            '# Result Panel Performance Stats',
            '',
            'Runtime samples captured from `result_panel.first_paint` during local usage.',
            '',
            `Samples: ${snapshot.sampleCount}`,
            `Window start: ${snapshot.oldestSampleTimestamp}`,
            `Window end: ${snapshot.newestSampleTimestamp}`,
            `Average first paint: ${snapshot.avgDurationMs.toFixed(1)} ms`,
            `P50 first paint: ${snapshot.p50DurationMs.toFixed(1)} ms`,
            `P95 first paint: ${snapshot.p95DurationMs.toFixed(1)} ms`,
            `Max first paint: ${snapshot.maxDurationMs.toFixed(1)} ms`,
            `Average result sets per hydrate: ${snapshot.avgResultSetCount.toFixed(1)}`,
            `Average rows per hydrate: ${snapshot.avgTotalRowCount.toFixed(1)}`,
            '',
            '## Execution States',
            '',
            '| State | Samples |',
            '| --- | ---: |',
        ];

        for (const state of Object.keys(snapshot.executionStates) as Array<keyof typeof snapshot.executionStates>) {
            lines.push(`| ${state} | ${snapshot.executionStates[state]} |`);
        }

        lines.push('', '## Payload Buckets', '', '| Bucket | Samples |', '| --- | ---: |');

        for (const bucket of Object.keys(snapshot.payloadBuckets) as Array<keyof typeof snapshot.payloadBuckets>) {
            lines.push(`| ${bucket} | ${snapshot.payloadBuckets[bucket]} |`);
        }

        lines.push('', '## Recent Samples', '', '| Timestamp | Duration (ms) | Rows | Result sets | State | Payload | Source |', '| --- | ---: | ---: | ---: | --- | --- | --- |');

        for (const sample of snapshot.recentSamples) {
            lines.push(
                `| ${sample.timestamp} | ${sample.durationMs.toFixed(1)} | ${sample.totalRowCount} | ${sample.resultSetCount} | ${sample.executionState} | ${sample.payloadSizeBucket} | ${sample.activeSource ?? 'n/a'} |`
            );
        }

        return lines.join('\n');
    }

    public async clear(): Promise<void> {
        await updateMementoValue(
            this._context.globalState,
            compatibilityStateKeys.resultPanelFirstPaintTelemetry,
            []
        );
    }

    private _readSamples(): ResultPanelFirstPaintSample[] {
        return getMementoValue<ResultPanelFirstPaintSample[]>(
            this._context.globalState,
            compatibilityStateKeys.resultPanelFirstPaintTelemetry,
            []
        ) ?? [];
    }
}
