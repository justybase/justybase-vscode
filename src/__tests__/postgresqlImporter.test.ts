import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseCommand, DatabaseConnection, DatabaseImportTypeMapper } from '../contracts/database';
import {
    createConnectedDatabaseConnectionFromDetails,
    getDatabaseConnectionConstructor,
    getRequiredDatabaseImportTypeMapper
} from '../core/connectionFactory';
import { ClipboardDataProcessor } from '../import/clipboardImporter';
import { NetezzaImporter } from '../import/dataImporter';
import { importClipboardDataToPostgreSql, importDataToPostgreSql } from '../import/postgresqlImporter';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
    getDatabaseConnectionConstructor: jest.fn(),
    getRequiredDatabaseImportTypeMapper: jest.fn()
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
                executeReader: jest.fn().mockRejectedValue(new Error('Reader execution is not expected in postgresqlImporter tests')),
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

function createMockPostgreSqlTypeMapper(): DatabaseImportTypeMapper {
    return {
        createDataType(dbType: string, precision?: number, scale?: number, length?: number) {
            const normalizedType = dbType.trim().toUpperCase();
            return {
                dbType: normalizedType,
                precision,
                scale,
                length,
                toString(): string {
                    if (normalizedType === 'DATETIME') {
                        return 'TIMESTAMP';
                    }
                    if (normalizedType === 'NVARCHAR' || normalizedType === 'VARCHAR') {
                        return `VARCHAR(${length ?? 255})`;
                    }
                    if (normalizedType === 'NUMERIC' && precision !== undefined && scale !== undefined) {
                        return `NUMERIC(${precision},${scale})`;
                    }
                    return normalizedType;
                }
            };
        },
        createColumnTypeChooser() {
            throw new Error('Type chooser should not be used in postgresqlImporter tests');
        }
    };
}

describe('postgresqlImporter', () => {
    const mockRegisterImportStream = jest.fn();
    const mockUnregisterImportStream = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (getDatabaseConnectionConstructor as jest.Mock).mockReturnValue({
            registerImportStream: mockRegisterImportStream,
            unregisterImportStream: mockUnregisterImportStream
        });
        (getRequiredDatabaseImportTypeMapper as jest.Mock).mockReturnValue(createMockPostgreSqlTypeMapper());
    });

    it('imports file rows using PostgreSQL create+copy SQL path', async () => {
        const tempFile = path.join(os.tmpdir(), `postgresql-import-${Date.now()}.csv`);
        fs.writeFileSync(tempFile, 'id,created_at,name\n1,01.02.2024 10:20:30,Alice\n2,2024-02-03 09:00:00,Bob\n', 'utf8');

        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);

        (NetezzaImporter as jest.Mock).mockImplementation(() => ({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getSourceHeaders: jest.fn().mockReturnValue(['id', 'created_at', 'name']),
            getColumnMappings: jest.fn().mockReturnValue([
                { sourceColumn: 'id', targetColumn: 'id', dataType: 'BIGINT' },
                { sourceColumn: 'created_at', targetColumn: 'created_at', dataType: 'DATETIME' },
                { sourceColumn: 'name', targetColumn: 'name', dataType: 'NVARCHAR(200)' }
            ]),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'CREATED_AT', dataType: 'DATETIME' },
                { sourceIndex: 2, columnName: 'NAME', dataType: 'NVARCHAR(200)' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([
                ['1', '01.02.2024 10:20:30', 'Alice'],
                ['2', '2024-02-03 09:00:00', 'Bob']
            ]),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(';')
        }));

        const result = await importDataToPostgreSql(tempFile, 'warehouse.public.orders_import', {
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            dbType: 'postgresql'
        });

        expect(result.success).toBe(true);
        expect(executedSql[0]).toContain('CREATE TABLE public.orders_import');
        expect(executedSql[0]).toContain('created_at TIMESTAMP');
        expect(executedSql[0]).toContain('name VARCHAR(200)');
        expect(executedSql[1]).toContain('COPY public.orders_import (id, created_at, name) FROM STDIN');
        expect(executedSql[1]).toContain("DELIMITER ';'");
        expect(executedSql[1]).toContain("NULL ''");
        expect(mockRegisterImportStream).toHaveBeenCalledTimes(1);
        expect(mockUnregisterImportStream).toHaveBeenCalledTimes(1);

        fs.unlinkSync(tempFile);
    });

    it('fails fast when DATABASE.SCHEMA.TABLE points to a different DB than active connection', async () => {
        const tempFile = path.join(os.tmpdir(), `postgresql-import-mismatch-${Date.now()}.csv`);
        fs.writeFileSync(tempFile, 'id\n1\n', 'utf8');

        (NetezzaImporter as jest.Mock).mockImplementation(() => ({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getSourceHeaders: jest.fn().mockReturnValue(['id']),
            getColumnMappings: jest.fn().mockReturnValue([
                { sourceColumn: 'id', targetColumn: 'id', dataType: 'BIGINT' }
            ]),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([['1']]),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(',')
        }));

        const result = await importDataToPostgreSql(tempFile, 'otherdb.public.orders_import', {
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            dbType: 'postgresql'
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain('does not match the active connection');
        expect(createConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();

        fs.unlinkSync(tempFile);
    });

    it('imports clipboard data using PostgreSQL COPY with a tab-delimited stream', async () => {
        const { connection, executedSql } = createMockConnectionCollector();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(connection);

        const analyzer = {
            getHeaders: jest.fn().mockReturnValue(['id', 'created_at']),
            getDataTypes: jest.fn().mockReturnValue([
                { currentType: { toString: () => 'BIGINT' } },
                { currentType: { toString: () => 'DATETIME' } }
            ]),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getDelimiter: jest.fn().mockReturnValue(','),
            getRowCount: jest.fn().mockReturnValue(1),
            *dataRowIterator() {
                yield ['1', '01.02.2024 10:20:30'];
            }
        };

        (ClipboardDataProcessor as jest.Mock).mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue(analyzer)
        }));

        const result = await importClipboardDataToPostgreSql('public.clip_import', {
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            dbType: 'postgresql'
        });

        expect(result.success).toBe(true);
        expect(executedSql[0]).toContain('CREATE TABLE public.clip_import');
        expect(executedSql[0]).toContain('"CREATED_AT" TIMESTAMP');
        expect(executedSql[1]).toContain('COPY public.clip_import ("ID", "CREATED_AT") FROM STDIN');
        expect(executedSql[1]).toContain("DELIMITER E'\\t'");
        expect(result.details?.detectedDelimiter).toBe(',');
        expect(mockRegisterImportStream).toHaveBeenCalledTimes(1);
        expect(mockUnregisterImportStream).toHaveBeenCalledTimes(1);
    });
});
