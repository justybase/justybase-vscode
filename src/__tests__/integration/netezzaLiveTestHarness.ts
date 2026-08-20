import { NzConnection } from '@justybase/netezza-driver';
import type { ConnectionDetails, DatabaseDataReader } from '../../types';
import { SqlParser } from '../../sql/sqlParser';

export const netezzaLiveEnabled = Boolean(process.env.NZ_DEV_PASSWORD);
export const netezzaFixtureEnabled = netezzaLiveEnabled && process.env.NZ_DEV_ALLOW_FIXTURE_DDL === '1';

export const NETEZZA_LIVE_CONNECTION_NAME = 'netezza-live-test';

export function buildNetezzaLiveDetails(): ConnectionDetails {
    return {
        host: process.env.NZ_DEV_HOST || 'localhost',
        port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
        database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
        user: process.env.NZ_DEV_USER || 'admin',
        password: process.env.NZ_DEV_PASSWORD || '',
        schema: process.env.NZ_DEV_SCHEMA || 'ADMIN',
        dbType: 'netezza'
    };
}

export function createNetezzaLiveConnection(database = buildNetezzaLiveDetails().database): NzConnection {
    const details = buildNetezzaLiveDetails();
    return new NzConnection({
        host: details.host,
        port: details.port,
        database,
        user: details.user,
        password: details.password || ''
    });
}

export function buildNetezzaLiveConnectionDetails(database = buildNetezzaLiveDetails().database): ConnectionDetails {
    return {
        ...buildNetezzaLiveDetails(),
        database
    };
}

export function uniqueNetezzaName(prefix: string): string {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        .replace(/[^a-z0-9]/gi, '')
        .toUpperCase();
    return `${prefix}_${suffix}`.slice(0, 120);
}

export function normalizeNetezzaIdentifier(value: string): string {
    return value.trim().toUpperCase();
}

export function quoteNetezzaLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export async function readRows(
    connection: NzConnection,
    sql: string
): Promise<unknown[][]> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        const rows: unknown[][] = [];
        while (await reader.read()) {
            rows.push(Array.from({ length: reader.fieldCount }, (_, index) => reader.getValue(index)));
        }
        return rows;
    } finally {
        await reader.close();
    }
}

export async function readRecordRows(
    connection: NzConnection,
    sql: string
): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        const rows: Record<string, unknown>[] = [];
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index += 1) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row);
        }
        return rows;
    } finally {
        await reader.close();
    }
}

export async function readScalar(
    connection: NzConnection,
    sql: string
): Promise<unknown> {
    const rows = await readRows(connection, sql);
    return rows[0]?.[0];
}

export async function executeNetezza(
    connection: NzConnection,
    sql: string
): Promise<void> {
    await connection.createCommand(sql).execute();
}

export async function tryExecuteNetezza(
    connection: NzConnection,
    sql: string
): Promise<{ ok: boolean; error?: string }> {
    try {
        await executeNetezza(connection, sql);
        return { ok: true };
    } catch (error: unknown) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function executeNetezzaScript(
    connection: NzConnection,
    script: string
): Promise<void> {
    const statements = SqlParser.splitStatements(script)
        .map(statement => statement.trim())
        .filter(statement => statement.length > 0 && !/^--(?:[^\n]*)$/m.test(statement));

    for (const statement of statements) {
        await executeNetezza(connection, statement);
    }
}

export async function currentNetezzaSessionId(connection: NzConnection): Promise<number> {
    const value = await readScalar(connection, 'SELECT CURRENT_SID');
    const sessionId = Number(value);
    if (!Number.isInteger(sessionId) || sessionId < 0) {
        throw new Error(`Netezza returned an invalid session id: ${String(value)}`);
    }
    return sessionId;
}

export async function readReaderMetadata(
    reader: DatabaseDataReader
): Promise<{ names: string[]; rows: unknown[][] }> {
    try {
        const names = Array.from({ length: reader.fieldCount }, (_, index) => reader.getName(index));
        const rows: unknown[][] = [];
        while (await reader.read()) {
            rows.push(Array.from({ length: reader.fieldCount }, (_, index) => reader.getValue(index)));
        }
        return { names, rows };
    } finally {
        await reader.close();
    }
}

export interface NetezzaLiveConnectionManagerDouble {
    getActiveConnectionName(): string;
    getConnection(name: string): Promise<ConnectionDetails | undefined>;
    getConnectionDatabaseKind(name?: string): 'netezza';
}

export function createNetezzaLiveConnectionManager(
    connectionName = NETEZZA_LIVE_CONNECTION_NAME
): NetezzaLiveConnectionManagerDouble {
    const details = buildNetezzaLiveDetails();
    return {
        getActiveConnectionName: () => connectionName,
        getConnection: async name => name === connectionName ? { ...details, name: connectionName } : undefined,
        getConnectionDatabaseKind: () => 'netezza'
    };
}
