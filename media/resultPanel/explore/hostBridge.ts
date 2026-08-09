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
let requestIdCounter = 0;

function waitForRequest<T>(command: string, payload: Record<string, unknown>, timeoutSeconds: number): Promise<T> {
    const requestId = ++requestIdCounter;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            const pending = pendingRequests.get(requestId);
            if (!pending) return;
            pendingRequests.delete(requestId);
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
    const { sourceUri, resultSetIndex } = sourceAndIndex();
    return waitForRequest<FullStatisticsPayload>('requestExploreFullStats', {
        sourceUri,
        resultSetIndex,
        columnIndex,
        filters,
        timeoutSeconds,
    }, timeoutSeconds);
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
    const { sourceUri, resultSetIndex } = sourceAndIndex();
    return waitForRequest<ExplorePivotResultPayload>('requestExplorePivot', {
        sourceUri,
        resultSetIndex,
        pivot,
        timeoutSeconds,
    }, timeoutSeconds);
}

export function previewExplorePivot(pivot: ExplorePivotConfig, pivotValues: string[]): Promise<string> {
    const { sourceUri, resultSetIndex } = sourceAndIndex();
    return waitForRequest<string>('previewExplorePivot', {
        sourceUri,
        resultSetIndex,
        pivot,
        pivotValues,
    }, 30);
}

export interface ExploreComposerResultPayload {
    columnIndexes: {
        bucket: number;
        dimension: number | undefined;
        split: number | undefined;
        measure: number;
        previous: number | undefined;
    };
    rows: unknown[][];
    sql: string;
}

export function requestExploreComposer(composer: ExploreComposerConfig, timeoutSeconds = 300): Promise<ExploreComposerResultPayload> {
    const { sourceUri, resultSetIndex } = sourceAndIndex();
    return waitForRequest<ExploreComposerResultPayload>('requestExploreComposer', {
        sourceUri,
        resultSetIndex,
        composer,
        timeoutSeconds,
    }, timeoutSeconds);
}

export function previewExploreComposer(composer: ExploreComposerConfig): Promise<string> {
    const { sourceUri, resultSetIndex } = sourceAndIndex();
    return waitForRequest<string>('previewExploreComposer', {
        sourceUri,
        resultSetIndex,
        composer,
    }, 30);
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
