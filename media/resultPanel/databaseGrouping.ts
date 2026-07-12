/**
 * Database Grouping Module
 *
 * Handles the webview-side logic for the database grouping panel.
 * Sends grouping requests to the host and manages pending state.
 */

import { postHostMessage } from './protocol.js';
import { getActiveGridIndex } from './state.js';
import { getActiveSourceUri, getResultSetAt } from './types.js';

export interface GroupingColumn {
    columnIndex: number;
    columnName: string;
}

export interface GroupingFunction {
    fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'countDistinct' | 'median';
    columnIndex?: number;
    alias?: string;
}

export interface DatabaseGroupingRequest {
    groupByColumns: GroupingColumn[];
    functions: GroupingFunction[];
    orderBy?: { columnIndex: number; desc: boolean }[];
    /** undefined preserves the source query limit; null means Unlimited. */
    limit?: number | null;
}

export interface GroupingResultColumn {
    name: string;
    type?: string;
    kind?: 'group' | 'count' | 'percentage' | 'aggregate';
}

export interface GroupingResult {
    columns: GroupingResultColumn[];
    rows: unknown[][];
    totalRows: number;
    truncated?: boolean;
    sql: string;
}

interface PendingGroupingRequest {
    resolve: (result: GroupingResult) => void;
    reject: (error: Error) => void;
    sourceUri: string;
    resultSetIndex: number;
    timer: ReturnType<typeof setTimeout>;
}

let requestIdCounter = 0;
const pendingRequests = new Map<number, PendingGroupingRequest>();

/**
 * Execute a database GROUP BY query.
 * Returns a promise that resolves with the grouping results.
 */
export function executeDatabaseGrouping(
    request: DatabaseGroupingRequest,
    timeoutSeconds = 300,
): Promise<GroupingResult> {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
        return Promise.reject(new Error('No active source'));
    }

    const resultSetIndex = getActiveGridIndex();
    const requestId = ++requestIdCounter;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const timedOut = pendingRequests.get(requestId);
            if (!timedOut) return;
            pendingRequests.delete(requestId);
            timedOut.reject(new Error(`Grouping query timed out after ${timeoutSeconds}s`));
        }, timeoutSeconds * 1000 + 2000);
        const pending: PendingGroupingRequest = {
            resolve,
            reject,
            sourceUri,
            resultSetIndex,
            timer,
        };

        pendingRequests.set(requestId, pending);

        // Store timer for cleanup
        const originalReject = reject;
        const wrappedReject = (error: Error) => {
            clearTimeout(timer);
            pendingRequests.delete(requestId);
            originalReject(error);
        };
        pending.reject = wrappedReject;

        postHostMessage({
            command: 'requestDatabaseGrouping',
            sourceUri,
            resultSetIndex,
            requestId,
            grouping: request,
            timeoutSeconds,
        });
    });
}

interface PendingPreviewRequest {
    resolve: (sql: string) => void;
    reject: (error: Error) => void;
}

const previewPendingRequests = new Map<number, PendingPreviewRequest>();

/**
 * Preview the generated SQL for a grouping query without executing it.
 * Returns a promise that resolves with the SQL string.
 */
export function previewDatabaseGrouping(
    request: DatabaseGroupingRequest,
): Promise<string> {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
        return Promise.reject(new Error('No active source'));
    }

    const resultSetIndex = getActiveGridIndex();
    const requestId = ++requestIdCounter;

    return new Promise((resolve, reject) => {
        previewPendingRequests.set(requestId, { resolve, reject });

        postHostMessage({
            command: 'previewDatabaseGrouping',
            sourceUri,
            resultSetIndex,
            requestId,
            grouping: request,
        });
    });
}

/**
 * Handle the grouping SQL preview result from the host.
 */
export function handleDatabaseGroupingPreviewResult(message: {
    requestId: number;
    sql?: string;
    error?: string;
}): void {
    const pending = previewPendingRequests.get(message.requestId);
    if (!pending) {
        return;
    }

    previewPendingRequests.delete(message.requestId);

    if (message.error) {
        pending.reject(new Error(message.error));
        return;
    }

    pending.resolve(message.sql ?? '');
}

/**
 * Handle the grouping result from the host.
 */
export function handleDatabaseGroupingResult(message: {
    requestId: number;
    sourceUri?: string;
    resultSetIndex?: number;
    columns?: GroupingResultColumn[];
    rows?: unknown[][];
    totalRows?: number;
    truncated?: boolean;
    sql?: string;
    error?: string;
}): void {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) {
        return;
    }

    pendingRequests.delete(message.requestId);
    clearTimeout(pending.timer);

    if (message.error) {
        pending.reject(new Error(message.error));
        return;
    }

    pending.resolve({
        columns: message.columns ?? [],
        rows: message.rows ?? [],
        totalRows: message.totalRows ?? 0,
        truncated: message.truncated,
        sql: message.sql ?? '',
    });
}

/**
 * Cancel a pending grouping request.
 */
export function cancelDatabaseGrouping(requestId: number): void {
    const pending = pendingRequests.get(requestId);
    if (pending) {
        pendingRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(new Error('Request cancelled'));
        postHostMessage({
            command: 'cancelDatabaseGrouping',
            sourceUri: pending.sourceUri,
            resultSetIndex: pending.resultSetIndex,
            requestId,
        });
    }
}

/**
 * Get the column definitions for the current result set.
 * Used for building grouping configuration UI.
 */
export function getCurrentResultColumns(): Array<{ index: number; name: string; type?: string }> {
    const activeIndex = getActiveGridIndex();
    const rs = getResultSetAt(activeIndex);
    if (!rs || !rs.columns) {
        return [];
    }
    return rs.columns.map((col, idx) => ({
        index: idx,
        name: col.name || `Column ${idx}`,
        type: col.type,
    }));
}

/**
 * Get the original SQL for the current result set.
 */
export function getCurrentResultSql(): string | undefined {
    const activeIndex = getActiveGridIndex();
    const rs = getResultSetAt(activeIndex);
    return rs?.refreshSql || rs?.sql;
}
