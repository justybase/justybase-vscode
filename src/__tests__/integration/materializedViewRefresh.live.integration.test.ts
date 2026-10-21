import { NzConnection } from '@justybase/netezza-driver';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../../contracts/database';
import { db2Harness, oracleHarness, postgresqlHarness } from './optionalDialectIntegrationHarness';
import { refreshMaterializedViewSql } from '../../commands/schema/menuSql';

interface RefreshCase {
    kind: string;
    config?: DatabaseConnectionConfig;
    create(config: DatabaseConnectionConfig): DatabaseConnection;
    schemaSql: string;
    objectType: string;
    base: string;
    view: string;
    setup: string[];
    /** Adds rows to the base table after the view was populated. */
    change: string[];
    cleanup: string[];
    concurrently?: boolean;
    /**
     * Netezza materialized views are sorted projections kept current on insert;
     * REFRESH re-sorts the unsorted tail instead of loading missing rows.
     */
    maintainedOnInsert?: boolean;
}

const netezzaConfig: DatabaseConnectionConfig | undefined = process.env.NZ_DEV_PASSWORD ? {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: Number(process.env.NZ_DEV_PORT || 5480),
    database: process.env.NZ_DEV_DATABASE || 'SYSTEM',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD,
} as DatabaseConnectionConfig : undefined;

/**
 * Live check of the "Refresh Materialized View" SQL: after new base rows the
 * refreshed view (Db2: MQT) must return them. Fixtures are ZZ_CLAUDE_* objects
 * dropped in finally; unconfigured dialects are skipped.
 */
const cases: RefreshCase[] = [
    {
        kind: 'netezza', config: netezzaConfig,
        create: c => new NzConnection({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password ?? '' }) as unknown as DatabaseConnection,
        schemaSql: 'SELECT CURRENT_SCHEMA AS S', objectType: 'MATERIALIZED VIEW', base: 'ZZ_CLAUDE_MVT', view: 'ZZ_CLAUDE_MV',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_MVT (ID INTEGER, V INTEGER) DISTRIBUTE ON (ID)',
            'INSERT INTO ZZ_CLAUDE_MVT VALUES (1, 10)',
            'CREATE MATERIALIZED VIEW ZZ_CLAUDE_MV AS SELECT ID, V FROM ZZ_CLAUDE_MVT ORDER BY ID',
        ],
        change: ['INSERT INTO ZZ_CLAUDE_MVT VALUES (2, 20)'],
        cleanup: ['DROP VIEW ZZ_CLAUDE_MV', 'DROP TABLE ZZ_CLAUDE_MVT'],
        maintainedOnInsert: true,
    },
    {
        kind: 'postgresql', config: postgresqlHarness.config, create: c => postgresqlHarness.createConnection(c),
        schemaSql: 'SELECT current_schema() AS s', objectType: 'MATERIALIZED VIEW', base: 'zz_claude_mvt', view: 'zz_claude_mv',
        setup: [
            'CREATE TABLE zz_claude_mvt (id int primary key, v int)',
            'INSERT INTO zz_claude_mvt VALUES (1, 10)',
            'CREATE MATERIALIZED VIEW zz_claude_mv AS SELECT id, v FROM zz_claude_mvt',
            'CREATE UNIQUE INDEX zz_claude_mv_ux ON zz_claude_mv (id)',
        ],
        change: ['INSERT INTO zz_claude_mvt VALUES (2, 20)'],
        cleanup: ['DROP MATERIALIZED VIEW IF EXISTS zz_claude_mv', 'DROP TABLE IF EXISTS zz_claude_mvt'],
        concurrently: true,
    },
    {
        kind: 'oracle', config: oracleHarness.config, create: c => oracleHarness.createConnection(c),
        schemaSql: "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL", objectType: 'MATERIALIZED VIEW', base: 'ZZ_CLAUDE_MVT', view: 'ZZ_CLAUDE_MV',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_MVT (ID NUMBER PRIMARY KEY, V NUMBER)',
            'INSERT INTO ZZ_CLAUDE_MVT VALUES (1, 10)',
            'COMMIT',
            'CREATE MATERIALIZED VIEW ZZ_CLAUDE_MV AS SELECT ID, V FROM ZZ_CLAUDE_MVT',
        ],
        change: ['INSERT INTO ZZ_CLAUDE_MVT VALUES (2, 20)', 'COMMIT'],
        cleanup: ['DROP MATERIALIZED VIEW ZZ_CLAUDE_MV', 'DROP TABLE ZZ_CLAUDE_MVT PURGE'],
    },
    {
        kind: 'db2', config: db2Harness.config, create: c => db2Harness.createConnection(c),
        schemaSql: 'SELECT RTRIM(CURRENT SCHEMA) AS S FROM SYSIBM.SYSDUMMY1', objectType: 'MATERIALIZED QUERY TABLE', base: 'ZZ_CLAUDE_MVT', view: 'ZZ_CLAUDE_MQT',
        setup: [
            'CREATE TABLE ZZ_CLAUDE_MVT (ID INTEGER NOT NULL PRIMARY KEY, V INTEGER)',
            'INSERT INTO ZZ_CLAUDE_MVT VALUES (1, 10)',
            'CREATE TABLE ZZ_CLAUDE_MQT AS (SELECT ID, V FROM ZZ_CLAUDE_MVT) DATA INITIALLY DEFERRED REFRESH DEFERRED',
            'REFRESH TABLE ZZ_CLAUDE_MQT',
        ],
        change: ['INSERT INTO ZZ_CLAUDE_MVT VALUES (2, 20)'],
        cleanup: ['DROP TABLE ZZ_CLAUDE_MQT', 'DROP TABLE ZZ_CLAUDE_MVT'],
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

/** Strips the statement terminator but keeps the one that ends a PL/SQL block. */
const executable = (sql: string): string => (/\bEND;\s*$/i.test(sql) ? sql.trim() : sql.replace(/;\s*$/, ''));

for (const probe of cases) {
    (probe.config ? it : it.skip)(`${probe.kind}: refresh picks up new base rows`, async () => {
        if (!probe.config) return;
        const connection = probe.create(probe.config);
        await connection.connect();
        const exec = async (sql: string) => { await rows(connection, sql); };
        const count = async () => Number(Object.values((await rows(connection, `SELECT COUNT(*) AS N FROM ${probe.view}`))[0])[0]);
        try {
            for (const sql of probe.cleanup) { try { await exec(sql); } catch { /* not there */ } }
            for (const sql of probe.setup) await exec(sql);
            const schema = String(Object.values((await rows(connection, probe.schemaSql))[0])[0]).trim();
            const ref = { database: probe.config.database, schema, name: probe.view };

            expect(await count()).toBe(1);
            for (const sql of probe.change) await exec(sql);
            expect(await count()).toBe(probe.maintainedOnInsert ? 2 : 1);

            await exec(executable(refreshMaterializedViewSql(probe.kind, probe.objectType, ref)));
            expect(await count()).toBe(2);

            if (probe.concurrently) {
                await exec("INSERT INTO zz_claude_mvt VALUES (3, 30)");
                await exec(executable(refreshMaterializedViewSql(probe.kind, probe.objectType, ref, { concurrently: true })));
                expect(await count()).toBe(3);
            }
        } finally {
            for (const sql of probe.cleanup) { try { await exec(sql); } catch { /* best effort */ } }
            await connection.close();
        }
    }, 180000);
}
