import * as fs from 'fs';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { ClipboardDataProcessor } from '../import/clipboardImporter';
import { importClipboardDataToAccess, importDataToAccess } from '../import/accessImporter';
import { importClipboardDataToClickHouse } from '../import/clickhouseImporter';
import { importClipboardDataToMySql, importDataToMySql } from '../import/mysqlImporter';
import { importDataToOracle } from '../import/oracleImporter';
import { importClipboardDataToSqlite } from '../import/sqliteImporter';
import { importClipboardDataToVertica, importDataToVertica } from '../import/verticaImporter';
import { createTabularDataImporter } from '../import/tabularDataImporter';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn()
}));

jest.mock('../import/tabularDataImporter', () => ({
    createTabularDataImporter: jest.fn()
}));

jest.mock('../import/clipboardImporter', () => ({
    ClipboardDataProcessor: jest.fn()
}));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
    statSync: jest.fn().mockReturnValue({ size: 128 })
}));

interface MockCommand {
    commandTimeout: number;
    executeReader: jest.Mock<Promise<never>, []>;
    cancel: jest.Mock<Promise<void>, []>;
    execute: jest.Mock<Promise<void>, []>;
    _recordsAffected: number;
}

function createMockConnection(executedSql: string[], failWhenSqlIncludes?: string) {
    return {
        createCommand: jest.fn((sql: string): MockCommand => ({
            commandTimeout: 0,
            executeReader: jest.fn(async () => {
                throw new Error('executeReader should not be called during import tests');
            }),
            cancel: jest.fn(async () => undefined),
            execute: jest.fn(async () => {
                if (failWhenSqlIncludes && sql.includes(failWhenSqlIncludes)) {
                    throw new Error('simulated SQL failure');
                }
                executedSql.push(sql);
            }),
            _recordsAffected: 0
        })),
        close: jest.fn(async () => undefined),
        connect: jest.fn(async () => undefined),
        on: jest.fn(),
        removeListener: jest.fn()
    };
}

function createClipboardAnalyzer(headers: string[], rows: string[][]): Record<string, jest.Mock | ((...args: never[]) => unknown)> {
    return {
        getHeaders: jest.fn().mockReturnValue(headers),
        getDataTypes: jest.fn().mockReturnValue(
            headers.map(() => ({ currentType: { toString: () => 'NVARCHAR(255)' } })),
        ),
        dataRowIterator: jest.fn().mockReturnValue(rows),
        getRowCount: jest.fn().mockReturnValue(rows.length),
        getDecimalDelimiter: jest.fn().mockReturnValue('.'),
        getDelimiter: jest.fn().mockReturnValue('\t')
    };
}

describe('new dialect importers', () => {
    const createConnectionMock = createConnectedDatabaseConnectionFromDetails as jest.Mock;
    const createTabularImporterMock = createTabularDataImporter as jest.Mock;
    const ClipboardDataProcessorMock = ClipboardDataProcessor as unknown as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.statSync as jest.Mock).mockReturnValue({ size: 128 });
    });

    it('imports file data into MySQL using dialect-aware DDL and batch inserts', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        createTabularImporterMock.mockReturnValue({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'Order_ID', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'TotalAmount', dataType: 'NUMERIC(16,2)' },
                { sourceIndex: 2, columnName: 'CreatedAt', dataType: 'DATETIME' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([
                ['1', '10.50', '2024-01-02 03:04:05'],
                ['2', '11.25', '2024-01-03 04:05:06']
            ]),
            getRowsCount: jest.fn().mockReturnValue(2),
            getWidthMismatchCount: jest.fn().mockReturnValue(0),
            iterateRows: jest.fn(() => (async function* () {
                yield ['1', '10.50', '2024-01-02 03:04:05'];
                yield ['2', '11.25', '2024-01-03 04:05:06'];
            })()),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(','),
        });

        const result = await importDataToMySql(
            '/tmp/orders.csv',
            'sales.orders',
            {
                host: 'localhost',
                database: 'warehouse',
                user: 'tester',
                dbType: 'mysql'
            }
        );

        expect(result.success).toBe(true);
        expect(createTabularImporterMock).toHaveBeenCalledWith('/tmp/orders.csv', 'sales.orders', { kind: 'mysql' });
        expect(executedSql[0]).toBe('START TRANSACTION');
        expect(executedSql[1]).toContain('CREATE TABLE sales.orders');
        expect(executedSql[1]).toContain('Order_ID BIGINT');
        expect(executedSql[1]).toContain('TotalAmount DECIMAL(16,2)');
        expect(executedSql[1]).toContain('CreatedAt DATETIME');
        expect(executedSql[2]).toContain('INSERT INTO sales.orders');
        expect(executedSql[2]).toContain("'2024-01-02 03:04:05'");
        expect(executedSql[3]).toBe('COMMIT');
    });

    it('accepts .tsv files in the shared batch import path', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        createTabularImporterMock.mockReturnValue({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }
            ]),
            getRowsCount: jest.fn().mockReturnValue(1),
            getWidthMismatchCount: jest.fn().mockReturnValue(0),
            iterateRows: jest.fn(() => (async function* () {
                yield ['1'];
            })()),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue('\t'),
        });

        const result = await importDataToMySql(
            '/tmp/orders.tsv',
            'sales.orders',
            {
                host: 'localhost',
                database: 'warehouse',
                user: 'tester',
                dbType: 'mysql'
            }
        );

        expect(result.success).toBe(true);
    });

    it('imports file data into Oracle using INSERT ALL and Oracle type mapping', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        createTabularImporterMock.mockReturnValue({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'ORDER_ID', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'ORDER_DATE', dataType: 'DATE' },
                { sourceIndex: 2, columnName: 'ORDER_TS', dataType: 'TIMESTAMP' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([
                ['1', '2024-03-01', '2024-03-01 10:11:12']
            ]),
            getRowsCount: jest.fn().mockReturnValue(1),
            getWidthMismatchCount: jest.fn().mockReturnValue(0),
            iterateRows: jest.fn(() => (async function* () {
                yield ['1', '2024-03-01', '2024-03-01 10:11:12'];
            })()),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(','),
        });

        const result = await importDataToOracle(
            '/tmp/orders.xlsx',
            'SALES.ORDERS',
            {
                host: 'localhost',
                database: 'ORCL',
                user: 'oracle',
                dbType: 'oracle'
            }
        );

        expect(result.success).toBe(true);
        expect(executedSql[0]).toContain('CREATE TABLE SALES.ORDERS');
        expect(executedSql[0]).toContain('ORDER_ID NUMBER(19,0)');
        expect(executedSql[0]).toContain('ORDER_DATE DATE');
        expect(executedSql[0]).toContain('ORDER_TS TIMESTAMP');
        expect(executedSql[1]).toContain('INSERT ALL');
        expect(executedSql[1]).toContain("TO_DATE('2024-03-01', 'YYYY-MM-DD')");
        expect(executedSql[1]).toContain("TO_TIMESTAMP('2024-03-01 10:11:12', 'YYYY-MM-DD HH24:MI:SS')");
        expect(executedSql[2]).toBe('COMMIT');
    });

    it('imports file data into Vertica using transactional batch inserts', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        createTabularImporterMock.mockReturnValue({
            analyzeDataTypes: jest.fn().mockResolvedValue([]),
            applyColumnOptions: jest.fn(),
            getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
                { sourceIndex: 0, columnName: 'order_id', dataType: 'BIGINT' },
                { sourceIndex: 1, columnName: 'customer_name', dataType: 'NVARCHAR(50)' },
                { sourceIndex: 2, columnName: 'order_ts', dataType: 'DATETIME' },
                { sourceIndex: 3, columnName: 'active', dataType: 'BOOLEAN' }
            ]),
            getAllRows: jest.fn().mockResolvedValue([
                ['1', 'Alice', '2024-03-01 10:11:12', 'true'],
                ['2', 'Bob', '2024-03-02 11:12:13', 'false']
            ]),
            getRowsCount: jest.fn().mockReturnValue(2),
            getWidthMismatchCount: jest.fn().mockReturnValue(0),
            iterateRows: jest.fn(() => (async function* () {
                yield ['1', 'Alice', '2024-03-01 10:11:12', 'true'];
                yield ['2', 'Bob', '2024-03-02 11:12:13', 'false'];
            })()),
            getDecimalDelimiter: jest.fn().mockReturnValue('.'),
            getCsvDelimiter: jest.fn().mockReturnValue(','),
        });

        const result = await importDataToVertica(
            '/tmp/orders.csv',
            'sales.orders',
            {
                host: 'localhost',
                database: 'warehouse',
                user: 'dbadmin',
                dbType: 'vertica'
            }
        );

        expect(result.success).toBe(true);
        expect(createTabularImporterMock).toHaveBeenCalledWith('/tmp/orders.csv', 'sales.orders', { kind: 'vertica' });
        expect(executedSql[0]).toBe('BEGIN');
        expect(executedSql[1]).toContain('CREATE TABLE sales.orders');
        expect(executedSql[1]).toContain('order_id BIGINT');
        expect(executedSql[1]).toContain('customer_name VARCHAR(50)');
        expect(executedSql[1]).toContain('order_ts TIMESTAMP');
        expect(executedSql[1]).toContain('active BOOLEAN');
        expect(executedSql[2]).toContain('INSERT INTO sales.orders');
        expect(executedSql[2]).toContain('UNION ALL SELECT');
        expect(executedSql[2]).not.toContain('VALUES\n(');
        expect(executedSql[2]).toContain("TIMESTAMP '2024-03-01 10:11:12'");
        expect(executedSql[2]).toContain('TRUE');
        expect(executedSql[2]).toContain('FALSE');
        expect(executedSql[3]).toBe('COMMIT');
    });

    it('imports clipboard data into SQLite with deduplicated preserved-case headers', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        ClipboardDataProcessorMock.mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue({
                getHeaders: jest.fn().mockReturnValue(['Order Id', 'Order Id']),
                getDataTypes: jest.fn().mockReturnValue([
                    { currentType: { toString: () => 'BIGINT' } },
                    { currentType: { toString: () => 'NVARCHAR(255)' } }
                ]),
                dataRowIterator: jest.fn().mockReturnValue([
                    ['1', 'Alice'],
                    ['2', 'Bob']
                ]),
                getRowCount: jest.fn().mockReturnValue(2),
                getDecimalDelimiter: jest.fn().mockReturnValue('.'),
                getDelimiter: jest.fn().mockReturnValue('\t')
            })
        }));

        const result = await importClipboardDataToSqlite(
            'main.orders',
            {
                host: ':memory:',
                database: ':memory:',
                user: 'sqlite',
                dbType: 'sqlite'
            }
        );

        expect(result.success).toBe(true);
        expect(executedSql[0]).toBe('BEGIN TRANSACTION');
        expect(executedSql[1]).toContain('CREATE TABLE main.orders');
        expect(executedSql[1]).toContain('Order_Id INTEGER');
        expect(executedSql[1]).toContain('Order_Id_1 TEXT');
        expect(executedSql[2]).toContain('INSERT INTO main.orders');
        expect(executedSql[3]).toBe('COMMIT');
    });

    it('imports clipboard data into MySQL with BOOLEAN/NVARCHAR mapping', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        ClipboardDataProcessorMock.mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue({
                getHeaders: jest.fn().mockReturnValue(['Active', 'Customer Name']),
                getDataTypes: jest.fn().mockReturnValue([
                    { currentType: { toString: () => 'BOOLEAN' } },
                    { currentType: { toString: () => 'NVARCHAR(50)' } }
                ]),
                dataRowIterator: jest.fn().mockReturnValue([
                    ['true', 'Alice']
                ]),
                getRowCount: jest.fn().mockReturnValue(1),
                getDecimalDelimiter: jest.fn().mockReturnValue('.'),
                getDelimiter: jest.fn().mockReturnValue('\t')
            })
        }));

        const result = await importClipboardDataToMySql(
            'sales.customers',
            {
                host: 'localhost',
                database: 'warehouse',
                user: 'tester',
                dbType: 'mysql'
            }
        );

        expect(result.success).toBe(true);
        expect(executedSql[1]).toContain('CREATE TABLE sales.customers');
        expect(executedSql[1]).toContain('Active BOOLEAN');
        expect(executedSql[1]).toContain('Customer_Name VARCHAR(50)');
        expect(executedSql[2]).toContain('TRUE');
        expect(executedSql[2]).toContain("'Alice'");
    });

    it.each([
        ['mysql', importDataToMySql, 'sales.orders'],
        ['vertica', importDataToVertica, 'sales.orders'],
    ] as const)('drops the created %s target table after a failed batch insert', async (dbType, importFn, target) => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql, 'INSERT'));
        createTabularImporterMock.mockReturnValue(createFileImporterMockForDropTest());

        const result = await importFn('/tmp/drop.csv', target, {
            host: 'localhost',
            database: 'warehouse',
            user: 'tester',
            dbType
        } as never);

        expect(result.success).toBe(false);
        expect(executedSql).toContain(`DROP TABLE ${target}`);
    });

    it('drops the created Access target table after a failed batch insert', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql, 'INSERT'));
        createTabularImporterMock.mockReturnValue(createFileImporterMockForDropTest());

        const result = await importDataToAccess(
            '/tmp/drop.csv',
            'orders',
            { host: '', database: '/tmp/data.accdb', user: '', dbType: 'access' } as never
        );

        expect(result.success).toBe(false);
        expect(executedSql).toContain('DROP TABLE orders');
    });

    it('appends Access clipboard rows without creating the table', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        ClipboardDataProcessorMock.mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue(createClipboardAnalyzer(['Id'], [['1']]))
        }));

        const result = await importClipboardDataToAccess(
            'orders',
            { host: '', database: '/tmp/data.accdb', user: '', dbType: 'access' } as never,
            null,
            { appendToExistingTable: true },
            undefined,
            () => false
        );

        expect(result.success).toBe(true);
        expect(executedSql.some(sql => sql.includes('CREATE TABLE'))).toBe(false);
        expect(executedSql.some(sql => sql.includes('INSERT'))).toBe(true);
    });

    it('drops the created ClickHouse target table after a failed batch insert', async () => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql, 'INSERT'));
        createTabularImporterMock.mockReturnValue(createFileImporterMockForDropTest());

        const result = await importClipboardDataToClickHouse(
            'analytics.orders',
            { host: 'localhost', database: 'analytics', user: 'default', dbType: 'clickhouse' } as never,
            null,
            undefined,
            undefined,
            () => false
        );

        expect(result.success).toBe(false);
        expect(executedSql).toContain('DROP TABLE analytics.orders');
    });

    it.each([
        ['vertica', importClipboardDataToVertica, 'sales.orders'],
        ['clickhouse', importClipboardDataToClickHouse, 'analytics.orders'],
    ] as const)('appends %s clipboard rows without creating the table', async (dbType, importFn, target) => {
        const executedSql: string[] = [];
        createConnectionMock.mockResolvedValue(createMockConnection(executedSql));
        ClipboardDataProcessorMock.mockImplementation(() => ({
            analyzeClipboardData: jest.fn().mockResolvedValue(createClipboardAnalyzer(['Id'], [['1']]))
        }));

        const result = await importFn(
            target,
            { host: 'localhost', database: 'warehouse', user: 'tester', dbType } as never,
            null,
            { appendToExistingTable: true },
            undefined,
            () => false
        );

        expect(result.success).toBe(true);
        expect(executedSql.some(sql => sql.includes('CREATE TABLE'))).toBe(false);
        expect(executedSql.some(sql => sql.includes('INSERT'))).toBe(true);
    });
});

function createFileImporterMockForDropTest() {
    return {
        analyzeDataTypes: jest.fn().mockResolvedValue([]),
        applyColumnOptions: jest.fn(),
        getEffectiveColumnDescriptors: jest.fn().mockReturnValue([
            { sourceIndex: 0, columnName: 'ID', dataType: 'BIGINT' }
        ]),
        getRowsCount: jest.fn().mockReturnValue(1),
        getWidthMismatchCount: jest.fn().mockReturnValue(0),
        iterateRows: jest.fn(() => (async function* () {
            yield ['1'];
        })()),
        getDecimalDelimiter: jest.fn().mockReturnValue('.'),
        getCsvDelimiter: jest.fn().mockReturnValue(',')
    };
}
