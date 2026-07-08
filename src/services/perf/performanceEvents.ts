export type PerformanceResult = 'ok' | 'error' | 'cancelled';

export type PayloadSizeBucket = 'none' | 'xs' | 's' | 'm' | 'l' | 'xl';

export type PerformanceMetadataValue = string | number | boolean | null;

export interface PerformanceMetadata {
    [key: string]: PerformanceMetadataValue;
}

export interface PerformanceEvent {
    operation: string;
    duration_ms: number;
    result: PerformanceResult;
    payload_size_bucket: PayloadSizeBucket;
    timestamp: string;
    error_code?: string;
    metadata?: PerformanceMetadata;
}

export interface PerformanceTimerFinishOptions {
    result?: PerformanceResult;
    errorCode?: string;
    metadata?: PerformanceMetadata;
    payloadSizeOverride?: number;
}

export interface PerformanceTimerOptions {
    payloadSize?: number;
    nowProvider?: () => number;
    timestampProvider?: () => string;
}

interface PerformanceTimerState {
    operation: string;
    startedAt: number;
    payloadSize?: number;
    nowProvider: () => number;
    timestampProvider: () => string;
}

export function bucketizePayloadSize(payloadSize?: number): PayloadSizeBucket {
    if (payloadSize === undefined || payloadSize === null || Number.isNaN(payloadSize)) {
        return 'none';
    }
    if (payloadSize < 0) {
        return 'none';
    }
    if (payloadSize <= 1_024) {
        return 'xs';
    }
    if (payloadSize <= 10_000) {
        return 's';
    }
    if (payloadSize <= 100_000) {
        return 'm';
    }
    if (payloadSize <= 1_000_000) {
        return 'l';
    }
    return 'xl';
}

export function createPerformanceTimer(
    operation: string,
    options: PerformanceTimerOptions = {}
): { finish: (finishOptions?: PerformanceTimerFinishOptions) => PerformanceEvent } {
    const nowProvider = options.nowProvider ?? (() => performance.now());
    const timestampProvider = options.timestampProvider ?? (() => new Date().toISOString());
    const state: PerformanceTimerState = {
        operation,
        startedAt: nowProvider(),
        payloadSize: options.payloadSize,
        nowProvider,
        timestampProvider
    };

    return {
        finish: (finishOptions: PerformanceTimerFinishOptions = {}): PerformanceEvent => {
            const endedAt = state.nowProvider();
            const durationMs = Math.max(0, endedAt - state.startedAt);
            const payloadSize = finishOptions.payloadSizeOverride ?? state.payloadSize;
            const event: PerformanceEvent = {
                operation: state.operation,
                duration_ms: Math.round(durationMs * 10) / 10,
                result: finishOptions.result ?? 'ok',
                payload_size_bucket: bucketizePayloadSize(payloadSize),
                timestamp: state.timestampProvider()
            };

            if (finishOptions.errorCode) {
                event.error_code = finishOptions.errorCode;
            }
            if (finishOptions.metadata) {
                event.metadata = finishOptions.metadata;
            }

            return event;
        }
    };
}

export function formatPerformanceEvent(event: PerformanceEvent): string {
    return `[perf_event] ${JSON.stringify(event)}`;
}
