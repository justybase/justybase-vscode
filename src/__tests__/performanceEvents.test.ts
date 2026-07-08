import {
    bucketizePayloadSize,
    createPerformanceTimer,
    formatPerformanceEvent,
    PerformanceEvent
} from '../services/perf/performanceEvents';

describe('services/perf/performanceEvents', () => {
    describe('bucketizePayloadSize', () => {
        it('returns none for undefined, NaN and negative values', () => {
            expect(bucketizePayloadSize(undefined)).toBe('none');
            expect(bucketizePayloadSize(Number.NaN)).toBe('none');
            expect(bucketizePayloadSize(-1)).toBe('none');
        });

        it('maps payload sizes to expected buckets', () => {
            expect(bucketizePayloadSize(0)).toBe('xs');
            expect(bucketizePayloadSize(1024)).toBe('xs');
            expect(bucketizePayloadSize(1025)).toBe('s');
            expect(bucketizePayloadSize(10_000)).toBe('s');
            expect(bucketizePayloadSize(10_001)).toBe('m');
            expect(bucketizePayloadSize(100_000)).toBe('m');
            expect(bucketizePayloadSize(100_001)).toBe('l');
            expect(bucketizePayloadSize(1_000_000)).toBe('l');
            expect(bucketizePayloadSize(1_000_001)).toBe('xl');
        });
    });

    describe('createPerformanceTimer', () => {
        it('creates success event with rounded duration and metadata', () => {
            const nowValues = [100, 123.456];
            let i = 0;
            const timer = createPerformanceTimer('query.run', {
                payloadSize: 2048,
                nowProvider: () => nowValues[i++],
                timestampProvider: () => '2026-02-24T17:10:00.000Z'
            });

            const event = timer.finish({
                result: 'ok',
                metadata: { query_count: 3 }
            });

            expect(event).toEqual({
                operation: 'query.run',
                duration_ms: 23.5,
                result: 'ok',
                payload_size_bucket: 's',
                timestamp: '2026-02-24T17:10:00.000Z',
                metadata: { query_count: 3 }
            });
        });

        it('allows overriding payload size and setting error code', () => {
            const nowValues = [10, 15];
            let i = 0;
            const timer = createPerformanceTimer('query.explain', {
                payloadSize: 500,
                nowProvider: () => nowValues[i++],
                timestampProvider: () => '2026-02-24T17:11:00.000Z'
            });

            const event = timer.finish({
                result: 'error',
                errorCode: 'TIMEOUT',
                payloadSizeOverride: 2_000_000
            });

            expect(event.payload_size_bucket).toBe('xl');
            expect(event.error_code).toBe('TIMEOUT');
            expect(event.result).toBe('error');
        });
    });

    describe('formatPerformanceEvent', () => {
        it('formats event with perf_event prefix', () => {
            const event: PerformanceEvent = {
                operation: 'extension.activate',
                duration_ms: 1200,
                result: 'ok',
                payload_size_bucket: 'none',
                timestamp: '2026-02-24T17:12:00.000Z'
            };

            const formatted = formatPerformanceEvent(event);
            expect(formatted).toContain('[perf_event]');
            expect(formatted).toContain('"operation":"extension.activate"');
        });
    });
});
