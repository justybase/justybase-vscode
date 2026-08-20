/**
 * Live end-to-end import coverage for the Netezza driver virtual-file path.
 *
 * The suite deliberately exercises both direct file imports and the migration
 * service. Direct imports cover the historical XLSX/clipboard failure mode;
 * migration tests cover SQLite and DuckDB File SQL (including Parquet).
 * Db2 is enabled only when its live credentials and native runtime are present.
 *
 * Run with NZ_DEV_* credentials:
 *   npm run test:netezza:import:integration
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as vscode from 'vscode';
import type { DatabaseKind } from '../../contracts/database';
import { getDatabaseDialect } from '../../core/connectionFactory';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import { importClipboardDataToNetezza } from '../../import/clipboardImporter';
import { importDataToNetezza, importDataToNetezzaAdvanced } from '../../import/dataImporter';
import { MigrationService } from '../../migration/migrationService';
import type { MigrationRequest } from '../../migration/types';
import type { ConnectionDetails } from '../../types';
import { NzConnection } from '@justybase/netezza-driver';
import { configureBundledClidriverForCurrentProcess } from '../../../extensions/db2/src/db2Connection';
import { db2Dialect } from '../../../extensions/db2/src/db2Dialect';
import { fileDialect } from '../../../extensions/duckdb/src/fileDialect';
import { loadDuckDb } from '../../../extensions/duckdb/src/duckdbConnection';
import { sqliteDialect } from '../../dialects/sqlite';

registerDatabaseDialect(db2Dialect);
registerDatabaseDialect(fileDialect);
registerDatabaseDialect(sqliteDialect);

const NZ_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const hasNetezza = Boolean(process.env.NZ_DEV_PASSWORD);
const describeIfNetezza = hasNetezza ? describe : describe.skip;
const db2Require = createRequire(path.join(process.cwd(), 'extensions', 'db2', 'package.json'));

let hasDb2Runtime = false;
try {
    configureBundledClidriverForCurrentProcess();
    db2Require('ibm_db');
    hasDb2Runtime = true;
} catch {
    hasDb2Runtime = false;
}

function buildNetezzaDetails(): ConnectionDetails {
    return {
        name: 'nz-import-live',
        host: NZ_CONFIG.host,
        port: NZ_CONFIG.port,
        database: NZ_CONFIG.database,
        user: NZ_CONFIG.user,
        password: NZ_CONFIG.password,
        dbType: 'netezza',
    };
}

function buildOptionalDetails(
    prefix: 'DB2',
    dbType: DatabaseKind,
): ConnectionDetails | undefined {
    const host = process.env[`${prefix}_LIVE_TEST_HOST`];
    const database = process.env[`${prefix}_LIVE_TEST_DATABASE`];
    const user = process.env[`${prefix}_LIVE_TEST_USER`];
    const password = process.env[`${prefix}_LIVE_TEST_PASSWORD`];
    if (!host || !database || !user || password === undefined) {
        return undefined;
    }

    return {
        name: `${dbType}-import-live`,
        host,
        port: process.env[`${prefix}_LIVE_TEST_PORT`]
            ? Number(process.env[`${prefix}_LIVE_TEST_PORT`])
            : undefined,
        database,
        user,
        password,
        dbType,
    };
}

const sourceSchema = (process.env.NZ_DEV_SCHEMA || 'ADMIN').replace(/[^A-Za-z0-9_$]/g, '_').toUpperCase();
const fixtureDirectory = process.env.NZ_IMPORT_SAMPLES_DIR
    || path.resolve(process.cwd(), '..', 'sql_samples');

function fixturePath(name: string): string {
    return path.join(fixtureDirectory, name);
}

function uniqueTable(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        .replace(/[^A-Za-z0-9_$]/g, '_')
        .toUpperCase();
}

function tableReference(schema: string, table: string): string {
    return `${schema}.${table}`;
}

async function openNetezza(): Promise<NzConnection> {
    const connection = new NzConnection({
        host: NZ_CONFIG.host,
        port: NZ_CONFIG.port,
        database: NZ_CONFIG.database,
        user: NZ_CONFIG.user,
        password: NZ_CONFIG.password,
    });
    await connection.connect();
    return connection;
}

async function dropNetezzaTable(table: string): Promise<void> {
    const connection = await openNetezza();
    try {
        await connection.createCommand(`DROP TABLE ${table}`).execute();
    } catch {
        // The import may have failed before CREATE TABLE; cleanup is best effort.
    } finally {
        await connection.close().catch(() => undefined);
    }
}

async function readRows(
    connection: {
        createCommand(sql: string): {
            executeReader(): Promise<{
                fieldCount: number;
                getName(index: number): string;
                getValue(index: number): unknown;
                read(): Promise<boolean>;
                close(): Promise<void>;
            }>;
        };
    },
    sql: string,
): Promise<{ names: string[]; rows: unknown[][] }> {
    const reader = await connection.createCommand(sql).executeReader();
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

async function readNetezzaRows(sql: string): Promise<{ names: string[]; rows: unknown[][] }> {
    const connection = await openNetezza();
    try {
        return await readRows(connection, sql);
    } finally {
        await connection.close().catch(() => undefined);
    }
}

function expectRowCount(rows: unknown[][], expected: number): void {
    expect(rows).toHaveLength(1);
    expect(Number(String(rows[0][0]))).toBe(expected);
}

class LiveConnectionManager {
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

async function runMigration(
    service: MigrationService,
    request: MigrationRequest,
): Promise<Awaited<ReturnType<MigrationService['execute']>>> {
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
    return service.execute(request, plan, analysis.sourceContext);
}

async function writeParquetFixture(filePath: string): Promise<void> {
    const duckdb = await loadDuckDb();
    const instance = await duckdb.DuckDBInstance.create(undefined);
    const connection = await instance.connect();
    try {
        const normalizedPath = filePath.split(path.sep).join('/').replace(/'/g, "''");
        await connection.run(
            `COPY (
                SELECT * FROM (VALUES
                    ('EU', 100),
                    ('US', 200),
                    ('EU', 150)
                ) AS data(region, amount)
            ) TO '${normalizedPath}' (FORMAT PARQUET)`,
        );
    } finally {
        connection.disconnectSync();
        instance.closeSync();
    }
}

describeIfNetezza('Live Netezza virtual import and migration coverage', () => {
    let liveConnection: NzConnection;

    beforeAll(async () => {
        liveConnection = await openNetezza();
    }, 60000);

    afterAll(async () => {
        await liveConnection?.close().catch(() => undefined);
    });

    async function verifyImportedFile(
        filePath: string,
        expectedColumns: string[],
        expectedRows: number,
        label: string,
    ): Promise<void> {
        if (!fs.existsSync(filePath)) {
            console.log(`Skipping ${label}: fixture does not exist: ${filePath}`);
            return;
        }

        const table = uniqueTable('JBL_IMPORT');
        const target = tableReference(sourceSchema, table);
        try {
            const result = await importDataToNetezza(filePath, target, buildNetezzaDetails());
            expect(result.success).toBe(true);
            if (!result.success) {
                throw new Error(result.message);
            }

            const imported = await readNetezzaRows(`SELECT * FROM ${target} ORDER BY 1`);
            expect(imported.names.map(name => name.toUpperCase())).toEqual(expectedColumns);
            expect(imported.rows).toHaveLength(expectedRows);
        } finally {
            await dropNetezzaTable(target);
        }
    }

    it('imports data1.xlsx with its header row through the live virtual stream', async () => {
        await verifyImportedFile(fixturePath('data1.xlsx'), ['COL1', 'COL2'], 4, 'data1.xlsx');
    }, 180000);

    it('deduplicates duplicate XLSX headers before loading data2.xlsx', async () => {
        await verifyImportedFile(fixturePath('data2.xlsx'), ['COL', 'COL_1'], 4, 'data2.xlsx');
    }, 180000);

    it('generates headers and preserves the first numeric row of data3.xlsx', async () => {
        const filePath = fixturePath('data3.xlsx');
        if (!fs.existsSync(filePath)) {
            console.log(`Skipping data3.xlsx: fixture does not exist: ${filePath}`);
            return;
        }

        const table = uniqueTable('JBL_IMPORT');
        const target = tableReference(sourceSchema, table);
        try {
            const result = await importDataToNetezza(filePath, target, buildNetezzaDetails());
            expect(result.success).toBe(true);
            if (!result.success) {
                throw new Error(result.message);
            }

            const imported = await readNetezzaRows(`SELECT * FROM ${target} ORDER BY 1`);
            expect(imported.names.map(name => name.toUpperCase())).toEqual(['COL_1', 'COL_2']);
            expect(imported.rows).toHaveLength(4);
            expect(String(imported.rows[0][0])).toBe('1');
            expect(String(imported.rows[0][1]).trim()).toBe('a');
        } finally {
            await dropNetezzaTable(target);
        }
    }, 180000);

    it('imports semicolon CSV and tab-delimited TXT through the same virtual stream path', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netezza-import-live-'));
        const csvPath = path.join(tempDir, 'semicolon.csv');
        const txtPath = path.join(tempDir, 'tabbed.txt');
        fs.writeFileSync(csvPath, 'id;label\n1;alpha\n2;beta\n');
        fs.writeFileSync(txtPath, 'id\tlabel\n3\tgamma\n4\tdelta\n');

        try {
            await verifyImportedFile(csvPath, ['ID', 'LABEL'], 2, 'semicolon.csv');
            await verifyImportedFile(txtPath, ['ID', 'LABEL'], 2, 'tabbed.txt');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }, 180000);

    it('runs the advanced create-then-load importer against the live database', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netezza-import-advanced-live-'));
        const csvPath = path.join(tempDir, 'advanced.csv');
        const table = uniqueTable('JBL_ADV_IMPORT');
        const target = tableReference(sourceSchema, table);
        fs.writeFileSync(csvPath, 'id;amount\n1;12.50\n2;8.25\n');

        try {
            const result = await importDataToNetezzaAdvanced(csvPath, target, buildNetezzaDetails());
            expect(result.success).toBe(true);
            if (!result.success) {
                throw new Error(result.message);
            }

            const imported = await readNetezzaRows(`SELECT COUNT(*) FROM ${target}`);
            expectRowCount(imported.rows, 2);
        } finally {
            await dropNetezzaTable(target);
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }, 180000);

    it('imports duplicate clipboard headers through the live virtual stream', async () => {
        const clipboard = vscode.env.clipboard as unknown as {
            readText?: () => Promise<string>;
        };
        const previousReadText = clipboard.readText;
        clipboard.readText = async () => 'col\tcol\n1\ta\n2\tb\n';

        const table = uniqueTable('JBL_CLIP_IMPORT');
        const target = tableReference(sourceSchema, table);
        try {
            const result = await importClipboardDataToNetezza(target, buildNetezzaDetails());
            expect(result.success).toBe(true);
            if (!result.success) {
                throw new Error(result.message);
            }

            const imported = await readNetezzaRows(`SELECT * FROM ${target} ORDER BY 1`);
            expect(imported.names.map(name => name.toUpperCase())).toEqual(['COL', 'COL_1']);
            expect(imported.rows).toHaveLength(2);
        } finally {
            await dropNetezzaTable(target);
            if (previousReadText) {
                clipboard.readText = previousReadText;
            } else {
                delete clipboard.readText;
            }
        }
    }, 180000);

    it('migrates a local SQLite table into Netezza', async () => {
        const sqlitePath = path.join(os.tmpdir(), `netezza-import-source-${Date.now()}.sqlite`);
        const sourceTable = uniqueTable('JBL_SQLITE_SRC');
        const targetTable = uniqueTable('JBL_SQLITE_TGT');
        const target = tableReference(sourceSchema, targetTable);
        const sqliteDetails: ConnectionDetails = {
            name: 'sqlite-import-source',
            host: 'local',
            database: sqlitePath,
            user: 'sqlite',
            password: '',
            dbType: 'sqlite',
        };
        const manager = new LiveConnectionManager();
        manager.register('sqlite-import-source', sqliteDetails);
        manager.register('nz-import-target', { ...buildNetezzaDetails(), name: 'nz-import-target', schema: sourceSchema });
        const service = new MigrationService({ connectionManager: manager });
        const sqliteConnection = getDatabaseDialect('sqlite').createConnection(sqliteDetails);

        try {
            await sqliteConnection.connect();
            await sqliteConnection.createCommand(
                `CREATE TABLE ${sourceTable} (id INTEGER, label TEXT, amount DECIMAL(10,2))`,
            ).execute();
            await sqliteConnection.createCommand(
                `INSERT INTO ${sourceTable} VALUES (1, 'alpha', 12.50), (2, 'beta', 8.25)`,
            ).execute();
            await sqliteConnection.close();

            const result = await runMigration(service, {
                source: {
                    mode: 'table',
                    connectionName: 'sqlite-import-source',
                    schema: 'main',
                    table: sourceTable,
                },
                target: {
                    connectionName: 'nz-import-target',
                    database: NZ_CONFIG.database,
                    schema: sourceSchema,
                    table: targetTable,
                    appendToExistingTable: false,
                },
            });
            expect(result.success).toBe(true);
            expect(result.rowsInserted).toBe(2);

            const imported = await readNetezzaRows(`SELECT COUNT(*) FROM ${target}`);
            expectRowCount(imported.rows, 2);
        } finally {
            await sqliteConnection.close().catch(() => undefined);
            await dropNetezzaTable(target);
            fs.rmSync(sqlitePath, { force: true });
        }
    }, 180000);

    it('migrates a Parquet file through File SQL into Netezza', async () => {
        let duckdbAvailable = true;
        try {
            await loadDuckDb();
        } catch {
            duckdbAvailable = false;
        }
        if (!duckdbAvailable) {
            console.log('Skipping Parquet migration: DuckDB runtime is unavailable.');
            return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netezza-parquet-live-'));
        const parquetPath = path.join(tempDir, 'sales.parquet');
        const targetTable = uniqueTable('JBL_PARQUET_TGT');
        const target = tableReference(sourceSchema, targetTable);
        const fileDetails: ConnectionDetails = {
            name: 'parquet-import-source',
            host: 'local',
            database: parquetPath,
            user: 'file',
            password: '',
            dbType: 'file',
        };
        const manager = new LiveConnectionManager();
        manager.register('parquet-import-source', fileDetails);
        manager.register('nz-parquet-target', { ...buildNetezzaDetails(), name: 'nz-parquet-target', schema: sourceSchema });
        const service = new MigrationService({ connectionManager: manager });

        try {
            await writeParquetFixture(parquetPath);
            const result = await runMigration(service, {
                source: {
                    mode: 'sql',
                    connectionName: 'parquet-import-source',
                    sql: 'SELECT region, amount FROM "sales" ORDER BY amount',
                },
                target: {
                    connectionName: 'nz-parquet-target',
                    database: NZ_CONFIG.database,
                    schema: sourceSchema,
                    table: targetTable,
                    appendToExistingTable: false,
                },
            });
            expect(result.success).toBe(true);
            expect(result.rowsInserted).toBe(3);

            const imported = await readNetezzaRows(`SELECT COUNT(*) FROM ${target}`);
            expectRowCount(imported.rows, 3);
        } finally {
            await dropNetezzaTable(target);
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }, 240000);

    it('migrates a Db2 table into Netezza when Db2 live access is configured', async () => {
        if (!hasDb2Runtime) {
            console.log('Skipping Db2 migration: ibm_db runtime is unavailable.');
            return;
        }
        const db2Details = buildOptionalDetails('DB2', 'db2');
        if (!db2Details) {
            console.log('Skipping Db2 migration: DB2_LIVE_TEST_* credentials are unavailable.');
            return;
        }

        const db2Schema = (process.env.DB2_LIVE_TEST_SCHEMA || db2Details.user).replace(/[^A-Za-z0-9_$]/g, '_').toUpperCase();
        const sourceTable = uniqueTable('JBL_DB2_SRC');
        const targetTable = uniqueTable('JBL_DB2_TGT');
        const target = tableReference(sourceSchema, targetTable);
        const manager = new LiveConnectionManager();
        manager.register('db2-import-source', db2Details);
        manager.register('nz-db2-target', { ...buildNetezzaDetails(), name: 'nz-db2-target', schema: sourceSchema });
        const service = new MigrationService({ connectionManager: manager });
        const db2Connection = getDatabaseDialect('db2').createConnection(db2Details);

        try {
            await db2Connection.connect();
            await db2Connection.createCommand(
                `CREATE TABLE ${db2Schema}.${sourceTable} (ID INTEGER, LABEL VARCHAR(64))`,
            ).execute();
            await db2Connection.createCommand(
                `INSERT INTO ${db2Schema}.${sourceTable} VALUES (1, 'alpha'), (2, 'beta')`,
            ).execute();
            await db2Connection.close();

            const result = await runMigration(service, {
                source: {
                    mode: 'table',
                    connectionName: 'db2-import-source',
                    schema: db2Schema,
                    table: sourceTable,
                },
                target: {
                    connectionName: 'nz-db2-target',
                    database: NZ_CONFIG.database,
                    schema: sourceSchema,
                    table: targetTable,
                    appendToExistingTable: false,
                },
            });
            expect(result.success).toBe(true);
            expect(result.rowsInserted).toBe(2);
        } finally {
            await db2Connection.close().catch(() => undefined);
            const cleanup = getDatabaseDialect('db2').createConnection(db2Details);
            try {
                await cleanup.connect();
                await cleanup.createCommand(`DROP TABLE ${db2Schema}.${sourceTable}`).execute();
            } catch {
                // Best-effort cleanup.
            } finally {
                await cleanup.close().catch(() => undefined);
            }
            await dropNetezzaTable(target);
        }
    }, 240000);
});
