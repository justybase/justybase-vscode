import type { DatabaseConnection, DatabaseConnectionConfig, DatabaseSessionMonitorProvider } from '../../contracts/database';
import { db2Harness, mssqlHarness, oracleHarness, postgresqlHarness } from './optionalDialectIntegrationHarness';
import { postgresqlSessionMonitorProvider } from '../../../extensions/postgresql/src/postgresqlSessionMonitorProvider';
import { oracleSessionMonitorProvider } from '../../../extensions/oracle/src/oracleSessionMonitorProvider';
import { mssqlSessionMonitorProvider } from '../../../extensions/mssql/src/mssqlSessionMonitorProvider';
import { db2SessionMonitorProvider } from '../../../extensions/db2/src/db2SessionMonitorProvider';

/**
 * Live check of session-monitor Cancel and Kill: connection A runs a long
 * sleep, connection B cancels the statement (A must stay usable) and then
 * kills A's session. Unconfigured dialects are skipped.
 */
interface CancelCase {
    kind: string;
    config?: DatabaseConnectionConfig;
    create(config: DatabaseConnectionConfig): DatabaseConnection;
    provider: DatabaseSessionMonitorProvider;
    sessionIdSql: string;
    sleepSql: string;
    pingSql: string;
}

const cases: CancelCase[] = [
    { kind: 'postgresql', config: postgresqlHarness.config, create: c => postgresqlHarness.createConnection(c), provider: postgresqlSessionMonitorProvider,
        sessionIdSql: 'SELECT pg_backend_pid() AS ID', sleepSql: 'SELECT pg_sleep(30)', pingSql: 'SELECT 1 AS X' },
    { kind: 'oracle', config: oracleHarness.config, create: c => oracleHarness.createConnection(c), provider: oracleSessionMonitorProvider,
        sessionIdSql: "SELECT SYS_CONTEXT('USERENV', 'SID') AS ID FROM DUAL", sleepSql: 'BEGIN DBMS_SESSION.SLEEP(30); END;', pingSql: 'SELECT 1 AS X FROM DUAL' },
    { kind: 'mssql', config: mssqlHarness.config, create: c => mssqlHarness.createConnection(c), provider: mssqlSessionMonitorProvider,
        sessionIdSql: 'SELECT @@SPID AS ID', sleepSql: "WAITFOR DELAY '00:00:30'", pingSql: 'SELECT 1 AS X' },
    { kind: 'db2', config: db2Harness.config, create: c => db2Harness.createConnection(c), provider: db2SessionMonitorProvider,
        sessionIdSql: 'SELECT MON_GET_APPLICATION_HANDLE() AS ID FROM SYSIBM.SYSDUMMY1', sleepSql: 'WITH t(n) AS (SELECT 1 FROM SYSIBM.SYSDUMMY1 UNION ALL SELECT n + 1 FROM t WHERE n < 2000000000) SELECT COUNT(*) FROM t', pingSql: 'SELECT 1 AS X FROM SYSIBM.SYSDUMMY1' },
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

const waitForStart = () => new Promise(resolve => setTimeout(resolve, 2000));

for (const testCase of cases) {
    (testCase.config ? it : it.skip)(`${testCase.kind}: cancel keeps the session and kill ends it`, async () => {
        const config = testCase.config!;
        const target = testCase.create(config);
        const monitor = testCase.create(config);
        await target.connect();
        await monitor.connect();
        const services = {
            query: async <T extends Record<string, unknown>>(sql: string) => (await rows(monitor, sql)) as T[],
            execute: async (sql: string) => { await rows(monitor, sql); },
        };
        try {
            if (testCase.kind === 'oracle') {
                try {
                    await rows(monitor, 'SELECT 1 AS X FROM V$SESSION WHERE ROWNUM = 1');
                } catch (error) {
                    console.warn(`Skipping Oracle cancel/kill: the live user cannot read V$SESSION (${(error as Error).message}).`);
                    return;
                }
            }
            const sessionId = Number(Object.values((await rows(target, testCase.sessionIdSql))[0])[0]);
            if (testCase.provider.cancelQuery) {
                const started = Date.now();
                const sleeping = rows(target, testCase.sleepSql).then(() => 'completed', (error: Error) => error.message);
                await waitForStart();
                await testCase.provider.cancelQuery(undefined, services, sessionId);
                const outcome = await sleeping;
                expect(outcome).not.toBe('completed');
                expect(Date.now() - started).toBeLessThan(20000);
                await expect(rows(target, testCase.pingSql)).resolves.toHaveLength(1);
            }
            const sleeping = rows(target, testCase.sleepSql).then(() => 'completed', (error: Error) => error.message);
            await waitForStart();
            await testCase.provider.killSession(undefined, services, sessionId);
            expect(await sleeping).not.toBe('completed');
        } finally {
            await target.close().catch(() => undefined);
            await monitor.close();
        }
    }, 120000);
}
