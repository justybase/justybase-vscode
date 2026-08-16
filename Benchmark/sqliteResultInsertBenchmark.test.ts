/**
 * SQLite result-store insert throughput benchmark.
 *
 * Compares insert strategies relevant to disk-backed query results:
 * - autocommit (no explicit transaction) vs batched transactions
 * - default SQLite settings vs bulk-insert PRAGMA profile
 * - batch sizes and redundant secondary index cost
 *
 * Run:
 *   npx jest --config Benchmark/jest.config.js --runInBand Benchmark/sqliteResultInsertBenchmark.test.ts
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ColumnDefinition } from '../src/types';
import { loadNodeSqliteModule } from '../src/core/resultDataProvider/sqliteModuleLoader';
import { mapColumnTypeToSqlite, sqliteColumnName } from '../src/core/resultDataProvider/netezzaToSqliteType';

function isNodeSqliteAvailable(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

const describeIfSqlite = isNodeSqliteAvailable() ? describe : describe.skip;

type DatabaseSync = import('node:sqlite').DatabaseSync;

interface InsertProfile {
    name: string;
    pragmas: string[];
    useTransaction: boolean;
    beginSql: string;
    extraRowidIndex: boolean;
}

interface BenchResult {
    profile: string;
    rowCount: number;
    batchSize: number;
    durationMs: number;
    rowsPerSec: number;
    dbBytes: number;
}

const RESULT_COLUMNS: ColumnDefinition[] = [
    { name: 'DATEKEY', type: 'INTEGER' },
    { name: 'ACCOUNT_ID', type: 'INTEGER' },
    { name: 'DESCRIPTION', type: 'VARCHAR' },
    { name: 'AMOUNT', type: 'NUMERIC(18,4)' },
    { name: 'STATUS', type: 'VARCHAR' },
];

function buildSyntheticRows(count: number): unknown[][] {
    const rows = new Array<unknown[]>(count);
    for (let i = 0; i < count; i++) {
        rows[i] = [
            20_260_101 + (i % 365),
            i % 50_000,
            `Transaction ${i} — sample label`,
            (i % 10_000) * 1.2345,
            i % 3 === 0 ? 'OPEN' : 'CLOSED',
        ];
    }
    return rows;
}

function createSchema(database: DatabaseSync, columns: ColumnDefinition[], extraRowidIndex: boolean): string {
    const colDefs = columns.map((col, index) =>
        `"${sqliteColumnName(index)}" ${mapColumnTypeToSqlite(col.type)}`
    );
    const colNames = columns.map((_col, index) => `"${sqliteColumnName(index)}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');

    database.exec(`
        CREATE TABLE result_rows (
            _rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            ${colDefs.join(',\n            ')}
        );
        ${extraRowidIndex ? 'CREATE INDEX idx_result_rows_rowid ON result_rows(_rowid);' : ''}
    `);

    return `INSERT INTO result_rows (${colNames}) VALUES (${placeholders})`;
}

function deleteDbArtifacts(dbPath: string): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const filePath = `${dbPath}${suffix}`;
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch {
            // ignore
        }
    }
}

function measureDbBytes(dbPath: string): number {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
        const filePath = `${dbPath}${suffix}`;
        if (fs.existsSync(filePath)) {
            total += fs.statSync(filePath).size;
        }
    }
    return total;
}

function runInsertBenchmark(
    profile: InsertProfile,
    rows: unknown[][],
    batchSize: number,
): BenchResult {
    const { DatabaseSync } = loadNodeSqliteModule();
    const dbPath = path.join(os.tmpdir(), `justybase-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const database = new DatabaseSync(dbPath);

    for (const pragma of profile.pragmas) {
        database.exec(pragma);
    }

    const insertSql = createSchema(database, RESULT_COLUMNS, profile.extraRowidIndex);
    const insert = database.prepare(insertSql);
    const columnCount = RESULT_COLUMNS.length;

    const started = performance.now();

    if (!profile.useTransaction) {
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const row = rows[rowIndex] ?? [];
            const values = new Array<unknown>(columnCount);
            for (let colIndex = 0; colIndex < columnCount; colIndex++) {
                values[colIndex] = row[colIndex] ?? null;
            }
            insert.run(...(values as import('node:sqlite').SQLInputValue[]));
        }
    } else {
        for (let offset = 0; offset < rows.length; offset += batchSize) {
            const end = Math.min(offset + batchSize, rows.length);
            database.exec(profile.beginSql);
            try {
                for (let rowIndex = offset; rowIndex < end; rowIndex++) {
                    const row = rows[rowIndex] ?? [];
                    const values = new Array<unknown>(columnCount);
                    for (let colIndex = 0; colIndex < columnCount; colIndex++) {
                        values[colIndex] = row[colIndex] ?? null;
                    }
                    insert.run(...(values as import('node:sqlite').SQLInputValue[]));
                }
                database.exec('COMMIT');
            } catch (error) {
                try {
                    database.exec('ROLLBACK');
                } catch {
                    // ignore
                }
                throw error;
            }
        }
    }

    const durationMs = performance.now() - started;
    const dbBytes = measureDbBytes(dbPath);

    database.close();
    deleteDbArtifacts(dbPath);

    return {
        profile: profile.name,
        rowCount: rows.length,
        batchSize,
        durationMs,
        rowsPerSec: rows.length / (durationMs / 1000),
        dbBytes,
    };
}

function formatResult(result: BenchResult): string {
    return [
        `  ${result.profile}`,
        `    rows=${result.rowCount.toLocaleString()} batch=${result.batchSize.toLocaleString()}`,
        `    ${result.durationMs.toFixed(0)} ms (${Math.round(result.rowsPerSec).toLocaleString()} rows/s)`,
        `    on-disk=${(result.dbBytes / (1024 * 1024)).toFixed(1)} MB`,
    ].join('\n');
}

const BULK_INSERT_PRAGMAS = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = OFF',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA cache_size = -131072',
    'PRAGMA locking_mode = EXCLUSIVE',
];

describeIfSqlite('SQLite result insert benchmark', () => {
    const results: BenchResult[] = [];
    const rowCounts = [100_000, 500_000];

    afterAll(() => {
        if (results.length === 0) {
            return;
        }

        const lines = [
            '# SQLite Result Store Insert Benchmark',
            '',
            `Date: ${new Date().toISOString()}`,
            `Node: ${process.version}`,
            `Columns: ${RESULT_COLUMNS.length} (${RESULT_COLUMNS.map((c) => c.name).join(', ')})`,
            '',
            '## Results',
            '',
            ...results.map((result) => formatResult(result)),
            '',
            '## Notes',
            '- Temp disposable DB files in os.tmpdir(); throughput prioritized over crash durability.',
            '- Production profile: bulk PRAGMA + batched BEGIN IMMEDIATE/COMMIT, no redundant _rowid index.',
            '',
        ];

        const outputPath = path.join(__dirname, 'sqliteInsert.results.md');
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
        console.log('\n' + lines.join('\n'));
    });

    const profiles: InsertProfile[] = [
        {
            name: 'autocommit (no transaction)',
            pragmas: [],
            useTransaction: false,
            beginSql: 'BEGIN',
            extraRowidIndex: true,
        },
        {
            name: 'default + BEGIN/COMMIT batches',
            pragmas: [],
            useTransaction: true,
            beginSql: 'BEGIN',
            extraRowidIndex: true,
        },
        {
            name: 'default + BEGIN IMMEDIATE batches',
            pragmas: [],
            useTransaction: true,
            beginSql: 'BEGIN IMMEDIATE',
            extraRowidIndex: true,
        },
        {
            name: 'bulk PRAGMA + BEGIN IMMEDIATE (with extra _rowid index)',
            pragmas: BULK_INSERT_PRAGMAS,
            useTransaction: true,
            beginSql: 'BEGIN IMMEDIATE',
            extraRowidIndex: true,
        },
        {
            name: 'bulk PRAGMA + BEGIN IMMEDIATE (no extra index)',
            pragmas: BULK_INSERT_PRAGMAS,
            useTransaction: true,
            beginSql: 'BEGIN IMMEDIATE',
            extraRowidIndex: false,
        },
    ];

    for (const rowCount of rowCounts) {
        it(`measures insert throughput for ${rowCount.toLocaleString()} rows`, () => {
            const rows = buildSyntheticRows(rowCount);
            const batchSize = 50_000;

            for (const profile of profiles) {
                const result = runInsertBenchmark(profile, rows, batchSize);
                results.push(result);
            }

            const baseline = results.find((r) =>
                r.rowCount === rowCount && r.profile === 'default + BEGIN/COMMIT batches'
            );
            const optimized = results.find((r) =>
                r.rowCount === rowCount && r.profile === 'bulk PRAGMA + BEGIN IMMEDIATE (no extra index)'
            );

            expect(baseline).toBeDefined();
            expect(optimized).toBeDefined();
            if (baseline && optimized) {
                const speedup = optimized.rowsPerSec / baseline.rowsPerSec;
                console.log(
                    `\n${rowCount.toLocaleString()} rows: optimized ${speedup.toFixed(2)}x vs default batched tx`
                );
                expect(optimized.rowsPerSec).toBeGreaterThan(baseline.rowsPerSec * 1.5);
            }
        }, 120_000);
    }
});
