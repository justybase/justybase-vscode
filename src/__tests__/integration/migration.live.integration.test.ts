/**
 * Live cross-database migration integration tests.
 *
 * Verifies the end-to-end migration pipeline against real databases:
 *  - source: Netezza (NZ_DEV_*) and PostgreSQL (PG_LIVE_TEST_*)
 *  - targets: Netezza, PostgreSQL, MySQL, SQLite, and (when runtimes/credentials
 *    are available) Db2, MS SQL Server, Oracle, Vertica
 *  - Snowflake is intentionally not covered (no live access in this environment).
 *
 * Run with credentials from `.env.local`:
 *   set -a; . ./.env.local; set +a
 *   npx jest --config jest.live.config.js src/__tests__/integration/migration.live.integration.test.ts --runInBand
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import type { DatabaseConnection, DatabaseKind } from '../../contracts/database';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import type { ConnectionDetails } from '../../types';
import { MigrationService } from '../../migration/migrationService';
import type {
    MigrationPhase,
    MigrationProgress,
    MigrationRequest,
} from '../../migration/types';

import { NzConnection } from '@justybase/netezza-driver';

import { db2Dialect } from '../../../extensions/db2/src/db2Dialect';
import { mssqlDialect } from '../../../extensions/mssql/src/mssqlDialect';
import { mysqlDialect } from '../../../extensions/mysql/src/mysqlDialect';
import { oracleDialect } from '../../../extensions/oracle/src/oracleDialect';
import { postgresqlDialect } from '../../../extensions/postgresql/src/postgresqlDialect';
import { verticaDialect } from '../../../extensions/vertica/src/verticaDialect';
import { sqliteDialect } from '../../dialects/sqlite';

registerDatabaseDialect(db2Dialect);
registerDatabaseDialect(mssqlDialect);
registerDatabaseDialect(mysqlDialect);
registerDatabaseDialect(oracleDialect);
registerDatabaseDialect(postgresqlDialect);
registerDatabaseDialect(verticaDialect);
registerDatabaseDialect(sqliteDialect);

const NZ_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const hasNetezza = Boolean(process.env.NZ_DEV_PASSWORD);
const hasDb2 = Boolean(process.env.DB2_LIVE_TEST_HOST && process.env.DB2_LIVE_TEST_PASSWORD);
const hasMssql = Boolean(process.env.MSSQL_LIVE_TEST_HOST && process.env.MSSQL_LIVE_TEST_PASSWORD);
const hasOracle = Boolean(process.env.ORACLE_LIVE_TEST_HOST && process.env.ORACLE_LIVE_TEST_PASSWORD);
const hasVertica = Boolean(process.env.VERTICA_LIVE_TEST_HOST);

const db2RuntimeRequire = createRequire(
    path.join(process.cwd(), 'extensions', 'db2', 'package.json'),
);
let hasDb2Runtime = false;
try {
    const { configureBundledClidriverForCurrentProcess } = require('../../../extensions/db2/src/db2Connection');
    configureBundledClidriverForCurrentProcess();
    db2RuntimeRequire('ibm_db');
    hasDb2Runtime = true;
} catch {
    hasDb2Runtime = false;
}

function buildLiveDetails(
    envPrefix: string,
    dbType: DatabaseKind,
    overrides?: Partial<ConnectionDetails>,
    options?: { allowEmptyPassword?: boolean },
): ConnectionDetails | undefined {
    const host = process.env[`${envPrefix}_LIVE_TEST_HOST`];
    const database = process.env[`${envPrefix}_LIVE_TEST_DATABASE`];
    const user = process.env[`${envPrefix}_LIVE_TEST_USER`];
    const rawPassword = process.env[`${envPrefix}_LIVE_TEST_PASSWORD`];
    const port = process.env[`${envPrefix}_LIVE_TEST_PORT`]
        ? Number(process.env[`${envPrefix}_LIVE_TEST_PORT`])
        : undefined;

    if (!host || !database || !user) {
        return undefined;
    }
    if (!options?.allowEmptyPassword && rawPassword === undefined) {
        return undefined;
    }

    return {
        name: `${dbType}-live`,
        host,
        port,
        database,
        user,
        password: rawPassword ?? '',
        dbType,
        ...overrides,
    };
}

class FakeConnectionManager {
    private readonly details = new Map<string, ConnectionDetails>();

    public register(name: string, details: ConnectionDetails): void {
        this.details.set(name, details);
    }

    public async getConnection(name: string): Promise<ConnectionDetails | undefined> {
        return this.details.get(name);
    }

    public getConnectionDatabaseKind(name?: string): DatabaseKind | undefined {
        return name ? this.details.get(name)?.dbType : undefined;
    }
}

function buildNetezzaDetails(): ConnectionDetails {
    return {
        name: 'nz-src',
        host: NZ_CONFIG.host,
        port: NZ_CONFIG.port,
        database: NZ_CONFIG.database,
        user: NZ_CONFIG.user,
        password: NZ_CONFIG.password,
        dbType: 'netezza',
    };
}

const describeIfNetezza = hasNetezza ? describe : describe.skip;

describeIfNetezza('Live migration between databases', () => {
    let sourceTable: string;
    let sourceSchema: string;
    let nzConnection: NzConnection;
    let service: MigrationService;
    let manager: FakeConnectionManager;

    const createdTables: Array<{ kind: DatabaseKind; name: string }> = [];

    beforeAll(async () => {
        nzConnection = new NzConnection({
            host: NZ_CONFIG.host,
            port: NZ_CONFIG.port,
            database: NZ_CONFIG.database,
            user: NZ_CONFIG.user,
            password: NZ_CONFIG.password,
        });
        await nzConnection.connect();

        sourceSchema = process.env.NZ_DEV_SCHEMA || 'ADMIN';
        sourceTable = `JBL_MIG_SRC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase();

        await nzConnection.createCommand(
            `CREATE TABLE ${sourceSchema}.${sourceTable} (
                ID INTEGER NOT NULL,
                AMOUNT NUMERIC(10,2),
                NAME VARCHAR(50),
                BIRTH DATE,
                CREATED_AT TIMESTAMP,
                ACTIVE BOOLEAN,
                PRIMARY KEY (ID)
            )`,
        ).execute();
        createdTables.push({ kind: 'netezza', name: sourceTable });

        const values = [
            "1, 12.34, 'Alice', '1990-05-12', '2024-02-01 10:20:30', TRUE",
            "2, 56.78, 'Bob', NULL, '2024-03-04 11:22:33', FALSE",
            "3, -1.5, 'Charlie', '1985-12-01', NULL, TRUE",
        ];
        for (const rowValues of values) {
            await nzConnection.createCommand(
                `INSERT INTO ${sourceSchema}.${sourceTable} VALUES (${rowValues})`,
            ).execute();
        }

        manager = new FakeConnectionManager();
        manager.register('nz-src', buildNetezzaDetails());
        service = new MigrationService({ connectionManager: manager });
    }, 60000);

    afterAll(async () => {
        for (const table of createdTables) {
            try {
                await nzConnection.createCommand(
                    `DROP TABLE IF EXISTS ${table.name.includes('.') ? table.name : `${sourceSchema}.${table.name}`}`,
                ).execute();
            } catch {
                // Best-effort cleanup.
            }
        }
        try {
            await nzConnection.close();
        } catch {
            // Ignore.
        }
    });

    async function verifyTargetTable(
        connection: DatabaseConnection,
        tableName: string,
        expectedRows: number,
        options?: { spotCheck?: Array<[number, string, unknown]> },
    ): Promise<void> {
        const countReader = await connection.createCommand(
            `SELECT COUNT(*) AS ROW_COUNT FROM ${tableName}`,
        ).executeReader();
        try {
            expect(await countReader.read()).toBe(true);
            const count = Number(countReader.getValue(0));
            expect(count).toBe(expectedRows);
        } finally {
            await countReader.close();
        }

        if (options?.spotCheck) {
            for (const [id, column, expected] of options.spotCheck) {
                const reader = await connection.createCommand(
                    `SELECT ${column} FROM ${tableName} WHERE ID = ${id}`,
                ).executeReader();
                try {
                    expect(await reader.read()).toBe(true);
                    const value = reader.getValue(0);
                    if (expected === null) {
                        expect(value === null || value === undefined).toBe(true);
                    } else if (typeof expected === 'number') {
                        expect(Number(String(value).replace(/,/g, ''))).toBeCloseTo(expected, 2);
                    } else if (expected instanceof Date) {
                        expect(new Date(String(value).replace('T', ' '))).toEqual(expected);
                    } else if (typeof expected === 'boolean') {
                        const normalized = String(value).trim().toLowerCase();
                        expect(['true', '1', 't', 'yes'].includes(normalized)).toBe(expected);
                    } else if (typeof expected === 'string' && value instanceof Date) {
                        expect(value.toISOString().slice(0, 10)).toBe(expected);
                    } else {
                        expect(String(value).trim()).toBe(String(expected));
                    }
                } finally {
                    await reader.close();
                }
            }
        }
    }

    async function runMigration(
        request: MigrationRequest,
    ): Promise<{ phases: MigrationPhase[]; maxPercent: number; result: Awaited<ReturnType<MigrationService['execute']>> }> {
        const analysis = await service.analyzeSource(request);
        const plan = service.buildPlan(
            request,
            analysis.sourceContext,
            analysis.columns,
            analysis.pkColumns,
            analysis.warnings,
            analysis.sampleCells,
        );
        expect(plan.columns.length).toBeGreaterThan(0);

        const phases: MigrationPhase[] = [];
        let maxPercent = 0;
        const result = await service.execute(request, plan, analysis.sourceContext, (progress: MigrationProgress) => {
            phases.push(progress.phase);
            maxPercent = Math.max(maxPercent, progress.percent);
        });

        if (!result.success) {
            console.log(`MIGRATION FAILED (${request.source.mode}/${plan.targetKind}): ${result.message}`);
        } else {
            console.log(`MIGRATION OK (${plan.targetKind}): rowsInserted=${result.rowsInserted}`);
        }

        return { phases, maxPercent, result };
    }

    async function migrateNetezzaTableTo(
        targetDetails: ConnectionDetails,
        targetKind: DatabaseKind,
        targetTable: string,
    ): Promise<{ phases: MigrationPhase[]; maxPercent: number; result: Awaited<ReturnType<MigrationService['execute']>> }> {
        manager.register(targetDetails.name ?? `${targetKind}-target`, targetDetails);
        const request: MigrationRequest = {
            source: {
                mode: 'table',
                connectionName: 'nz-src',
                database: NZ_CONFIG.database,
                schema: sourceSchema,
                table: sourceTable,
            },
            target: {
                connectionName: targetDetails.name ?? `${targetKind}-target`,
                database: targetDetails.database,
                schema: targetDetails.schema,
                table: targetTable,
                appendToExistingTable: false,
            },
        };
        return runMigration(request);
    }

    function buildTargetConnection(kind: DatabaseKind, details: ConnectionDetails): DatabaseConnection {
        const { getDatabaseDialect } = require('../../core/connectionFactory') as typeof import('../../core/connectionFactory');
        return getDatabaseDialect(kind).createConnection(details);
    }

    async function executeOnTarget(
        kind: DatabaseKind,
        details: ConnectionDetails,
        sql: string,
    ): Promise<void> {
        const connection = buildTargetConnection(kind, details);
        try {
            await connection.connect();
            await connection.createCommand(sql).execute();
        } finally {
            await connection.close();
        }
    }

    it('migrates Netezza table to PostgreSQL (table mode)', async () => {
        const details = buildLiveDetails('PG', 'postgresql');
        if (!details) {
            console.log('Skipping PostgreSQL target: no PG_LIVE_TEST_* credentials.');
            return;
        }

        const targetTable = `JBL_MIG_TGT_${Date.now()}`.toLowerCase();
        const { phases, maxPercent, result } = await migrateNetezzaTableTo(
            details,
            'postgresql',
            targetTable,
        );
        createdTables.push({ kind: 'postgresql', name: targetTable });

        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(3);
        expect(phases).not.toContain('count');
        expect(phases).toContain('stream');
        expect(phases).toContain('done');
        expect(maxPercent).toBe(100);

        const connection = buildTargetConnection('postgresql', details);
        try {
            await connection.connect();
            await verifyTargetTable(connection, targetTable, 3, {
                spotCheck: [
                    [1, 'NAME', 'Alice'],
                    [2, 'ACTIVE', false],
                    [3, 'AMOUNT', -1.5],
                ] as [number, string, unknown][],
            });
        } finally {
            await connection.close();
        }
    }, 180000);

    it('migrates Netezza table to Netezza (external table stream)', async () => {
        const details = buildNetezzaDetails();
        const targetTable = `JBL_MIG_TGT_${Date.now()}`.toUpperCase();

        const { phases, maxPercent, result } = await migrateNetezzaTableTo(
            { ...details, name: 'nz-target', schema: sourceSchema },
            'netezza',
            targetTable,
        );
        createdTables.push({ kind: 'netezza', name: `${sourceSchema}.${targetTable}` });

        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(3);
        expect(phases).toContain('stream');
        expect(phases).toContain('done');
        expect(maxPercent).toBe(100);

        const connection = buildTargetConnection('netezza', details);
        try {
            await connection.connect();
            await verifyTargetTable(connection, `${sourceSchema}.${targetTable}`, 3, {
                spotCheck: [
                    [1, 'NAME', 'Alice'],
                    [3, 'BIRTH', '1985-12-01'],
                ] as [number, string, unknown][],
            });
        } finally {
            await connection.close();
        }
    }, 180000);

    it('migrates Netezza table to MySQL', async () => {
        const details = buildLiveDetails('MYSQL', 'mysql');
        if (!details) {
            console.log('Skipping MySQL target: no MYSQL_LIVE_TEST_* credentials.');
            return;
        }

        const targetTable = `JBL_MIG_TGT_${Date.now()}`.toLowerCase();
        const { phases, result } = await migrateNetezzaTableTo(
            details,
            'mysql',
            targetTable,
        );
        createdTables.push({ kind: 'mysql', name: targetTable });

        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(3);
        expect(phases).toContain('done');

        const connection = buildTargetConnection('mysql', details);
        try {
            await connection.connect();
            await verifyTargetTable(connection, targetTable, 3, {
                spotCheck: [
                    [1, 'NAME', 'Alice'],
                    [2, 'ACTIVE', false],
                ] as [number, string, unknown][],
            });
        } finally {
            await connection.close();
        }
    }, 180000);

    it('migrates Netezza table to SQLite (local file)', async () => {
        const dbPath = path.join(os.tmpdir(), `jbl_migration_${Date.now()}.sqlite`);
        const details: ConnectionDetails = {
            name: 'sqlite-target',
            host: '',
            database: dbPath,
            user: '',
            password: '',
            dbType: 'sqlite',
        };
        manager.register('sqlite-target', details);

        const targetTable = `JBL_MIG_TGT_${Date.now()}`.toLowerCase();
        const request: MigrationRequest = {
            source: {
                mode: 'table',
                connectionName: 'nz-src',
                database: NZ_CONFIG.database,
                schema: sourceSchema,
                table: sourceTable,
            },
            target: {
                connectionName: 'sqlite-target',
                table: targetTable,
                appendToExistingTable: false,
            },
        };

        const { phases, result } = await runMigration(request);

        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(3);
        expect(phases).toContain('done');

        const connection = buildTargetConnection('sqlite', details);
        try {
            await connection.connect();
            await verifyTargetTable(connection, targetTable, 3, {
                spotCheck: [
                    [1, 'NAME', 'Alice'],
                    [3, 'AMOUNT', -1.5],
                ] as [number, string, unknown][],
            });
        } finally {
            await connection.close();
            if (fs.existsSync(dbPath)) {
                fs.unlinkSync(dbPath);
            }
        }
    }, 180000);

    it('migrates PostgreSQL SELECT result to Netezza (SQL mode with expression)', async () => {
        const pgDetails = buildLiveDetails('PG', 'postgresql');
        if (!pgDetails) {
            console.log('Skipping PostgreSQL source: no PG_LIVE_TEST_* credentials.');
            return;
        }

        const sourceTableName = `jbl_mig_src_${Date.now()}`.toLowerCase();
        const connection = buildTargetConnection('postgresql', pgDetails);
        try {
            await connection.connect();
            await connection.createCommand(
                `CREATE TABLE ${sourceTableName} (id INTEGER, amount NUMERIC(10,2), name VARCHAR(50), created_at TIMESTAMP)`,
            ).execute();
            await connection.createCommand(
                `INSERT INTO ${sourceTableName} VALUES (1, 7.25, 'Zeus', '2024-06-01 12:00:00'), (2, 8.5, 'Hera', NULL)`,
            ).execute();
        } finally {
            await connection.close();
        }

        const targetTable = `JBL_MIG_SQLTGT_${Date.now()}`.toUpperCase();
        manager.register('pg-src', pgDetails);
        manager.register('nz-target', { ...buildNetezzaDetails(), name: 'nz-target', schema: sourceSchema });

        const request: MigrationRequest = {
            source: {
                mode: 'sql',
                connectionName: 'pg-src',
                sql: `SELECT id * 10 AS id_x10, UPPER(name) AS name_upper, amount FROM ${sourceTableName}`,
            },
            target: {
                connectionName: 'nz-target',
                database: NZ_CONFIG.database,
                schema: sourceSchema,
                table: targetTable,
                appendToExistingTable: false,
            },
        };

        const { phases, maxPercent, result } = await runMigration(request);
        createdTables.push({ kind: 'netezza', name: `${sourceSchema}.${targetTable}` });

        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(2);
        expect(phases).not.toContain('count');
        expect(phases).toContain('stream');
        expect(phases).toContain('done');
        expect(maxPercent).toBe(100);

        const nz = buildTargetConnection('netezza', buildNetezzaDetails());
        try {
            await nz.connect();
            const reader = await nz.createCommand(
                `SELECT ID_X10, NAME_UPPER FROM ${sourceSchema}.${targetTable} ORDER BY ID_X10`,
            ).executeReader();
            try {
                expect(await reader.read()).toBe(true);
                expect(Number(reader.getValue(0))).toBe(10);
                expect(String(reader.getValue(1)).trim()).toBe('ZEUS');
            } finally {
                await reader.close();
            }
        } finally {
            await nz.close();
        }

        // Cleanup PG source table.
        const pgCleanup = buildTargetConnection('postgresql', pgDetails);
        try {
            await pgCleanup.connect();
            await pgCleanup.createCommand(`DROP TABLE IF EXISTS ${sourceTableName}`).execute();
        } finally {
            await pgCleanup.close();
        }
    }, 180000);

    it('uses Oracle SELECT metadata without sampling or counting a live result', async () => {
        const oracleDetails = buildLiveDetails('ORACLE', 'oracle');
        if (!oracleDetails) {
            console.log('Skipping Oracle source metadata test: no ORACLE_LIVE_TEST_* credentials.');
            return;
        }

        manager.register('oracle-meta-src', oracleDetails);
        manager.register('nz-meta-target', { ...buildNetezzaDetails(), name: 'nz-meta-target' });
        const request: MigrationRequest = {
            source: {
                mode: 'sql',
                connectionName: 'oracle-meta-src',
                sql: `
                    SELECT
                        CAST(1 AS NUMBER(10,2)) AS ID_DEC,
                        CAST(SYSTIMESTAMP AS TIMESTAMP) AS CREATED_TS,
                        CAST('x' AS VARCHAR2(20)) AS LABEL
                    FROM DUAL
                    WHERE 1 = 0
                `,
            },
            target: {
                connectionName: 'nz-meta-target',
                database: NZ_CONFIG.database,
                schema: sourceSchema,
                table: `JBL_MIG_META_${Date.now()}`.toUpperCase(),
                appendToExistingTable: false,
            },
        };

        const analysis = await service.analyzeSource(request);
        expect(analysis.sampleCells).toBeUndefined();
        expect(analysis.columns.map(column => column.driverType)).toEqual([
            'NUMBER(10,2)',
            'TIMESTAMP(6)',
            'VARCHAR2(20)',
        ]);

        const plan = service.buildPlan(
            request,
            analysis.sourceContext,
            analysis.columns,
            analysis.pkColumns,
            analysis.warnings,
            analysis.sampleCells,
        );
        expect(plan.columns.map(column => column.targetType)).toEqual([
            'NUMERIC(10,2)',
            'TIMESTAMP',
            'VARCHAR(20)',
        ]);
        expect(plan.columns.map(column => column.targetTypeDisplay)).toEqual([
            'NUMERIC(10,2)',
            'DATETIME',
            'NVARCHAR(20)',
        ]);
    }, 180000);

    it('migrates a live Oracle SQL result to a temporary Netezza table without implicit counting', async () => {
        const oracleDetails = buildLiveDetails('ORACLE', 'oracle');
        if (!oracleDetails) {
            console.log('Skipping Oracle to Netezza migration: no ORACLE_LIVE_TEST_* credentials.');
            return;
        }

        const targetTable = `JBL_MIG_ORA_NZ_${Date.now()}`.toUpperCase();
        manager.register('oracle-e2e-src', oracleDetails);
        manager.register('nz-e2e-target', { ...buildNetezzaDetails(), name: 'nz-e2e-target', schema: sourceSchema });
        const request: MigrationRequest = {
            source: {
                mode: 'sql',
                connectionName: 'oracle-e2e-src',
                sql: `
                    SELECT 1 AS ID, CAST(12.34 AS NUMBER(10,2)) AS AMOUNT, CAST('Alice' AS VARCHAR2(20)) AS NAME FROM DUAL
                    UNION ALL
                    SELECT 2 AS ID, CAST(56.78 AS NUMBER(10,2)) AS AMOUNT, CAST('Bob' AS VARCHAR2(20)) AS NAME FROM DUAL
                `,
            },
            target: {
                connectionName: 'nz-e2e-target',
                database: NZ_CONFIG.database,
                schema: sourceSchema,
                table: targetTable,
                appendToExistingTable: false,
            },
        };

        const { phases, result } = await runMigration(request);
        createdTables.push({ kind: 'netezza', name: `${sourceSchema}.${targetTable}` });

        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(2);
        expect(phases).not.toContain('count');
        expect(phases).toContain('stream');
        expect(phases).toContain('done');

        const nz = buildTargetConnection('netezza', buildNetezzaDetails());
        try {
            await nz.connect();
            await verifyTargetTable(nz, `${sourceSchema}.${targetTable}`, 2, {
                spotCheck: [
                    [1, 'NAME', 'Alice'],
                    [2, 'AMOUNT', 56.78],
                ] as [number, string, unknown][],
            });
        } finally {
            await nz.close();
        }
    }, 180000);

    const optionalTargets: Array<{
        label: string;
        kind: DatabaseKind;
        envPrefix: string;
        enabled: boolean;
        nameCase: 'upper' | 'lower';
    }> = [
        { label: 'Db2', kind: 'db2', envPrefix: 'DB2', enabled: hasDb2 && hasDb2Runtime, nameCase: 'upper' },
        { label: 'MS SQL Server', kind: 'mssql', envPrefix: 'MSSQL', enabled: hasMssql, nameCase: 'lower' },
        { label: 'Oracle', kind: 'oracle', envPrefix: 'ORACLE', enabled: hasOracle, nameCase: 'upper' },
        { label: 'Vertica', kind: 'vertica', envPrefix: 'VERTICA', enabled: hasVertica, nameCase: 'lower' },
    ];

    for (const target of optionalTargets) {
        it(`migrates Netezza table to ${target.label}`, async () => {
            if (!target.enabled) {
                console.log(`Skipping ${target.label} target (no credentials or runtime).`);
                return;
            }

            const details = buildLiveDetails(
                target.envPrefix,
                target.kind,
                undefined,
                { allowEmptyPassword: target.kind === 'vertica' },
            );
            if (!details) {
                console.log(`Skipping ${target.label} target: incomplete credentials.`);
                return;
            }

            const targetTable = `JBL_MIG_TGT_${Date.now()}`;
            const finalTableName = target.nameCase === 'upper' ? targetTable.toUpperCase() : targetTable.toLowerCase();

            const { phases, result } = await migrateNetezzaTableTo(
                details,
                target.kind,
                finalTableName,
            );
            createdTables.push({ kind: target.kind, name: finalTableName });

            if (target.kind === 'oracle' || target.kind === 'vertica') {
                const diag = buildTargetConnection(target.kind, details);
                try {
                    await diag.connect();
                    const r = await diag.createCommand(`SELECT COUNT(*) AS C FROM ${finalTableName}`).executeReader();
                    if (await r.read()) {
                        console.log(`DIAG ${target.kind} COUNT:`, r.getValue(0));
                    }
                    await r.close();
                } finally {
                    await diag.close();
                }
            }

            expect(result.success).toBe(true);
            expect(result.rowsInserted).toBe(3);
            expect(phases).toContain('done');

            const connection = buildTargetConnection(target.kind, details);
            try {
                await connection.connect();
                await verifyTargetTable(connection, finalTableName, 3, {
                    spotCheck: [
                        [1, 'NAME', 'Alice'],
                        [3, 'AMOUNT', -1.5],
                    ] as [number, string, unknown][],
                });
            } finally {
                await connection.close();
            }
        }, 240000);
    }

    it('appends Netezza rows into an existing PostgreSQL table', async () => {
        const details = buildLiveDetails('PG', 'postgresql');
        if (!details) {
            console.log('Skipping append test: no PostgreSQL target.');
            return;
        }

        const targetTable = `jbl_mig_append_${Date.now()}`.toLowerCase();
        await executeOnTarget('postgresql', details, `CREATE TABLE ${targetTable} (id INTEGER NOT NULL, amount NUMERIC(10,2), name VARCHAR(50), birth DATE, created_at TIMESTAMP, active BOOLEAN)`);
        createdTables.push({ kind: 'postgresql', name: targetTable });

        manager.register('pg-append-target', details);
        const request: MigrationRequest = {
            source: {
                mode: 'table',
                connectionName: 'nz-src',
                database: NZ_CONFIG.database,
                schema: sourceSchema,
                table: sourceTable,
            },
            target: {
                connectionName: 'pg-append-target',
                table: targetTable,
                appendToExistingTable: true,
            },
        };

        const { result } = await runMigration(request);
        expect(result.success).toBe(true);
        expect(result.rowsInserted).toBe(3);

        const connection = buildTargetConnection('postgresql', details);
        try {
            await connection.connect();
            await verifyTargetTable(connection, targetTable, 3);
        } finally {
            await connection.close();
        }
    }, 180000);
});
