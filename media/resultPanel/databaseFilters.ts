import { postHostMessage } from './protocol.js';
import { getActiveGridIndex } from './state.js';
import type { DiskDistinctValue, DiskQuerySpec } from './types.js';
import { getActiveSourceUri } from './types.js';
import {
    ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
    ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
    ALL_ROWS_RETRY_TIMEOUT_SECONDS,
} from './allRowsOperationTimeouts.js';

interface RequestContext {
    sourceUri: string;
    resultSetIndex: number;
    columnIndex?: number;
}

interface PendingValuesRequest {
    resolve: (result: { values: DiskDistinctValue[]; truncated: boolean }) => void;
    reject: (error: Error) => void;
    context: RequestContext & { columnIndex: number };
    watchTimer?: ReturnType<typeof setTimeout>;
}

interface PendingApplyRequest {
    resolve: () => void;
    reject: (error: Error) => void;
    context: RequestContext;
    watchTimer?: ReturnType<typeof setTimeout>;
}

interface AllRowsRequestTiming {
    timeoutSeconds?: number;
    isRetry?: boolean;
}

const WATCHDOG_GRACE_MS = 2000;

let requestIdCounter = 0;
const pendingValuesRequests = new Map<number, PendingValuesRequest>();
const pendingApplyRequests = new Map<number, PendingApplyRequest>();

function isStaleContext(context: RequestContext): boolean {
    const activeSource = getActiveSourceUri();
    const activeIndex = getActiveGridIndex();
    return context.sourceUri !== activeSource || context.resultSetIndex !== activeIndex;
}

function buildRetryTiming(): AllRowsRequestTiming {
    return {
        timeoutSeconds: ALL_ROWS_RETRY_TIMEOUT_SECONDS,
        isRetry: true,
    };
}

function clearWatchTimer(pending: PendingValuesRequest | PendingApplyRequest): void {
    if (pending.watchTimer !== undefined) {
        clearTimeout(pending.watchTimer);
        pending.watchTimer = undefined;
    }
}

function removeValuesPending(requestId: number): PendingValuesRequest | undefined {
    const pending = pendingValuesRequests.get(requestId);
    if (!pending) {
        return undefined;
    }
    clearWatchTimer(pending);
    pendingValuesRequests.delete(requestId);
    return pending;
}

function removeApplyPending(requestId: number): PendingApplyRequest | undefined {
    const pending = pendingApplyRequests.get(requestId);
    if (!pending) {
        return undefined;
    }
    clearWatchTimer(pending);
    pendingApplyRequests.delete(requestId);
    return pending;
}

function isStaleResponse(
    pending: PendingValuesRequest | PendingApplyRequest,
    message: { sourceUri?: string; resultSetIndex?: number; columnIndex?: number },
): boolean {
    return (
        (message.sourceUri !== undefined && message.sourceUri !== pending.context.sourceUri)
        || (typeof message.resultSetIndex === 'number' && message.resultSetIndex !== pending.context.resultSetIndex)
        || (typeof message.columnIndex === 'number'
            && 'columnIndex' in pending.context
            && message.columnIndex !== pending.context.columnIndex)
        || isStaleContext(pending.context)
    );
}

function scheduleWatchdog<T extends PendingValuesRequest | PendingApplyRequest>(
    requestId: number,
    pending: T,
    pendingMap: Map<number, T>,
    removePending: (id: number) => T | undefined,
    timeoutSeconds: number,
    timeoutLabel: string,
): void {
    pending.watchTimer = setTimeout(() => {
        const active = pendingMap.get(requestId);
        if (!active || active !== pending) {
            return;
        }
        removePending(requestId);
        pending.reject(new Error(`Timed out: ${timeoutLabel} did not complete within ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000 + WATCHDOG_GRACE_MS);
}

export function discardAllDatabaseFilterPending(): void {
    for (const pending of pendingValuesRequests.values()) {
        clearWatchTimer(pending);
    }
    for (const pending of pendingApplyRequests.values()) {
        clearWatchTimer(pending);
    }
    pendingValuesRequests.clear();
    pendingApplyRequests.clear();
}

export function clearAllDatabaseFilterPending(reason = 'Request cancelled'): void {
    const error = new Error(reason);
    for (const pending of pendingValuesRequests.values()) {
        clearWatchTimer(pending);
        pending.reject(error);
    }
    pendingValuesRequests.clear();
    for (const pending of pendingApplyRequests.values()) {
        clearWatchTimer(pending);
        pending.reject(error);
    }
    pendingApplyRequests.clear();
}

export function queryDatabaseFilterValues(
    sourceUri: string,
    resultSetIndex: number,
    columnIndex: number,
    querySpec?: DiskQuerySpec,
    timing: AllRowsRequestTiming = {
        timeoutSeconds: ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
        isRetry: false,
    },
): Promise<{ values: DiskDistinctValue[]; truncated: boolean }> {
    const requestId = ++requestIdCounter;
    const resolvedTiming = timing.isRetry ? buildRetryTiming() : timing;
    const timeoutSeconds = resolvedTiming.timeoutSeconds ?? ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS;

    return new Promise((resolve, reject) => {
        const pending: PendingValuesRequest = {
            resolve,
            reject,
            context: { sourceUri, resultSetIndex, columnIndex },
        };

        scheduleWatchdog(
            requestId,
            pending,
            pendingValuesRequests,
            removeValuesPending,
            timeoutSeconds,
            'database filter values request',
        );

        pendingValuesRequests.set(requestId, pending);
        postHostMessage({
            command: 'requestDatabaseFilterValues',
            sourceUri,
            resultSetIndex,
            columnIndex,
            requestId,
            querySpec,
            timeoutSeconds: resolvedTiming.timeoutSeconds,
            isRetry: resolvedTiming.isRetry === true,
        });
    });
}

export function applyDatabaseFilter(
    sourceUri: string,
    resultSetIndex: number,
    querySpec?: DiskQuerySpec,
    timing: AllRowsRequestTiming = {
        timeoutSeconds: ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
        isRetry: false,
    },
): Promise<void> {
    const requestId = ++requestIdCounter;
    const resolvedTiming = timing.isRetry ? buildRetryTiming() : timing;
    const timeoutSeconds = resolvedTiming.timeoutSeconds ?? ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS;

    return new Promise((resolve, reject) => {
        const pending: PendingApplyRequest = {
            resolve,
            reject,
            context: { sourceUri, resultSetIndex },
        };

        scheduleWatchdog(
            requestId,
            pending,
            pendingApplyRequests,
            removeApplyPending,
            timeoutSeconds,
            'database filter apply',
        );

        pendingApplyRequests.set(requestId, pending);
        postHostMessage({
            command: 'applyDatabaseFilter',
            sourceUri,
            resultSetIndex,
            requestId,
            querySpec,
            timeoutSeconds: resolvedTiming.timeoutSeconds,
            isRetry: resolvedTiming.isRetry === true,
        });
    });
}

export function handleDatabaseFilterValuesResult(message: {
    requestId: number;
    sourceUri?: string;
    resultSetIndex?: number;
    columnIndex?: number;
    values?: DiskDistinctValue[];
    truncated?: boolean;
    error?: string;
}): void {
    const pending = removeValuesPending(message.requestId);
    if (!pending) {
        return;
    }
    if (isStaleResponse(pending, message)) {
        pending.reject(new Error('Request superseded'));
        return;
    }
    if (message.error) {
        pending.reject(new Error(message.error));
        return;
    }
    pending.resolve({
        values: message.values ?? [],
        truncated: message.truncated === true,
    });
}

export function handleDatabaseFilterApplyResult(message: {
    requestId: number;
    sourceUri?: string;
    resultSetIndex?: number;
    error?: string;
}): void {
    const pending = removeApplyPending(message.requestId);
    if (!pending) {
        return;
    }
    if (isStaleResponse(pending, message)) {
        pending.reject(new Error('Request superseded'));
        return;
    }
    if (message.error) {
        pending.reject(new Error(message.error));
        return;
    }
    pending.resolve();
}
