import { writeFileSync } from 'node:fs';
import type { DatabaseConnection, DatabaseConnectionConfig, DatabaseMetadataProvider } from '../../contracts/database';
import type { DatabaseReportKind, DatabaseTableReportKind } from '../../contracts/database/metadataProvider';
import { db2Harness, mssqlHarness, oracleHarness, postgresqlHarness } from './optionalDialectIntegrationHarness';
import { MysqlConnection } from '../../../extensions/mysql/src/mysqlConnection';
import { mysqlMetadataProvider } from '../../../extensions/mysql/src/mysqlSchemaProvider';

interface ReportCase {
    kind: string;
    config?: DatabaseConnectionConfig;
    create(config: DatabaseConnectionConfig): DatabaseConnection;
    provider: DatabaseMetadataProvider;
    schemaSql: string;
    table: string;
    setup: string[];
    cleanup: string[];
    /** Reports that need privileges the test account lacks; their failure is recorded, not asserted. */
    privileged?: ReadonlyArray<DatabaseTableReportKind | DatabaseReportKind>;
    /** Opens a transaction that holds a lock on the table (run on a second connection). */
    holdLock?: string[];
    /** Statement that waits for that lock (run on a third connection, not awaited). */
    waitForLock?: string[];
    releaseLock?: string;
    /** The last holdLock statement keeps the lock itself (e.g. WAITFOR) and is not awaited. */
    holdLockInBackground?: boolean;
}

const TABLE_REPORTS: DatabaseTableReportKind[] = ['size', 'privileges', 'maintenance'];
const DATABASE_REPORTS: DatabaseReportKind[] = ['locks', 'invalidObjects'];

/**
 * Live check of the read-only schema reports (table size, privileges,
 * maintenance status, lock waits, invalid objects). Each dialect creates a
 * ZZ_CLAUDE_* table and drops it in finally; unconfigured dialects are skipped.
 * Set JUSTYBASE_REPORT_DUMP=<file> to write the returned columns and rows.
 */
const cases: ReportCase[] = [
    {
        kind: 'postgresql', config: postgresqlHarness.config, create: c => postgresqlHarness.createConnection(c), provider: postgresqlHarness.metadataProvider,
        schemaSql: 'SELECT current_schema() AS s', table: 'zz_claude_report',
        setup: [
            'CREATE TABLE zz_claude_report (id int primary key, note text)',
            "INSERT INTO zz_claude_report SELECT g, repeat('x', 50) FROM generate_series(1, 200) g",
            'GRANT SELECT ON zz_claude_report TO public',
        ],
        cleanup: ['DROP TABLE IF EXISTS zz_claude_report'],
        holdLock: ['BEGIN', 'LOCK TABLE zz_claude_report IN ACCESS EXCLUSIVE MODE'],
        waitForLock: ["SET lock_timeout = '20s'", 'SELECT count(*) FROM zz_claude_report'],
        releaseLock: 'ROLLBACK',
    },
    {
        kind: 'oracle', config: oracleHarness.config, create: c => oracleHarness.createConnection(c), provider: oracleHarness.metadataProvider,
        schemaSql: "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL", table: 'ZZ_CLAUDE_REPORT',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_REPORT (ID NUMBER PRIMARY KEY, NOTE VARCHAR2(100), DOC CLOB)',
            "INSERT INTO ZZ_CLAUDE_REPORT SELECT LEVEL, RPAD('x', 50, 'x'), NULL FROM DUAL CONNECT BY LEVEL <= 200",
            'GRANT SELECT ON ZZ_CLAUDE_REPORT TO PUBLIC',
        ],
        cleanup: ['DROP TABLE ZZ_CLAUDE_REPORT PURGE'],
        privileged: ['locks'],
    },
    {
        kind: 'mssql', config: mssqlHarness.config, create: c => mssqlHarness.createConnection(c), provider: mssqlHarness.metadataProvider,
        schemaSql: 'SELECT SCHEMA_NAME() AS S', table: 'ZZ_CLAUDE_REPORT',
        setup: [
            'CREATE TABLE dbo.ZZ_CLAUDE_REPORT (ID INT PRIMARY KEY, NOTE NVARCHAR(100))',
            "INSERT INTO dbo.ZZ_CLAUDE_REPORT SELECT TOP 200 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)), REPLICATE('x', 50) FROM sys.all_objects",
            'GRANT SELECT ON dbo.ZZ_CLAUDE_REPORT TO public',
        ],
        cleanup: ['DROP TABLE IF EXISTS dbo.ZZ_CLAUDE_REPORT'],
        // The driver rejects a transaction left open across calls, so one batch holds the lock and waits.
        holdLock: ["BEGIN TRANSACTION; UPDATE dbo.ZZ_CLAUDE_REPORT SET NOTE = NOTE WHERE ID = 1; WAITFOR DELAY '00:00:06'; ROLLBACK"],
        holdLockInBackground: true,
        waitForLock: ['SET LOCK_TIMEOUT 20000', 'SELECT NOTE FROM dbo.ZZ_CLAUDE_REPORT WHERE ID = 1'],
        releaseLock: 'SELECT 1',
    },
    {
        kind: 'mysql', config: process.env.MYSQL_LIVE_TEST_HOST ? {
            host: process.env.MYSQL_LIVE_TEST_HOST, database: process.env.MYSQL_LIVE_TEST_DATABASE!, user: process.env.MYSQL_LIVE_TEST_USER!,
            password: process.env.MYSQL_LIVE_TEST_PASSWORD!, port: Number(process.env.MYSQL_LIVE_TEST_PORT || 3306),
        } as DatabaseConnectionConfig : undefined,
        create: c => new MysqlConnection(c), provider: mysqlMetadataProvider,
        schemaSql: 'SELECT DATABASE() AS s', table: 'zz_claude_report',
        setup: [
            'CREATE TABLE zz_claude_report (id int primary key, note varchar(100))',
            "INSERT INTO zz_claude_report (id, note) VALUES (1, 'x'), (2, 'y'), (3, 'z')",
        ],
        cleanup: ['DROP TABLE IF EXISTS zz_claude_report'],
        privileged: ['locks'],
    },
    {
        kind: 'db2', config: db2Harness.config, create: c => db2Harness.createConnection(c), provider: db2Harness.metadataProvider,
        schemaSql: 'SELECT RTRIM(CURRENT SCHEMA) AS S FROM SYSIBM.SYSDUMMY1', table: 'ZZ_CLAUDE_REPORT',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_REPORT (ID INTEGER NOT NULL PRIMARY KEY, NOTE VARCHAR(100))',
            "INSERT INTO ZZ_CLAUDE_REPORT (ID, NOTE) VALUES (1, 'x'), (2, 'y'), (3, 'z')",
            'GRANT SELECT ON ZZ_CLAUDE_REPORT TO PUBLIC',
        ],
        cleanup: ['DROP TABLE ZZ_CLAUDE_REPORT'],
    },
];

async function rows(connection: DatabaseConnection, sql: string): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    const out: Record<string, unknown>[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let i = 0; i < reader.fieldCount; i++) row[reader.getName(i)] = reader.getValue(i);
            out.push(row);
        }
    } finally {
        await reader.close();
    }
    return out;
}

const dump: Record<string, unknown> = {};

/** Makes one session wait on another and returns what the locks report sees meanwhile. */
async function observeLockWait(probe: ReportCase, locksSql: string, reporter: DatabaseConnection): Promise<Record<string, unknown>[]> {
    const holder = probe.create(probe.config!);
    const waiter = probe.create(probe.config!);
    await holder.connect();
    await waiter.connect();
    let waiting: Promise<unknown> | undefined;
    let holding: Promise<unknown> | undefined;
    try {
        const holdStatements = probe.holdLock!;
        const backgroundHold = probe.holdLockInBackground ? holdStatements[holdStatements.length - 1] : undefined;
        for (const sql of backgroundHold ? holdStatements.slice(0, -1) : holdStatements) await rows(holder, sql);
        if (backgroundHold) {
            holding = rows(holder, backgroundHold).catch(() => undefined);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        const [setup, blocked] = [probe.waitForLock!.slice(0, -1), probe.waitForLock![probe.waitForLock!.length - 1]];
        for (const sql of setup) await rows(waiter, sql);
        waiting = rows(waiter, blocked).catch(() => undefined);
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const found = await rows(reporter, locksSql);
            if (found.length > 0) return found;
        }
        return [];
    } finally {
        await holding;
        await rows(holder, probe.releaseLock!).catch(() => undefined);
        await waiting;
        await holder.close();
        await waiter.close();
    }
}

afterAll(() => {
    const file = process.env.JUSTYBASE_REPORT_DUMP;
    if (file) writeFileSync(file, JSON.stringify(dump, (_key, value) => (typeof value === 'bigint' ? String(value) : value), 2));
});

for (const probe of cases) {
    (probe.config ? it : it.skip)(`${probe.kind}: schema reports run against the live catalogue`, async () => {
        if (!probe.config) return;
        const connection = probe.create(probe.config);
        await connection.connect();
        const exec = async (sql: string) => { await rows(connection, sql); };
        const errors: string[] = [];
        const results: Record<string, unknown> = {};
        try {
            for (const sql of probe.cleanup) { try { await exec(sql); } catch { /* not there */ } }
            for (const sql of probe.setup) { await exec(sql); }
            const schema = String(Object.values((await rows(connection, probe.schemaSql))[0])[0]).trim();
            const reports: Array<[string, string | undefined]> = [
                ...TABLE_REPORTS.map(report => [report, probe.provider.buildTableReportQuery?.(probe.config!.database, schema, probe.table, report)] as [string, string | undefined]),
                ...DATABASE_REPORTS.map(report => [report, probe.provider.buildDatabaseReportQuery?.(probe.config!.database, report)] as [string, string | undefined]),
            ];
            if (probe.holdLock && probe.waitForLock) {
                results.lockWait = await observeLockWait(probe, probe.provider.buildDatabaseReportQuery!(probe.config.database, 'locks')!, connection);
            }
            for (const [report, sql] of reports) {
                if (!sql) {
                    results[report] = 'not offered';
                    continue;
                }
                try {
                    const found = await rows(connection, sql);
                    results[report] = { rows: found.length, sample: found.slice(0, 3) };
                } catch (e) {
                    const message = (e as Error).message;
                    results[report] = { error: message };
                    if (!probe.privileged?.includes(report as DatabaseReportKind)) errors.push(`${report}: ${message}`);
                }
            }
        } finally {
            for (const sql of probe.cleanup) { try { await exec(sql); } catch { /* best effort */ } }
            await connection.close();
        }
        dump[probe.kind] = results;
        expect(errors).toEqual([]);
        if (probe.holdLock) {
            // The waiting session must be reported together with the session that blocks it.
            expect((results.lockWait as unknown[]).length).toBeGreaterThan(0);
        }
        for (const report of TABLE_REPORTS) {
            expect((results[report] as { rows?: number }).rows).toBeGreaterThan(report === 'privileges' ? -1 : 0);
        }
    }, 180000);
}
