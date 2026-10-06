import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importDataToSqlite } from '../import/sqliteImporter';

interface TestWorkbookWriter {
    startSheet(sheetName: string, columnCount: number, headers?: string[]): void;
    writeRow(row: unknown[]): void;
    endSheet(): void;
    finalize(): Promise<void>;
}

const spreadsheetTasks = require('@justybase/spreadsheet-tasks') as {
    XlsxWriter: new (filePath: string) => TestWorkbookWriter;
    XlsbWriter: new (filePath: string) => TestWorkbookWriter;
};

const FORMATS: Array<{
    format: 'xlsx' | 'xlsb';
    extension: string;
    createWriter: (filePath: string) => TestWorkbookWriter;
}> = [
    {
        format: 'xlsx',
        extension: '.xlsx',
        createWriter: (filePath) => new spreadsheetTasks.XlsxWriter(filePath),
    },
    {
        format: 'xlsb',
        extension: '.xlsb',
        createWriter: (filePath) => new spreadsheetTasks.XlsbWriter(filePath),
    },
];

async function writeTwoSheetWorkbook(
    filePath: string,
    createWriter: (filePath: string) => TestWorkbookWriter,
): Promise<void> {
    const writer = createWriter(filePath);
    writer.startSheet('First', 2, ['ID', 'NAME']);
    writer.writeRow([1, 'Alice']);
    writer.endSheet();
    writer.startSheet('Second', 2, ['CODE', 'VALUE']);
    writer.writeRow([9, 'Zulu']);
    writer.writeRow([10, 'Yankee']);
    writer.endSheet();
    await writer.finalize();
}

function readSqliteRows(
    databasePath: string,
): Array<{ CODE: number; VALUE: string }> {
    const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (databasePath: string) => {
            prepare(sql: string): { all(): unknown[] };
            close(): void;
        };
    };
    const database = new DatabaseSync(databasePath);
    try {
        return database
            .prepare('SELECT CODE, VALUE FROM main.orders ORDER BY CODE')
            .all() as Array<{ CODE: number; VALUE: string }>;
    } finally {
        database.close();
    }
}

describe.each(FORMATS)(
    'SQLite import worksheet selection ($format)',
    ({ extension, createWriter }) => {
        let tempDir: string;
        let filePath: string;

        beforeEach(async () => {
            tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), `sqlite-sheet-${extension.slice(1)}-`),
            );
            filePath = path.join(tempDir, `two-sheets${extension}`);
            await writeTwoSheetWorkbook(filePath, createWriter);
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function sqliteConnection(databasePath: string) {
            return {
                name: 'sqlite-target',
                host: 'local',
                database: databasePath,
                user: 'sqlite',
                password: '',
                dbType: 'sqlite',
            } as never;
        }

        it('imports only the selected worksheet rows', async () => {
            const databasePath = path.join(tempDir, 'selected.db');

            const result = await importDataToSqlite(
                filePath,
                'main.orders',
                sqliteConnection(databasePath),
                undefined,
                undefined,
                { sheetName: 'Second', hasHeaders: true },
            );

            expect(result.success).toBe(true);
            expect(readSqliteRows(databasePath)).toEqual([
                { CODE: 9, VALUE: 'Zulu' },
                { CODE: 10, VALUE: 'Yankee' },
            ]);
        });

        it('aborts before creating the database for an unknown worksheet', async () => {
            const databasePath = path.join(tempDir, 'aborted.db');

            await expect(
                importDataToSqlite(
                    filePath,
                    'main.orders',
                    sqliteConnection(databasePath),
                    undefined,
                    undefined,
                    { sheetName: 'Missing', hasHeaders: true },
                ),
            ).rejects.toThrow(/Worksheet "Missing" was not found/);

            expect(fs.existsSync(databasePath)).toBe(false);
        });
    },
);
