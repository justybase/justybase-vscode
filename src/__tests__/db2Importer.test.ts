import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseCommand, DatabaseConnection } from '../contracts/database';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { ClipboardDataProcessor } from '../import/clipboardImporter';
import { NetezzaImporter } from '../import/dataImporter';
import { importClipboardDataToDb2, importDataToDb2 } from '../import/db2Importer';

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

function createMockConnectionCollector(): {
    connection: DatabaseConnection;
    executedSql: string[];
} {
    const executedSql: string[] = [];
    const connection: DatabaseConnection = {
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn((sql: string): DatabaseCommand => {
            executedSql.push(sql);
            return {
                commandTimeout: 0,
                executeReader: jest.fn().mockRejectedValue(new Error('Reader execution not expected in db2Importer tests')),
                cancel: jest.fn().mockResolvedValue(undefined),
                execute: jest.fn().mockResolvedValue(undefined),
                _recordsAffected: 0
            };
        }),
        on: jest.fn(),
        removeListener: jest.fn()
    };

    return {
        connection,
        executedSql
    };
}

describe('db2Importer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('imports file rows using DB2 create+insert SQL path', async () => {
        const tempFile = path.join(os.tmpdir(), `db2-import-${Date.now()}.csv`);
        fs.writeFileSync(tempFile, 'id,created_at,name\n1,01.02.2024 10:20:30,O\'Reilly\n2,2024-02-03 09:00:00,Beta\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);

        const importerMock = {
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getSourceHeaders: jest.fn().mockReturnValue(['id', 'created_at', 'name']),
            getColumnMappings: jest.fn().mockReturnValue([
                { sourceColumn: 'id', targetColumn: 'ID', dataType: 'BIGINT' },
                { sourceColumn: 'created_at', targetColumn: 'CREATED_AT', dataType: 'DATETIME' },
                { sourceColumn: 'name', targetColumn: 'NAME', dataType: 'NVARCHAR(200)' }
            ]),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'CREATED_AT', dataType: 'DATETIME' },
                { sourceIndex: 2, columnName: 'NAME', dataType: 'NVARCHAR(200)' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([
                ['1', '01.02.2024 10:20:30', 'O\'Reilly'],
                ['2', '2024-02-03 09:00:00', 'Beta']
            ]),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(',')
        };
        (NetezzaImporter as jest.Mock).mockImplementation(() => importerMock);

        const result = await importDataToDb2(tempFile, 'TESTDB.DB2INST1.EMP_IMPORT', {
            host: 'localhost',
            database: 'TESTDB',
            user: 'db2inst1',
            dbType: 'db2'
        });

        expect(result.success).toBe(true);
        expect(executedSql[0]).toContain('CREATE TABLE DB2INST1.EMP_IMPORT');
        expect(executedSql[0]).toContain('CREATED_AT TIMESTAMP');
        expect(executedSql[1]).toContain('INSERT INTO DB2INST1.EMP_IMPORT');
        expect(executedSql[1]).toContain("'2024-02-01 10:20:30'");
        expect(executedSql[1]).toContain("'O''Reilly'");

        fs.unlinkSync(tempFile);
    });

    it('fails fast when DATABASE.SCHEMA.TABLE points to a different DB than active connection', async () => {
        const tempFile = path.join(os.tmpdir(), `db2-import-mismatch-${Date.now()}.csv`);
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');

        const importerMock = {
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getSourceHeaders: jest.fn().mockReturnValue(['id']),
            getColumnMappings: jest.fn().mockReturnValue([
                { sourceColumn: 'id', targetColumn: 'ID', dataType: 'BIGINT' }
            ]),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([['1']]),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(',')
        };
        (NetezzaImporter as jest.Mock).mockImplementation(() => importerMock);

        const result = await importDataToDb2(tempFile, 'OTHERDB.DB2INST1.EMP_IMPORT', {
            host: 'localhost',
            database: 'TESTDB',
            user: 'db2inst1',
            dbType: 'db2'
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain('does not match the active connection');
        expect(createConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();

        fs.unlinkSync(tempFile);
    });

    it('imports clipboard data with DB2 insert SQL path', async () => {
        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);

        const analyzer = {
            getHeaders: jest.fn().mockReturnValue(['id', 'amount']),
            getDataTypes: jest.fn().mockReturnValue([
                { currentType: { toString: () => 'BIGINT' } },
                { currentType: { toString: () => 'NUMERIC(10,2)' } }
            ]),
            getDecimalDelimiter: jest.fn().mockReturnValue(','),
            getRowCount: jest.fn().mockReturnValue(1),
            *dataRowIterator() {
                yield ['1', '12,34'];
            }
        };

        (ClipboardDataProcessor as jest.Mock).mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue(analyzer)
        }));

        const result = await importClipboardDataToDb2('DB2INST1.CLIP_IMPORT', {
            host: 'localhost',
            database: 'TESTDB',
            user: 'db2inst1',
            dbType: 'db2'
        });

        expect(result.success).toBe(true);
        expect(executedSql[0]).toContain('CREATE TABLE DB2INST1.CLIP_IMPORT');
        expect(executedSql[1]).toContain('INSERT INTO DB2INST1.CLIP_IMPORT');
        expect(executedSql[1]).toContain('(1, 12.34)');
    });
});
