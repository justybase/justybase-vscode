/**
 * Migration throughput benchmark.
 *
 * Measures end-to-end migration time for a 10-column, 100k-row table across
 * every local dialect pair (SQLite / DuckDB) and, when live Netezza
 * credentials are present (NZ_DEV_PASSWORD), the Netezza external-table
 * stream paths. Also sweeps target batch sizes:
 *  - SQLite / DuckDB batch-insert size (production default: 300)
 *  - Netezza external-table stream option (the current driver requires
 *    one-row event-loop pacing, so this is recorded as a protocol check)
 *
 * Run:
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/migrationPerfBenchmark.test.ts
 *
 * With live Netezza:
 *   set -a; . ./.env.local; set +a
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/migrationPerfBenchmark.test.ts
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerDatabaseDialect } from '../src/core/factories/databaseDialectRegistry';
import { sqliteDialect } from '../src/dialects/sqlite';
import { duckdbDialect } from '../extensions/duckdb/src/duckdbDialect';
import { getDatabaseDialect } from '../src/core/connectionFactory';
import { loadNodeSqliteModule } from '../src/core/resultDataProvider/sqliteModuleLoader';
import { executeBatchImport, type ImportExecutionInput } from '../src/import/batchImportSupport';
import { sqliteBatchImportConfig } from '../src/import/sqliteImporter';
import { duckdbBatchImportConfig } from '../src/import/duckdbImporter';
import type { BatchImportDialectConfig } from '../src/import/batchImportSupport';
import type { ImportColumnDescriptor } from '../src/import/dataImporter';
import { MigrationService } from '../src/migration/migrationService';
import type { MigrationProgress, MigrationRequest } from '../src/migration/types';
import type { DatabaseConnection, DatabaseKind } from '../src/contracts/database';
import type { ConnectionDetails } from '../src/types';
import { NzConnection } from '@justybase/netezza-driver';

registerDatabaseDialect(sqliteDialect);
registerDatabaseDialect(duckdbDialect);

const ROW_COUNT = 100_000;
const TABLE_COLUMNS = [
    'ID INTEGER NOT NULL PRIMARY KEY',
    'AMOUNT NUMERIC(10,2)',
    'NAME TEXT',
    'DESCRIPTION TEXT',
    'BIRTH_DATE TEXT',
    'CREATED_AT TEXT',
    'SCORE INTEGER',
    'RATING REAL',
    'ACTIVE INTEGER',
    'PAYLOAD TEXT',
];

const SWEEP_COLUMNS: ImportColumnDescriptor[] = [
    { sourceIndex: 0, columnName: 'ID', dataType: 'INTEGER' },
    { sourceIndex: 1, columnName: 'AMOUNT', dataType: 'NUMERIC(10,2)' },
    { sourceIndex: 2, columnName: 'NAME', dataType: 'VARCHAR(50)' },
    { sourceIndex: 3, columnName: 'DESCRIPTION', dataType: 'VARCHAR(200)' },
    { sourceIndex: 4, columnName: 'BIRTH_DATE', dataType: 'VARCHAR(10)' },
    { sourceIndex: 5, columnName: 'CREATED_AT', dataType: 'VARCHAR(19)' },
    { sourceIndex: 6, columnName: 'SCORE', dataType: 'INTEGER' },
    { sourceIndex: 7, columnName: 'RATING', dataType: 'DOUBLE' },
    { sourceIndex: 8, columnName: 'ACTIVE', dataType: 'BOOLEAN' },
    { sourceIndex: 9, columnName: 'PAYLOAD', dataType: 'VARCHAR(100)' },
];

const NZ_CONFIG = {
    host: process.env.NZ_DEV_HOST || '192.168.0.144',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const NZ_SCHEMA = process.env.NZ_DEV_SCHEMA || 'ADMIN';
const hasNetezza = Boolean(process.env.NZ_DEV_PASSWORD);
const describeIfNetezza = hasNetezza ? describe : describe.skip;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-perf-'));
const sqliteSourcePath = path.join(tempDir, 'source.sqlite');
const duckdbSourcePath = path.join(tempDir, 'source.duckdb');
const sqliteSourceTable = 'JBL_PERF_SRC';
const duckdbSourceTable = 'jbl_perf_src';

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

const manager = new FakeConnectionManager();

function rowValues(index: number): unknown[] {
    return [
        index + 1,
        ((index % 1000) * 1.25).toFixed(2),
        `Name ${index}`,
        `Description for row ${index}`,
        `2024-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
        `2024-01-01 ${String(index % 24).padStart(2, '0')}:10:30`,
        index % 100,
        Number(((index % 100) / 7.0).toFixed(4)),
        index % 2 === 0 ? 1 : 0,
        `payload-${index}`,
    ];
}

function createSqliteSource(dbPath: string, table: string): void {
    const { DatabaseSync } = loadNodeSqliteModule();
    const database = new DatabaseSync(dbPath);
    try {
        database.exec(`CREATE TABLE ${table} (${TABLE_COLUMNS.join(', ')})`);
        const insert = database.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        database.exec('BEGIN');
        for (let index = 0; index < ROW_COUNT; index++) {
            insert.run(...(rowValues(index) as unknown as import('node:sqlite').SQLInputValue[]));
        }
        database.exec('COMMIT');
    } finally {
        database.close();
    }
}

function quoteSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value);
    }
    return `'${String(value).replace(/'/g, "''")}'`;
}

async function createDuckDbSource(dbPath: string, table: string): Promise<void> {
    const details: ConnectionDetails = {
        name: 'duckdb-setup',
        host: '',
        database: dbPath,
        user: '',
        password: '',
        dbType: 'duckdb',
    };
    const connection = getDatabaseDialect('duckdb').createConnection(details);
    await connection.connect();
    try {
        await connection.createCommand(
            `CREATE TABLE ${table} (ID INTEGER NOT NULL PRIMARY KEY, AMOUNT DECIMAL(10,2), NAME VARCHAR(100), DESCRIPTION VARCHAR(200), BIRTH_DATE VARCHAR(10), CREATED_AT VARCHAR(19), SCORE INTEGER, RATING DOUBLE, ACTIVE BOOLEAN, PAYLOAD VARCHAR(100))`,
        ).execute();
        const batchSize = 2000;
        for (let offset = 0; offset < ROW_COUNT; offset += batchSize) {
            const end = Math.min(offset + batchSize, ROW_COUNT);
            const valueRows: string[] = [];
            for (let index = offset; index < end; index++) {
                const values = rowValues(index).map(quoteSqlLiteral);
                valueRows.push(`(${values.join(', ')})`);
            }
            await connection.createCommand(
                `INSERT INTO ${table} VALUES ${valueRows.join(', ')}`,
            ).execute();
        }
    } finally {
        await connection.close();
    }
}

function sqliteTargetDetails(dbPath: string): ConnectionDetails {
    return { name: 'sqlite-target', host: '', database: dbPath, user: '', password: '', dbType: 'sqlite' };
}

function duckdbTargetDetails(dbPath: string): ConnectionDetails {
    return { name: 'duckdb-target', host: '', database: dbPath, user: '', password: '', dbType: 'duckdb' };
}

function buildNetezzaDetails(name: string, schema?: string): ConnectionDetails {
    return { name, host: NZ_CONFIG.host, port: NZ_CONFIG.port, database: NZ_CONFIG.database, user: NZ_CONFIG.user, password: NZ_CONFIG.password, dbType: 'netezza', schema };
}

async function createNetezzaSourceTable(connection: NzConnection, table: string): Promise<void> {
    await connection.createCommand(
        `CREATE TABLE ${NZ_SCHEMA}.${table} (
            ID INTEGER NOT NULL,
            AMOUNT NUMERIC(10,2),
            NAME VARCHAR(100),
            DESCRIPTION VARCHAR(200),
            BIRTH_DATE DATE,
            CREATED_AT TIMESTAMP,
            SCORE INTEGER,
            RATING DOUBLE PRECISION,
            ACTIVE BOOLEAN,
            PAYLOAD VARCHAR(100)
        )`,
    ).execute();

    // NPS has no GENERATOR / recursive CTE and multi-row VALUES is not
    // supported, so the row source is a catalog cross join with LIMIT
    // (fast, server-side, single statement).
    await connection.createCommand(
        `INSERT INTO ${NZ_SCHEMA}.${table} (ID, AMOUNT, NAME, DESCRIPTION, BIRTH_DATE, CREATED_AT, SCORE, RATING, ACTIVE, PAYLOAD)
         SELECT MOD(A.OBJID + B.OBJID, 100000), MOD(A.OBJID, 1000) * 1.25, 'Name ' || MOD(A.OBJID + B.OBJID, 100000), 'Description ' || MOD(A.OBJID, 10), '2024-01-01', '2024-01-01 10:20:30', MOD(A.OBJID, 100), MOD(B.OBJID, 100) / 7.0, CASE WHEN MOD(A.OBJID, 2) = 0 THEN TRUE ELSE FALSE END, 'payload-' || MOD(A.OBJID, 1000)
         FROM _V_OBJECT_DATA A CROSS JOIN _V_OBJECT_DATA B LIMIT 100000`,
    ).execute();
}

interface ScenarioMetrics {
    label: string;
    status: 'passed' | 'known-failure';
    message?: string;
    analyzeMs: number;
    executeMs: number;
    streamMs: number;
    finalizeMs: number;
    rowsPerSec: number;
    progressMessages: number;
    rowsInserted: number;
    targetCount: number;
}

async function countTargetRows(kind: DatabaseKind, details: ConnectionDetails, table: string): Promise<number> {
    const connection = getDatabaseDialect(kind).createConnection(details);
    try {
        await connection.connect();
        const reader = await connection.createCommand(`SELECT COUNT(*) AS C FROM ${table}`).executeReader();
        try {
            if (!await reader.read()) {
                return -1;
            }
            return Number(reader.getValue(0));
        } finally {
            await reader.close();
        }
    } finally {
        await connection.close();
    }
}

async function runScenario(
    label: string,
    request: MigrationRequest,
    targetKind: DatabaseKind,
    targetDetails: ConnectionDetails,
    targetTable: string,
    options?: { streamBatchSize?: number; allowServerLoadLimitFailure?: boolean },
): Promise<ScenarioMetrics> {
    const service = new MigrationService({ connectionManager: manager });

    const analyzeStart = performance.now();
    const analysis = await service.analyzeSource(request);
    const analyzeMs = performance.now() - analyzeStart;

    const plan = service.buildPlan(
        request,
        analysis.sourceContext,
        analysis.columns,
        analysis.pkColumns,
        analysis.warnings,
        analysis.sampleCells,
    );

    const progressLog: Array<{ progress: MigrationProgress; at: number }> = [];
    const executeStart = performance.now();
    const result = await service.execute(
        request,
        plan,
        analysis.sourceContext,
        progress => progressLog.push({ progress, at: performance.now() }),
        { streamBatchSize: options?.streamBatchSize },
    );
    const executeMs = performance.now() - executeStart;

    const streamTimes = progressLog.filter(entry => entry.progress.phase === 'stream').map(entry => entry.at);
    const finalizeTimes = progressLog.filter(entry => entry.progress.phase === 'finalize').map(entry => entry.at);
    const executeEndAt = executeStart + executeMs;
    const streamMs = streamTimes.length > 1 ? streamTimes[streamTimes.length - 1] - streamTimes[0] : streamTimes.length === 1 ? executeMs : 0;
    const finalizeMs = finalizeTimes.length > 0 ? executeEndAt - finalizeTimes[0] : 0;

    const targetCount = result.success
        ? await countTargetRows(targetKind, targetDetails, targetTable)
        : -1;

    const serverLoadLimitFailure = options?.allowServerLoadLimitFailure === true
        && !result.success
        && result.message.includes('Transaction rolled back by client');

    const metrics: ScenarioMetrics = {
        label,
        status: serverLoadLimitFailure ? 'known-failure' : 'passed',
        message: serverLoadLimitFailure ? result.message : undefined,
        analyzeMs,
        executeMs,
        streamMs,
        finalizeMs,
        rowsPerSec: executeMs > 0 ? ROW_COUNT / (executeMs / 1000) : 0,
        progressMessages: progressLog.length,
        rowsInserted: result.rowsInserted,
        targetCount,
    };

    const rowsPerSecondText = serverLoadLimitFailure ? 'n/a' : `${Math.round(metrics.rowsPerSec).toLocaleString()} rows/s`;
    console.log(`  [${label}] analyze=${analyzeMs.toFixed(0)}ms execute=${executeMs.toFixed(0)}ms (${rowsPerSecondText}) stream=${streamMs.toFixed(0)}ms finalize=${finalizeMs.toFixed(0)}ms progress=${progressLog.length}${result.success ? '' : ` FAILED: ${result.message}`}`);

    if (serverLoadLimitFailure) {
        console.log(`    NOTE: server-side external-table load limit (~10s) cancels the load at ${ROW_COUNT.toLocaleString()} rows (50k passes). Known NPS environment limit.`);
        return metrics;
    }

    expect(result.success).toBe(true);
    expect(result.rowsInserted).toBe(ROW_COUNT);
    expect(targetCount).toBe(ROW_COUNT);
    expect(progressLog.length).toBeLessThan(5000);

    return metrics;
}

interface SweepResult {
    kind: string;
    batchSize: number;
    durationMs: number;
    rowsPerSec: number;
    rowsInserted: number;
}

async function runBatchSweep(
    kind: 'sqlite' | 'duckdb',
    config: BatchImportDialectConfig,
    sizes: number[],
    targetDetails: ConnectionDetails,
    createTargetTable: (connection: DatabaseConnection, table: string) => Promise<void>,
): Promise<SweepResult[]> {
    const results: SweepResult[] = [];
    for (const batchSize of sizes) {
        const targetTable = `jbl_sweep_${batchSize}`.toLowerCase();
        const connection = getDatabaseDialect(kind).createConnection(targetDetails);
        await connection.connect();
        try {
            await createTargetTable(connection, targetTable);
        } finally {
            await connection.close();
        }

        async function* rows(): AsyncGenerator<string[], void, unknown> {
            for (let index = 0; index < ROW_COUNT; index++) {
                yield rowValues(index).map(value => value === null || value === undefined ? '' : String(value));
            }
        }

        const sweepConfig: BatchImportDialectConfig = { ...config, insertBatchSize: batchSize };
        const input: ImportExecutionInput = {
            targetTable,
            connectionDetails: targetDetails,
            columns: SWEEP_COLUMNS,
            appendToExistingTable: true,
            rows: rows(),
            totalRows: ROW_COUNT,
            decimalDelimiter: '.',
            format: 'MIGRATION',
            progressCallback: () => undefined,
        };

        const started = performance.now();
        const result = await executeBatchImport(sweepConfig, input);
        const durationMs = performance.now() - started;

        const sweepResult: SweepResult = {
            kind,
            batchSize,
            durationMs,
            rowsPerSec: durationMs > 0 ? ROW_COUNT / (durationMs / 1000) : 0,
            rowsInserted: result.details?.rowsInserted ?? -1,
        };

        console.log(`  [sweep ${kind} batch=${batchSize}] ${durationMs.toFixed(0)}ms (${Math.round(sweepResult.rowsPerSec).toLocaleString()} rows/s)`);

        expect(result.success).toBe(true);
        expect(sweepResult.rowsInserted).toBe(ROW_COUNT);
        results.push(sweepResult);
    }
    return results;
}

const BATCH_SIZES = [300, 1000, 5000, 10_000, 20_000];
const NZ_STREAM_BATCH_SIZES = [1000, 5000, 10_000, 20_000];

const allScenarioMetrics: ScenarioMetrics[] = [];
const sweepResults: SweepResult[] = [];

function writeResults(): void {
    const lines: string[] = [];
    lines.push('# Migration Performance Benchmark');
    lines.push('');
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push(`Node: ${process.version}`);
    lines.push(`Rows: ${ROW_COUNT.toLocaleString()}; Columns: 10 (INTEGER, NUMERIC, TEXT, DATE, TIMESTAMP, INTEGER, REAL, BOOLEAN, TEXT)`);
    lines.push('');
    lines.push('## Scenarios');
    lines.push('');
    lines.push('| Scenario | Status | Analyze (ms) | Execute (ms) | Rows/s | Stream (ms) | Finalize (ms) | Progress msgs | Rows inserted | Target count | Note |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const scenario of allScenarioMetrics) {
        lines.push(`| ${scenario.label} | ${scenario.status} | ${scenario.analyzeMs.toFixed(0)} | ${scenario.executeMs.toFixed(0)} | ${scenario.status === 'passed' ? Math.round(scenario.rowsPerSec).toLocaleString() : 'n/a'} | ${scenario.streamMs.toFixed(0)} | ${scenario.finalizeMs.toFixed(0)} | ${scenario.progressMessages} | ${scenario.rowsInserted} | ${scenario.targetCount} | ${scenario.message ?? ''} |`);
    }
    lines.push('');
    lines.push('## Batch-size sweeps (append mode, isolated INSERT cost)');
    lines.push('');
    lines.push('| Target | Batch size | Duration (ms) | Rows/s | Rows inserted |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const sweep of sweepResults) {
        lines.push(`| ${sweep.kind} | ${sweep.batchSize.toLocaleString()} | ${sweep.durationMs.toFixed(0)} | ${Math.round(sweep.rowsPerSec).toLocaleString()} | ${sweep.rowsInserted} |`);
    }
    lines.push('');
    lines.push('## Notes');
    lines.push('- Production batch size: SQLite/DuckDB insertBatchSize=300.');
    lines.push('- Netezza streamBatchSize is retained for API compatibility; the current driver requires one-row event-loop pacing, so the stream sweep does not change the actual reader behavior.');
    lines.push('- Netezza scenarios run only when NZ_DEV_PASSWORD is set.');
    lines.push('- Progress messages: source stream reports every 5000 rows; batch engine per batch; Netezza stream every 5000 rows.');
    lines.push('- Known Netezza environment limit: SQLite/DuckDB -> Netezza 100k-row loads may be cancelled after approximately 10 seconds; 50k rows passed during the probe.');
    lines.push('');
    lines.push('## Interpretation');
    lines.push('- **Stream (ms)**: time between first and last streaming progress message.');
    lines.push('- **Finalize (ms)**: time from first finalize message to execute completion (external load / CREATE TABLE / COMMIT).');
    lines.push('- **Rows/s**: 100k rows / execute wall time.');
    lines.push('');
    fs.writeFileSync(path.join(__dirname, 'migrationPerf.results.md'), lines.join('\n'), 'utf8');
    console.log(`\nBenchmark results saved to ${path.join(__dirname, 'migrationPerf.results.md')}`);
}

function sqliteSourceRequest(target: { connectionName: string; table: string; appendToExistingTable?: boolean }): MigrationRequest {
    return {
        source: { mode: 'table', connectionName: 'sqlite-src', table: sqliteSourceTable },
        target: { connectionName: target.connectionName, table: target.table, appendToExistingTable: target.appendToExistingTable ?? false },
    };
}

function duckdbSourceRequest(target: { connectionName: string; table: string }): MigrationRequest {
    return {
        source: { mode: 'table', connectionName: 'duckdb-src', database: '', schema: 'main', table: duckdbSourceTable },
        target: { connectionName: target.connectionName, table: target.table, appendToExistingTable: false },
    };
}

afterAll(() => {
    writeResults();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Migration performance benchmark', () => {
    beforeAll(async () => {
        console.log(`Temp dir: ${tempDir}`);
        createSqliteSource(sqliteSourcePath, sqliteSourceTable);
        await createDuckDbSource(duckdbSourcePath, duckdbSourceTable);
        manager.register('sqlite-src', { name: 'sqlite-src', host: '', database: sqliteSourcePath, user: '', password: '', dbType: 'sqlite' });
        manager.register('duckdb-src', { name: 'duckdb-src', host: '', database: duckdbSourcePath, user: '', password: '', dbType: 'duckdb' });
    }, 120000);

    it('SQLite -> SQLite', async () => {
        const dbPath = path.join(tempDir, 'tgt_sqlite_sqlite.db');
        manager.register('sqlite-target', sqliteTargetDetails(dbPath));
        const metrics = await runScenario(
            'SQLite -> SQLite',
            sqliteSourceRequest({ connectionName: 'sqlite-target', table: 'TGT_SQLITE_SQLITE' }),
            'sqlite',
            sqliteTargetDetails(dbPath),
            'TGT_SQLITE_SQLITE',
        );
        allScenarioMetrics.push(metrics);
    }, 120000);

    it('SQLite -> DuckDB', async () => {
        const dbPath = path.join(tempDir, 'tgt_sqlite_duckdb.duckdb');
        manager.register('duckdb-target', duckdbTargetDetails(dbPath));
        const metrics = await runScenario(
            'SQLite -> DuckDB',
            sqliteSourceRequest({ connectionName: 'duckdb-target', table: 'jbl_tgt_sqlite_duckdb' }),
            'duckdb',
            duckdbTargetDetails(dbPath),
            'jbl_tgt_sqlite_duckdb',
        );
        allScenarioMetrics.push(metrics);
    }, 120000);

    it('DuckDB -> SQLite', async () => {
        const dbPath = path.join(tempDir, 'tgt_duckdb_sqlite.db');
        manager.register('sqlite-target', sqliteTargetDetails(dbPath));
        const metrics = await runScenario(
            'DuckDB -> SQLite',
            duckdbSourceRequest({ connectionName: 'sqlite-target', table: 'TGT_DUCKDB_SQLITE' }),
            'sqlite',
            sqliteTargetDetails(dbPath),
            'TGT_DUCKDB_SQLITE',
        );
        allScenarioMetrics.push(metrics);
    }, 120000);

    it('DuckDB -> DuckDB', async () => {
        const dbPath = path.join(tempDir, 'tgt_duckdb_duckdb.duckdb');
        manager.register('duckdb-target', duckdbTargetDetails(dbPath));
        const metrics = await runScenario(
            'DuckDB -> DuckDB',
            duckdbSourceRequest({ connectionName: 'duckdb-target', table: 'jbl_tgt_duckdb_duckdb' }),
            'duckdb',
            duckdbTargetDetails(dbPath),
            'jbl_tgt_duckdb_duckdb',
        );
        allScenarioMetrics.push(metrics);
    }, 120000);

    it('SQLite -> SQLite (append to existing table)', async () => {
        const dbPath = path.join(tempDir, 'tgt_sqlite_append.db');
        manager.register('sqlite-target', sqliteTargetDetails(dbPath));

        const connection = getDatabaseDialect('sqlite').createConnection(sqliteTargetDetails(dbPath));
        await connection.connect();
        try {
            await connection.createCommand(
                `CREATE TABLE TGT_SQLITE_APPEND (${TABLE_COLUMNS.join(', ')})`,
            ).execute();
        } finally {
            await connection.close();
        }

        const metrics = await runScenario(
            'SQLite -> SQLite append',
            sqliteSourceRequest({ connectionName: 'sqlite-target', table: 'TGT_SQLITE_APPEND', appendToExistingTable: true }),
            'sqlite',
            sqliteTargetDetails(dbPath),
            'TGT_SQLITE_APPEND',
        );
        allScenarioMetrics.push(metrics);
    }, 120000);

    it('SQLite batch-size sweep', async () => {
        const dbPath = path.join(tempDir, 'sweep_sqlite.db');
        const results = await runBatchSweep(
            'sqlite',
            sqliteBatchImportConfig,
            BATCH_SIZES,
            sqliteTargetDetails(dbPath),
            async (connection, table) => {
                await connection.createCommand(
                    `CREATE TABLE ${table} (${TABLE_COLUMNS.join(', ')})`,
                ).execute();
            },
        );
        sweepResults.push(...results);
    }, 180000);

    it('DuckDB batch-size sweep', async () => {
        const dbPath = path.join(tempDir, 'sweep_duckdb.duckdb');
        const results = await runBatchSweep(
            'duckdb',
            duckdbBatchImportConfig,
            BATCH_SIZES,
            duckdbTargetDetails(dbPath),
            async (connection, table) => {
                await connection.createCommand(
                    `CREATE TABLE ${table} (ID INTEGER NOT NULL PRIMARY KEY, AMOUNT DECIMAL(10,2), NAME VARCHAR(100), DESCRIPTION VARCHAR(200), BIRTH_DATE VARCHAR(10), CREATED_AT VARCHAR(19), SCORE INTEGER, RATING DOUBLE, ACTIVE BOOLEAN, PAYLOAD VARCHAR(100))`,
                ).execute();
            },
        );
        sweepResults.push(...results);
    }, 180000);
});

describeIfNetezza('Migration performance benchmark (live Netezza)', () => {
    let nzConnection: NzConnection;
    let nzSourceTable: string;
    const createdTables: string[] = [];

    beforeAll(async () => {
        nzConnection = new NzConnection({
            host: NZ_CONFIG.host,
            port: NZ_CONFIG.port,
            database: NZ_CONFIG.database,
            user: NZ_CONFIG.user,
            password: NZ_CONFIG.password,
        });
        await nzConnection.connect();

        nzSourceTable = `JBL_PERF_SRC_${Date.now()}`.toUpperCase();
        console.log(`Creating live Netezza source table ${NZ_SCHEMA}.${nzSourceTable} (${ROW_COUNT.toLocaleString()} rows)...`);
        const setupStart = performance.now();
        await createNetezzaSourceTable(nzConnection, nzSourceTable);
        console.log(`Netezza source setup: ${((performance.now() - setupStart) / 1000).toFixed(1)}s`);
        createdTables.push(`${NZ_SCHEMA}.${nzSourceTable}`);

        manager.register('nz-src', buildNetezzaDetails('nz-src', NZ_SCHEMA));
    }, 600000);

    afterAll(async () => {
        for (const table of createdTables) {
            try {
                await nzConnection.createCommand(`DROP TABLE ${table}`).execute();
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

    function nzSourceRequest(target: { connectionName: string; table: string }): MigrationRequest {
        return {
            source: { mode: 'table', connectionName: 'nz-src', database: NZ_CONFIG.database, schema: NZ_SCHEMA, table: nzSourceTable },
            target: { connectionName: target.connectionName, database: NZ_CONFIG.database, schema: NZ_SCHEMA, table: target.table, appendToExistingTable: false },
        };
    }

    function nzTargetDetails(name: string): ConnectionDetails {
        return buildNetezzaDetails(name, NZ_SCHEMA);
    }

    it('Netezza -> Netezza (external table stream)', async () => {
        const targetTable = `JBL_PERF_TGT_NZNZ_${Date.now()}`.toUpperCase();
        manager.register('nz-target', nzTargetDetails('nz-target'));
        const metrics = await runScenario(
            'Netezza -> Netezza',
            nzSourceRequest({ connectionName: 'nz-target', table: targetTable }),
            'netezza',
            nzTargetDetails('nz-target'),
            `${NZ_SCHEMA}.${targetTable}`,
        );
        createdTables.push(`${NZ_SCHEMA}.${targetTable}`);
        allScenarioMetrics.push(metrics);
    }, 600000);

    it('Netezza -> SQLite', async () => {
        const dbPath = path.join(tempDir, 'tgt_nz_sqlite.db');
        manager.register('sqlite-target', sqliteTargetDetails(dbPath));
        const targetTable = `JBL_PERF_TGT_NZSQL_${Date.now()}`.toLowerCase();
        const request: MigrationRequest = {
            source: { mode: 'table', connectionName: 'nz-src', database: NZ_CONFIG.database, schema: NZ_SCHEMA, table: nzSourceTable },
            target: { connectionName: 'sqlite-target', table: targetTable, appendToExistingTable: false },
        };
        const metrics = await runScenario(
            'Netezza -> SQLite',
            request,
            'sqlite',
            sqliteTargetDetails(dbPath),
            targetTable,
        );
        allScenarioMetrics.push(metrics);
    }, 600000);

    it('Netezza -> DuckDB', async () => {
        const dbPath = path.join(tempDir, 'tgt_nz_duckdb.duckdb');
        manager.register('duckdb-target', duckdbTargetDetails(dbPath));
        const targetTable = `jbl_perf_tgt_nzduck_${Date.now()}`.toLowerCase();
        const request: MigrationRequest = {
            source: { mode: 'table', connectionName: 'nz-src', database: NZ_CONFIG.database, schema: NZ_SCHEMA, table: nzSourceTable },
            target: { connectionName: 'duckdb-target', table: targetTable, appendToExistingTable: false },
        };
        const metrics = await runScenario(
            'Netezza -> DuckDB',
            request,
            'duckdb',
            duckdbTargetDetails(dbPath),
            targetTable,
        );
        allScenarioMetrics.push(metrics);
    }, 600000);

    it('SQLite -> Netezza', async () => {
        const targetTable = `JBL_PERF_TGT_SQLNZ_${Date.now()}`.toUpperCase();
        manager.register('nz-target', nzTargetDetails('nz-target'));
        const metrics = await runScenario(
            'SQLite -> Netezza',
            sqliteSourceRequest({ connectionName: 'nz-target', table: targetTable }),
            'netezza',
            nzTargetDetails('nz-target'),
            `${NZ_SCHEMA}.${targetTable}`,
            { allowServerLoadLimitFailure: true },
        );
        createdTables.push(`${NZ_SCHEMA}.${targetTable}`);
        allScenarioMetrics.push(metrics);
    }, 600000);

    it('DuckDB -> Netezza', async () => {
        const targetTable = `JBL_PERF_TGT_DUCKNZ_${Date.now()}`.toUpperCase();
        manager.register('nz-target', nzTargetDetails('nz-target'));
        const metrics = await runScenario(
            'DuckDB -> Netezza',
            duckdbSourceRequest({ connectionName: 'nz-target', table: targetTable }),
            'netezza',
            nzTargetDetails('nz-target'),
            `${NZ_SCHEMA}.${targetTable}`,
            { allowServerLoadLimitFailure: true },
        );
        createdTables.push(`${NZ_SCHEMA}.${targetTable}`);
        allScenarioMetrics.push(metrics);
    }, 600000);

    it('Netezza stream batch-size sweep', async () => {
        for (const batchSize of NZ_STREAM_BATCH_SIZES) {
            const targetTable = `JBL_PERF_STREAM_${batchSize}_${Date.now()}`.toUpperCase();
            manager.register('nz-target', nzTargetDetails('nz-target'));
            const metrics = await runScenario(
                `Netezza -> Netezza (stream batch ${batchSize.toLocaleString()})`,
                nzSourceRequest({ connectionName: 'nz-target', table: targetTable }),
                'netezza',
                nzTargetDetails('nz-target'),
                `${NZ_SCHEMA}.${targetTable}`,
                { streamBatchSize: batchSize },
            );
            createdTables.push(`${NZ_SCHEMA}.${targetTable}`);
            allScenarioMetrics.push(metrics);
            sweepResults.push({
                kind: 'netezza-stream',
                batchSize,
                durationMs: metrics.executeMs,
                rowsPerSec: metrics.rowsPerSec,
                rowsInserted: metrics.rowsInserted,
            });
        }
    }, 600000);
});
