import { db2Harness } from './optionalDialectIntegrationHarness';
import { DB2_RUNSTATS_OPTIONS } from '../../../extensions/db2/src/db2MaintenanceProvider';

jest.mock('vscode', () => ({ window: {} }), { virtual: true });

/**
 * Live check that every RUNSTATS variant offered by "Generate Statistics" is
 * accepted by ADMIN_CMD. The ZZ_CLAUDE_* fixture is dropped in finally.
 */
(db2Harness.config ? it : it.skip)('db2: every RUNSTATS option runs through ADMIN_CMD', async () => {
    const config = db2Harness.config!;
    const connection = db2Harness.createConnection(config);
    await connection.connect();
    const exec = async (sql: string) => {
        const reader = await connection.createCommand(sql).executeReader();
        try { while (await reader.read()) { /* drain */ } } finally { await reader.close(); }
    };
    const table = 'ZZ_CLAUDE_RUNSTATS';
    try {
        try { await exec(`DROP TABLE ${table}`); } catch { /* not there */ }
        await exec(`CREATE TABLE ${table} (ID INTEGER NOT NULL PRIMARY KEY, V VARCHAR(20))`);
        await exec(`INSERT INTO ${table} VALUES (1, 'a'), (2, 'b'), (3, 'b')`);
        const reader = await connection.createCommand('SELECT RTRIM(CURRENT SCHEMA) FROM SYSIBM.SYSDUMMY1').executeReader();
        await reader.read();
        const schema = String(reader.getValue(0)).trim();
        await reader.close();

        // USE PROFILE needs a saved profile; the first variant stores one.
        await exec(`CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE ${schema}.${table} ON ALL COLUMNS AND DETAILED INDEXES ALL SET PROFILE ONLY')`);
        for (const option of DB2_RUNSTATS_OPTIONS) {
            await exec(`CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE ${schema}.${table} ${option.clause}')`);
        }
    } finally {
        try { await exec(`DROP TABLE ${table}`); } catch { /* best effort */ }
        await connection.close();
    }
}, 180000);
