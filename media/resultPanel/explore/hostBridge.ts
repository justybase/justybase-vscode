import type { ExploreOperation, ExploreResponse } from '@justybase/contracts';
import { getResultSetAt } from '../types.js';
// Host bridge for Explore server-side operations (full stats, pivot, composer,
// SQL previews). Mirrors the pending-request pattern of databaseGrouping.ts.

import { postHostMessage } from '../protocol.js';
import { getActiveSourceUri } from '../types.js';
import { getActiveGridIndex } from '../state.js';
import type {
    ExploreComposerConfig,
    ExploreFilterModel,
    ExplorePivotConfig,
} from './types.js';

interface PendingRequest<T> {
    resolve: (result: T) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
}

const pendingRequests = new Map<number, PendingRequest<unknown>>();
let requestIdCounter = Date.now() * 1000;

function waitForRequest<T>(command: string, payload: Record<string, unknown>, timeoutSeconds: number): Promise<T> {
    const requestId = ++requestIdCounter;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            const pending = pendingRequests.get(requestId);
            if (!pending) return;
            pendingRequests.delete(requestId);
            postHostMessage({ command: 'cancelExploreOperation', requestId });
            pending.reject(new Error(`${command} timed out after ${timeoutSeconds}s`));
        }, timeoutSeconds * 1000 + 2000);
        pendingRequests.set(requestId, {
            resolve: value => resolve(value as T),
            reject,
            timer,
        });
        postHostMessage({
            command,
            requestId,
            ...payload,
        } as never);
    });
}

function settlePending(requestId: number, error: string | undefined, result: unknown): void {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
        return;
    }
    pendingRequests.delete(requestId);
    if (pending.timer) {
        clearTimeout(pending.timer);
    }
    if (error) {
        pending.reject(new Error(error));
        return;
    }
    pending.resolve(result);
}

export function handleExploreHostMessage(message: { command: string; requestId?: number; error?: string } & Record<string, unknown>): void {
    const requestId = message.requestId;
    if (requestId === undefined) {
        return;
    }
    switch (message.command) {
        case 'exploreOperationResult':
            settlePending(requestId, message.error, message.result);
            break;
        case 'exploreFullStatsResult':
            settlePending(requestId, message.error, {
                columnIndex: message.columnIndex,
                values: message.values,
                percentilesUnavailable: message.percentilesUnavailable,
                stddevUnavailable: message.stddevUnavailable,
                sql: message.sql,
            });
            break;
        case 'explorePivotResult':
            settlePending(requestId, message.error, {
                columns: message.columns ?? [],
                rows: message.rows ?? [],
                totalRows: message.totalRows ?? 0,
                pivotValues: message.pivotValues ?? [],
                truncated: message.truncated,
                sql: message.sql,
            });
            break;
        case 'explorePivotPreviewResult':
        case 'exploreComposerPreviewResult':
        case 'exploreFilteredSqlPreviewResult':
            settlePending(requestId, message.error, message.sql ?? '');
            break;
        case 'exploreComposerResult':
            settlePending(requestId, message.error, {
                columnIndexes: message.columnIndexes,
                rows: message.rows ?? [],
                sql: message.sql,
            });
            break;
        default:
            break;
    }
}

function sourceAndIndex(): { sourceUri: string; resultSetIndex: number } {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) {
        throw new Error('No active source');
    }
    return { sourceUri, resultSetIndex: getActiveGridIndex() };
}

export interface FullStatisticsPayload {
    columnIndex: number;
    values: Partial<Record<string, number | null>>;
    percentilesUnavailable: boolean;
    stddevUnavailable: boolean;
    sql: string;
}

export function requestExploreFullStats(
    columnIndex: number,
    filters?: ExploreFilterModel,
    timeoutSeconds = 120,
): Promise<FullStatisticsPayload> {
    return requestExploreOperation({ kind: 'fullStats', columnIndex, filters }, false, timeoutSeconds).then(result => ({ columnIndex,
        values: result.values ?? {}, percentilesUnavailable: result.percentilesUnavailable ?? false,
        stddevUnavailable: result.stddevUnavailable ?? false, sql: result.sql }));
}

export interface ExplorePivotResultPayload {
    columns: Array<{ name: string; type?: string; kind: 'row' | 'value' }>;
    rows: unknown[][];
    totalRows: number;
    pivotValues: string[];
    truncated?: boolean;
    sql: string;
}

export function requestExplorePivot(pivot: ExplorePivotConfig, timeoutSeconds = 300): Promise<ExplorePivotResultPayload> {
    return requestExploreOperation({ kind: 'pivot', config: pivot }, false, timeoutSeconds).then(result => ({ columns: result.columns ?? [], rows: result.rows,
        totalRows: result.rows.length, pivotValues: result.pivotValues ?? [], truncated: result.truncated, sql: result.sql }));
}

export function previewExplorePivot(pivot: ExplorePivotConfig, pivotValues: string[]): Promise<string> {
    return requestExploreOperation({ kind: 'pivot', config: pivot, pivotValues }, true).then(result => result.sql);
}

export interface ExploreComposerResultPayload {
    columnIndexes: {
        bucket: number;
        dimension: number | undefined;
        split: number | undefined;
    splitOther?: number;
        measure: number;
        previous: number | undefined;
    };
    rows: unknown[][];
    sql: string;
}

export function requestExploreComposer(composer: ExploreComposerConfig, timeoutSeconds = 300): Promise<ExploreComposerResultPayload> {
    return requestExploreOperation({ kind: 'composer', config: composer }, false, timeoutSeconds).then(result => {
        if (!result.columnIndexes) throw new Error('Missing time-series column metadata.');
        return { columnIndexes: result.columnIndexes, rows: result.rows, sql: result.sql };
    });
}

export function previewExploreComposer(composer: ExploreComposerConfig): Promise<string> {
    return requestExploreOperation({ kind: 'composer', config: composer }, true).then(result => result.sql);
}

export function previewExploreFilteredSql(filters: ExploreFilterModel): Promise<string> {
    const { sourceUri, resultSetIndex } = sourceAndIndex();
    return waitForRequest<string>('previewExploreFilteredSql', {
        sourceUri,
        resultSetIndex,
        filters,
    }, 30);
}

export function openExploreSqlInEditor(sql: string, label?: string): void {
    postHostMessage({ command: 'openExploreSqlInEditor', sql, label } as never);
}

export function requestExploreOperation(operation: ExploreOperation, preview = false, timeoutSeconds = operation.kind === 'values' || operation.kind === 'fullStats' ? 120 : 300): Promise<ExploreResponse> {
    const scope = sourceAndIndex();
    return waitForRequest<ExploreResponse>('requestExploreOperation', { ...scope,
        resultSetId: getResultSetAt(scope.resultSetIndex)?.resultSetId, operation, preview, timeoutSeconds }, preview ? 30 : timeoutSeconds);
}

/** Reject pending work on view replacement; the host cancels only its owned executions. */
export function cancelExploreRequests(): void {
    for (const [requestId, pending] of pendingRequests) {
        postHostMessage({ command: 'cancelExploreOperation', requestId });
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('Cancelled'));
    }
    pendingRequests.clear();
}
