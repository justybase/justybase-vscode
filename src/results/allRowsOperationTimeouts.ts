/** Short per-operation timeouts for All rows panel actions (seconds). */
export const ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS = 5;
export const ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS = 8;
export const ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS = 10;
/** Longer timeout used when the user clicks Retry after a fail-fast timeout. */
export const ALL_ROWS_RETRY_TIMEOUT_SECONDS = 30;

function parseTimeoutSeconds(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

/** Resolve per-command timeout for All rows host handlers. */
export function resolveAllRowsOperationTimeout(
    defaultSeconds: number,
    timeoutSeconds?: unknown,
    isRetry?: boolean,
): number {
    if (isRetry === true) {
        return ALL_ROWS_RETRY_TIMEOUT_SECONDS;
    }
    return parseTimeoutSeconds(timeoutSeconds) ?? defaultSeconds;
}
