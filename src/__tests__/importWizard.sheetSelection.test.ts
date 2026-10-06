import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportWizardSession } from '../import/wizard/ImportWizardSession';
import { ImportPreviewService } from '../import/wizard/ImportPreviewService';
import { ImportValidationService } from '../import/wizard/ImportValidationService';
import type { DatabaseImportWizardAdapter } from '../import/wizard/adapters/DatabaseImportWizardAdapter';

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
    writer.writeRow([2, 'Bob']);
    writer.endSheet();
    writer.startSheet('Second', 2, ['CODE', 'VALUE']);
    writer.writeRow([9, 'Zulu']);
    writer.writeRow([10, 'Yankee']);
    writer.endSheet();
    await writer.finalize();
}

function createFakeAdapter(): DatabaseImportWizardAdapter & {
    execute: jest.Mock;
} {
    return {
        kind: 'postgresql',
        supportsAppendToExistingTable: true,
        normalizeTargetColumnName: (name: string) => name,
        getSupportedTypeOptions: () => ['BIGINT', 'VARCHAR(255)'],
        mapInferredType: (typeName: string) => typeName.toUpperCase(),
        validateTypeOverride: () => [],
        buildCreateTableSql: (input) => `CREATE TABLE ${input.targetTable} (...)`,
        buildExecutionPlan: (input) => ({
            mode: 'direct',
            createTableSql: `CREATE TABLE ${input.targetTable} (...)`,
            loadSql: 'LOAD PREVIEW SQL',
            warnings: [],
        }),
        execute: jest.fn(async () => ({ success: true, message: 'ok' })),
        getExecutionMode: () => 'direct',
    };
}

describe.each(FORMATS)(
    'ImportWizardSession worksheet selection ($format)',
    ({ extension, createWriter }) => {
        let tempDir: string;
        let filePath: string;

        beforeEach(async () => {
            tempDir = fs.mkdtempSync(
                path.join(os.tmpdir(), `wizard-sheet-${extension.slice(1)}-`),
            );
            filePath = path.join(tempDir, `two-sheets${extension}`);
            await writeTwoSheetWorkbook(filePath, createWriter);
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        function createSession(adapter: DatabaseImportWizardAdapter) {
            return new ImportWizardSession(
                {
                    filePath,
                    targetTable: 'public.orders',
                    connectionDetails: {
                        dbType: 'postgresql',
                        host: 'localhost',
                        database: 'warehouse',
                        user: 'postgres',
                    } as never,
                    connectionName: 'WAREHOUSE',
                    previewRowCount: 2,
                    validationSampleSize: 10,
                },
                adapter,
                new ImportPreviewService(),
                new ImportValidationService(),
            );
        }

        it('exposes both worksheets and starts on the first one', async () => {
            const adapter = createFakeAdapter();
            const session = createSession(adapter);

            const state = await session.initialize();

            expect(state.availableSheets).toEqual(['First', 'Second']);
            expect(state.canChangeSheet).toBe(true);
            expect(state.sheetName).toBe('First');
            expect(state.sourceHeaders).toEqual(['ID', 'NAME']);
            expect(state.previewRows).toEqual([
                ['1', 'Alice'],
                ['2', 'Bob'],
            ]);
        });

        it('refreshes preview data for a non-first worksheet', async () => {
            const adapter = createFakeAdapter();
            const session = createSession(adapter);
            await session.initialize();

            const state = await session.setSheet('Second');

            expect(state.sheetName).toBe('Second');
            expect(state.sourceHeaders).toEqual(['CODE', 'VALUE']);
            expect(state.previewRows).toEqual([
                ['9', 'Zulu'],
                ['10', 'Yankee'],
            ]);
        });

        it('passes the selected worksheet to import execution', async () => {
            const adapter = createFakeAdapter();
            const session = createSession(adapter);
            await session.initialize();
            await session.setSheet('Second');

            await session.executeImport();

            expect(adapter.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    filePath,
                    sheetName: 'Second',
                    columnOptions: expect.objectContaining({
                        sheetName: 'Second',
                    }),
                }),
            );
        });

        it('rejects an unknown worksheet before changing state', async () => {
            const adapter = createFakeAdapter();
            const session = createSession(adapter);
            await session.initialize();

            await expect(session.setSheet('Missing')).rejects.toThrow(
                'Unknown worksheet: Missing',
            );
            expect(session.getState().sheetName).toBe('First');
        });
    },
);
