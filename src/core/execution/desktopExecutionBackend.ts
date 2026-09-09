import type {
    ExecutionBackend,
    ExecutionBackendContext,
    ExecutionResourceScope,
} from '@justybase/database-runtime/execution';
import { ExecutionBackendError } from '@justybase/database-runtime/execution';
import type {
    DatabaseQueryCallbacks,
    DatabaseQueryOptions,
    DatabaseQueryResult,
} from '@justybase/contracts';

import type { NzConnection } from '../../types';

/** Structural chunk boundary kept independent from the StreamingManager module. */
export interface DesktopStreamingChunk {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    isFirstChunk: boolean;
    isLastChunk: boolean;
    totalRowsSoFar: number;
    limitReached: boolean;
    isCancelled?: boolean;
}

export interface DesktopStreamingExecutionPort {
    executeAndFetch(
        connection: NzConnection,
        query: string,
        limit: number,
        timeoutSeconds?: number,
        documentUri?: string,
        sessionId?: string,
        connectionManager?: { closeDocumentPersistentConnection(uri: string): Promise<void> },
        maxRows?: number,
        onDropSession?: (sessionId: string) => Promise<void>,
    ): Promise<DesktopBufferedExecutionResult>;
    executeWithStreaming(
        connection: NzConnection,
        query: string,
        limit: number,
        chunkSize: number,
        timeoutSeconds: number | undefined,
        documentUri: string | undefined,
        onChunk: (chunk: DesktopStreamingChunk) => void | Promise<void>,
        sessionId?: string,
        connectionManager?: { closeDocumentPersistentConnection(uri: string): Promise<void> },
        maxRows?: number,
        onDropSession?: (sessionId: string) => Promise<void>,
    ): Promise<DesktopStreamingExecutionResult>;
    abortQuery(documentUri: string, reason?: string): boolean;
}

export interface DesktopBufferedExecutionResult {
    results: readonly DesktopResultSet[];
    error?: Error;
    recordsAffected?: number;
    status: 'success' | 'cancelled' | 'timeout' | 'error';
    timing?: unknown;
}

export interface DesktopStreamingExecutionResult {
    totalRows: number;
    limitReached: boolean;
    error?: Error;
    recordsAffected?: number;
    status: 'success' | 'cancelled' | 'timeout' | 'error';
    timing?: unknown;
}

export interface DesktopResultSet {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    limitReached: boolean;
}

export interface DesktopExecutionConnectionLease {
    connection: NzConnection;
    shouldCloseConnection: boolean;
}

/** Mutable target owned by one desktop execution. */
export interface DesktopExecutionTarget {
    connection?: NzConnection;
    shouldCloseConnection?: boolean;
    readonly keepConnectionOpen: boolean;
    readonly documentUri?: string;
    sessionId?: string;
    readonly connectionManager?: {
        closeDocumentPersistentConnection(uri: string): Promise<void>;
    };
    readonly openConnection?: () => Promise<DesktopExecutionConnectionLease>;
    readonly onConnectionAcquired?: (connection: NzConnection) => Promise<string | undefined>;
    readonly onNotice?: (message: unknown) => void;
    readonly onTiming?: (timing: unknown) => void;
    readonly onChunk?: (chunk: DesktopStreamingChunk) => void | Promise<void>;
    readonly onStatementSucceeded?: (connection: NzConnection, sql: string) => Promise<void>;
    readonly onDropSession?: (sessionId: string) => Promise<void>;
    readonly chunkSize: number;
    readonly cancelWithoutDocument?: (reason?: string) => Promise<void>;
    readonly isCancellationRequested?: () => boolean;
}

export interface DesktopExecutionBackendOptions {
    streamingManager: DesktopStreamingExecutionPort;
    isConnectionBrokenError?: (error: unknown) => boolean;
    isSafeToRetrySql?: (sql: string) => boolean;
}

function totalRows(resultSets: readonly DesktopResultSet[]): number {
    return resultSets.reduce((sum, result) => sum + result.rows.length, 0);
}

/**
 * Adapts the existing VS Code connection/reader boundary to the shared
 * execution lifecycle. The adapter owns only product concerns (connection
 * acquisition, notices and the legacy StreamingManager); ordering, retry,
 * cancellation state and terminal events stay in database-runtime.
 */
export class DesktopExecutionBackend implements ExecutionBackend<DesktopExecutionTarget> {
    private readonly streamingManager: DesktopStreamingExecutionPort;
    private readonly connectionBroken?: (error: unknown) => boolean;
    private readonly safeToRetry?: (sql: string) => boolean;

    public constructor(options: DesktopExecutionBackendOptions) {
        this.streamingManager = options.streamingManager;
        this.connectionBroken = options.isConnectionBrokenError;
        this.safeToRetry = options.isSafeToRetrySql;
    }

    public isConnectionBrokenError(error: unknown): boolean {
        return this.connectionBroken?.(error) ?? false;
    }

    public isSafeToRetrySql(sql: string): boolean {
        return this.safeToRetry?.(sql) ?? false;
    }

    public isCancellationRequested(target: DesktopExecutionTarget): boolean {
        return target.isCancellationRequested?.() ?? false;
    }

    public async execute(
        target: DesktopExecutionTarget,
        sql: string,
        options: DatabaseQueryOptions,
        callbacks: DatabaseQueryCallbacks,
        _resources?: ExecutionResourceScope,
        context?: ExecutionBackendContext<DesktopExecutionTarget>,
    ): Promise<DatabaseQueryResult> {
        const connection = await this.ensureConnection(target);
        const noticeHandler = target.onNotice;
        if (noticeHandler) connection.on('notice', noticeHandler);

        try {
            if (context?.delivery === 'streaming') {
                const result = await this.streamingManager.executeWithStreaming(
                    connection,
                    sql,
                    options.maxRows,
                    target.chunkSize,
                    options.timeoutSeconds,
                    target.documentUri,
                    chunk => {
                        this.forwardChunk(callbacks, chunk);
                        return target.onChunk?.(chunk);
                    },
                    target.sessionId,
                    target.connectionManager,
                    options.maxRows,
                    target.onDropSession,
                );
                target.onTiming?.(result.timing);
                this.throwExecutionError(result.error, {
                    totalRows: result.totalRows,
                    limitReached: result.limitReached,
                    rowsAffected: result.recordsAffected,
                });
                if (target.onStatementSucceeded && target.connection) {
                    await target.onStatementSucceeded(target.connection, sql);
                }
                return {
                    totalRows: result.totalRows,
                    limitReached: result.limitReached,
                    ...(result.recordsAffected === undefined ? {} : { rowsAffected: result.recordsAffected }),
                };
            }

            const result = await this.streamingManager.executeAndFetch(
                connection,
                sql,
                options.maxRows,
                options.timeoutSeconds,
                target.documentUri,
                target.sessionId,
                target.connectionManager,
                options.maxRows,
                target.onDropSession,
            );
            target.onTiming?.(result.timing);
            this.throwExecutionError(result.error, {
                totalRows: totalRows(result.results),
                limitReached: result.results.some(resultSet => resultSet.limitReached),
                rowsAffected: result.recordsAffected,
            });

            let deliveredRows = 0;
            for (const resultSet of result.results) {
                callbacks.onColumns(resultSet.columns);
                deliveredRows += resultSet.rows.length;
                callbacks.onRows(resultSet.rows, deliveredRows);
            }
            if (target.onStatementSucceeded && target.connection) {
                await target.onStatementSucceeded(target.connection, sql);
            }
            return {
                totalRows: totalRows(result.results),
                limitReached: result.results.some(resultSet => resultSet.limitReached),
                ...(result.recordsAffected === undefined ? {} : { rowsAffected: result.recordsAffected }),
            };
        } finally {
            if (noticeHandler) connection.removeListener('notice', noticeHandler);
        }
    }

    public async cancel(
        target: DesktopExecutionTarget,
        _request: Parameters<NonNullable<ExecutionBackend<DesktopExecutionTarget>['cancel']>>[1],
        reason?: string,
    ): Promise<void> {
        if (target.documentUri) {
            this.streamingManager.abortQuery(target.documentUri, reason);
            return;
        }
        await target.cancelWithoutDocument?.(reason);
    }

    public async reconnect(target: DesktopExecutionTarget): Promise<void> {
        await this.closeTarget(target);
    }

    public async closeTarget(target: DesktopExecutionTarget): Promise<void> {
        const connection = target.connection;
        target.connection = undefined;
        if (!target.shouldCloseConnection && target.documentUri && target.connectionManager) {
            await target.connectionManager.closeDocumentPersistentConnection(target.documentUri);
            return;
        }
        if (connection) await connection.close();
    }

    public async cleanup(target: DesktopExecutionTarget): Promise<void> {
        if (target.shouldCloseConnection) await this.closeTarget(target);
    }

    private async ensureConnection(target: DesktopExecutionTarget): Promise<NzConnection> {
        if (target.connection) return target.connection;
        if (!target.openConnection) throw new Error('Desktop execution connection is unavailable.');
        const lease = await target.openConnection();
        target.connection = lease.connection;
        target.shouldCloseConnection = lease.shouldCloseConnection;
        if (target.onConnectionAcquired) {
            target.sessionId = await target.onConnectionAcquired(lease.connection);
        }
        return lease.connection;
    }

    private forwardChunk(callbacks: DatabaseQueryCallbacks, chunk: DesktopStreamingChunk): void {
        if (chunk.isFirstChunk) callbacks.onColumns(chunk.columns);
        if (chunk.rows.length > 0) callbacks.onRows(chunk.rows, chunk.totalRowsSoFar);
    }

    private throwExecutionError(
        error: Error | undefined,
        metadata: { totalRows?: number; limitReached?: boolean; rowsAffected?: number },
    ): void {
        if (error) {
            throw new ExecutionBackendError(error.message, error, metadata);
        }
    }
}
