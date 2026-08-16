/**
 * Phase 4 Dogfooding: Live Netezza Execution Path Validation
 * 
 * Runs all Phase 4 dogfooding scenarios against a live Netezza instance
 * and produces a structured report with execution timings and result shapes.
 * 
 * Usage: NZ_DEV_PASSWORD=password npx jest Benchmark/phase4DogfoodingLive.test.ts --runInBand --verbose
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import { ResultFormatter } from '../src/core/streaming/ResultFormatter';

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || ''
};

interface ScenarioResult {
    scenario: string;
    durationMs: number;
    rowCount: number;
    columnCount: number;
    columns: { name: string; type?: string }[];
    status: 'success' | 'error' | 'cancelled';
    error?: string;
    payloadSizeBucket?: string;
}

function bucketize(bytes: number): string {
    if (bytes === 0) return 'none';
    if (bytes < 1024) return 'xs';
    if (bytes < 50_000) return 's';
    if (bytes < 500_000) return 'm';
    if (bytes < 2_000_000) return 'l';
    return 'xl';
}

async function runScenario(
    connection: NzConnection,
    name: string,
    sql: string,
    expectError = false
): Promise<ScenarioResult> {
    const start = performance.now();
    try {
        const cmd = connection.createCommand(sql);
        const reader = await cmd.executeReader();
        const columns = ResultFormatter.extractColumns(reader);
        let rowCount = 0;
        let totalBytes = 0;

        while (await reader.read()) {
            rowCount++;
            // Estimate payload by reading values
            for (let i = 0; i < reader.fieldCount; i++) {
                const val = reader.getValue(i);
                totalBytes += val === null ? 4 : String(val).length * 2;
            }
        }
        await reader.close();
        const duration = performance.now() - start;

        return {
            scenario: name,
            durationMs: Math.round(duration * 10) / 10,
            rowCount,
            columnCount: columns.length,
            columns,
            status: 'success',
            payloadSizeBucket: bucketize(totalBytes)
        };
    } catch (err: unknown) {
        const duration = performance.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        if (expectError) {
            return {
                scenario: name,
                durationMs: Math.round(duration * 10) / 10,
                rowCount: 0,
                columnCount: 0,
                columns: [],
                status: 'error',
                error: msg.slice(0, 120)
            };
        }
        throw err;
    }
}

describeIfDb('Phase 4 Dogfooding – Live Netezza', () => {
    let connection: NzConnection;
    const results: ScenarioResult[] = [];

    beforeAll(async () => {
        connection = new NzConnection({
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: DB_CONFIG.database,
            user: DB_CONFIG.user,
            password: DB_CONFIG.password
        });
        await connection.connect();
        console.log(`Connected to ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
    }, 30000);

    afterAll(async () => {
        if (connection) {
            connection.close();
        }

        // Print structured report
        console.log('\n' + '='.repeat(80));
        console.log('PHASE 4 DOGFOODING REPORT');
        console.log('='.repeat(80));
        console.log(`Date: ${new Date().toISOString()}`);
        console.log(`Database: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
        console.log(`Total scenarios: ${results.length}`);
        console.log('');
        console.log('| Scenario | Status | Duration (ms) | Rows | Columns | Payload | Error |');
        console.log('| --- | --- | ---: | ---: | ---: | --- | --- |');
        for (const r of results) {
            console.log(
                `| ${r.scenario} | ${r.status} | ${r.durationMs} | ${r.rowCount} | ${r.columnCount} | ${r.payloadSizeBucket || '-'} | ${r.error || '-'} |`
            );
        }
        console.log('');

        // Summary stats
        const successResults = results.filter(r => r.status === 'success');
        if (successResults.length > 0) {
            const durations = successResults.map(r => r.durationMs).sort((a, b) => a - b);
            const p50 = durations[Math.floor(durations.length * 0.5)];
            const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
            console.log(`Successful scenarios: ${successResults.length}`);
            console.log(`P50 execution: ${p50} ms`);
            console.log(`P95 execution: ${p95} ms`);
            console.log(`Max execution: ${Math.max(...durations)} ms`);
        }
        console.log('='.repeat(80));
    });

    // ── SCENARIO 1: Zero-row SELECT ──────────────────────────────────────
    itIfDb('Scenario 1: zero-row SELECT preserves column metadata', async () => {
        const r = await runScenario(connection, 'zero-row SELECT',
            `SELECT 'zero' AS scenario, 1 AS col_a, 'text' AS col_b, CURRENT_TIMESTAMP AS col_ts
             FROM _V_DATABASE WHERE 1 = 0`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.rowCount).toBe(0);
        expect(r.columnCount).toBe(4);
        expect(r.columns.map(c => c.name)).toEqual(['SCENARIO', 'COL_A', 'COL_B', 'COL_TS']);
    });

    // ── SCENARIO 2: Single-row SELECT ────────────────────────────────────
    itIfDb('Scenario 2: single-row SELECT renders correctly', async () => {
        const r = await runScenario(connection, 'single-row SELECT',
            `SELECT 'single_row' AS scenario, 42 AS numeric_col, 'hello' AS text_col, CURRENT_TIMESTAMP AS ts_col
             FROM _V_DATABASE LIMIT 1`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.rowCount).toBe(1);
        expect(r.columnCount).toBe(4);
    });

    // ── SCENARIO 3: Medium result (~1000 rows) ──────────────────────────
    itIfDb('Scenario 3: medium result set (up to ~1000 rows)', async () => {
        const r = await runScenario(connection, 'medium ~1k rows',
            `SELECT *
            FROM JUST_DATA..DIMACCOUNT
            LIMIT 1000`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.rowCount).toBeGreaterThan(0);
        expect(r.rowCount).toBeLessThanOrEqual(1000);
    });

    // ── SCENARIO 4: Large result (~5000 rows) ───────────────────────────
    itIfDb('Scenario 4: large result set (up to ~5000 rows)', async () => {
        const r = await runScenario(connection, 'large ~5k rows',
            `SELECT
                DATEKEY,
                FULLDATEALTERNATEKEY,
                DAYNUMBEROFWEEK,
                ENGLISHDAYNAMEOFWEEK,
                DAYNUMBEROFMONTH,
                CALENDARYEAR
            FROM JUST_DATA..DIMDATE
            LIMIT 5000`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.rowCount).toBeGreaterThan(0);
        expect(r.rowCount).toBeLessThanOrEqual(5000);
    }, 30000);

    // ── SCENARIO 5: Syntax error ─────────────────────────────────────────
    itIfDb('Scenario 5: syntax error produces error result', async () => {
        const r = await runScenario(connection, 'syntax error',
            'SELECTX 1 AS this_should_fail',
            true
        );
        results.push(r);
        expect(r.status).toBe('error');
        expect(r.error).toBeDefined();
    });

    // ── SCENARIO 6: Runtime error (non-existent table) ──────────────────
    itIfDb('Scenario 6: runtime error from non-existent table', async () => {
        const r = await runScenario(connection, 'runtime error (bad table)',
            'SELECT * FROM _NONEXISTENT_TABLE_P4_XYZ',
            true
        );
        results.push(r);
        expect(r.status).toBe('error');
        expect(r.error).toBeDefined();
    });

    // ── SCENARIO 7: Mixed type columns (alignment check) ────────────────
    itIfDb('Scenario 7: mixed type columns for alignment validation', async () => {
        const r = await runScenario(connection, 'mixed types (alignment)',
            `SELECT
                'left-aligned' AS varchar_col,
                12345 AS integer_col,
                123.456 AS numeric_col,
                CURRENT_DATE AS date_col,
                CURRENT_TIMESTAMP AS timestamp_col,
                TRUE AS bool_col
            FROM _V_DATABASE LIMIT 1`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.columnCount).toBe(6);

        // Verify column types are reported
        const types = r.columns.map(c => c.type);
        expect(types.length).toBe(6);
        for (const t of types) {
            expect(t).toBeDefined();
            expect(t!.length).toBeGreaterThan(0);
        }
    });

    // ── SCENARIO 8: NVARCHAR types (should NOT right-align) ─────────────
    itIfDb('Scenario 8: NVARCHAR types preserve text metadata', async () => {
        const r = await runScenario(connection, 'NVARCHAR metadata',
            `SELECT
                'AA'::VARCHAR(32) AS VARCHAR_COL,
                'BB'::NVARCHAR(32) AS NVARCHAR_COL,
                'CC'::NCHAR(8) AS NCHAR_COL
            FROM _V_DATABASE LIMIT 1`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.columns).toEqual([
            { name: 'VARCHAR_COL', type: 'VARCHAR(32)' },
            { name: 'NVARCHAR_COL', type: 'NVARCHAR(32)' },
            { name: 'NCHAR_COL', type: 'NCHAR(8)' }
        ]);
    });

    // ── SCENARIO 9: Batch-like multi-statement simulation ───────────────
    itIfDb('Scenario 9: multiple sequential queries with different shapes', async () => {
        const r1 = await runScenario(connection, 'batch-1 (small count)',
            `SELECT COUNT(*) AS total FROM _V_RELATION_COLUMN`
        );
        results.push(r1);
        expect(r1.status).toBe('success');
        expect(r1.rowCount).toBe(1);

        const r2 = await runScenario(connection, 'batch-2 (grouped)',
            `SELECT OBJTYPE, COUNT(*) AS cnt FROM _V_OBJ_RELATION GROUP BY OBJTYPE LIMIT 20`
        );
        results.push(r2);
        expect(r2.status).toBe('success');
        expect(r2.rowCount).toBeGreaterThan(0);

        const r3 = await runScenario(connection, 'batch-3 (zero rows)',
            `SELECT 1 AS empty_result FROM _V_DATABASE WHERE 1 = 0`
        );
        results.push(r3);
        expect(r3.status).toBe('success');
        expect(r3.rowCount).toBe(0);
        expect(r3.columnCount).toBe(1);
    });

    // ── SCENARIO 10: DB..TABLE notation ─────────────────────────────────
    itIfDb('Scenario 10: DB..TABLE notation works correctly', async () => {
        const r = await runScenario(connection, 'DB..TABLE notation',
            `SELECT ACCOUNTCODEALTERNATEKEY FROM JUST_DATA..DIMACCOUNT LIMIT 5`
        );
        results.push(r);
        expect(r.status).toBe('success');
        expect(r.rowCount).toBeGreaterThan(0);
    });
});

if (skipTests) {
    console.log('⚠️ Phase 4 dogfooding tests skipped: NZ_DEV_PASSWORD not set');
}
