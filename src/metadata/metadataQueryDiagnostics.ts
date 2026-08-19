import { logWithFallback } from '../utils/logger';

export type MetadataRequestSource =
    | 'connection-prefetch'
    | 'database-prefetch'
    | 'schema-prefetch'
    | 'completion'
    | 'schema-tree'
    | 'ddl-sync'
    | 'warmup'
    | 'synonym'
    | 'system'
    | 'unknown';

export type MetadataQueryKind =
    | 'databases'
    | 'schemas'
    | 'type-groups'
    | 'objects'
    | 'external-objects'
    | 'procedures'
    | 'columns'
    | 'external-columns'
    | 'table-columns'
    | 'external-table-columns'
    | 'comment'
    | 'synonym'
    | 'unknown';

export interface MetadataQueryContext {
    source: MetadataRequestSource;
    kind?: MetadataQueryKind;
    connectionName?: string;
    database?: string;
    schema?: string;
    table?: string;
    reason?: string;
    requestId?: string;
    queueWaitMs?: number;
}

export interface MetadataColumnLookupOptions {
    allowPublicSynonym?: boolean;
    /** Completion uses the hydrated cache and must not start a live catalog query. */
    allowDatabaseFetch?: boolean;
    requestSource?: MetadataRequestSource;
}

export interface MetadataQueryTiming {
    queueWaitMs?: number;
    executeReaderMs?: number;
    serverWaitToFirstRowMs?: number;
    rowFetchMs?: number;
    readerCloseMs?: number;
    rowsRead?: number;
    totalMs?: number;
    sessionId?: string;
    status?: 'success' | 'error' | 'cancelled' | 'timeout';
}

function formatTarget(context: MetadataQueryContext): string {
    const parts = [context.database, context.schema, context.table]
        .filter((part): part is string => Boolean(part && part.trim()))
        .map((part) => part.trim());
    return parts.length > 0 ? parts.join('.') : '-';
}

/**
 * Log client-observed catalog timings without logging the SQL text. The
 * `serverWaitToFirstRowMs` value includes driver/server time until the first
 * row (or EOF) becomes observable; it is not a server CPU measurement.
 */
export function logMetadataQueryTiming(
    context: MetadataQueryContext,
    timing: MetadataQueryTiming,
): void {
    const fields = [
        `source=${context.source}`,
        `kind=${context.kind ?? 'unknown'}`,
        `target=${formatTarget(context)}`,
        `reason=${context.reason ?? '-'}`,
        `queueWaitMs=${timing.queueWaitMs ?? context.queueWaitMs ?? 0}`,
        `executeReaderMs=${timing.executeReaderMs ?? '-'}`,
        `serverWaitToFirstRowMs=${timing.serverWaitToFirstRowMs ?? '-'}`,
        `rowFetchMs=${timing.rowFetchMs ?? '-'}`,
        `readerCloseMs=${timing.readerCloseMs ?? '-'}`,
        `rowsRead=${timing.rowsRead ?? '-'}`,
        `totalMs=${timing.totalMs ?? '-'}`,
        `status=${timing.status ?? 'success'}`,
        `sessionId=${timing.sessionId ?? '-'}`,
    ];
    if (context.requestId) {
        fields.push(`requestId=${context.requestId}`);
    }
    logWithFallback('debug', `[MetadataTiming] ${fields.join(' ')}`);
}
