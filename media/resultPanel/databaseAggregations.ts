import { postHostMessage } from './protocol.js';
import { getActiveGridIndex } from './state.js';
import type { DiskAggregationResult } from './types.js';
import { getActiveSourceUri } from './types.js';
import {
    ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
    ALL_ROWS_RETRY_TIMEOUT_SECONDS,
} from './allRowsOperationTimeouts.js';

interface RequestContext {
    sourceUri: string;
    resultSetIndex: number;
}

interface PendingDatabaseAggregation {
    resolve: (results: DiskAggregationResult[]) => void;
    reject: (error: Error) => void;
    context: RequestContext;
    aggregationKey?: string;
    watchTimer?: ReturnType<typeof setTimeout>;
}

interface AllRowsRequestTiming {
    timeoutSeconds?: number;
    isRetry?: boolean;
    aggregationKey?: string;
}

const WATCHDOG_GRACE_MS = 2000;

let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingDatabaseAggregation>();
const aggregationErrorsByKey = new Map<string, string>();

function isStaleContext(context: RequestContext): boolean {
    const activeSource = getActiveSourceUri();
    const activeIndex = getActiveGridIndex();
    return context.sourceUri !== activeSource || context.resultSetIndex !== activeIndex;
}

function shouldRememberAggregationError(message: string): boolean {
    return !message.includes('Request cancelled') && !message.includes('Request superseded');
}

function clearWatchTimer(pending: PendingDatabaseAggregation): void {
    if (pending.watchTimer !== undefined) {
        clearTimeout(pending.watchTimer);
        pending.watchTimer = undefined;
    }
}

function rememberDatabaseAggregationError(key: string, message: string): void {
    aggregationErrorsByKey.set(key, message);
}

export function getDatabaseAggregationError(key: string): string | undefined {
    return aggregationErrorsByKey.get(key);
}

export function clearDatabaseAggregationError(key: string): void {
    aggregationErrorsByKey.delete(key);
}

function rejectPending(pending: PendingDatabaseAggregation, error: Error): void {
    if (pending.aggregationKey && shouldRememberAggregationError(error.message)) {
        rememberDatabaseAggregationError(pending.aggregationKey, error.message);
    }
    pending.reject(error);
}

function removePending(requestId: number): PendingDatabaseAggregation | undefined {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
        return undefined;
    }
    clearWatchTimer(pending);
    pendingRequests.delete(requestId);
    return pending;
}

export function discardAllDatabaseAggregationPending(): void {
    for (const pending of pendingRequests.values()) {
        clearWatchTimer(pending);
    }
    pendingRequests.clear();
    aggregationErrorsByKey.clear();
}

export function clearAllDatabaseAggregationPending(reason = 'Request cancelled'): void {
    const error = new Error(reason);
    for (const [requestId, pending] of pendingRequests.entries()) {
        clearWatchTimer(pending);
        pending.reject(error);
        pendingRequests.delete(requestId);
    }
}

export function queryDatabaseAggregations(
    sourceUri: string,
    resultSetIndex: number,
    aggregations: Array<{ columnIndex: number; fn: string }>,
    timing: AllRowsRequestTiming = {
        timeoutSeconds: ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
        isRetry: false,
    },
): Promise<DiskAggregationResult[]> {
    const requestId = ++requestIdCounter;
    const resolvedTiming = timing.isRetry
        ? { timeoutSeconds: ALL_ROWS_RETRY_TIMEOUT_SECONDS, isRetry: true as const, aggregationKey: timing.aggregationKey }
        : timing;
    const timeoutSeconds = resolvedTiming.timeoutSeconds ?? ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS;

    return new Promise((resolve, reject) => {
        const pending: PendingDatabaseAggregation = {
            resolve,
            reject,
            context: { sourceUri, resultSetIndex },
            aggregationKey: resolvedTiming.aggregationKey,
        };

        pending.watchTimer = setTimeout(() => {
            const active = pendingRequests.get(requestId);
            if (!active || active !== pending) {
                return;
            }
            removePending(requestId);
            rejectPending(
                pending,
                new Error(`Timed out: database aggregation did not complete within ${timeoutSeconds}s`),
            );
        }, timeoutSeconds * 1000 + WATCHDOG_GRACE_MS);

        pendingRequests.set(requestId, pending);
        postHostMessage({
            command: 'requestDatabaseAggregations',
            sourceUri,
            resultSetIndex,
            requestId,
            aggregations,
            timeoutSeconds,
            isRetry: resolvedTiming.isRetry === true,
        });
    });
}

export function handleDatabaseAggregationResult(message: {
    requestId: number;
    sourceUri?: string;
    resultSetIndex?: number;
    aggregations?: DiskAggregationResult[];
    error?: string;
}): void {
    const pending = removePending(message.requestId);
    if (!pending) {
        return;
    }

    if (
        (message.sourceUri && message.sourceUri !== pending.context.sourceUri)
        || (typeof message.resultSetIndex === 'number' && message.resultSetIndex !== pending.context.resultSetIndex)
        || isStaleContext(pending.context)
    ) {
        rejectPending(pending, new Error('Request superseded'));
        return;
    }

    if (message.error) {
        rejectPending(pending, new Error(message.error));
        return;
    }

    if (pending.aggregationKey) {
        clearDatabaseAggregationError(pending.aggregationKey);
    }
    pending.resolve(message.aggregations ?? []);
}
