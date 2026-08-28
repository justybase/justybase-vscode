/**
 * One or more physical connections for one full metadata refresh.
 *
 * The normal raw-query path intentionally opens a short-lived connection when
 * there is no document URI. That is safe for individual requests, but a full
 * Netezza refresh can otherwise perform dozens of TCP/login handshakes. This
 * runner serializes work on each connection and is disposed by CachePrefetcher
 * on every completion path. The primary connection is used for all stages;
 * optional additional connections are exposed only to the column stage.
 */

import type * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { getExtensionConfiguration } from '../compatibility/configuration';
import {
    DEFAULT_FULL_REFRESH_COLUMN_CONNECTIONS,
    normalizeFullRefreshColumnConnections,
} from './metadataQueryLimiter';
import {
    runQueryRaw,
    type MetadataQuerySession,
    type RunQueryRawOptions,
} from '../core/queryRunner';
import type { NzConnection, QueryResult } from '../types';
import { logWithFallback } from '../utils/logger';
import type { MetadataQueryContext } from './metadataQueryDiagnostics';
import type {
    DisposableQueryRunnerRawFn,
    MetadataColumnQueryRunner,
    MetadataPrefetchExecutionObserver,
} from './prefetch';

type MetadataQueryExecutor = (options: RunQueryRawOptions) => Promise<QueryResult>;

export interface ConnectionScopedMetadataQueryRunnerOptions {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    connectionName: string;
    /** Defaults to the full-prefetch row cap. */
    maxRows?: number;
    timeoutSeconds?: number;
    /** Injectable for activation wiring and focused tests. */
    queryExecutor?: MetadataQueryExecutor;
    /** Number of physical sessions made available to the full-refresh column stage. */
    columnConnectionCount?: number;
}

class ConnectionScopedMetadataSession {
    private connection: NzConnection | undefined;
    private connectionPromise: Promise<NzConnection> | undefined;
    private session: MetadataQuerySession | undefined;
    private queuedWork: Promise<void> = Promise.resolve();
    private disposeRequested = false;
    private disposePromise: Promise<void> | undefined;

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly connectionName: string,
    ) {}

    async run<T>(
        operation: (
            connection: NzConnection,
            session: MetadataQuerySession,
            sessionQueueWaitMs: number,
        ) => Promise<T>,
    ): Promise<T> {
        const queuedAt = Date.now();
        const previous = this.queuedWork;
        let releaseQueue!: () => void;
        this.queuedWork = new Promise<void>((resolve) => {
            releaseQueue = resolve;
        });

        await previous;
        try {
            if (this.disposeRequested) {
                throw new Error(`Metadata session for '${this.connectionName}' was already closed`);
            }
            const connection = await this.getConnection();
            const session = this.session ?? { connection };
            this.session = session;
            return await operation(connection, session, Date.now() - queuedAt);
        } finally {
            releaseQueue();
        }
    }

    /** Open this slot without executing a catalog statement. */
    async ensureConnected(): Promise<void> {
        if (this.disposeRequested) {
            throw new Error(`Metadata session for '${this.connectionName}' was already closed`);
        }
        await this.getConnection();
    }

    async dispose(): Promise<void> {
        if (this.disposePromise) {
            return this.disposePromise;
        }
        this.disposeRequested = true;
        this.disposePromise = (async () => {
            // Finish the active query before closing its connection. Any work
            // queued after disposal observes `disposeRequested` and never uses
            // the connection.
            await this.queuedWork;
            const connection = this.connection;
            this.connection = undefined;
            this.connectionPromise = undefined;
            this.session = undefined;
            if (!connection) {
                return;
            }
            try {
                await connection.close();
                logWithFallback(
                    'debug',
                    `[MetadataConnectionScope] Closed shared metadata session for ${this.connectionName}`,
                );
            } catch (error: unknown) {
                logWithFallback(
                    'warn',
                    `[MetadataConnectionScope] Failed to close shared metadata session for ${this.connectionName}:`,
                    error,
                );
            }
        })();
        return this.disposePromise;
    }

    private async getConnection(): Promise<NzConnection> {
        if (this.connection) {
            return this.connection;
        }
        if (!this.connectionPromise) {
            this.connectionPromise = this.openConnection();
        }
        try {
            return await this.connectionPromise;
        } catch (error: unknown) {
            this.connectionPromise = undefined;
            throw error;
        }
    }

    private async openConnection(): Promise<NzConnection> {
        const details = await this.connectionManager.getConnection(this.connectionName);
        if (!details) {
            throw new Error(`Connection '${this.connectionName}' not found`);
        }

        const startedAt = Date.now();
        const connection = await createConnectedDatabaseConnectionFromDetails(details) as NzConnection;
        if (this.disposeRequested) {
            try {
                await connection.close();
            } catch {
                // Preserve the disposal outcome; the connection was never made available.
            }
            throw new Error(`Metadata session for '${this.connectionName}' was closed while connecting`);
        }
        this.connection = connection;
        logWithFallback(
            'debug',
            `[MetadataConnectionScope] Opened shared metadata session for ${this.connectionName} in ${Date.now() - startedAt}ms`,
        );
        return connection;
    }
}

/**
 * Creates the primary runner for a full metadata refresh. The runner exposes
 * configured column-stage slots; its `dispose` hook closes every slot and is
 * called by CachePrefetcher, including failed-start paths.
 */
export function createConnectionScopedMetadataQueryRunner(
    options: ConnectionScopedMetadataQueryRunnerOptions,
): DisposableQueryRunnerRawFn {
    const execute: MetadataQueryExecutor = options.queryExecutor
        ?? ((queryOptions) => runQueryRaw(queryOptions));

    const configuredCount = options.columnConnectionCount
        ?? getExtensionConfiguration('metadata').get<number>(
            'fullRefreshColumnConnections',
            DEFAULT_FULL_REFRESH_COLUMN_CONNECTIONS,
        );
    const columnConnectionCount = normalizeFullRefreshColumnConnections(configuredCount);

    const scopes: ConnectionScopedMetadataSession[] = [];
    const columnRunners: MetadataColumnQueryRunner[] = [];

    const createRunnerForScope = (scope: ConnectionScopedMetadataSession): MetadataColumnQueryRunner => {
        const runner = (async (
            query: string,
            metadataContext?: MetadataQueryContext,
            executionObserver?: MetadataPrefetchExecutionObserver,
        ): Promise<QueryResult> => scope.run(async (connection, session, sessionQueueWaitMs) => {
            const queueWaitMs = (metadataContext?.queueWaitMs ?? 0) + sessionQueueWaitMs;
            const scopedMetadataContext = metadataContext
                ? { ...metadataContext, queueWaitMs }
                : undefined;
            executionObserver?.onExecutionStarted(queueWaitMs);

            let executionCompleted = false;
            const reportExecutionCompleted = (timing?: Parameters<MetadataPrefetchExecutionObserver['onExecutionCompleted']>[0]): void => {
                if (executionCompleted) {
                    return;
                }
                executionCompleted = true;
                executionObserver?.onExecutionCompleted(timing);
            };

            try {
                const result = await execute({
                    context: options.context,
                    query,
                    silent: true,
                    connectionManager: options.connectionManager,
                    connectionName: options.connectionName,
                    maxRows: options.maxRows ?? 1_000_000,
                    isUserQuery: false,
                    timeoutSeconds: options.timeoutSeconds,
                    metadataContext: scopedMetadataContext,
                    metadataQueueWaitMs: queueWaitMs,
                    onMetadataExecutionComplete: reportExecutionCompleted,
                    connectionOverride: connection,
                    metadataSession: session,
                });
                reportExecutionCompleted();
                return result;
            } catch (error: unknown) {
                reportExecutionCompleted();
                throw error;
            }
        })) as MetadataColumnQueryRunner;
        runner.ensureConnected = () => scope.ensureConnected();
        runner.dispose = () => scope.dispose();
        return runner;
    };

    for (let index = 0; index < columnConnectionCount; index += 1) {
        const scope = new ConnectionScopedMetadataSession(
            options.connectionManager,
            options.connectionName,
        );
        scopes.push(scope);
        columnRunners.push(createRunnerForScope(scope));
    }

    const primaryRunner = columnRunners[0] as DisposableQueryRunnerRawFn;
    primaryRunner.getColumnQueryRunners = () => columnRunners;
    primaryRunner.dispose = async () => {
        for (const scope of scopes) {
            await scope.dispose();
        }
    };
    return primaryRunner;
}
