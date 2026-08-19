/**
 * Desktop Data Grid / Import Wizard performance benchmark.
 *
 * The fixture is generated before each timed operation. Data generation, input
 * file creation, worker construction for warm runs, and SQLite insertion are
 * deliberately outside the measured sections.
 *
 * Run with:
 *   npm run benchmark:data-grid
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { ReaderFactory } from '@justybase/spreadsheet-tasks';
import { ImportPreviewService } from '../src/import/wizard/ImportPreviewService';
import { ImportValidationService } from '../src/import/wizard/ImportValidationService';
import { getImportWizardAdapter } from '../src/import/wizard/adapters';
import { createTabularDataImporter } from '../src/import/tabularDataImporter';
import type { ConnectionDetails, ResultSet } from '../src/types';
import { exportResultSetToFile } from '../src/export/resultExporter';
import { exportStructuredToXlsb } from '../src/export/xlsbExporter';
import { exportStructuredToXlsx } from '../src/export/xlsxExporter';
import { SqliteResultStore } from '../src/core/resultDataProvider/sqliteResultStore';
import type { DiskQuerySpec } from '../src/core/resultDataProvider/types';
import {
    buildDataGridDataset,
    countDatasetMatches,
    estimateDatasetBytes,
    writeDatasetCsv,
    type DataGridDataset,
} from './dataGridPerformance/data';
import {
    createBenchmarkEnvironment,
    createEmptyBenchmarkRecord,
    type BenchmarkValidation,
    type DataGridBenchmarkRecord,
} from './dataGridPerformance/contract';
import { measureAsync, measureSync, type TimedRun } from './dataGridPerformance/stats';
import { writeDataGridBenchmarkReport } from './dataGridPerformance/report';

const WARMUPS = 2;
const SAMPLES = 8;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-data-grid-perf-'));
const environment = createBenchmarkEnvironment('node', { workerCount: 1 });
const results: DataGridBenchmarkRecord[] = [];
const generatedFiles: string[] = [];

let largeDataset: DataGridDataset;
let importDataset: DataGridDataset;
let importCsvPath: string;
let importCsvBytes = 0;
let exportDatasetFixture: DataGridDataset;

const sqliteConnectionDetails: ConnectionDetails = {
    name: 'data-grid-benchmark',
    host: '',
    database: '',
    user: '',
    password: '',
    dbType: 'sqlite',
};

function validation(
    expectedRows: number,
    actualRows: number,
    expectedColumns?: number,
    actualColumns?: number,
    message?: string,
): BenchmarkValidation {
    const ok = expectedRows === actualRows
        && (expectedColumns === undefined || expectedColumns === actualColumns);
    return {
        ok,
        expectedRows,
        actualRows,
        expectedColumns,
        actualColumns,
        message: message ?? (ok ? undefined : `Expected ${expectedRows} rows/${expectedColumns ?? 'any'} columns, got ${actualRows}/${actualColumns ?? 'unknown'}.`),
    };
}

function addTimedRecord<T>(
    input: Pick<DataGridBenchmarkRecord, 'operation' | 'stage' | 'caseId' | 'rowCount' | 'columnCount' | 'gridMode'>
        & Partial<Pick<DataGridBenchmarkRecord, 'format' | 'inputBytes' | 'notes'>>,
    timing: TimedRun<T>,
    checked: BenchmarkValidation,
    throughputRows = input.rowCount,
    throughputBytes = input.inputBytes,
    outputBytes?: number,
): DataGridBenchmarkRecord {
    const seconds = timing.medianMs / 1000;
    const record: DataGridBenchmarkRecord = {
        ...createEmptyBenchmarkRecord(input, environment, checked.ok ? 'PASS' : 'WARN'),
        ...timing,
        validation: checked,
        rowsPerSecond: seconds > 0 ? throughputRows / seconds : undefined,
        bytesPerSecond: (outputBytes ?? throughputBytes) !== undefined && seconds > 0
            ? (outputBytes ?? throughputBytes)! / seconds
            : undefined,
        outputBytes,
    };
    results.push(record);
    return record;
}

function addSkippedRecord(
    input: Pick<DataGridBenchmarkRecord, 'operation' | 'stage' | 'caseId' | 'rowCount' | 'columnCount' | 'gridMode'>
        & Partial<Pick<DataGridBenchmarkRecord, 'format' | 'inputBytes' | 'notes'>>,
    note: string,
): void {
    results.push(createEmptyBenchmarkRecord({ ...input, notes: [note] }, environment, 'SKIP'));
}

function outputExtension(format: string): string {
    switch (format) {
        case 'csv.gz': return 'csv.gz';
        case 'csv.zst': return 'csv.zst';
        case 'markdown': return 'md';
        default: return format;
    }
}

function resultSetFor(dataset: DataGridDataset): ResultSet {
    return {
        name: `Data Grid ${dataset.profile}`,
        columns: dataset.columns,
        data: dataset.rows,
        sql: 'SELECT * FROM DATA_GRID_PERFORMANCE',
        executionTimestamp: 1,
    };
}

function parseCsvRecords(content: string): string[][] {
    const records: string[][] = [];
    let record: string[] = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (character === '"') {
            if (quoted && content[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === ',' && !quoted) {
            record.push(field);
            field = '';
        } else if ((character === '\n' || character === '\r') && !quoted) {
            if (character === '\r' && content[index + 1] === '\n') {
                index += 1;
            }
            record.push(field);
            field = '';
            if (record.some((value) => value.length > 0) || record.length > 1) {
                records.push(record);
            }
            record = [];
        } else {
            field += character;
        }
    }
    if (field.length > 0 || record.length > 0) {
        record.push(field);
        records.push(record);
    }
    return records;
}

function decodeExportContent(format: string, filePath: string): string {
    const bytes = fs.readFileSync(filePath);
    if (format === 'csv.gz') {
        return gunzipSync(bytes).toString('utf8');
    }
    if (format === 'csv.zst') {
        return zstdDecompressSync(bytes).toString('utf8');
    }
    return bytes.toString('utf8');
}

interface SpreadsheetReader {
    _currentRow: unknown[];
    open(filePath: string): Promise<void>;
    read(): Promise<boolean> | boolean;
    close(): Promise<void>;
    getSheetNames?(): string[];
}

async function readWorkbook(filePath: string): Promise<{ headers: string[]; rows: number; sheets: string[] }> {
    const reader = ReaderFactory.create(filePath) as unknown as SpreadsheetReader;
    await reader.open(filePath);
    const sheets = reader.getSheetNames?.() ?? [];
    let headers: string[] = [];
    let rows = 0;
    try {
        while (await reader.read()) {
            const current = Array.isArray(reader._currentRow) ? reader._currentRow : [];
            if (headers.length === 0) {
                headers = current.map((value) => String(value ?? ''));
            } else {
                rows += 1;
            }
        }
    } finally {
        await reader.close();
    }
    return { headers, rows, sheets };
}

async function validateExportFile(
    format: string,
    filePath: string,
    dataset: DataGridDataset,
): Promise<BenchmarkValidation> {
    if (format === 'xlsx' || format === 'xlsb') {
        const workbook = await readWorkbook(filePath);
        const headers = dataset.columns.map((column) => column.name);
        const headerMatches = JSON.stringify(workbook.headers) === JSON.stringify(headers);
        const hasWorkbookSheet = workbook.sheets.length === 0 || workbook.sheets.includes(`Data Grid ${dataset.profile}`);
        return validation(dataset.rowCount, workbook.rows, dataset.columnCount, workbook.headers.length, headerMatches && hasWorkbookSheet ? undefined : 'Workbook headers or sheet metadata did not match the source dataset.');
    }

    if (format === 'json') {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>;
        const headers = dataset.columns.map((column) => column.name);
        const firstKeys = parsed.length > 0 ? Object.keys(parsed[0]) : headers;
        return validation(dataset.rowCount, parsed.length, dataset.columnCount, firstKeys.length, JSON.stringify(firstKeys) === JSON.stringify(headers) ? undefined : 'JSON keys did not match source headers.');
    }

    const records = parseCsvRecords(decodeExportContent(format, filePath));
    const headers = dataset.columns.map((column) => column.name);
    const actualHeaders = records[0] ?? [];
    const headerMatches = JSON.stringify(actualHeaders) === JSON.stringify(headers);
    return validation(dataset.rowCount, Math.max(0, records.length - 1), dataset.columnCount, actualHeaders.length, headerMatches ? undefined : 'Delimited export headers did not match source headers.');
}

async function exportDataset(format: string, dataset: DataGridDataset, filePath: string): Promise<void> {
    const resultSet = resultSetFor(dataset);
    if (format === 'xlsx') {
        const result = await exportStructuredToXlsx([{
            columns: dataset.columns,
            rows: dataset.rows,
            name: `Data Grid ${dataset.profile}`,
        }], filePath);
        if (!result.success) throw new Error(result.message);
        return;
    }
    if (format === 'xlsb') {
        const result = await exportStructuredToXlsb([{
            columns: dataset.columns,
            rows: dataset.rows,
            name: `Data Grid ${dataset.profile}`,
        }], filePath);
        if (!result.success) throw new Error(result.message);
        return;
    }
    await exportResultSetToFile(resultSet, filePath, {
        format: format as 'csv' | 'csv.gz' | 'csv.zst' | 'json',
    });
}

const SEARCH_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let rows = [];
function valueText(value) { return value === null || value === undefined ? 'NULL' : String(value); }
function search(query) {
  const normalized = String(query || '').toLowerCase();
  if (!normalized) return rows.length;
  let count = 0;
  for (const row of rows) {
    let match = false;
    for (const value of row) {
      if (valueText(value).toLowerCase().includes(normalized)) { match = true; break; }
    }
    if (match) count++;
  }
  return count;
}
parentPort.on('message', message => {
  if (message.command === 'init') { rows = message.rows; parentPort.postMessage({ command: 'ready', rows: rows.length }); }
  if (message.command === 'search') { parentPort.postMessage({ command: 'result', count: search(message.query), seq: message.seq }); }
});
`;

function waitForWorkerMessage<T extends { command: string }>(worker: Worker, command: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const onMessage = (message: T) => {
            if (message.command !== command) return;
            worker.off('message', onMessage);
            worker.off('error', onError);
            resolve(message);
        };
        const onError = (error: Error) => {
            worker.off('message', onMessage);
            reject(error);
        };
        worker.once('error', onError);
        worker.on('message', onMessage);
    });
}

async function createSearchWorker(dataset: DataGridDataset): Promise<Worker> {
    const worker = new Worker(SEARCH_WORKER_SOURCE, { eval: true });
    const ready = waitForWorkerMessage<{ command: string; rows: number }>(worker, 'ready');
    worker.postMessage({ command: 'init', rows: dataset.rows });
    const response = await ready;
    if (response.rows !== dataset.rowCount) {
        await worker.terminate();
        throw new Error(`Search worker loaded ${response.rows} rows instead of ${dataset.rowCount}.`);
    }
    return worker;
}

async function workerSearch(worker: Worker, query: string, seq: number): Promise<number> {
    const response = waitForWorkerMessage<{ command: string; count: number; seq: number }>(worker, 'result');
    worker.postMessage({ command: 'search', query, seq });
    const result = await response;
    if (result.seq !== seq) {
        throw new Error(`Search worker response sequence mismatch: expected ${seq}, got ${result.seq}.`);
    }
    return result.count;
}

async function runColdWorkerSearch(dataset: DataGridDataset, query: string, iteration: number): Promise<number> {
    const worker = await createSearchWorker(dataset);
    try {
        return await workerSearch(worker, query, iteration);
    } finally {
        await worker.terminate();
    }
}

function inlineSearch(dataset: DataGridDataset, query: string): number {
    return countDatasetMatches(dataset, query);
}

function searchCaseId(profile: string, mode: string, queryName: string): string {
    return `${profile}/${mode}/${queryName}`;
}

async function benchmarkSearches(dataset: DataGridDataset): Promise<void> {
    const queryCases: Array<{ name: string; query: string }> = [
        { name: 'start', query: dataset.searchTerms.start },
        { name: 'middle', query: dataset.searchTerms.middle },
        { name: 'missing', query: dataset.searchTerms.missing },
        { name: 'clear', query: '' },
    ];
    const inputBytes = estimateDatasetBytes(dataset);

    for (const queryCase of queryCases) {
        const expected = countDatasetMatches(dataset, queryCase.query);
        const timing = measureSync(
            () => inlineSearch(dataset, queryCase.query),
            { warmups: WARMUPS, samples: SAMPLES },
        );
        addTimedRecord(
            {
                operation: 'search',
                stage: 'inline_scan',
                caseId: searchCaseId(dataset.profile, 'inline', queryCase.name),
                rowCount: dataset.rowCount,
                columnCount: dataset.columnCount,
                gridMode: 'inline',
                inputBytes,
            },
            timing,
            validation(expected, timing.lastValue ?? -1),
        );
    }

    for (const queryCase of queryCases.slice(0, 3)) {
        const expected = countDatasetMatches(dataset, queryCase.query);
        const timing = await measureAsync(
            (iteration) => runColdWorkerSearch(dataset, queryCase.query, iteration),
            { warmups: WARMUPS, samples: SAMPLES },
        );
        addTimedRecord(
            {
                operation: 'search',
                stage: 'worker_cold',
                caseId: searchCaseId(dataset.profile, 'worker', queryCase.name),
                rowCount: dataset.rowCount,
                columnCount: dataset.columnCount,
                gridMode: 'worker',
                inputBytes,
            },
            timing,
            validation(expected, timing.lastValue ?? -1),
        );
    }

    const warmWorker = await createSearchWorker(dataset);
    try {
        for (const queryCase of queryCases.slice(0, 3)) {
            const expected = countDatasetMatches(dataset, queryCase.query);
            const timing = await measureAsync(
                (iteration) => workerSearch(warmWorker, queryCase.query, iteration),
                { warmups: WARMUPS, samples: SAMPLES },
            );
            addTimedRecord(
                {
                    operation: 'search',
                    stage: 'worker_warm',
                    caseId: searchCaseId(dataset.profile, 'worker', queryCase.name),
                    rowCount: dataset.rowCount,
                    columnCount: dataset.columnCount,
                    gridMode: 'worker',
                    inputBytes,
                },
                timing,
                validation(expected, timing.lastValue ?? -1),
            );
        }
    } finally {
        await warmWorker.terminate();
    }
}

async function benchmarkSqliteSearch(dataset: DataGridDataset): Promise<void> {
    const dbPath = path.join(tempDir, `search-${dataset.profile}.db`);
    const store = SqliteResultStore.create(dataset.columns, 10_000, dbPath);
    const sqliteRows = dataset.rows.map((row) => row.map((value, index) =>
        dataset.columns[index]?.type === 'BOOLEAN' && typeof value === 'boolean'
            ? (value ? 1 : 0)
            : value,
    ));
    store.insertRows(sqliteRows);
    store.finalizeBulkInsert();
    try {
        for (const queryCase of [
            { name: 'start', query: dataset.searchTerms.start },
            { name: 'middle', query: dataset.searchTerms.middle },
            { name: 'missing', query: dataset.searchTerms.missing },
            { name: 'clear', query: '' },
        ]) {
            const expected = countDatasetMatches(dataset, queryCase.query);
            const spec: DiskQuerySpec | undefined = queryCase.query ? { globalSearch: queryCase.query } : undefined;
            const timing = measureSync(
                () => {
                    const rows = store.queryRows(spec, { offset: 0, limit: dataset.rowCount });
                    const count = store.countRows(spec);
                    return { count, returned: rows.length };
                },
                { warmups: WARMUPS, samples: SAMPLES },
            );
            const actual = timing.lastValue ?? { count: -1, returned: -1 };
            addTimedRecord(
                {
                    operation: 'search',
                    stage: 'sqlite_query_and_count',
                    caseId: searchCaseId(dataset.profile, 'sqlite', queryCase.name),
                    rowCount: dataset.rowCount,
                    columnCount: dataset.columnCount,
                    gridMode: 'sqlite',
                    inputBytes: estimateDatasetBytes(dataset),
                },
                timing,
                validation(expected, actual.count, undefined, undefined, actual.returned === expected ? undefined : `queryRows returned ${actual.returned} rows while countRows returned ${actual.count}.`),
            );
        }
    } finally {
        store.dispose();
    }
}

describe('Data Grid Performance Benchmark', () => {
    beforeAll(() => {
        largeDataset = buildDataGridDataset('large');
        importDataset = buildDataGridDataset('inline');
        exportDatasetFixture = importDataset;
        importCsvPath = path.join(tempDir, 'inline.csv');
        importCsvBytes = writeDatasetCsv(importDataset, importCsvPath);
        generatedFiles.push(importCsvPath);
    });

    afterAll(() => {
        try {
            writeDataGridBenchmarkReport(results, environment);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('benchmarks import preview, validation, SQL generation, and full stream consumption', async () => {
        const previewService = new ImportPreviewService();
        const validationService = new ImportValidationService();
        const adapter = getImportWizardAdapter('sqlite');
        const timing = await measureAsync(
            async () => {
                const snapshot = await previewService.initialize({
                    filePath: importCsvPath,
                    targetTable: 'DATA_GRID_IMPORT',
                    connectionDetails: sqliteConnectionDetails,
                    previewRowCount: 100,
                    validationSampleSize: 100,
                }, adapter);
                const summary = validationService.validate(
                    snapshot.columns,
                    snapshot.rawPreviewRows,
                    100,
                    adapter,
                );
                const columns = snapshot.columns.map((column) => ({
                    sourceIndex: column.sourceIndex,
                    columnName: column.targetName,
                    dataType: column.selectedType,
                }));
                const plan = adapter.buildExecutionPlan({
                    filePath: importCsvPath,
                    targetTable: 'DATA_GRID_IMPORT',
                    connectionDetails: sqliteConnectionDetails,
                    columns,
                    previewRows: snapshot.rawPreviewRows,
                    detectedDelimiter: snapshot.detectedDelimiter,
                    decimalDelimiter: snapshot.decimalDelimiter,
                    importer: snapshot.importer,
                });
                return {
                    rows: snapshot.importer.getRowsCount(),
                    previewRows: snapshot.rawPreviewRows.length,
                    columns: snapshot.columns.length,
                    hasErrors: summary.hasErrors,
                    validSql: plan.createTableSql.includes('CREATE TABLE') && Boolean(plan.loadSql),
                };
            },
            { warmups: WARMUPS, samples: SAMPLES },
        );
        const last = timing.lastValue ?? { rows: -1, previewRows: -1, columns: -1, hasErrors: true, validSql: false };
        const checked = validation(importDataset.rowCount, last.rows, importDataset.columnCount, last.columns, last.hasErrors || !last.validSql ? 'Preview validation or generated SQL reported an error.' : last.previewRows >= 100 ? undefined : 'Preview returned fewer than 100 rows.');
        addTimedRecord({
            operation: 'import',
            stage: 'preview_validate_sql',
            caseId: 'inline/csv',
            rowCount: importDataset.rowCount,
            columnCount: importDataset.columnCount,
            gridMode: 'inline',
            format: 'csv',
            inputBytes: importCsvBytes,
        }, timing, checked, importDataset.rowCount, importCsvBytes);
        expect(checked.ok).toBe(true);

        const importer = createTabularDataImporter(importCsvPath, 'DATA_GRID_IMPORT', { kind: 'sqlite' });
        await importer.analyzeDataTypes();
        const streamTiming = await measureAsync(
            async () => {
                const stream = await importer.getDelegate().createDataStream();
                let bytes = 0;
                let rows = 0;
                for await (const chunk of stream) {
                    const text = String(chunk);
                    bytes += Buffer.byteLength(text, 'utf8');
                    rows += [...text].filter((character) => character === '\n').length;
                }
                return { bytes, rows };
            },
            { warmups: WARMUPS, samples: SAMPLES },
        );
        const streamResult = streamTiming.lastValue ?? { bytes: -1, rows: -1 };
        const streamValidation = validation(importDataset.rowCount, streamResult.rows, undefined, undefined, streamResult.bytes > 0 ? undefined : 'The import stream was empty.');
        addTimedRecord({
            operation: 'import',
            stage: 'stream_prepare_and_consume',
            caseId: 'inline/csv',
            rowCount: importDataset.rowCount,
            columnCount: importDataset.columnCount,
            gridMode: 'inline',
            format: 'csv',
            inputBytes: importCsvBytes,
        }, streamTiming, streamValidation, importDataset.rowCount, streamResult.bytes);
        expect(streamValidation.ok).toBe(true);
    }, 120_000);

    it('benchmarks CSV, compressed CSV, JSON, XLSX, and XLSB exports', async () => {
        const formats = ['csv', 'csv.gz', 'csv.zst', 'json', 'xlsx', 'xlsb'] as const;
        const inputBytes = estimateDatasetBytes(exportDatasetFixture);
        for (const format of formats) {
            let lastOutputPath = '';
            const timing = await measureAsync(
                async (iteration, warmup) => {
                    const outputPath = path.join(tempDir, `inline-${format}-${warmup ? 'warmup' : 'sample'}-${iteration}.${outputExtension(format)}`);
                    lastOutputPath = outputPath;
                    await exportDataset(format, exportDatasetFixture, outputPath);
                    return fs.statSync(outputPath).size;
                },
                { warmups: WARMUPS, samples: SAMPLES },
            );
            generatedFiles.push(lastOutputPath);
            const outputBytes = timing.lastValue ?? 0;
            const checked = await validateExportFile(format, lastOutputPath, exportDatasetFixture);
            addTimedRecord({
                operation: 'export',
                stage: 'write_and_finalize',
                caseId: `inline/${format}/full`,
                rowCount: exportDatasetFixture.rowCount,
                columnCount: exportDatasetFixture.columnCount,
                gridMode: 'inline',
                format,
                inputBytes,
            }, timing, checked, exportDatasetFixture.rowCount, inputBytes, outputBytes);
            expect(checked.ok).toBe(true);
        }

        for (const futureFormat of ['xml', 'sql', 'markdown', 'parquet', 'xpt']) {
            addSkippedRecord({
                operation: 'export',
                stage: 'registered_future_format',
                caseId: `inline/${futureFormat}/full`,
                rowCount: exportDatasetFixture.rowCount,
                columnCount: exportDatasetFixture.columnCount,
                gridMode: 'inline',
                format: futureFormat,
                inputBytes,
            }, 'Registered for the next data-grid benchmark phase; not part of the reference matrix yet.');
        }
    }, 120_000);

    it('benchmarks inline, worker cold/warm, and SQLite search paths', async () => {
        await benchmarkSearches(largeDataset);
        await benchmarkSqliteSearch(largeDataset);
        for (const profile of ['worker-boundary-19999', 'worker-boundary-20000'] as const) {
            const dataset = buildDataGridDataset(profile);
            const expected = countDatasetMatches(dataset, dataset.searchTerms.middle);
            const mode = dataset.rowCount >= 20_000 ? 'worker' : 'inline';
            if (mode === 'inline') {
                const timing = measureSync(() => inlineSearch(dataset, dataset.searchTerms.middle), { warmups: WARMUPS, samples: SAMPLES });
                addTimedRecord({
                    operation: 'search', stage: 'worker_threshold', caseId: `${profile}/middle`, rowCount: dataset.rowCount, columnCount: dataset.columnCount, gridMode: 'inline', inputBytes: estimateDatasetBytes(dataset),
                }, timing, validation(expected, timing.lastValue ?? -1));
            } else {
                const worker = await createSearchWorker(dataset);
                try {
                    const timing = await measureAsync((iteration) => workerSearch(worker, dataset.searchTerms.middle, iteration), { warmups: WARMUPS, samples: SAMPLES });
                    addTimedRecord({
                        operation: 'search', stage: 'worker_threshold', caseId: `${profile}/middle`, rowCount: dataset.rowCount, columnCount: dataset.columnCount, gridMode: 'worker', inputBytes: estimateDatasetBytes(dataset),
                    }, timing, validation(expected, timing.lastValue ?? -1));
                } finally {
                    await worker.terminate();
                }
            }
        }
    }, 120_000);
});
