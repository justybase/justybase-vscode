import type { ImportLoadStatus } from '@justybase/contracts';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import type { ConnectionDetails, NzConnection } from '../types';
import { formatIdentifierForSql } from '../utils/identifierUtils';
import { Logger } from '../utils/logger';

export interface NetezzaLoadStatusMonitorOptions {
    connectionDetails: ConnectionDetails;
    /** Qualified target table used to pick the matching `_V_LOAD_STATUS` row. */
    targetTable: string;
    databaseName?: string;
    intervalMs?: number;
    onStatus: (status: ImportLoadStatus) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const LOAD_STATUS_QUERY_TIMEOUT_SECONDS = 20;

function asText(value: unknown): string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.replace(/,/g, ''));
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** Table part of a qualified Netezza target (`DB..TABLE`, `SCHEMA.TABLE`, `TABLE`). */
function targetTableName(qualified: string): string | undefined {
    const parts = qualified
        .split('.')
        .map(part => part.trim().replace(/^"|"$/g, ''))
        .filter(part => part.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

/** Database part of a target (`DB..TABLE` or `DB.SCHEMA.TABLE`), falling back to the connection DB. */
export function resolveNetezzaLoadStatusDatabase(
    targetTable: string,
    fallbackDatabase?: string,
): string | undefined {
    const doubleDot = targetTable.indexOf('..');
    if (doubleDot > 0) {
        const database = targetTable.slice(0, doubleDot).trim().replace(/^"|"$/g, '');
        if (database) {
            return database;
        }
    }
    const parts = targetTable
        .split('.')
        .map(part => part.trim().replace(/^"|"$/g, ''))
        .filter(part => part.length > 0);
    return parts.length >= 3 ? parts[0] : fallbackDatabase?.trim() || undefined;
}

function quoteDatabase(database: string): string {
    return formatIdentifierForSql(database, 'netezza');
}

/**
 * Best-effort monitor for Netezza `_V_LOAD_STATUS`. It uses its own connection and never throws
 * into the import: a missing view or insufficient privileges simply stop the monitor.
 */
export class NetezzaLoadStatusMonitor {
    private stopped = false;
    private connection: NzConnection | undefined;
    private lastStatusKey = '';
    private reportedUnavailable = false;

    public constructor(private readonly options: NetezzaLoadStatusMonitorOptions) { }

    public start(): void {
        void this.run();
    }

    public stop(): void {
        this.stopped = true;
        const connection = this.connection;
        this.connection = undefined;
        if (connection) {
            void connection.close().catch(() => undefined);
        }
    }

    private async run(): Promise<void> {
        try {
            this.connection = await createConnectedDatabaseConnectionFromDetails(this.options.connectionDetails);
            while (!this.stopped) {
                try {
                    const status = await this.queryStatus();
                    if (status) {
                        this.emit(status);
                    }
                } catch (error) {
                    this.markUnavailable(error);
                    return;
                }
                await this.sleep(this.options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
            }
        } catch (error) {
            this.markUnavailable(error);
        } finally {
            const connection = this.connection;
            this.connection = undefined;
            if (connection) {
                try {
                    await connection.close();
                } catch {
                    // The import must not be affected by monitor cleanup.
                }
            }
        }
    }

    private async queryStatus(): Promise<ImportLoadStatus | undefined> {
        const connection = this.connection;
        if (!connection || this.stopped) {
            return undefined;
        }

        const database = this.options.databaseName?.trim();
        const sql = database
            ? `SELECT * FROM ${quoteDatabase(database)}.._V_LOAD_STATUS`
            : 'SELECT * FROM _V_LOAD_STATUS';
        const command = connection.createCommand(sql);
        command.commandTimeout = LOAD_STATUS_QUERY_TIMEOUT_SECONDS;

        const reader = await command.executeReader();
        const rows: Array<Record<string, unknown>> = [];
        try {
            while (await reader.read()) {
                const row: Record<string, unknown> = {};
                for (let index = 0; index < reader.fieldCount; index++) {
                    row[reader.getName(index).toUpperCase()] = reader.getValue(index);
                }
                rows.push(row);
            }
        } finally {
            await reader.close();
        }

        return this.selectStatus(rows);
    }

    private selectStatus(rows: Array<Record<string, unknown>>): ImportLoadStatus | undefined {
        const table = targetTableName(this.options.targetTable)?.toUpperCase();
        if (!table) {
            return undefined;
        }

        const tableRows = rows.filter(row => asText(row.TABLENAME)?.toUpperCase() === table);
        if (tableRows.length === 0) {
            return undefined;
        }

        const database = this.options.databaseName?.toUpperCase();
        const databaseRows = database
            ? tableRows.filter(row => {
                const name = asText(row.DATABASENAME)?.toUpperCase();
                return !name || name === database;
            })
            : tableRows;
        if (databaseRows.length === 0) {
            return undefined;
        }

        const user = asText(this.options.connectionDetails.user)?.toUpperCase();
        const userRows = user
            ? databaseRows.filter(row => asText(row.USERNAME)?.toUpperCase() === user)
            : [];
        const candidates = userRows.length > 0 ? userRows : databaseRows;
        candidates.sort((left, right) => (asNumber(right.PLANID) ?? 0) - (asNumber(left.PLANID) ?? 0));

        const row = candidates[0];
        return {
            planId: asNumber(row.PLANID),
            databaseName: asText(row.DATABASENAME),
            tableName: asText(row.TABLENAME),
            schemaName: asText(row.SCHEMANAME),
            userName: asText(row.USERNAME),
            bytesProcessed: asNumber(row.BYTESPROCESSED),
            rowsInserted: asNumber(row.ROWSINSERTED),
            rowsRejected: asNumber(row.ROWSREJECTED),
            bytesDownloaded: asNumber(row.BYTESDOWNLOADED),
        };
    }

    private emit(status: ImportLoadStatus): void {
        const key = [
            status.planId,
            status.rowsInserted,
            status.rowsRejected,
            status.bytesProcessed,
            status.bytesDownloaded,
        ].join(':');
        if (key === this.lastStatusKey) {
            return;
        }
        this.lastStatusKey = key;
        this.options.onStatus(status);
    }

    private markUnavailable(error: unknown): void {
        if (this.reportedUnavailable) {
            return;
        }
        this.reportedUnavailable = true;
        const message = error instanceof Error ? error.message : String(error);
        Logger.tryGetInstance()?.warn(`Netezza load status monitoring unavailable: ${message}`);
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
    }
}

export function startNetezzaLoadStatusMonitor(options: NetezzaLoadStatusMonitorOptions): NetezzaLoadStatusMonitor {
    const monitor = new NetezzaLoadStatusMonitor(options);
    monitor.start();
    return monitor;
}
