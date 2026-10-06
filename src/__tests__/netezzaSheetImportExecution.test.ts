import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { importDataToNetezzaAdvanced } from '../import/dataImporter';
import * as connectionFactory from '../core/connectionFactory';
import * as netezzaVirtualImport from '../import/netezzaVirtualImport';

interface TestWorkbookWriter {
    startSheet(sheetName: string, columnCount: number, headers?: string[]): void;
    writeRow(row: unknown[]): void;
    endSheet(): void;
    finalize(): Promise<void>;
}

const spreadsheetTasks = require('@justybase/spreadsheet-tasks') as {
    XlsxWriter: new (filePath: string) => TestWorkbookWriter;
};

const validConnection = {
    host: '127.0.0.1',
    port: 5480,
    database: 'TESTDB',
    user: 'admin',
    password: 'secret',
};

async function writeTwoSheetWorkbook(filePath: string): Promise<void> {
    const writer = new spreadsheetTasks.XlsxWriter(filePath);
    writer.startSheet('First', 2, ['ID', 'NAME']);
    writer.writeRow([1, 'Alice']);
    writer.endSheet();
    writer.startSheet('Second', 2, ['CODE', 'VALUE']);
    writer.writeRow([9, 'Zulu']);
    writer.writeRow([10, 'Yankee']);
    writer.endSheet();
    await writer.finalize();
}

describe('importDataToNetezzaAdvanced worksheet selection', () => {
    let tempDir: string;
    let filePath: string;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netezza-sheet-advanced-'));
        filePath = path.join(tempDir, 'two-sheets.xlsx');
        await writeTwoSheetWorkbook(filePath);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function stubConnection(): {
        executedSql: string[];
        loadSql: () => string | undefined;
    } {
        const executedSql: string[] = [];
        let capturedStream: Readable | undefined;
        let streamedData = '';
        let loadSql: string | undefined;

        jest.spyOn(
            netezzaVirtualImport,
            'registerNetezzaImportStream',
        ).mockImplementation((_streamName, stream) => {
            capturedStream = stream;
            return () => undefined;
        });

        const connection = {
            _connected: true,
            on: jest.fn(),
            createCommand: jest.fn((sql: string) => ({
                commandTimeout: 0,
                execute: jest.fn(async () => {
                    executedSql.push(sql);
                    if (sql.includes('FROM EXTERNAL') && capturedStream) {
                        loadSql = sql;
                        const chunks: string[] = [];
                        for await (const chunk of capturedStream) {
                            chunks.push(String(chunk));
                        }
                        streamedData = chunks.join('');
                    }
                }),
            })),
            close: jest.fn(async () => undefined),
        };

        jest.spyOn(
            connectionFactory,
            'createConnectedDatabaseConnectionFromDetails',
        ).mockResolvedValue(connection as never);

        return {
            executedSql,
            loadSql: () => (loadSql ? `${loadSql}\n${streamedData}` : undefined),
        };
    }

    it('loads rows from the selected worksheet', async () => {
        const stub = stubConnection();

        const result = await importDataToNetezzaAdvanced(
            filePath,
            'TEST_TABLE',
            validConnection,
            undefined,
            undefined,
            { sheetName: 'Second', hasHeaders: true },
        );

        expect(result.success).toBe(true);
        expect(stub.executedSql).toHaveLength(2);
        expect(stub.executedSql[0]).toContain('"CODE"');
        const loadSql = stub.loadSql();
        expect(loadSql).toBeDefined();
        expect(loadSql).toContain('"CODE"');
        expect(loadSql).toContain('9\tZulu');
        expect(loadSql).toContain('10\tYankee');
    });

    it('aborts before connecting when the worksheet does not exist', async () => {
        const factorySpy = jest.spyOn(
            connectionFactory,
            'createConnectedDatabaseConnectionFromDetails',
        );

        const result = await importDataToNetezzaAdvanced(
            filePath,
            'TEST_TABLE',
            validConnection,
            undefined,
            undefined,
            { sheetName: 'Missing', hasHeaders: true },
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Worksheet "Missing" was not found');
        expect(result.message).toContain('Available worksheets: First, Second.');
        expect(factorySpy).not.toHaveBeenCalled();
    });
});
