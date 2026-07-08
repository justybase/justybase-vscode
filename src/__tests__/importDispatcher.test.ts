import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importClipboardDataToNetezza } from '../import/clipboardImporter';
import { importDataToNetezza } from '../import/dataImporter';
import { importClipboardDataToDb2, importDataToDb2 } from '../import/db2Importer';
import { importClipboardDataToPostgreSql, importDataToPostgreSql } from '../import/postgresqlImporter';
import { importClipboardDataToVertica, importDataToVertica } from '../import/verticaImporter';
import { importClipboardDataToOracle, importDataToOracle } from '../import/oracleImporter';
import { importClipboardDataToMySql, importDataToMySql } from '../import/mysqlImporter';
import { importClipboardDataToDuckDb, importDataToDuckDb } from '../import/duckdbImporter';
import { importClipboardDataToSqlite, importDataToSqlite } from '../import/sqliteImporter';
import {
    getImportDialectLabel,
    importClipboardDataForConnection,
    importDataForConnection,
    resolveImportDialect
} from '../import/importDispatcher';

jest.mock('../import/clipboardImporter', () => ({
    importClipboardDataToNetezza: jest.fn().mockResolvedValue({ success: true, message: 'netezza-clipboard' })
}));

jest.mock('../import/dataImporter', () => ({
    importDataToNetezza: jest.fn().mockResolvedValue({ success: true, message: 'netezza-file' }),
    NetezzaImporter: jest.fn().mockImplementation((_filePath: string, _targetTable: string) => ({
        analyzeDataTypes: jest.fn().mockResolvedValue([]),
        applyColumnOptions: jest.fn(),
        getSourceHeaders: jest.fn().mockReturnValue(['order_id', 'customer_name', 'total']),
        getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
            { sourceIndex: 0, columnName: 'ORDER_ID', dataType: 'BIGINT' },
            { sourceIndex: 1, columnName: 'CUSTOMER_NAME', dataType: 'NVARCHAR(20)' },
            { sourceIndex: 2, columnName: 'TOTAL', dataType: 'NUMERIC(16,2)' },
        ]),
        getRowsCount: jest.fn().mockReturnValue(2),
        getCsvDelimiter: jest.fn().mockReturnValue(','),
        getDecimalDelimiter: jest.fn().mockReturnValue('.'),
    })),
}));

jest.mock('../import/db2Importer', () => ({
    importClipboardDataToDb2: jest.fn().mockResolvedValue({ success: true, message: 'db2-clipboard' }),
    importDataToDb2: jest.fn().mockResolvedValue({ success: true, message: 'db2-file' })
}));

jest.mock('../import/postgresqlImporter', () => ({
    importClipboardDataToPostgreSql: jest.fn().mockResolvedValue({ success: true, message: 'postgresql-clipboard' }),
    importDataToPostgreSql: jest.fn().mockResolvedValue({ success: true, message: 'postgresql-file' })
}));

jest.mock('../import/verticaImporter', () => ({
    importClipboardDataToVertica: jest.fn().mockResolvedValue({ success: true, message: 'vertica-clipboard' }),
    importDataToVertica: jest.fn().mockResolvedValue({ success: true, message: 'vertica-file' })
}));

jest.mock('../import/oracleImporter', () => ({
    importClipboardDataToOracle: jest.fn().mockResolvedValue({ success: true, message: 'oracle-clipboard' }),
    importDataToOracle: jest.fn().mockResolvedValue({ success: true, message: 'oracle-file' })
}));

jest.mock('../import/mysqlImporter', () => ({
    importClipboardDataToMySql: jest.fn().mockResolvedValue({ success: true, message: 'mysql-clipboard' }),
    importDataToMySql: jest.fn().mockResolvedValue({ success: true, message: 'mysql-file' })
}));

jest.mock('../import/duckdbImporter', () => ({
    importClipboardDataToDuckDb: jest.fn().mockResolvedValue({ success: true, message: 'duckdb-clipboard' }),
    importDataToDuckDb: jest.fn().mockResolvedValue({ success: true, message: 'duckdb-file' })
}));

jest.mock('../import/sqliteImporter', () => ({
    importClipboardDataToSqlite: jest.fn().mockResolvedValue({ success: true, message: 'sqlite-clipboard' }),
    importDataToSqlite: jest.fn().mockResolvedValue({ success: true, message: 'sqlite-file' })
}));

describe('importDispatcher', () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowflake-import-dispatcher-'));
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('resolves supported dialect aliases and labels', () => {
        expect(resolveImportDialect(undefined)).toBe('netezza');
        expect(resolveImportDialect('postgres')).toBe('postgresql');
        expect(resolveImportDialect('verticadb')).toBe('vertica');
        expect(resolveImportDialect('sqlite3')).toBe('sqlite');
        expect(resolveImportDialect('duckdb')).toBe('duckdb');
        expect(resolveImportDialect('snowflake')).toBe('snowflake');
        expect(getImportDialectLabel('db2')).toBe('Db2');
        expect(getImportDialectLabel('postgresql')).toBe('PostgreSQL');
        expect(getImportDialectLabel('vertica')).toBe('Vertica');
        expect(getImportDialectLabel('oracle')).toBe('Oracle');
        expect(getImportDialectLabel('mysql')).toBe('MySQL');
        expect(getImportDialectLabel('duckdb')).toBe('DuckDB');
        expect(getImportDialectLabel('sqlite')).toBe('SQLite');
        expect(getImportDialectLabel('snowflake')).toBe('Snowflake');
    });

    it('validates file-import requests before dispatching', async () => {
        await expect(importDataForConnection('', 'public.t', {
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            dbType: 'postgresql'
        })).resolves.toEqual({
            success: false,
            message: 'Source file path is required.'
        });

        await expect(importDataForConnection('C:\\data.csv', '', {
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            dbType: 'postgresql'
        })).resolves.toEqual({
            success: false,
            message: 'Target table name is required.'
        });

        await expect(importDataForConnection('C:\\data.csv', 'public.t', undefined as never)).resolves.toEqual({
            success: false,
            message: 'Connection details are required.'
        });

        expect(importDataToPostgreSql).not.toHaveBeenCalled();
    });

    it('routes file import to PostgreSQL importer', async () => {
        const result = await importDataForConnection(
            '  C:\\data.csv  ',
            '  public.orders  ',
            {
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
                dbType: 'postgresql'
            },
            undefined,
            120
        );

        expect(result).toEqual({ success: true, message: 'postgresql-file' });
        expect(importDataToPostgreSql).toHaveBeenCalledWith(
            'C:\\data.csv',
            'public.orders',
            expect.objectContaining({ dbType: 'postgresql' }),
            undefined,
            120,
            undefined
        );
        expect(importDataToDb2).not.toHaveBeenCalled();
        expect(importDataToNetezza).not.toHaveBeenCalled();
    });

    it.each([
        ['vertica', importDataToVertica, 'vertica-file'],
        ['oracle', importDataToOracle, 'oracle-file'],
        ['mysql', importDataToMySql, 'mysql-file'],
        ['duckdb', importDataToDuckDb, 'duckdb-file'],
        ['sqlite', importDataToSqlite, 'sqlite-file'],
    ] as const)('routes file import to %s importer', async (dbType, importerMock, message) => {
        const result = await importDataForConnection(
            '/tmp/orders.xlsx',
            'target.orders',
            {
                host: 'localhost',
                database: 'warehouse',
                user: 'tester',
                dbType
            }
        );

        expect(result).toEqual({ success: true, message });
        expect(importerMock).toHaveBeenCalledWith(
            '/tmp/orders.xlsx',
            'target.orders',
            expect.objectContaining({ dbType }),
            undefined,
            undefined,
            undefined
        );
    });

    it('validates clipboard-import requests before dispatching', async () => {
        await expect(importClipboardDataForConnection('', {
            host: 'localhost',
            database: 'warehouse',
            user: 'db2inst1',
            dbType: 'db2'
        })).resolves.toEqual({
            success: false,
            message: 'Target table name is required.'
        });

        await expect(importClipboardDataForConnection('public.t', undefined as never)).resolves.toEqual({
            success: false,
            message: 'Connection details are required.'
        });

        expect(importClipboardDataToDb2).not.toHaveBeenCalled();
    });

    it('routes clipboard import for supported dialects and reports unsupported kinds cleanly', async () => {
        const postgresResult = await importClipboardDataForConnection('  public.orders  ', {
            host: 'localhost',
            database: 'warehouse',
            user: 'postgres',
            dbType: 'postgresql'
        });

        expect(postgresResult).toEqual({ success: true, message: 'postgresql-clipboard' });
        expect(importClipboardDataToPostgreSql).toHaveBeenCalledWith(
            'public.orders',
            expect.objectContaining({ dbType: 'postgresql' }),
            undefined,
            undefined,
            undefined
        );
        expect(importClipboardDataToNetezza).not.toHaveBeenCalled();

        await expect(importClipboardDataForConnection('public.orders', {
            host: 'localhost',
            database: 'warehouse',
            user: 'oracle',
            dbType: 'oracle'
        })).resolves.toEqual({ success: true, message: 'oracle-clipboard' });
        expect(importClipboardDataToOracle).toHaveBeenCalledWith(
            'public.orders',
            expect.objectContaining({ dbType: 'oracle' }),
            undefined,
            undefined,
            undefined
        );

        await expect(importClipboardDataForConnection('public.orders', {
            host: 'localhost',
            database: 'warehouse',
            user: 'vertica',
            dbType: 'vertica'
        })).resolves.toEqual({ success: true, message: 'vertica-clipboard' });
        expect(importClipboardDataToVertica).toHaveBeenCalledWith(
            'public.orders',
            expect.objectContaining({ dbType: 'vertica' }),
            undefined,
            undefined,
            undefined
        );

        await expect(importClipboardDataForConnection('public.orders', {
            host: 'localhost',
            database: 'warehouse',
            user: 'sqlite',
            dbType: 'sqlite'
        })).resolves.toEqual({ success: true, message: 'sqlite-clipboard' });
        expect(importClipboardDataToSqlite).toHaveBeenCalled();

        await expect(importClipboardDataForConnection('public.orders', {
            host: 'localhost',
            database: 'warehouse',
            user: 'mysql',
            dbType: 'mysql'
        })).resolves.toEqual({ success: true, message: 'mysql-clipboard' });
        expect(importClipboardDataToMySql).toHaveBeenCalled();

        await expect(importClipboardDataForConnection('public.orders', {
            host: 'localhost',
            database: 'warehouse',
            user: 'duckdb',
            dbType: 'duckdb'
        })).resolves.toEqual({ success: true, message: 'duckdb-clipboard' });
        expect(importClipboardDataToDuckDb).toHaveBeenCalled();

        await expect(importClipboardDataForConnection('public.orders', {
            host: 'localhost',
            database: 'warehouse',
            user: 'unknown',
            dbType: 'unsupported-db'
        } as never)).resolves.toEqual({
            success: false,
            message: 'Import is not supported for database kind "unsupported-db".'
        });
    });

    it('generates a staged Snowflake file-import workflow instead of returning unsupported', async () => {
        const sourceFile = path.join(tempDir, 'orders.csv');
        fs.writeFileSync(sourceFile, 'order_id,customer_name,total\n1,Alice,10.50\n2,Bob,11.25\n', 'utf8');

        const result = await importDataForConnection(
            sourceFile,
            'analytics.public.orders',
            {
                host: 'test-account',
                database: 'analytics',
                user: 'snow-user',
                dbType: 'snowflake'
            },
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('staged COPY INTO workflow');
        expect(result.details?.rowsProcessed).toBe(2);
        expect(result.details?.columns).toBe(3);
        expect(result.details?.snowflakeWorkflow?.createTableSql).toContain('CREATE TABLE IF NOT EXISTS');
        expect(result.details?.snowflakeWorkflow?.copyIntoSql).toContain('COPY INTO');
        expect(result.details?.snowflakeWorkflow?.copyIntoSql).toContain('FILE_FORMAT = (');
        expect(result.details?.snowflakeWorkflow?.workflowMarkdown).toContain('# Snowflake staged import workflow');
    });

    it('returns Snowflake clipboard guidance instead of a generic unsupported error', async () => {
        const result = await importClipboardDataForConnection('analytics.public.orders', {
            host: 'test-account',
            database: 'analytics',
            user: 'snow-user',
            dbType: 'snowflake'
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain('clipboard import is not executed directly');
        expect(result.details?.snowflakeWorkflow?.workflowMarkdown).toContain('Snowflake clipboard import guidance');
    });
});
