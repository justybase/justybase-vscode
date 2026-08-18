/**
 * Read-only live diagnostic for metadata-session cleanup.
 *
 * It mirrors the extension's metadata path: every catalog query gets a fresh
 * physical connection, while a separate monitor connection samples _V_SESSION.
 * No database, schema, table, or other database object is created or changed.
 *
 * Usage:
 *   NZ_DEV_PASSWORD=... \
 *   NZ_METADATA_DIAGNOSTIC_DATABASE=JUST_DATA \
 *   npx jest --config Benchmark/jest.config.js --runInBand \
 *   Benchmark/metadataSessionLifecycleLive.test.ts
 */

import { describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import { ResultFormatter } from '../src/core/streaming/ResultFormatter';
import { NZ_QUERIES } from '../src/dialects/netezza/metadata/systemQueries';

const skipLive = !process.env.NZ_DEV_PASSWORD;
const describeIfLive = skipLive ? describe.skip : describe;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const DIAGNOSTIC_DATABASE = (
    process.env.NZ_METADATA_DIAGNOSTIC_DATABASE
    || process.env.NZ_DEV_DATABASE
    || 'SYSTEM'
).trim().toUpperCase();

const SETTLE_WAIT_MS = Number(process.env.NZ_METADATA_DIAGNOSTIC_WAIT_MS || '2000');
const PARALLEL_QUERY_COUNT = Number(process.env.NZ_METADATA_DIAGNOSTIC_PARALLEL || '5');

type SessionRow = Record<string, unknown>;

interface SessionSummary {
    id: string;
    pid?: string;
    dbName?: string;
    status?: string;
    command?: string;
    connectTime?: string;
    clientIp?: string;
}

function validateDatabaseName(database: string): string {
    if (!/^[A-Z_][A-Z0-9_$]*$/.test(database)) {
        throw new Error(`Invalid diagnostic database identifier: ${database}`);
    }
    return database;
}

function asText(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    return String(value);
}

function sessionId(row: SessionRow): string | undefined {
    const value = row.ID ?? row.SESSIONID;
    const normalized = asText(value);
    return normalized && normalized.length > 0 ? normalized : undefined;
}

function summarizeSession(row: SessionRow): SessionSummary | undefined {
    const id = sessionId(row);
    if (!id) {
        return undefined;
    }
    return {
        id,
        pid: asText(row.PID),
        dbName: asText(row.DBNAME),
        status: asText(row.STATUS),
        command: asText(row.COMMAND)?.replace(/\s+/g, ' ').trim().slice(0, 180),
        connectTime: asText(row.CONNTIME),
        clientIp: asText(row.IPADDR),
    };
}

async function executeRows(
    connection: NzConnection,
    sql: string,
): Promise<SessionRow[]> {
    const command = connection.createCommand(sql);
    const reader = await command.executeReader();
    try {
        const columns = ResultFormatter.extractColumns(reader);
        const data: unknown[][] = [];
        while (await reader.read()) {
            const row: unknown[] = [];
            for (let index = 0; index < reader.fieldCount; index++) {
                row.push(reader.getValue(index));
            }
            data.push(row);
        }
        return ResultFormatter.queryResultToRows<SessionRow>({ columns, data });
    } finally {
        await reader.close();
    }
}

async function currentSessionId(connection: NzConnection): Promise<string> {
    const rows = await executeRows(connection, 'SELECT CURRENT_SID');
    const value = rows[0] ? Object.values(rows[0])[0] : undefined;
    const id = asText(value);
    if (!id) {
        throw new Error('Netezza returned no CURRENT_SID');
    }
    return id;
}

async function openConnection(database: string): Promise<NzConnection> {
    const connection = new NzConnection({
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
    });
    await connection.connect();
    return connection;
}

async function snapshotSessions(
    monitor: NzConnection,
    monitorSessionId: string,
): Promise<SessionSummary[]> {
    // Keep this as SELECT * intentionally: different Netezza versions expose
    // different _V_SESSION columns, and the full row is useful for diagnosis.
    const rows = await executeRows(monitor, 'SELECT * FROM _V_SESSION');
    return rows
        .map(summarizeSession)
        .filter((row): row is SessionSummary => Boolean(row))
        .filter((row) => row.id !== monitorSessionId);
}

async function waitForSessionIdsToDisappear(
    monitor: NzConnection,
    monitorSessionId: string,
    trackedIds: ReadonlySet<string>,
    waitMs: number,
): Promise<SessionSummary[]> {
    const deadline = Date.now() + waitMs;
    while (true) {
        const rows = await snapshotSessions(monitor, monitorSessionId);
        const remaining = rows.filter((row) => trackedIds.has(row.id));
        if (remaining.length === 0) {
            return [];
        }
        if (Date.now() >= deadline) {
            return remaining;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function executeOnFreshConnection(
    database: string,
    sql: string,
    trackedIds: Set<string>,
): Promise<SessionRow[]> {
    const connection = await openConnection(database);
    try {
        trackedIds.add(await currentSessionId(connection));
        return await executeRows(connection, sql);
    } finally {
        await connection.close();
    }
}

function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

describeIfLive('metadata session lifecycle live diagnostic', () => {
    it(
        'closes fresh metadata connections and leaves no tracked _V_SESSION rows',
        async () => {
            const database = validateDatabaseName(DIAGNOSTIC_DATABASE);
            const trackedIds = new Set<string>();
            const monitor = await openConnection(database);
            let monitorSessionId: string | undefined;

            try {
                monitorSessionId = await currentSessionId(monitor);
                const baseline = await snapshotSessions(monitor, monitorSessionId);

                const firstCatalogQuery = NZ_QUERIES.LIST_DATABASES;
                const schemaQuery = NZ_QUERIES.listSchemas(database);
                const objectQuery = `
                    SELECT OBJNAME, SCHEMA
                    FROM ${database}.._V_OBJECT_DATA
                    WHERE DBNAME = '${escapeLiteral(database)}'
                      AND OBJTYPE IN ('TABLE', 'VIEW')
                    ORDER BY OBJNAME
                    LIMIT 1
                `.trim();

                await executeOnFreshConnection(database, firstCatalogQuery, trackedIds);
                await executeOnFreshConnection(database, schemaQuery, trackedIds);
                const objectRows = await executeOnFreshConnection(database, objectQuery, trackedIds);

                const firstObject = objectRows[0];
                const tableName = asText(firstObject?.OBJNAME);
                const schemaName = asText(firstObject?.SCHEMA);
                if (tableName) {
                    await executeOnFreshConnection(
                        database,
                        NZ_QUERIES.listColumnsWithKeys(database, {
                            schema: schemaName,
                            tableName,
                        }),
                        trackedIds,
                    );
                }

                const parallelQuery = NZ_QUERIES.listSchemas(database);
                await Promise.all(
                    Array.from({ length: Math.max(1, PARALLEL_QUERY_COUNT) }, () =>
                        executeOnFreshConnection(database, parallelQuery, trackedIds),
                    ),
                );

                const remaining = await waitForSessionIdsToDisappear(
                    monitor,
                    monitorSessionId,
                    trackedIds,
                    Math.max(0, SETTLE_WAIT_MS),
                );
                const after = await snapshotSessions(monitor, monitorSessionId);

                console.log(JSON.stringify({
                    database,
                    monitorSessionId,
                    baselineSessionCount: baseline.length,
                    trackedFreshSessionIds: [...trackedIds],
                    trackedSessionCount: trackedIds.size,
                    remainingTrackedSessions: remaining,
                    afterSessionCount: after.length,
                    afterSessions: after,
                }, null, 2));

                expect(trackedIds.size).toBeGreaterThan(0);
                expect(remaining).toEqual([]);
            } finally {
                await monitor.close();
            }
        },
        120_000,
    );

    it(
        'drops a tracked stale session via the sweeper verification + DROP SESSION path',
        async () => {
            const sweeperLive = process.env.NZ_METADATA_SWEEPER_LIVE === '1';
            if (!sweeperLive) {
                console.log('Sweeper live check skipped: set NZ_METADATA_SWEEPER_LIVE=1 to run');
                return;
            }
            const database = validateDatabaseName(DIAGNOSTIC_DATABASE);
            const target = await openConnection(database);
            const sweeper = await openConnection(database);
            let targetSessionId: string | undefined;
            try {
                targetSessionId = await currentSessionId(target);
                const sweeperSessionId = await currentSessionId(sweeper);
                const rows = await executeRows(
                    sweeper,
                    `SELECT ID, USERNAME FROM _V_SESSION WHERE ID IN (${targetSessionId})`,
                );
                const verified = rows.some(
                    (row) =>
                        asText(row.ID) === targetSessionId
                        && String(row.USERNAME ?? '').toLowerCase()
                            === DB_CONFIG.user.toLowerCase(),
                );
                console.log(JSON.stringify({
                    database,
                    targetSessionId,
                    sweeperSessionId,
                    verifiedInVSession: verified,
                }, null, 2));
                expect(verified).toBe(true);

                await executeRows(sweeper, `DROP SESSION ${targetSessionId}`);

                const remaining = await waitForSessionIdsToDisappear(
                    sweeper,
                    sweeperSessionId,
                    new Set([targetSessionId]),
                    Math.max(0, SETTLE_WAIT_MS),
                );
                expect(remaining).toEqual([]);
            } finally {
                await target.close();
                await sweeper.close();
            }
        },
        120_000,
    );

});

if (skipLive) {
    console.log('Metadata session lifecycle diagnostic skipped: set NZ_DEV_PASSWORD to run against live Netezza');
}
