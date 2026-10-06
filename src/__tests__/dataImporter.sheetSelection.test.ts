import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import {
    NetezzaImporter,
    importDataToNetezza,
} from '../import/dataImporter';

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

type WorkbookFormat = 'xlsx' | 'xlsb';

const FORMATS: Array<{
    format: WorkbookFormat;
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
    writer.writeRow([2, 'Bob']);
    writer.endSheet();
    writer.startSheet('Second', 2, ['CODE', 'VALUE']);
    writer.writeRow([9, 'Zulu']);
    writer.writeRow([10, 'Yankee']);
    writer.endSheet();
    await writer.finalize();
}

async function drainStream(stream: Readable): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of stream) {
        chunks.push(String(chunk));
    }
    return chunks.join('');
}

const validConnection = {
    host: '127.0.0.1',
    port: 5480,
    database: 'TESTDB',
    user: 'admin',
    password: 'secret',
};

describe.each(FORMATS)(
    'NetezzaImporter worksheet selection ($format)',
    ({ extension, createWriter }) => {
        let tempDir: string;
        let filePath: string;

        beforeEach(async () => {
            tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), `netezza-sheet-${extension.slice(1)}-`),
            );
            filePath = path.join(tempDir, `two-sheets${extension}`);
            await writeTwoSheetWorkbook(filePath, createWriter);
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('lists worksheets in workbook order', async () => {
            const importer = new NetezzaImporter(filePath, 'TEST_TABLE');

            await expect(importer.getAvailableSheetNames()).resolves.toEqual([
                'First',
                'Second',
            ]);
        });

        it('defaults to the first worksheet', async () => {
            const importer = new NetezzaImporter(filePath, 'TEST_TABLE');

            await importer.analyzeDataTypes();

            expect(importer.getSelectedSheet()).toBeUndefined();
            expect(importer.getSqlHeaders()).toEqual(['ID', 'NAME']);
            expect(importer.getRowsCount()).toBe(2);
            await expect(importer.getSampleRows(5)).resolves.toEqual([
                ['1', 'Alice'],
                ['2', 'Bob'],
            ]);
            await expect(
                drainStream(await importer.createDataStream()),
            ).resolves.toBe('1\tAlice\n2\tBob\n');
        });

        it('reads the selected non-first worksheet across preview and stream paths', async () => {
            const importer = new NetezzaImporter(filePath, 'TEST_TABLE');
            importer.setSelectedSheet('Second');

            await importer.analyzeDataTypes();

            expect(importer.getSelectedSheet()).toBe('Second');
            expect(importer.getSqlHeaders()).toEqual(['CODE', 'VALUE']);
            expect(importer.getRowsCount()).toBe(2);
            await expect(importer.getSampleRows(5)).resolves.toEqual([
                ['9', 'Zulu'],
                ['10', 'Yankee'],
            ]);
            await expect(importer.getAllRows()).resolves.toEqual([
                ['9', 'Zulu'],
                ['10', 'Yankee'],
            ]);
            await expect(
                drainStream(await importer.createDataStream()),
            ).resolves.toBe('9\tZulu\n10\tYankee\n');
        });

        it('resolves worksheet names on demand when streaming without prior analysis', async () => {
            const importer = new NetezzaImporter(filePath, 'TEST_TABLE');
            importer.setSelectedSheet('Second');

            await drainStream(await importer.createDataStream());

            expect(importer.getRowsCount()).toBe(2);
            await expect(importer.getSampleRows(5)).resolves.toEqual([
                ['9', 'Zulu'],
                ['10', 'Yankee'],
            ]);
        });

        it('aborts with the available worksheet list for an unknown selection', async () => {
            const importer = new NetezzaImporter(filePath, 'TEST_TABLE');
            importer.setSelectedSheet('Missing');

            await expect(importer.analyzeDataTypes()).rejects.toThrow(
                /Worksheet "Missing" was not found/,
            );
            await expect(importer.analyzeDataTypes()).rejects.toThrow(
                /Available worksheets: First, Second\./,
            );
        });

        it('recovers after an unknown selection is corrected', async () => {
            const importer = new NetezzaImporter(filePath, 'TEST_TABLE');
            importer.setSelectedSheet('Missing');
            await expect(importer.analyzeDataTypes()).rejects.toThrow();

            importer.setSelectedSheet('Second');
            await importer.analyzeDataTypes();

            expect(importer.getSqlHeaders()).toEqual(['CODE', 'VALUE']);
        });

        it('fails the Netezza import job before connecting for an unknown worksheet', async () => {
            const result = await importDataToNetezza(
                filePath,
                'TEST_TABLE',
                validConnection,
                undefined,
                undefined,
                { sheetName: 'Missing' },
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('Worksheet "Missing" was not found');
            expect(result.message).toContain(
                'Available worksheets: First, Second.',
            );
        });
    },
);
