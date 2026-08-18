import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    resolveConnectionDatabaseKind,
} from '../core/connectionFactory';
import type { DatabaseConnection } from '../contracts/database';
import { logWithFallback } from '../utils/logger';

const DEFAULT_ENABLED = true;
const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_AGE_MINUTES = 20;
const MAX_REGISTRY_ENTRIES = 500;
const SWEEPER_COMMAND_TIMEOUT_SECONDS = 15;

interface SessionRecord {
    startedAtMs: number;
}

/**
 * Tracks metadata catalog sessions (no documentUri, isUserQuery=false) and
 * automatically drops sessions that outlive the configured age threshold.
 * Only Netezza connections are swept; `DROP SESSION` is Netezza-specific.
 */
class MetadataSessionSweeper {
    private readonly registry = new Map<string, Map<string, SessionRecord>>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private sweepInProgress = false;
    private connectionManager: ConnectionManager | undefined;

    /** @internal Test / diagnostics */
    hasSession(connectionName: string, sessionId: string): boolean {
        return this.registry.get(connectionName)?.has(sessionId) ?? false;
    }

    /** @internal Test / diagnostics */
    getRegisteredSessionCount(connectionName: string): number {
        return this.registry.get(connectionName)?.size ?? 0;
    }

    register(connectionName: string, sessionId: string): void {
        if (!connectionName || !sessionId) {
            return;
        }
        let perConnection = this.registry.get(connectionName);
        if (!perConnection) {
            perConnection = new Map<string, SessionRecord>();
            this.registry.set(connectionName, perConnection);
        }
        perConnection.set(sessionId, { startedAtMs: Date.now() });
        if (perConnection.size > MAX_REGISTRY_ENTRIES) {
            const oldest = [...perConnection.entries()]
                .sort((a, b) => a[1].startedAtMs - b[1].startedAtMs)
                .slice(0, perConnection.size - MAX_REGISTRY_ENTRIES);
            for (const [sid] of oldest) {
                perConnection.delete(sid);
            }
        }
    }

    start(connectionManager: ConnectionManager): void {
        if (this.timer || this.connectionManager) {
            return;
        }
        this.connectionManager = connectionManager;
        const intervalMs = Math.max(60_000, this.readIntervalMinutes() * 60_000);
        this.timer = setInterval(() => {
            void this.sweep();
        }, intervalMs);
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = undefined;
        this.connectionManager = undefined;
        this.registry.clear();
    }

    async sweep(): Promise<void> {
        if (this.sweepInProgress) {
            return;
        }
        this.sweepInProgress = true;
        try {
            const connManager = this.connectionManager;
            if (!connManager) {
                return;
            }
            if (!this.isEnabled()) {
                this.registry.clear();
                return;
            }
            const maxAgeMs = Math.max(1, this.readMaxAgeMinutes()) * 60_000;
            const now = Date.now();
            for (const [connectionName, sessions] of [...this.registry.entries()]) {
                const staleIds = [...sessions.entries()]
                    .filter(([, record]) => now - record.startedAtMs >= maxAgeMs)
                    .map(([sid]) => sid);
                if (staleIds.length === 0) {
                    continue;
                }
                await this.processStaleSessions(connManager, connectionName, sessions, staleIds);
            }
        } catch (error) {
            logWithFallback('error', '[MetadataSessionSweeper] sweep failed:', error);
        } finally {
            this.sweepInProgress = false;
        }
    }

    private async processStaleSessions(
        connManager: ConnectionManager,
        connectionName: string,
        sessions: Map<string, SessionRecord>,
        staleIds: string[],
    ): Promise<void> {
        let details;
        try {
            details = await connManager.getConnection(connectionName);
        } catch {
            details = undefined;
        }
        if (!details) {
            for (const sid of staleIds) {
                sessions.delete(sid);
            }
            return;
        }
        if (resolveConnectionDatabaseKind(details.dbType) !== 'netezza') {
            for (const sid of staleIds) {
                sessions.delete(sid);
            }
            return;
        }

        let connection: DatabaseConnection | undefined;
        try {
            connection = await createConnectedDatabaseConnectionFromDetails(details);
            const liveSessions = await this.findLiveSessions(connection, staleIds, details.user);
            for (const sid of staleIds) {
                if (liveSessions.has(sid)) {
                    await this.dropSession(connection, sid, connectionName);
                }
                sessions.delete(sid);
            }
        } catch (error) {
            logWithFallback(
                'warn',
                `[MetadataSessionSweeper] stale-session check failed for '${connectionName}':`,
                error,
            );
        } finally {
            if (connection) {
                try {
                    await connection.close();
                } catch {
                    // Best-effort close
                }
            }
        }
    }

    private async findLiveSessions(
        connection: DatabaseConnection,
        sessionIds: string[],
        expectedUser: string | undefined,
    ): Promise<Set<string>> {
        const found = new Set<string>();
        const cmd = connection.createCommand(
            `SELECT ID, USERNAME FROM _V_SESSION WHERE ID IN (${sessionIds.join(',')})`,
        );
        cmd.commandTimeout = SWEEPER_COMMAND_TIMEOUT_SECONDS;
        const reader = await cmd.executeReader();
        try {
            while (await reader.read()) {
                const id = String(reader.getValue(0));
                const username = String(reader.getValue(1) ?? '');
                if (
                    expectedUser
                    && username
                    && username.toLowerCase() === String(expectedUser).toLowerCase()
                ) {
                    found.add(id);
                }
            }
        } finally {
            try {
                await reader.close();
            } catch {
                // Best-effort close
            }
        }
        return found;
    }

    private async dropSession(
        connection: DatabaseConnection,
        sessionId: string,
        connectionName: string,
    ): Promise<void> {
        const dropCmd = connection.createCommand(`DROP SESSION ${sessionId}`);
        dropCmd.commandTimeout = SWEEPER_COMMAND_TIMEOUT_SECONDS;
        const reader = await dropCmd.executeReader();
        try {
            await reader.close();
        } catch {
            // DROP SESSION returns no result set on some Netezza versions
        }
        logWithFallback(
            'info',
            `[MetadataSessionSweeper] dropped stale metadata session ${sessionId} on '${connectionName}'`,
        );
    }

    private isEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('justybase.metadata.sessionSweep')
            .get<boolean>('enabled', DEFAULT_ENABLED);
    }

    private readIntervalMinutes(): number {
        return vscode.workspace
            .getConfiguration('justybase.metadata.sessionSweep')
            .get<number>('intervalMinutes', DEFAULT_SWEEP_INTERVAL_MINUTES);
    }

    private readMaxAgeMinutes(): number {
        return vscode.workspace
            .getConfiguration('justybase.metadata.sessionSweep')
            .get<number>('maxAgeMinutes', DEFAULT_MAX_AGE_MINUTES);
    }
}

export const metadataSessionSweeper = new MetadataSessionSweeper();
