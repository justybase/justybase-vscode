import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseCommand, DatabaseConnection } from '../contracts/database';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { ClipboardDataProcessor } from '../import/clipboardImporter';
import { NetezzaImporter } from '../import/dataImporter';
import { importClipboardDataToMsSql, importDataToMsSql } from '../import/mssqlImporter';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn()
}));

jest.mock('../import/dataImporter', () => {
    const actual = jest.requireActual('../import/dataImporter');
    return {
        ...actual,
        NetezzaImporter: jest.fn()
    };
});

jest.mock('../import/clipboardImporter', () => ({
    ClipboardDataProcessor: jest.fn()
}));

function createMockConnectionCollector(options?: {
    failWhenSqlIncludes?: string;
}): {
    connection: DatabaseConnection;
    executedSql: string[];
} {
    const executedSql: string[] = [];
    const connection: DatabaseConnection = {
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn((sql: string): DatabaseCommand => {
            executedSql.push(sql);
            const shouldFail = options?.failWhenSqlIncludes
                ? sql.includes(options.failWhenSqlIncludes)
                : false;
            return {
                commandTimeout: 0,
                executeReader: jest.fn().mockRejectedValue(new Error('Reader execution not expected in mssqlImporter tests')),
                cancel: jest.fn().mockResolvedValue(undefined),
                execute: shouldFail
                    ? jest.fn().mockRejectedValue(new Error('simulated SQL failure'))
                    : jest.fn().mockResolvedValue(undefined),
                _recordsAffected: 0
            };
        }),
        on: jest.fn(),
        removeListener: jest.fn()
    };

    return { connection, executedSql };
}

function createFileImporterMock(rows: string[][]): Record<string, jest.Mock | ((...args: never[]) => unknown)> {
    return {
        analyzeDataTypes: jest.fn().mockResolvedValue([]),
        applyColumnOptions: jest.fn(),
        getSourceHeaders: jest.fn().mockReturnValue(['id', 'created_at', 'name', 'amount']),
        getColumnMappings: jest.fn().mockReturnValue([
            { sourceColumn: 'id', targetColumn: 'ID', dataType: 'BIGINT' },
            { sourceColumn: 'created_at', targetColumn: 'CREATED_AT', dataType: 'DATETIME' },
            { sourceColumn: 'name', targetColumn: 'NAME', dataType: 'NVARCHAR(200)' },
            { sourceColumn: 'amount', targetColumn: 'AMOUNT', dataType: 'DECIMAL(10,2)' }
        ]),
        getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
            { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' },
            { sourceIndex: 1, columnName: 'CREATED_AT', dataType: 'DATETIME' },
            { sourceIndex: 2, columnName: 'NAME', dataType: 'NVARCHAR(200)' },
            { sourceIndex: 3, columnName: 'AMOUNT', dataType: 'DECIMAL(10,2)' }
        ]),
        getRowsCount: jest.fn().mockReturnValue(rows.length),
        getWidthMismatchCount: jest.fn().mockReturnValue(0),
        iterateRows: jest.fn(() => (async function* generateRows() {
            for (const row of rows) {
                yield row;
            }
        })()),
        getDecimalDelimiter: jest.fn().mockReturnValue('.'),
        getCsvDelimiter: jest.fn().mockReturnValue(',')
    };
}

describe('mssqlImporter', () => {
    let tempDir: string;

    beforeEach(() => {
        jest.clearAllMocks();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mssql-import-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('imports file rows using MSSQL create+insert SQL path', async () => {
        const tempFile = path.join(tempDir, 'orders.csv');
        fs.writeFileSync(tempFile, 'id,created_at,name,amount\n1,01.02.2024 10:20:30,O\'Reilly,12.5\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock([
            ['1', '01.02.2024 10:20:30', 'O\'Reilly', '12.5']
        ]));

        const result = await importDataToMsSql(
            tempFile,
            'WAREHOUSE.dbo.ORDERS_IMPORT',
            {
                host: 'localhost',
                database: 'WAREHOUSE',
                user: 'sa',
                dbType: 'mssql'
            }
        );

        expect(result.success).toBe(true);
        expect(executedSql[0]).toContain('CREATE TABLE [dbo].ORDERS_IMPORT');
        expect(executedSql[0]).toContain('[created_at] DATETIME2');
        expect(executedSql[0]).toContain('[name] NVARCHAR(200)');
        expect(executedSql[1]).toContain('INSERT INTO [dbo].ORDERS_IMPORT');
        expect(executedSql[1]).toContain("N'2024-02-01 10:20:30'");
        expect(executedSql[1]).toContain("N'O''Reilly'");
        expect(executedSql[1]).toContain('12.5');
    });

    it('drops the newly created table when the insert fails', async () => {
        const tempFile = path.join(tempDir, 'failing.csv');
        fs.writeFileSync(tempFile, 'id,created_at,name,amount\n1,01.02.2024 10:20:30,Alice,1\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector({ failWhenSqlIncludes: 'INSERT' });
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock([
            ['1', '01.02.2024 10:20:30', 'Alice', '1']
        ]));

        const result = await importDataToMsSql(
            tempFile,
            'dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' }
        );

        expect(result.success).toBe(false);
        expect(executedSql).toContain('DROP TABLE [dbo].ORDERS_IMPORT');
    });

    it('appends file rows without creating the target table', async () => {
        const tempFile = path.join(tempDir, 'append.csv');
        fs.writeFileSync(tempFile, 'id,created_at,name,amount\n1,01.02.2024 10:20:30,Alice,1\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock([
            ['1', '01.02.2024 10:20:30', 'Alice', '1']
        ]));

        const result = await importDataToMsSql(
            tempFile,
            'dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' },
            undefined,
            undefined,
            { appendToExistingTable: true }
        );

        expect(result.success).toBe(true);
        expect(executedSql.some(sql => sql.includes('CREATE TABLE'))).toBe(false);
        expect(executedSql.some(sql => sql.includes('INSERT INTO'))).toBe(true);
    });

    it('stops before connecting when the file import is already cancelled', async () => {
        const tempFile = path.join(tempDir, 'cancelled.csv');
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock([['1']]));

        const result = await importDataToMsSql(
            tempFile,
            'dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' },
            undefined,
            undefined,
            undefined,
            () => true
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/cancelled/i);
        expect(createConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();
    });

    it('appends clipboard rows without creating the target table', async () => {
        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (ClipboardDataProcessor as jest.Mock).mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue({
                getHeaders: () => ['id', 'name'],
                getDataTypes: () => [
                    { currentType: { toString: () => 'BIGINT' } },
                    { currentType: { toString: () => 'NVARCHAR(50)' } }
                ],
                getDecimalDelimiter: () => '.',
                getRowCount: () => 1,
                *dataRowIterator() {
                    yield ['1', 'Alice'];
                }
            })
        }));

        const result = await importClipboardDataToMsSql(
            'dbo.CLIP_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' },
            null,
            { appendToExistingTable: true }
        );

        expect(result.success).toBe(true);
        expect(executedSql.some(sql => sql.includes('CREATE TABLE'))).toBe(false);
        expect(executedSql.some(sql => sql.includes('INSERT INTO'))).toBe(true);
    });

    it('drops the clipboard target table when the insert fails', async () => {
        const { connection, executedSql } = createMockConnectionCollector({ failWhenSqlIncludes: 'INSERT' });
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (ClipboardDataProcessor as jest.Mock).mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue({
                getHeaders: () => ['id'],
                getDataTypes: () => [{ currentType: { toString: () => 'BIGINT' } }],
                getDecimalDelimiter: () => '.',
                getRowCount: () => 1,
                *dataRowIterator() {
                    yield ['1'];
                }
            })
        }));

        const result = await importClipboardDataToMsSql(
            'dbo.CLIP_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' }
        );

        expect(result.success).toBe(false);
        expect(executedSql).toContain('DROP TABLE [dbo].CLIP_IMPORT');
    });

    it('formats dash-zero, compact dates, booleans and escaped text literals', async () => {
        const tempFile = path.join(tempDir, 'varied.csv');
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock([
            ['-', '03/02/2024', 'It\'s here', '-'],
            ['2', '2024-02-03 09:00:00', 'Bob', '0']
        ]));

        const result = await importDataToMsSql(
            tempFile,
            'dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' },
            undefined,
            undefined,
            { appendToExistingTable: true }
        );

        expect(result.success).toBe(true);
        const insertSql = executedSql.find(sql => sql.includes('INSERT INTO')) ?? '';
        expect(insertSql).toContain('N\'2024-02-03 00:00:00\'');
        expect(insertSql).toContain('N\'It\'\'s here\'');
        expect(insertSql).toContain('0');
        expect(insertSql).toContain("N'2024-02-03 09:00:00'");
    });

    it('falls back for rejected numerics and applies sheet selection', async () => {
        const tempFile = path.join(tempDir, 'fallback.csv');
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        const importerMock = createFileImporterMock([
            ['-', 'not-a-date', 'text', 'abc'],
            ['2', '2024-02-03', 'x', 'abc']
        ]);
        importerMock.getDecimalDelimiter = jest.fn().mockReturnValue(',');
        importerMock.setSelectedSheet = jest.fn();
        (NetezzaImporter as jest.Mock).mockImplementation(() => importerMock);

        const result = await importDataToMsSql(
            tempFile,
            'dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' },
            undefined,
            undefined,
            { appendToExistingTable: true, sheetName: 'Sheet1' }
        );

        expect(result.success).toBe(true);
        expect(importerMock.setSelectedSheet).toHaveBeenCalledWith('Sheet1');
        const insertSql = executedSql.find(sql => sql.includes('INSERT INTO')) ?? '';
        expect(insertSql).toContain('0');
        expect(insertSql).toContain('abc');
    });

    it('inserts in multiple batches when the row count exceeds the batch size', async () => {
        const tempFile = path.join(tempDir, 'batched.csv');
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');

        const rows = Array.from({ length: 101 }, (_unused, index) => [String(index), '2024-02-03', 'x', '1']);
        const { connection } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock(rows));

        const result = await importDataToMsSql(
            tempFile,
            'dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' }
        );

        expect(result.success).toBe(true);
        expect(result.details?.rowsInserted).toBe(101);
    });

    it('rejects unsupported target database mismatches', async () => {
        const tempFile = path.join(tempDir, 'mismatch.csv');
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');
        (NetezzaImporter as jest.Mock).mockImplementation(() => createFileImporterMock([['1']]));

        const result = await importDataToMsSql(
            tempFile,
            'OTHERDB.dbo.ORDERS_IMPORT',
            { host: 'localhost', database: 'WAREHOUSE', user: 'sa', dbType: 'mssql' }
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('does not match the active connection');
        expect(createConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();
    });
});
