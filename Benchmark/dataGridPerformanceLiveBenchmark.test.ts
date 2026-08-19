/**
 * Optional live Netezza import benchmark.
 *
 * It is intentionally a separate Jest entry point. A missing configuration is
 * a normal SKIP, not a failed connection attempt. Every sample owns a unique
 * table and drops it in finally, including failed imports.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importDataToNetezzaAdvanced } from '../src/import/dataImporter';
import { createConnectedDatabaseConnectionFromDetails } from '../src/core/connectionFactory';
import type { ConnectionDetails } from '../src/types';
import {
    buildDataGridDataset,
    writeDatasetCsv,
} from './dataGridPerformance/data';
import {
    createBenchmarkEnvironment,
    createEmptyBenchmarkRecord,
    type DataGridBenchmarkRecord,
} from './dataGridPerformance/contract';
import { calculateTimingStats } from './dataGridPerformance/stats';
import { writeDataGridBenchmarkReport } from './dataGridPerformance/report';

const liveReportOptions = {
    jsonPath: path.join(__dirname, 'data-grid-live.v1.results.json'),
    markdownPath: path.join(__dirname, 'data-grid-live.v1.results.md'),
};

const configured = Boolean(
    process.env.NZ_DEV_HOST
    && process.env.NZ_DEV_PORT
    && process.env.NZ_DEV_DATABASE
    && process.env.NZ_DEV_USER
    && process.env.NZ_DEV_PASSWORD,
);
const environment = createBenchmarkEnvironment('node', { workerCount: 1 });
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-data-grid-live-'));
const records: DataGridBenchmarkRecord[] = [];

function liveDetails(): ConnectionDetails {
    return {
        name: 'data-grid-live-benchmark',
        host: process.env.NZ_DEV_HOST ?? '',
        port: Number(process.env.NZ_DEV_PORT ?? 5480),
        database: process.env.NZ_DEV_DATABASE ?? '',
        user: process.env.NZ_DEV_USER ?? '',
        password: process.env.NZ_DEV_PASSWORD,
        dbType: 'netezza',
        schema: process.env.NZ_DEV_SCHEMA ?? 'ADMIN',
    };
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

async function countRows(details: ConnectionDetails, tableName: string): Promise<number> {
    const connection = await createConnectedDatabaseConnectionFromDetails(details);
    try {
        const reader = await connection.createCommand(`SELECT COUNT(*) FROM ${tableName}`).executeReader();
        try {
            if (!await reader.read()) return -1;
            return Number(reader.getValue(0));
        } finally {
            await reader.close();
        }
    } finally {
        await connection.close();
    }
}

async function dropTable(details: ConnectionDetails, tableName: string): Promise<void> {
    try {
        const connection = await createConnectedDatabaseConnectionFromDetails(details);
        try {
            await connection.createCommand(`DROP TABLE ${tableName}`).execute();
        } finally {
            await connection.close();
        }
    } catch {
        // A failed CREATE/import can leave no table. Cleanup is best effort.
    }
}

async function runLiveSample(
    filePath: string,
    details: ConnectionDetails,
    sampleIndex: number,
    expectedRows: number,
): Promise<{ durationMs: number; actualRows: number }> {
    const schema = quoteIdentifier(details.schema ?? process.env.NZ_DEV_SCHEMA ?? 'ADMIN');
    const table = `JBL_DG_PERF_${process.pid}_${Date.now()}_${sampleIndex}`.replace(/[^A-Za-z0-9_]/g, '_');
    const tableName = `${schema}.${quoteIdentifier(table)}`;
    const startedAt = performance.now();
    try {
        const result = await importDataToNetezzaAdvanced(filePath, tableName, details, undefined, 3600);
        if (!result.success) {
            throw new Error(result.message);
        }
        const actualRows = await countRows(details, tableName);
        if (actualRows !== expectedRows) {
            throw new Error(`Netezza import count mismatch: expected ${expectedRows}, got ${actualRows}.`);
        }
        return { durationMs: performance.now() - startedAt, actualRows };
    } finally {
        await dropTable(details, tableName);
    }
}

describe('Data Grid Performance — live Netezza', () => {
    afterAll(() => {
        try {
            writeDataGridBenchmarkReport(records, environment, liveReportOptions);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('measures file → import → COUNT(*) with guaranteed cleanup', async () => {
        const dataset = buildDataGridDataset('small');
        const filePath = path.join(tempDir, 'small.csv');
        const inputBytes = writeDatasetCsv(dataset, filePath);

        if (!configured) {
            records.push(createEmptyBenchmarkRecord({
                operation: 'import',
                stage: 'live_file_import_count',
                caseId: 'small/csv/netezza',
                rowCount: dataset.rowCount,
                columnCount: dataset.columnCount,
                gridMode: 'inline',
                format: 'csv',
                inputBytes,
                notes: ['Set NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER, and NZ_DEV_PASSWORD to enable.'],
            }, environment, 'SKIP'));
            return;
        }

        const details = liveDetails();
        const warmups = 2;
        const samples = Number(process.env.DATA_GRID_PERF_LIVE_SAMPLES ?? 3);
        for (let index = 0; index < warmups; index += 1) {
            await runLiveSample(filePath, details, index, dataset.rowCount);
        }
        const sampleMs: number[] = [];
        let actualRows = 0;
        for (let index = 0; index < samples; index += 1) {
            const sample = await runLiveSample(filePath, details, warmups + index, dataset.rowCount);
            sampleMs.push(sample.durationMs);
            actualRows = sample.actualRows;
        }
        const timing = calculateTimingStats(sampleMs);
        const seconds = timing.medianMs / 1000;
        records.push({
            ...createEmptyBenchmarkRecord({
                operation: 'import',
                stage: 'live_file_import_count',
                caseId: 'small/csv/netezza',
                rowCount: dataset.rowCount,
                columnCount: dataset.columnCount,
                gridMode: 'inline',
                format: 'csv',
                inputBytes,
            }, environment, 'PASS'),
            ...timing,
            rowsPerSecond: seconds > 0 ? dataset.rowCount / seconds : undefined,
            bytesPerSecond: seconds > 0 ? inputBytes / seconds : undefined,
            validation: {
                ok: actualRows === dataset.rowCount,
                expectedRows: dataset.rowCount,
                actualRows,
                expectedColumns: dataset.columnCount,
                actualColumns: dataset.columnCount,
            },
        });
    }, 900_000);
});
