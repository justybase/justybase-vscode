/**
 * E2E tests: Netezza timestamp/date/time filter format discovery
 *
 * Creates a test table with all temporal column types, inserts known values,
 * then systematically tests which string literal formats Netezza accepts
 * in WHERE clause comparisons. Results feed the fix for the "Bad timestamp
 * external representation" error in databaseFilterSql.ts.
 *
 * Prerequisites:
 *   NZ_DEV_PASSWORD environment variable (falls back to 'password')
 *
 * Run:
 *   NZ_DEV_PASSWORD=password npm run test -- --testPathPatterns="netezzaTimestampFilterFormats"
 */

const skipTests = !process.env.NZ_DEV_PASSWORD;
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import { buildDatabaseFilteredSql } from '../../results/databaseFilterSql';
import type { ColumnDefinition } from '../../types';

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || '192.168.0.144',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password',
};

const TABLE = 'ADMIN.FILTER_FORMAT_TEST';

interface FormatTestCase {
    label: string;
    sql: string;
    expectSuccess: boolean;
}

async function tryExecute(
    connection: NzConnection,
    sql: string,
): Promise<{ ok: boolean; error?: string }> {
    const cmd = connection.createCommand(sql);
    cmd.commandTimeout = 15;
    try {
        if (/^\s*(SELECT|WITH|EXPLAIN|SHOW|SET)\b/i.test(sql)) {
            const reader = await cmd.executeReader();
            await reader.close();
        } else {
            await cmd.executeNonQuery();
        }
        return { ok: true };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err ?? 'unknown');
        return { ok: false, error: msg.substring(0, 500) };
    }
}

async function executeOrFail(
    connection: NzConnection,
    sql: string,
    label: string,
): Promise<void> {
    const result = await tryExecute(connection, sql);
    if (!result.ok) {
        throw new Error(`Setup failed [${label}]: ${result.error}`);
    }
}

describeIfDb('Netezza Temporal Filter Format Discovery', () => {
    let connection: NzConnection;

    beforeAll(async () => {
        if (skipTests) return;

        connection = new NzConnection(DB_CONFIG);
        await connection.connect();

        await executeOrFail(connection, `DROP TABLE ${TABLE} IF EXISTS`, 'DROP');

        await executeOrFail(connection,
            `CREATE TABLE ${TABLE} (ID INT, TS_COL TIMESTAMP, DATE_COL DATE, INT_COL INT, DEC_COL DECIMAL(10,2), FLOAT_COL FLOAT, VARCHAR_COL VARCHAR(100), CHAR_COL CHAR(20))`,
            'CREATE TABLE');

        await executeOrFail(connection,
            `INSERT INTO ${TABLE} VALUES (1, '2005-01-03 00:00:00', '2005-01-03', 42, 123.45, 1.5E+2, 'hello world', 'fixed char    ')`,
            'INSERT row 1');

        await executeOrFail(connection,
            `INSERT INTO ${TABLE} VALUES (2, '2005-01-03 12:00:00', '2005-01-04', 100, 999.99, 2.5E+3, 'goodbye world', 'another char   ')`,
            'INSERT row 2');
    }, 30_000);

    afterAll(async () => {
        if (connection) {
            await tryExecute(connection, `DROP TABLE ${TABLE} IF EXISTS`);
            connection.close();
        }
    });

    describe('TIMESTAMP literal formats', () => {
        const cases: FormatTestCase[] = [
            { label: 'space-separated (canonical)', sql: `SELECT * FROM ${TABLE} WHERE TS_COL = '2005-01-03 00:00:00'`, expectSuccess: true },
            { label: 'ISO 8601 with T separator', sql: `SELECT * FROM ${TABLE} WHERE TS_COL = '2005-01-03T00:00:00.000Z'`, expectSuccess: false },
            { label: 'space-separated with milliseconds', sql: `SELECT * FROM ${TABLE} WHERE TS_COL = '2005-01-03 00:00:00.000'`, expectSuccess: true },
            { label: 'date only (implicit time 00:00:00)', sql: `SELECT * FROM ${TABLE} WHERE TS_COL = '2005-01-03'`, expectSuccess: true },
        ];

        for (const c of cases) {
            itIfDb(`TIMESTAMP — ${c.label}`, async () => {
                const result = await tryExecute(connection, c.sql);
                if (c.expectSuccess) {
                    expect(result.ok).toBe(true);
                } else {
                    expect(result.ok).toBe(false);
                    expect(result.error).toMatch(/Bad timestamp|invalid|cast/i);
                }
            });
        }
    });

    describe('DATE literal formats', () => {
        const cases: FormatTestCase[] = [
            { label: 'date only (YYYY-MM-DD)', sql: `SELECT * FROM ${TABLE} WHERE DATE_COL = '2005-01-03'`, expectSuccess: true },
            { label: 'ISO 8601 with T', sql: `SELECT * FROM ${TABLE} WHERE DATE_COL = '2005-01-03T00:00:00.000Z'`, expectSuccess: false },
            { label: 'date with space time', sql: `SELECT * FROM ${TABLE} WHERE DATE_COL = '2005-01-03 00:00:00'`, expectSuccess: true },
        ];

        for (const c of cases) {
            itIfDb(`DATE — ${c.label}`, async () => {
                const result = await tryExecute(connection, c.sql);
                if (c.expectSuccess) {
                    expect(result.ok).toBe(true);
                } else {
                    expect(result.ok).toBe(false);
                    expect(result.error).toMatch(/Bad date|Bad timestamp|invalid|cast/i);
                }
            });
        }
    });

    describe('Numeric literal formats', () => {
        const cases: FormatTestCase[] = [
            { label: 'INT plain', sql: `SELECT * FROM ${TABLE} WHERE INT_COL = 42`, expectSuccess: true },
            { label: 'DECIMAL plain', sql: `SELECT * FROM ${TABLE} WHERE DEC_COL = 123.45`, expectSuccess: true },
            { label: 'FLOAT scientific', sql: `SELECT * FROM ${TABLE} WHERE FLOAT_COL = 1.5E+2`, expectSuccess: true },
        ];

        for (const c of cases) {
            itIfDb(`NUMERIC — ${c.label}`, async () => {
                const result = await tryExecute(connection, c.sql);
                if (c.expectSuccess) {
                    expect(result.ok).toBe(true);
                } else {
                    expect(result.ok).toBe(false);
                }
            });
        }
    });

    describe('String literal formats', () => {
        const cases: FormatTestCase[] = [
            { label: 'plain string', sql: `SELECT * FROM ${TABLE} WHERE VARCHAR_COL = 'hello world'`, expectSuccess: true },
            { label: 'escaped single quotes', sql: `SELECT * FROM ${TABLE} WHERE VARCHAR_COL = 'it''s a test'`, expectSuccess: true },
            { label: 'LIKE with pattern', sql: `SELECT * FROM ${TABLE} WHERE VARCHAR_COL LIKE '%world%'`, expectSuccess: true },
        ];

        for (const c of cases) {
            itIfDb(`STRING — ${c.label}`, async () => {
                const result = await tryExecute(connection, c.sql);
                if (c.expectSuccess) {
                    expect(result.ok).toBe(true);
                } else {
                    expect(result.ok).toBe(false);
                }
            });
        }
    });

    describe('Comparison operators on temporal columns', () => {
        itIfDb('TIMESTAMP BETWEEN with space-separated literals', async () => {
            const result = await tryExecute(connection,
                `SELECT * FROM ${TABLE} WHERE TS_COL BETWEEN '2005-01-03 00:00:00' AND '2005-01-03 12:00:00'`);
            expect(result.ok).toBe(true);
        });

        itIfDb('TIMESTAMP > with space-separated literal', async () => {
            const result = await tryExecute(connection,
                `SELECT * FROM ${TABLE} WHERE TS_COL > '2005-01-03 00:00:00'`);
            expect(result.ok).toBe(true);
        });

        itIfDb('TIMESTAMP < with space-separated literal', async () => {
            const result = await tryExecute(connection,
                `SELECT * FROM ${TABLE} WHERE TS_COL < '2005-01-03 12:00:00'`);
            expect(result.ok).toBe(true);
        });

        itIfDb('DATE BETWEEN', async () => {
            const result = await tryExecute(connection,
                `SELECT * FROM ${TABLE} WHERE DATE_COL BETWEEN '2005-01-03' AND '2005-01-04'`);
            expect(result.ok).toBe(true);
        });

        itIfDb('TIMESTAMP IS NULL', async () => {
            const result = await tryExecute(connection,
                `SELECT * FROM ${TABLE} WHERE TS_COL IS NULL`);
            expect(result.ok).toBe(true);
        });

        itIfDb('TIMESTAMP IS NOT NULL', async () => {
            const result = await tryExecute(connection,
                `SELECT * FROM ${TABLE} WHERE TS_COL IS NOT NULL`);
            expect(result.ok).toBe(true);
        });
    });

    describe('buildDatabaseFilteredSql with temporal columns — live execution', () => {
        const tsColumns: ColumnDefinition[] = [
            { name: 'ID', type: 'INT4' },
            { name: 'TS_COL', type: 'TIMESTAMP' },
            { name: 'DATE_COL', type: 'DATE' },
        ];
        const baseSql = `SELECT ID, TS_COL, DATE_COL FROM ${TABLE} LIMIT 100`;

        itIfDb('VALUES filter on TIMESTAMP column succeeds', async () => {
            const sql = buildDatabaseFilteredSql(baseSql, tsColumns, {
                columnFilters: [{ columnIndex: 1, values: ['2005-01-03T00:00:00.000Z'] }],
            });
            const result = await tryExecute(connection, sql);
            expect(result.ok).toBe(true);
        });

        itIfDb('VALUES filter on DATE column succeeds', async () => {
            const sql = buildDatabaseFilteredSql(baseSql, tsColumns, {
                columnFilters: [{ columnIndex: 2, values: ['2005-01-03T00:00:00.000Z'] }],
            });
            const result = await tryExecute(connection, sql);
            expect(result.ok).toBe(true);
        });

        itIfDb('CONDITIONS greaterThan on TIMESTAMP succeeds', async () => {
            const sql = buildDatabaseFilteredSql(baseSql, tsColumns, {
                columnFilters: [{
                    columnIndex: 1,
                    conditions: [{ type: 'greaterThan', value: '2005-01-03T00:00:00.000Z' }],
                    conditionLogic: 'and',
                }],
            });
            const result = await tryExecute(connection, sql);
            expect(result.ok).toBe(true);
        });

        itIfDb('CONDITIONS between on TIMESTAMP succeeds', async () => {
            const sql = buildDatabaseFilteredSql(baseSql, tsColumns, {
                columnFilters: [{
                    columnIndex: 1,
                    conditions: [{ type: 'between', value: '2005-01-03T00:00:00.000Z', value2: '2005-01-03T12:00:00.000Z' }],
                    conditionLogic: 'and',
                }],
            });
            const result = await tryExecute(connection, sql);
            expect(result.ok).toBe(true);
        });

        itIfDb('CONDITIONS equals on DATE succeeds', async () => {
            const sql = buildDatabaseFilteredSql(baseSql, tsColumns, {
                columnFilters: [{
                    columnIndex: 2,
                    conditions: [{ type: 'equals', value: '2005-01-03T00:00:00.000Z' }],
                    conditionLogic: 'and',
                }],
            });
            const result = await tryExecute(connection, sql);
            expect(result.ok).toBe(true);
        });

        itIfDb('VALUES filter on TIMESTAMP returns correct rows', async () => {
            const sql = buildDatabaseFilteredSql(baseSql, tsColumns, {
                columnFilters: [{ columnIndex: 1, values: ['2005-01-03T00:00:00.000Z'] }],
            });
            const cmd = connection.createCommand(sql);
            const reader = await cmd.executeReader();
            const rows: unknown[][] = [];
            try {
                while (await reader.read()) {
                    rows.push([reader.getValue(0), reader.getValue(1), reader.getValue(2)]);
                }
            } finally {
                await reader.close();
            }
            expect(rows.length).toBe(1);
            expect(rows[0][0]).toBe(1);
        });
    });
});

if (skipTests) {
    console.log('⚠️ Netezza temporal format tests skipped: NZ_DEV_PASSWORD not set');
}
