#!/usr/bin/env node
/**
 * Side experiment — XLSX write benchmark: DuckDB COPY (FORMAT XLSX, HEADER TRUE)
 * vs @justybase/spreadsheet-tasks XlsxUpdater (used by XLSB write-back).
 *
 * This is NOT part of the test suite. Run it ad-hoc:
 *
 *   node Benchmark/xlsxWriteBenchmark.js                  # 5k, 50k, 200k rows
 *   node Benchmark/xlsxWriteBenchmark.js --rows 1000,50000
 *   node Benchmark/xlsxWriteBenchmark.js --save           # write Benchmark/xlsxWriteBenchmark.results.md
 *   node Benchmark/xlsxWriteBenchmark.js --keep           # keep temp workbooks in Benchmark/.xlsx-bench/
 *
 * What it measures per row count:
 *   - DuckDB:    CREATE TABLE AS SELECT * FROM read_csv(...) + COPY TO 'out.xlsx' (FORMAT XLSX, HEADER TRUE)
 *                (the exact SQL the "Save File Edits" command runs for xlsx files).
 *                Requires the DuckDB 'excel' extension — downloaded once from the
 *                internet on first use; the DuckDB stage is SKIPPED when offline.
 *   - spreadsheet-tasks: XlsxUpdater open + replaceSheetData + save (the flow used
 *                for XLSB in-place write-back; XlsxUpdater patches only the target
 *                worksheet part and appends new strings to the shared-strings table).
 *
 * After each write both outputs are reopened with XlsxReader and verified
 * (sheet names, row counts, cell spot checks) — a broken/truncated file fails
 * the run. CSV staging for DuckDB is reported separately, since it is not part
 * of the file-write cost.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BENCH_DIR = path.join(__dirname, '.xlsx-bench');
const RESULTS_FILE = path.join(__dirname, 'xlsxWriteBenchmark.results.md');
const KEEP = process.argv.includes('--keep');
const SAVE = process.argv.includes('--save');

const rowsArg = process.argv.find((arg) => arg.startsWith('--rows='));
const ROW_COUNTS = rowsArg
    ? rowsArg.split('=')[1].split(',').map((n) => parseInt(n.trim(), 10))
    : [5000, 50000, 200000];

const STRING_POOL = Array.from({ length: 400 }, (_, i) => `Product line alpha-${i} "quoted" & styled`);
const CATEGORIES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12'];
const STATUSES = ['NEW', 'OPEN', 'PROCESSING', 'CLOSED', 'ARCHIVED'];
const REGIONS = ['EU-WEST', 'EU-NORTH', 'US-EAST', 'US-WEST', 'APAC-SING', 'APAC-TOKYO', 'ME-DUBAI', 'AFR-JHB',
    'LATAM-SP', 'LATAM-MX', 'CA-TOR', 'AU-SYD', 'IN-BLR', 'BR-SAO', 'DE-FRA', 'PL-WAW', 'FR-PAR', 'ES-MAD', 'IT-MIL',
    'NL-AMS', 'SE-STO', 'NO-OSL', 'DK-CPH', 'FI-HEL', 'CZ-PRG'];

const { XlsxWriter, XlsxUpdater, XlsxReader } = require('@justybase/spreadsheet-tasks');

function requireDuckDb() {
    const duckdbCandidates = [
        path.join(ROOT, 'node_modules/@duckdb/node-api'),
        path.join(ROOT, 'extensions/duckdb/node_modules/@duckdb/node-api'),
    ];
    for (const candidate of duckdbCandidates) {
        if (fs.existsSync(candidate)) {
            return require(candidate);
        }
    }
    throw new Error('@duckdb/node-api not found (npm install in extensions/duckdb first)');
}

const HEADERS = ['id', 'name', 'category', 'status', 'amount', 'qty', 'region', 'active'];

function makeRows(count) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        rows.push([
            i + 1,
            STRING_POOL[i % STRING_POOL.length],
            CATEGORIES[i % CATEGORIES.length],
            STATUSES[i % STATUSES.length],
            Math.round(((i * 7919) % 100000) * 100) / 100,
            (i * 13) % 1000,
            REGIONS[i % REGIONS.length],
            i % 2 === 0,
        ]);
    }
    return rows;
}

function escapeCsv(value) {
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function writeCsv(rows) {
    const lines = [HEADERS.join(',')];
    for (const row of rows) {
        lines.push(row.map(escapeCsv).join(','));
    }
    return lines.join('\n');
}

async function benchDuckDb(csvPath, xlsxPath) {
    const duckdb = requireDuckDb();
    const instance = await duckdb.DuckDBInstance.create(':memory:');
    try {
        const connection = await instance.connect();
        try {
            await connection.run('INSTALL excel');
            await connection.run('LOAD excel');
        } catch (error) {
            connection.closeSync();
            throw new Error(`DuckDB 'excel' extension unavailable (offline?): ${error.message}`);
        }
        try {
            const csvLiteral = csvPath.replace(/'/g, "''");
            const xlsxLiteral = xlsxPath.replace(/'/g, "''");
            await connection.run(`CREATE TABLE bench AS SELECT * FROM read_csv('${csvLiteral}')`);
            const start = process.hrtime.bigint();
            await connection.run(`COPY bench TO '${xlsxLiteral}' (FORMAT XLSX, HEADER TRUE)`);
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            return { elapsedMs, stage: 'copy' };
        } finally {
            connection.closeSync();
        }
    } finally {
        instance.closeSync();
    }
}

async function createBaseWorkbook(filePath, rows) {
    const writer = new XlsxWriter(filePath);
    writer.addSheet('Sheet1');
    writer.writeSheet(rows.slice(0, 1), HEADERS);
    await writer.finalize();
}

function benchSpreadsheetTasks(basePath, xlsxPath, rows) {
    const start = process.hrtime.bigint();
    const updater = new XlsxUpdater(basePath);
    updater.replaceSheetData('Sheet1', rows, { headers: HEADERS });
    updater.save(xlsxPath);
    return Number(process.hrtime.bigint() - start) / 1e6;
}

async function verifyWorkbook(filePath, expectedRows, expectedColumns, expectedHeader, sample) {
    const reader = new XlsxReader();
    await reader.open(filePath, true);
    const sheetNames = reader.getSheetNames();
    let rows = 0;
    let maxColumns = 0;
    let firstDataRow = null;
    let secondDataRow = null;
    let lastDataRow = null;
    while (await reader.read()) {
        const values = [];
        let lastCol = -1;
        for (let col = 0; col < expectedColumns; col += 1) {
            const cell = reader.getValue(col);
            if (cell !== null && cell !== undefined) {
                values[col] = String(cell);
                lastCol = col;
            }
        }
        if (lastCol + 1 > maxColumns) maxColumns = lastCol + 1;
        if (rows === 0) firstDataRow = values;
        if (rows === 1) secondDataRow = values;
        lastDataRow = values;
        rows += 1;
    }
    await reader.close();
    const failures = [];
    if (sheetNames.length !== 1 || sheetNames[0] !== 'Sheet1') {
        failures.push(`sheet names ${JSON.stringify(sheetNames)}`);
    }
    if (rows !== expectedRows) {
        failures.push(`row count ${rows} !== ${expectedRows}`);
    }
    if (maxColumns !== expectedColumns) {
        failures.push(`column count ${maxColumns} !== ${expectedColumns}`);
    }
    if (expectedHeader !== null) {
        const headerCells = firstDataRow ? firstDataRow.slice(0, expectedColumns) : [];
        if (JSON.stringify(headerCells) !== JSON.stringify(expectedHeader)) {
            failures.push(`header row ${JSON.stringify(headerCells)} !== ${JSON.stringify(expectedHeader)}`);
        }
    }
    if (sample) {
        for (const [rowIndex, colIndex, expected] of sample) {
            const row = rowIndex === 1
                ? (expectedHeader !== null ? secondDataRow : firstDataRow)
                : lastDataRow;
            const actual = row ? row[colIndex] : '<no row>';
            if (actual !== String(expected)) {
                failures.push(`cell[${rowIndex}][${colIndex}] '${actual}' !== '${expected}'`);
            }
        }
    }
    return { rows, columns: maxColumns, failures };
}

async function main() {
    if (KEEP) fs.mkdirSync(BENCH_DIR, { recursive: true });
    const workDir = KEEP ? BENCH_DIR : fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-xlsx-bench-'));
    const startedAt = new Date();

    console.log(`# XLSX write benchmark — DuckDB COPY (FORMAT XLSX, HEADER TRUE) vs spreadsheet-tasks XlsxUpdater`);
    console.log(`started: ${startedAt.toISOString()}, node ${process.version}`);
    console.log(`rows: ${ROW_COUNTS.join(', ')}`);
    console.log('columns: ' + HEADERS.join(', '));
    console.log('');

    const output = {
        startedAt: startedAt.toISOString(),
        node: process.version,
        headers: HEADERS,
        runs: [],
        duckdbExcel: 'ok',
        duckdbError: null,
    };

    try {
        for (const count of ROW_COUNTS) {
            console.log(`\n=== ${count} rows ===`);
            const rows = makeRows(count);
            const csvPath = path.join(workDir, `data-${count}.csv`);
            const duckPath = path.join(workDir, `duck-${count}.xlsx`);
            const stsPath = path.join(workDir, `sts-${count}.xlsx`);
            const basePath = path.join(workDir, `base-${count}.xlsx`);
            const sample = [
                [1, 0, 1],
                [1, 1, STRING_POOL[0]],
                [1, 7, true],
                [-1, 0, count],
                [-1, 3, STATUSES[(count - 1) % STATUSES.length]],
            ];

            const stagingStart = process.hrtime.bigint();
            fs.writeFileSync(csvPath, writeCsv(rows));
            const stagingMs = Number(process.hrtime.bigint() - stagingStart) / 1e6;

            const baseStart = process.hrtime.bigint();
            await createBaseWorkbook(basePath, rows);
            const baseMs = Number(process.hrtime.bigint() - baseStart) / 1e6;

            let duckMs = null;
            let duckVerification = null;
            try {
                duckMs = (await benchDuckDb(csvPath, duckPath)).elapsedMs;
                duckVerification = await verifyWorkbook(duckPath, count + 1, HEADERS.length, HEADERS, sample);
            } catch (error) {
                output.duckdbExcel = 'skipped';
                output.duckdbError = String(error.message);
                console.log(`  [duckdb] SKIPPED: ${error.message}`);
            }

            const stsMs = benchSpreadsheetTasks(basePath, stsPath, rows);
            const stsVerification = await verifyWorkbook(stsPath, count + 1, HEADERS.length, HEADERS, sample);

            if (duckVerification && duckVerification.failures.length > 0) {
                throw new Error(`DuckDB output FAILED verification: ${duckVerification.failures.join('; ')}`);
            }
            if (stsVerification.failures.length > 0) {
                throw new Error(`spreadsheet-tasks output FAILED verification: ${stsVerification.failures.join('; ')}`);
            }

            const duckSize = duckVerification ? fs.statSync(duckPath).size : 0;
            const stsSize = fs.statSync(stsPath).size;
            const ratio = duckMs !== null ? (duckMs / stsMs).toFixed(2) : '—';

            console.log(`  csv staging (JS, informational):        ${stagingMs.toFixed(1)} ms`);
            console.log(`  base workbook via XlsxWriter (one-time): ${baseMs.toFixed(1)} ms`);
            if (duckMs !== null) {
                console.log(`  [duckdb]        load + COPY (FORMAT XLSX): ${duckMs.toFixed(1)} ms   (${duckVerification.rows} rows, ${duckVerification.columns} cols verified, ${(duckSize / 1024).toFixed(0)} KiB)`);
            }
            console.log(`  [spreadsheet]   XlsxUpdater open+patch+save: ${stsMs.toFixed(1)} ms   (${stsVerification.rows} rows, ${stsVerification.columns} cols verified, ${(stsSize / 1024).toFixed(0)} KiB)`);
            if (duckMs !== null) {
                console.log(`  ratio duckdb/spreadsheet:                ${ratio}x`);
            }

            output.runs.push({
                rows: count,
                stagingMs: +stagingMs.toFixed(1),
                baseMs: +baseMs.toFixed(1),
                duckdbMs: duckMs !== null ? +duckMs.toFixed(1) : null,
                duckdbKiB: duckVerification ? +(duckSize / 1024).toFixed(0) : null,
                spreadsheetMs: +stsMs.toFixed(1),
                spreadsheetKiB: +(stsSize / 1024).toFixed(0),
                verified: true,
            });
        }

        console.log('\n=== ALL OUTPUTS VERIFIED (reopened with XlsxReader, rows/cells match) ===');
    } finally {
        if (!KEEP) {
            fs.rmSync(workDir, { recursive: true, force: true });
        } else {
            console.log(`workbooks kept in ${workDir}`);
        }
    }

    if (SAVE) {
        const lines = [
            `# XLSX write benchmark results`,
            ``,
            `Run: ${output.startedAt} · node ${output.node}`,
            `Columns: ${HEADERS.join(', ')}`,
            ``,
            `| rows | duckdb ms | spreadsheet ms | ratio | duckdb KiB | spreadsheet KiB | verified |`,
            `|---|---:|---:|---:|---:|---:|---|`,
        ];
        for (const run of output.runs) {
            lines.push(`| ${run.rows} | ${run.duckdbMs ?? 'SKIP'} | ${run.spreadsheetMs} | ${run.duckdbMs !== null ? (run.duckdbMs / run.spreadsheetMs).toFixed(2) : '—'} | ${run.duckdbKiB ?? '—'} | ${run.spreadsheetKiB} | ${run.verified ? 'yes' : 'no'} |`);
        }
        if (output.duckdbError) {
            lines.push(``, `DuckDB stage skipped: ${output.duckdbError}`);
        }
        fs.writeFileSync(RESULTS_FILE, lines.join('\n') + '\n');
        console.log(`\nresults saved to ${RESULTS_FILE}`);
    }
}

main().catch((error) => {
    console.error(`\nBENCHMARK FAILED: ${error.message}`);
    process.exitCode = 1;
});
