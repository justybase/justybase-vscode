/**
 * Lightweight per-connection database usage history.
 *
 * The metadata prefetch scope uses this to warm the active database and a
 * small number of recently used databases instead of every database on the
 * server. Only counters and timestamps are stored; SQL text and result data
 * never leave the query history store.
 */

import type * as vscode from 'vscode';
import type { QueryHistoryEntry } from '../core/history/types';

export const DATABASE_USAGE_STATE_KEY = 'justybase.metadata.databaseUsage.v1';
export const DEFAULT_POPULAR_DATABASE_COUNT = 2;
export const MAX_POPULAR_DATABASE_COUNT = 5;
export const DEFAULT_USAGE_MAX_AGE_DAYS = 30;
export const MAX_DATABASES_PER_CONNECTION = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 1000;

export interface DatabaseUsageRecord {
    /** Catalog spelling of the database (first observed spelling wins). */
    database: string;
    count: number;
    lastUsedAt: number;
}

export interface DatabaseUsageState {
    version: 1;
    connections: Record<string, Record<string, DatabaseUsageRecord>>;
}

type MementoLike = Pick<vscode.Memento, 'get' | 'update'>;

export function normalizeDatabaseUsageKey(database: string): string {
    return database.trim().toUpperCase();
}

function createEmptyState(): DatabaseUsageState {
    return { version: 1, connections: {} };
}

function sanitizeRecord(value: unknown): DatabaseUsageRecord | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as Partial<DatabaseUsageRecord>;
    if (
        typeof candidate.database !== 'string'
        || candidate.database.trim().length === 0
        || typeof candidate.count !== 'number'
        || !Number.isFinite(candidate.count)
        || candidate.count <= 0
        || typeof candidate.lastUsedAt !== 'number'
        || !Number.isFinite(candidate.lastUsedAt)
    ) {
        return undefined;
    }
    return {
        database: candidate.database.trim(),
        count: Math.floor(candidate.count),
        lastUsedAt: candidate.lastUsedAt,
    };
}

function sanitizeState(value: unknown): DatabaseUsageState {
    const state = createEmptyState();
    if (!value || typeof value !== 'object') {
        return state;
    }
    const candidate = value as Partial<DatabaseUsageState>;
    if (!candidate.connections || typeof candidate.connections !== 'object') {
        return state;
    }
    for (const [connectionName, databases] of Object.entries(candidate.connections)) {
        if (!connectionName.trim() || !databases || typeof databases !== 'object') {
            continue;
        }
        const sanitized: Record<string, DatabaseUsageRecord> = {};
        for (const [databaseKey, record] of Object.entries(databases)) {
            const sanitizedRecord = sanitizeRecord(record);
            if (sanitizedRecord) {
                sanitized[databaseKey] = sanitizedRecord;
            }
        }
        if (Object.keys(sanitized).length > 0) {
            state.connections[connectionName] = sanitized;
        }
    }
    return state;
}

/**
 * Tracks how often each database was used for a connection.
 *
 * The store is intentionally small and boring: counters are updated from the
 * query-history event and persisted in `globalState`. The prefetch coordinator
 * only asks for the top N databases, so a stale or missing entry can never
 * block metadata refresh.
 */
export class DatabaseUsageHistory {
    private state: DatabaseUsageState;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(
        private readonly memento: MementoLike,
        private readonly now: () => number = Date.now,
    ) {
        this.state = sanitizeState(this.memento.get<unknown>(DATABASE_USAGE_STATE_KEY));
    }

    get isEmpty(): boolean {
        return Object.keys(this.state.connections).length === 0;
    }

    /** Record one successful use of a database. */
    record(connectionName: string, database: string): void {
        const normalizedConnection = connectionName.trim();
        const normalizedDatabase = database.trim();
        if (!normalizedConnection || !normalizedDatabase || this.disposed) {
            return;
        }
        const databaseKey = normalizeDatabaseUsageKey(normalizedDatabase);
        if (!databaseKey) {
            return;
        }
        const connection = this.state.connections[normalizedConnection]
            ?? (this.state.connections[normalizedConnection] = {});
        const existing = connection[databaseKey];
        const timestamp = this.now();
        connection[databaseKey] = existing
            ? { ...existing, count: existing.count + 1, lastUsedAt: timestamp }
            : { database: normalizedDatabase, count: 1, lastUsedAt: timestamp };
        this.pruneConnection(connection);
        this.scheduleSave();
    }

    /**
     * Seed counters from existing query history. Callers should use this only
     * when the store is empty so a repeated activation cannot double count.
     */
    seed(entries: readonly Pick<QueryHistoryEntry, 'database' | 'connectionName' | 'timestamp'>[]): number {
        if (this.disposed || entries.length === 0) {
            return 0;
        }
        let added = 0;
        for (const entry of entries) {
            const connectionName = entry.connectionName?.trim();
            const database = entry.database?.trim();
            if (!connectionName || !database) {
                continue;
            }
            const databaseKey = normalizeDatabaseUsageKey(database);
            if (!databaseKey) {
                continue;
            }
            const connection = this.state.connections[connectionName]
                ?? (this.state.connections[connectionName] = {});
            const existing = connection[databaseKey];
            const timestamp = Number.isFinite(entry.timestamp) ? entry.timestamp : this.now();
            connection[databaseKey] = existing
                ? {
                    ...existing,
                    count: existing.count + 1,
                    lastUsedAt: Math.max(existing.lastUsedAt, timestamp),
                }
                : { database, count: 1, lastUsedAt: timestamp };
            added += 1;
        }
        for (const connection of Object.values(this.state.connections)) {
            this.pruneConnection(connection);
        }
        if (added > 0) {
            this.scheduleSave();
        }
        return added;
    }

    /** Most used databases for a connection, newest first on ties. */
    getPopular(
        connectionName: string,
        limit = DEFAULT_POPULAR_DATABASE_COUNT,
    ): string[] {
        const normalizedConnection = connectionName.trim();
        if (!normalizedConnection) {
            return [];
        }
        const connection = this.state.connections[normalizedConnection];
        if (!connection) {
            return [];
        }
        const boundedLimit = Math.max(0, Math.min(
            MAX_POPULAR_DATABASE_COUNT,
            Math.trunc(Number.isFinite(limit) ? limit : DEFAULT_POPULAR_DATABASE_COUNT),
        ));
        if (boundedLimit === 0) {
            return [];
        }
        return Object.values(connection)
            .sort((left, right) =>
                right.count - left.count
                || right.lastUsedAt - left.lastUsedAt
                || left.database.localeCompare(right.database),
            )
            .slice(0, boundedLimit)
            .map(record => record.database);
    }

    /** Usage records for diagnostics/tests. */
    getUsage(connectionName: string): ReadonlyArray<DatabaseUsageRecord> {
        const connection = this.state.connections[connectionName.trim()];
        return connection ? Object.values(connection).map(record => ({ ...record })) : [];
    }

    prune(maxAgeDays = DEFAULT_USAGE_MAX_AGE_DAYS): void {
        const maxAgeMs = Math.max(1, maxAgeDays) * DAY_MS;
        const cutoff = this.now() - maxAgeMs;
        for (const [connectionName, connection] of Object.entries(this.state.connections)) {
            for (const [databaseKey, record] of Object.entries(connection)) {
                if (record.lastUsedAt < cutoff) {
                    delete connection[databaseKey];
                }
            }
            this.pruneConnection(connection);
            if (Object.keys(connection).length === 0) {
                delete this.state.connections[connectionName];
            }
        }
        this.scheduleSave();
    }

    async flush(): Promise<void> {
        this.clearSaveTimer();
        if (this.disposed) {
            return;
        }
        await this.memento.update(DATABASE_USAGE_STATE_KEY, this.state);
    }

    dispose(): void {
        this.clearSaveTimer();
        if (!this.disposed) {
            // Best-effort final persist; the memento update is asynchronous and
            // the extension host may be shutting down.
            void Promise.resolve(
                this.memento.update(DATABASE_USAGE_STATE_KEY, this.state),
            ).catch(() => undefined);
        }
        this.disposed = true;
    }

    private pruneConnection(connection: Record<string, DatabaseUsageRecord>): void {
        const entries = Object.entries(connection)
            .sort(([, left], [, right]) => right.lastUsedAt - left.lastUsedAt);
        for (const [databaseKey] of entries.slice(MAX_DATABASES_PER_CONNECTION)) {
            delete connection[databaseKey];
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer || this.disposed) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.flush().catch(() => undefined);
        }, SAVE_DEBOUNCE_MS);
        (this.saveTimer as { unref?: () => void }).unref?.();
    }

    private clearSaveTimer(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
    }
}
