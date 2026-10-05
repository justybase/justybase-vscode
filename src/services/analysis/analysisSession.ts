import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionManager } from '../../core/connectionManager';
import { createConnectedDatabaseConnectionFromDetails } from '../../core/connectionFactory';
import { runQueryRaw, queryResultToRows, runExplainQuery, type MetadataQuerySession } from '../../core/queryRunner';
import { streamingManager } from '../../core/queryCancellation';
import type { DatabaseConnection } from '../../contracts/database';
import { buildSafeExplainSql } from '../copilotTools/aiSqlSafety';
import { Logger } from '../../utils/logger';

/** One isolated, caller-owned metadata/EXPLAIN session using the existing runtime. */
export class AnalysisSession {
    private readonly source = `justybase-analysis:${randomUUID()}`;
    private cancellation?: vscode.Disposable;
    private connection?: DatabaseConnection;
    private session?: MetadataQuerySession;
    constructor(private readonly context: vscode.ExtensionContext, private readonly manager: ConnectionManager,
        readonly connectionName: string, readonly database: string, private readonly token: vscode.CancellationToken) {}
    private check(): void { if (this.token.isCancellationRequested) { throw new vscode.CancellationError(); } }
    async open(): Promise<void> {
        this.check();
        const details = await this.manager.getConnection(this.connectionName);
        if (!details || this.manager.getConnectionDatabaseKind(this.connectionName) !== 'netezza') { throw new Error('This analysis requires a Netezza connection.'); }
        this.connection = await createConnectedDatabaseConnectionFromDetails(details, this.database);
        this.cancellation = this.token.onCancellationRequested(() => streamingManager.abortQuery(this.source));
        await this.captureSessionId();
        this.check();
    }
    /**
     * Reuse one metadata session for every query. Without a pre-seeded session id,
     * runQueryRaw issues its own SELECT CURRENT_SID before each statement, which
     * leaves the shared connection busy for the next statement.
     */
    private async captureSessionId(): Promise<void> {
        if (!this.connection) { return; }
        try {
            const command = this.connection.createCommand('SELECT CURRENT_SID');
            const reader = await command.executeReader();
            try {
                if (await reader.read()) {
                    this.session = { connection: this.connection, sessionId: String(reader.getValue(0)) };
                }
            } finally { await reader.close(); }
        } catch { this.session = undefined; }
    }
    async rows(query: string, maxRows = 20_001): Promise<Record<string, unknown>[]> {
        this.check();
        const result = await runQueryRaw({ context: this.context, query, connectionManager: this.manager,
            connectionName: this.connectionName, connectionOverride: this.connection, metadataSession: this.session,
            documentUri: this.source, silent: true, isUserQuery: false, maxRows, timeoutSeconds: 60, isExecutionCurrent: () => !this.token.isCancellationRequested });
        this.check();
        return queryResultToRows<Record<string, unknown>>(result);
    }
    async explain(sql: string): Promise<string> {
        this.check();
        const output = await runExplainQuery(this.context, buildSafeExplainSql(sql, true), this.connectionName, this.manager, this.source, this.connection);
        this.check();
        return output;
    }
    async close(): Promise<void> {
        this.cancellation?.dispose();
        this.session = undefined;
        try { await this.connection?.close(); }
        catch (error) { Logger.getInstance().warn('Analysis session cleanup failed', error); }
        finally { this.connection = undefined; streamingManager.clearAborted(this.source); }
    }
}
