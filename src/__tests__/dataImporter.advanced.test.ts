import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { importDataToNetezzaAdvanced } from '../import/dataImporter';

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
}));

jest.mock('../import/netezzaVirtualImport', () => ({
    buildNetezzaVirtualImportName: jest.fn(() => 'virtual_import.csv'),
    registerNetezzaImportStream: jest.fn(() => jest.fn()),
    destroyNetezzaImportStream: jest.fn(),
}));

const createConnection = createConnectedDatabaseConnectionFromDetails as jest.Mock;

function reader(rows: Array<Record<string, unknown>>) {
    const names = rows[0] ? Object.keys(rows[0]) : [];
    let index = -1;
    return {
        fieldCount: names.length,
        getName: (fieldIndex: number) => names[fieldIndex],
        getValue: (fieldIndex: number) => rows[index]?.[names[fieldIndex]] ?? null,
        read: jest.fn(async () => {
            index += 1;
            return index < rows.length;
        }),
        close: jest.fn(async () => undefined),
    };
}

function fakeConnection(options: {
    counts?: number[];
    statusRows?: Array<Record<string, unknown>>;
    failStatus?: boolean;
    failCount?: boolean;
    emptyCount?: boolean;
}) {
    const commands: string[] = [];
    const counts = [...(options.counts ?? [])];
    const connection = {
        on: jest.fn(),
        close: jest.fn(async () => undefined),
        createCommand: jest.fn((sql: string) => {
            commands.push(sql);
            if (sql.startsWith('SELECT COUNT(*)')) {
                if (options.failCount) {
                    throw new Error('count unavailable');
                }
                if (options.emptyCount) {
                    return {
                        commandTimeout: 0,
                        execute: jest.fn(async () => undefined),
                        executeReader: jest.fn(async () => reader([])),
                    };
                }
                const count = counts.shift();
                return {
                    commandTimeout: 0,
                    execute: jest.fn(async () => undefined),
                    executeReader: jest.fn(async () => reader([{ ROW_COUNT: count }])),
                };
            }
            if (sql.includes('_V_LOAD_STATUS')) {
                return {
                    commandTimeout: 0,
                    execute: jest.fn(async () => undefined),
                    executeReader: jest.fn(async () => {
                        if (options.failStatus) {
                            throw new Error('load status unavailable');
                        }
                        return reader(options.statusRows ?? []);
                    }),
                };
            }
            return {
                commandTimeout: 0,
                execute: jest.fn(async () => undefined),
                executeReader: jest.fn(async () => reader([])),
            };
        }),
    };
    return { connection, commands };
}

describe('importDataToNetezzaAdvanced reporting', () => {
    let tempDir: string;
    let csvPath: string;

    beforeEach(() => {
        jest.clearAllMocks();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-import-'));
        csvPath = path.join(tempDir, 'source.csv');
        fs.writeFileSync(csvPath, 'id\n1\n2\n3,EXTRA\n');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('reports counted inserted and rejected rows when rejects are recoverable', async () => {
        const { connection, commands } = fakeConnection({
            counts: [10, 12],
            statusRows: [{ TABLENAME: 'TARGET', ROWSINSERTED: 99, ROWSREJECTED: 7 }],
        });
        createConnection.mockResolvedValue(connection);

        const result = await importDataToNetezzaAdvanced(
            csvPath,
            'ADMIN.TARGET',
            { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            undefined,
            undefined,
            {
                selectedColumnIndexes: [0],
                hasHeaders: true,
                appendToExistingTable: true,
                maxErrors: 2147483647,
            },
        );

        if (!result.success) {
            throw new Error(result.message);
        }
        expect(result.details?.rowsInserted).toBe(2);
        expect(result.details?.rowsRejected).toBe(1);
        expect(result.message).toContain('1 rejected row');
        expect(result.details?.warnings).toContainEqual(
            expect.stringContaining('rejected by the database load'),
        );
        expect(commands.filter((sql) => sql.startsWith('SELECT COUNT(*)'))).toHaveLength(2);
    });

    it('uses the load status for a successful abort-mode import', async () => {
        const { connection, commands } = fakeConnection({
            statusRows: [{ TABLENAME: 'TARGET', ROWSINSERTED: 3, ROWSREJECTED: 0, BYTESDOWNLOADED: 512 }],
        });
        createConnection.mockResolvedValue(connection);

        const result = await importDataToNetezzaAdvanced(
            csvPath,
            'ADMIN.TARGET',
            { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            undefined,
            undefined,
            {
                selectedColumnIndexes: [0],
                hasHeaders: true,
                appendToExistingTable: true,
            },
        );

        if (!result.success) {
            throw new Error(result.message);
        }
        expect(result.message).toBe('Import completed successfully');
        expect(result.details?.rowsInserted).toBe(3);
        expect(result.details?.rowsRejected).toBe(0);
        expect(result.details?.warnings).toContainEqual(
            expect.stringContaining('extra fields were ignored'),
        );
        expect(commands.some((sql) => sql.startsWith('SELECT COUNT(*)'))).toBe(false);
        expect(commands.some((sql) => sql.includes('_V_LOAD_STATUS'))).toBe(true);
    });

    it('falls back when the pre-load row count is unavailable', async () => {
        const statusRows = [{ TABLENAME: 'TARGET', ROWSINSERTED: 3, ROWSREJECTED: 0 }];

        const failed = fakeConnection({ failCount: true, statusRows });
        createConnection.mockResolvedValueOnce(failed.connection);
        const failedResult = await importDataToNetezzaAdvanced(
            csvPath,
            'ADMIN.TARGET',
            { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            undefined,
            undefined,
            {
                selectedColumnIndexes: [0],
                hasHeaders: true,
                appendToExistingTable: true,
                maxErrors: 2147483647,
            },
        );
        if (!failedResult.success) {
            throw new Error(failedResult.message);
        }
        expect(failedResult.details?.rowsInserted).toBe(3);

        const empty = fakeConnection({ emptyCount: true, statusRows });
        createConnection.mockResolvedValueOnce(empty.connection);
        const emptyResult = await importDataToNetezzaAdvanced(
            csvPath,
            'ADMIN.TARGET',
            { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            undefined,
            undefined,
            {
                selectedColumnIndexes: [0],
                hasHeaders: true,
                appendToExistingTable: true,
                maxErrors: 2147483647,
            },
        );
        if (!emptyResult.success) {
            throw new Error(emptyResult.message);
        }
        expect(emptyResult.details?.rowsInserted).toBe(3);
    });

    it('falls back to source rows when load status cannot be read', async () => {
        const { connection } = fakeConnection({ failStatus: true });
        createConnection.mockResolvedValue(connection);

        const result = await importDataToNetezzaAdvanced(
            csvPath,
            'ADMIN.TARGET',
            { dbType: 'netezza', host: 'localhost', database: 'JUST_DATA', user: 'ADMIN' } as never,
            undefined,
            undefined,
            {
                selectedColumnIndexes: [0],
                hasHeaders: true,
                appendToExistingTable: true,
            },
        );

        if (!result.success) {
            throw new Error(result.message);
        }
        expect(result.details?.rowsInserted).toBe(3);
        expect(result.details?.rowsRejected).toBeUndefined();
        expect(result.details?.warnings).toContainEqual(
            expect.stringContaining('extra fields were ignored'),
        );
    });
});
