import {
    ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
    ALL_ROWS_RETRY_TIMEOUT_SECONDS,
    resolveAllRowsOperationTimeout,
} from '../results/allRowsOperationTimeouts';

describe('resolveAllRowsOperationTimeout', () => {
    it('uses default timeout for first attempt', () => {
        expect(resolveAllRowsOperationTimeout(ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS, undefined, false))
            .toBe(5);
    });

    it('forces 30s when isRetry is true even without timeoutSeconds', () => {
        expect(resolveAllRowsOperationTimeout(ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS, undefined, true))
            .toBe(ALL_ROWS_RETRY_TIMEOUT_SECONDS);
    });

    it('forces 30s when isRetry is true even if a short timeout is present', () => {
        expect(resolveAllRowsOperationTimeout(ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS, 5, true))
            .toBe(ALL_ROWS_RETRY_TIMEOUT_SECONDS);
    });

    it('accepts explicit timeoutSeconds on first attempt', () => {
        expect(resolveAllRowsOperationTimeout(ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS, 12, false))
            .toBe(12);
    });

    it('parses string timeoutSeconds on first attempt', () => {
        expect(resolveAllRowsOperationTimeout(ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS, '12', false))
            .toBe(12);
    });
});
