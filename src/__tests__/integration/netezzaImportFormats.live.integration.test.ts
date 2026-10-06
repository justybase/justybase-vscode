/**
 * Live Netezza E2E round-trip coverage for locale-formatted number imports.
 *
 * Proves that the file and clipboard importers create the expected Netezza
 * column types and that the written values read back unchanged:
 *   - Polish formats (`123 457`, `123 456,78`, `123 456,78 zł`, `12,8%`,
 *     `-123 456,78`, `(123 456,78)`, `123,5`, `1,23E+05`, `123 456,8 kg`)
 *   - Anglo-Saxon formats (`123,456.78`, `$123,456.78`, `($123,456.78)`,
 *     `£123,456.78`, `£123,457`, `12.75%`, `1.23E+05`, `123,456.8 kg`)
 *   - Currency-marked integers (`123 457 zł`, `£123,457`) infer NUMERIC
 *   - Lone dashes (`-`) load as 0 in numeric columns and stay literal in text columns
 *   - PESEL-valued columns stay text so leading zeros survive the round trip
 *   - The original single-column clipboard sample with surrounding spaces
 *
 * Fixture DDL is required because the suite creates and drops unique tables.
 * Every created table is dropped in `finally`.
 *
 * Required configuration (missing variables are a configuration error, not a
 * silent skip):
 *   NZ_DEV_PASSWORD
 *   NZ_DEV_ALLOW_FIXTURE_DDL=1
 *
 * Optional:
 *   NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER, NZ_DEV_SCHEMA
 *
 * Run:
 *   NZ_DEV_PASSWORD=... NZ_DEV_ALLOW_FIXTURE_DDL=1 \
 *     npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/netezzaImportFormats.live.integration.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import * as vscode from 'vscode';
import { importClipboardDataToNetezza } from '../../import/clipboardImporter';
import { importDataToNetezza } from '../../import/dataImporter';
import type { NzConnection } from '@justybase/netezza-driver';
import {
    buildNetezzaLiveDetails,
    createNetezzaLiveConnection,
    executeNetezza,
    netezzaFixtureEnabled,
    netezzaLiveEnabled,
    readRecordRows,
    uniqueNetezzaName,
} from './netezzaLiveTestHarness';

const configurationError = !netezzaLiveEnabled
    ? 'NZ_DEV_PASSWORD is required for the live locale-import suite.'
    : !netezzaFixtureEnabled
        ? 'NZ_DEV_ALLOW_FIXTURE_DDL=1 is required because this suite creates and drops fixture tables.'
        : undefined;

const sourceSchema = (process.env.NZ_DEV_SCHEMA || 'ADMIN')
    .replace(/[^A-Za-z0-9_$]/g, '_')
    .toUpperCase();

type Verify = (connection: NzConnection, table: string, target: string) => Promise<void>;

async function readColumnTypes(connection: NzConnection, table: string): Promise<Map<string, string>> {
    const rows = await readRecordRows(
        connection,
        `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS `
        + `WHERE TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,
    );
    const types = new Map<string, string>();
    for (const row of rows) {
        types.set(String(row.COLUMN_NAME).toUpperCase(), String(row.DATA_TYPE).toUpperCase());
    }
    return types;
}

function numericColumn<T extends Record<string, unknown>>(rows: T[], column: string): number[] {
    return rows.map(row => Number(String(row[column])));
}

/** Create a unique table, run the import, verify, then always drop and close. */
async function runImportScenario(
    importer: (target: string) => Promise<{ success: boolean; message?: string }>,
    verify: Verify,
): Promise<void> {
    const table = uniqueNetezzaName('JB_IMP_FMT');
    const target = `${sourceSchema}.${table}`;
    const connection = createNetezzaLiveConnection();
    try {
        await connection.connect();
        const result = await importer(target);
        expect(result.success).toBe(true);
        if (!result.success) {
            throw new Error(result.message);
        }
        await verify(connection, table, target);
    } finally {
        await executeNetezza(connection, `DROP TABLE ${target}`).catch(() => undefined);
        await connection.close().catch(() => undefined);
    }
}

async function runFileImportScenario(fileName: string, content: string, verify: Verify): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nz-import-formats-'));
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    try {
        await runImportScenario(
            target => importDataToNetezza(filePath, target, buildNetezzaLiveDetails()),
            verify,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

describe('Live Netezza locale-formatted import round trip', () => {
    if (configurationError) {
        it('fails fast when the live Netezza configuration is missing', () => {
            throw new Error(configurationError);
        });
        return;
    }

    it('round-trips Polish number formats through Netezza', async () => {
        const content = [
            'ID;INTEGER_PL;DECIMAL_PL;PLN_STD;PLN_INT;PERCENT_PL;NEG_MINUS;NEG_UNICODE;NEG_PARENS;THOUSANDS;SCIENTIFIC;UNIT_KG',
            '1;123 457;123 456,78;123 456,78 zł;123 457 zł;12,8%;-123 456,78;\u2212123 456,78;(123 456,78);123,5;1,23E+05;123 456,8 kg',
            '2;223 457;223 456,78;223 456,78 zł;223 457 zł;12,75%;-223 456,78;\u2212223 456,78;(223 456,78);223,5;2,23E+05;223 456,8 kg',
            '',
        ].join('\n');

        await runFileImportScenario('pl-formats.csv', content, async (connection, table, target) => {
            const types = await readColumnTypes(connection, table);
            expect(types.get('ID')).toBe('BIGINT');
            expect(types.get('INTEGER_PL')).toBe('BIGINT');
            expect(types.get('DECIMAL_PL')).toBe('NUMERIC(16,2)');
            expect(types.get('PLN_STD')).toBe('NUMERIC(16,2)');
            // Currency-marked integers are money, not BIGINT.
            expect(types.get('PLN_INT')).toBe('NUMERIC(16,0)');
            expect(types.get('PERCENT_PL')).toBe('NUMERIC(16,2)');
            expect(types.get('NEG_MINUS')).toBe('NUMERIC(16,2)');
            expect(types.get('NEG_UNICODE')).toBe('NUMERIC(16,2)');
            expect(types.get('NEG_PARENS')).toBe('NUMERIC(16,2)');
            expect(types.get('THOUSANDS')).toBe('NUMERIC(16,1)');
            expect(types.get('SCIENTIFIC')).toBe('BIGINT');
            expect(types.get('UNIT_KG')).toBe('NUMERIC(16,1)');

            const rows = await readRecordRows(connection, `SELECT * FROM ${target} ORDER BY ID`);
            expect(rows).toHaveLength(2);
            expect(numericColumn(rows, 'INTEGER_PL')).toEqual([123457, 223457]);
            expect(numericColumn(rows, 'DECIMAL_PL')).toEqual([123456.78, 223456.78]);
            expect(numericColumn(rows, 'PLN_STD')).toEqual([123456.78, 223456.78]);
            expect(numericColumn(rows, 'PLN_INT')).toEqual([123457, 223457]);
            expect(numericColumn(rows, 'PERCENT_PL')).toEqual([12.8, 12.75]);
            expect(numericColumn(rows, 'NEG_MINUS')).toEqual([-123456.78, -223456.78]);
            expect(numericColumn(rows, 'NEG_UNICODE')).toEqual([-123456.78, -223456.78]);
            expect(numericColumn(rows, 'NEG_PARENS')).toEqual([-123456.78, -223456.78]);
            expect(numericColumn(rows, 'THOUSANDS')).toEqual([123.5, 223.5]);
            expect(numericColumn(rows, 'SCIENTIFIC')).toEqual([123000, 223000]);
            expect(numericColumn(rows, 'UNIT_KG')).toEqual([123456.8, 223456.8]);
        });
    }, 180000);

    it('round-trips Anglo-Saxon number formats through Netezza', async () => {
        const content = [
            'ID;DECIMAL_EN;USD_STD;USD_ACCT;GBP_STD;GBP_INT;PERCENT_EN;SCIENTIFIC_EN;UNIT_KG_EN',
            '1;123,456.78;$123,456.78;($123,456.78);£123,456.78;£123,457;12.75%;1.23E+05;123,456.8 kg',
            '2;223,456.78;$223,456.78;($223,456.78);£223,456.78;£223,457;15.25%;2.23E+05;223,456.8 kg',
            '',
        ].join('\n');

        await runFileImportScenario('en-formats.csv', content, async (connection, table, target) => {
            const types = await readColumnTypes(connection, table);
            expect(types.get('ID')).toBe('BIGINT');
            expect(types.get('DECIMAL_EN')).toBe('NUMERIC(16,2)');
            expect(types.get('USD_STD')).toBe('NUMERIC(16,2)');
            expect(types.get('USD_ACCT')).toBe('NUMERIC(16,2)');
            expect(types.get('GBP_STD')).toBe('NUMERIC(16,2)');
            // Currency-marked integers are money, not BIGINT.
            expect(types.get('GBP_INT')).toBe('NUMERIC(16,0)');
            expect(types.get('PERCENT_EN')).toBe('NUMERIC(16,2)');
            expect(types.get('SCIENTIFIC_EN')).toBe('BIGINT');
            expect(types.get('UNIT_KG_EN')).toBe('NUMERIC(16,1)');

            const rows = await readRecordRows(connection, `SELECT * FROM ${target} ORDER BY ID`);
            expect(rows).toHaveLength(2);
            expect(numericColumn(rows, 'DECIMAL_EN')).toEqual([123456.78, 223456.78]);
            expect(numericColumn(rows, 'USD_STD')).toEqual([123456.78, 223456.78]);
            expect(numericColumn(rows, 'USD_ACCT')).toEqual([-123456.78, -223456.78]);
            expect(numericColumn(rows, 'GBP_STD')).toEqual([123456.78, 223456.78]);
            expect(numericColumn(rows, 'GBP_INT')).toEqual([123457, 223457]);
            expect(numericColumn(rows, 'PERCENT_EN')).toEqual([12.75, 15.25]);
            expect(numericColumn(rows, 'SCIENTIFIC_EN')).toEqual([123000, 223000]);
            expect(numericColumn(rows, 'UNIT_KG_EN')).toEqual([123456.8, 223456.8]);
        });
    }, 180000);

    it('loads lone dashes as 0 in numeric columns and keeps them in text columns', async () => {
        const content = [
            'ID;AMOUNT;NOTE',
            '1;12,50;hello',
            '2;-;-',
            '3;8,25;world',
            '',
        ].join('\n');

        await runFileImportScenario('dash-zero.csv', content, async (connection, table, target) => {
            const types = await readColumnTypes(connection, table);
            expect(types.get('AMOUNT')).toBe('NUMERIC(16,2)');
            expect(types.get('NOTE')).toMatch(/^NATIONAL CHARACTER VARYING/);

            const rows = await readRecordRows(connection, `SELECT * FROM ${target} ORDER BY ID`);
            expect(rows).toHaveLength(3);
            expect(numericColumn(rows, 'AMOUNT')).toEqual([12.5, 0, 8.25]);
            expect(rows.map(row => row.NOTE === null ? null : String(row.NOTE))).toEqual([
                'hello',
                '-',
                'world',
            ]);
        });
    }, 180000);

    it('keeps PESEL-valued columns as text with leading zeros intact', async () => {
        const content = [
            'ID;LICZBA;NAME',
            '1;44051401359;Jan',
            '2;92071314764;Anna',
            '3;02070803628;Ola',
            '',
        ].join('\n');

        await runFileImportScenario('pesel.csv', content, async (connection, table, target) => {
            const types = await readColumnTypes(connection, table);
            expect(types.get('ID')).toBe('BIGINT');
            // Header `LICZBA` must not matter; the values decide the text type.
            expect(types.get('LICZBA')).toMatch(/^NATIONAL CHARACTER VARYING/);

            const rows = await readRecordRows(connection, `SELECT * FROM ${target} ORDER BY ID`);
            expect(rows.map(row => String(row.LICZBA))).toEqual([
                '44051401359',
                '92071314764',
                '02070803628',
            ]);
        });
    }, 180000);

    it('round-trips the clipboard sample with surrounding spaces and currency', async () => {
        const clipboard = vscode.env.clipboard as unknown as {
            readText?: () => Promise<string>;
        };
        const previousReadText = clipboard.readText;
        clipboard.readText = async () => 'col1\n 123 456,78   \n123 457 zł\n(1 234,56)';

        try {
            await runImportScenario(
                target => importClipboardDataToNetezza(target, buildNetezzaLiveDetails()),
                async (connection, table, target) => {
                    const types = await readColumnTypes(connection, table);
                    expect(types.get('COL1')).toBe('NUMERIC(16,2)');

                    const rows = await readRecordRows(connection, `SELECT COL1 FROM ${target}`);
                    const values = rows
                        .map(row => Number(String(row.COL1)))
                        .sort((left, right) => left - right);
                    expect(values).toEqual([-1234.56, 123456.78, 123457]);
                },
            );
        } finally {
            if (previousReadText) {
                clipboard.readText = previousReadText;
            } else {
                delete clipboard.readText;
            }
        }
    }, 180000);
});
