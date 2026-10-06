import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createSnowflakeClipboardImportResult,
    createSnowflakeStagedImportResult,
    planSnowflakeStageImport,
    renderSnowflakeStageImportPlanMarkdown,
} from '../../../../extensions/snowflake/src/snowflakeImportPlanner';

interface TestWorkbookWriter {
    startSheet(sheetName: string, columnCount: number, headers?: string[]): void;
    writeRow(row: unknown[]): void;
    endSheet(): void;
    finalize(): Promise<void>;
}

const XlsxWriter = require('@justybase/spreadsheet-tasks').XlsxWriter as new (
    filePath: string,
) => TestWorkbookWriter;

describe('snowflakeImportPlanner', () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowflake-import-planner-'));
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('builds a staged Snowflake import plan for CSV files', async () => {
        const sourceFile = path.join(tempDir, 'orders.csv');
        fs.writeFileSync(sourceFile, 'order_id,customer_name,total\n1,Alice,10.50\n2,Bob,11.25\n', 'utf8');

        const plan = await planSnowflakeStageImport(sourceFile, 'analytics.public.orders');
        const markdown = renderSnowflakeStageImportPlanMarkdown(plan);
        const result = await createSnowflakeStagedImportResult(sourceFile, 'analytics.public.orders');

        expect(plan.rowCountEstimate).toBe(2);
        expect(plan.columns).toHaveLength(3);
        expect(plan.createTableSql).toContain('CREATE TABLE IF NOT EXISTS');
        expect(plan.createTableSql).toContain('"analytics"."public"."orders"');
        expect(plan.copyIntoSql).toContain('COPY INTO');
        expect(plan.copyIntoSql).toContain('FIELD_DELIMITER =');
        expect(markdown).toContain('# Snowflake staged import workflow');
        expect(markdown).toContain('Generated COPY INTO SQL');
        expect(result.details?.snowflakeWorkflow?.workflowMarkdown).toContain('Recommended column mapping');
    });

    it('plans the selected worksheet of an Excel workbook', async () => {
        const sourceFile = path.join(tempDir, 'two-sheets.xlsx');
        const writer = new XlsxWriter(sourceFile);
        writer.startSheet('First', 2, ['ID', 'NAME']);
        writer.writeRow([1, 'Alice']);
        writer.endSheet();
        writer.startSheet('Second', 2, ['CODE', 'VALUE']);
        writer.writeRow([9, 'Zulu']);
        writer.writeRow([10, 'Yankee']);
        writer.endSheet();
        await writer.finalize();

        const plan = await planSnowflakeStageImport(sourceFile, 'analytics.public.orders', {
            sheetName: 'Second',
        });
        const markdown = renderSnowflakeStageImportPlanMarkdown(plan);

        expect(plan.worksheet).toBe('Second');
        expect(plan.rowCountEstimate).toBe(2);
        expect(plan.columns.map((column) => column.sourceColumn)).toEqual(['CODE', 'VALUE']);
        expect(markdown).toContain('- Worksheet: `Second`');
    });

    it('detects comma decimals when dotted dates share the sample', async () => {
        const sourceFile = path.join(tempDir, 'pl-dates.csv');
        fs.writeFileSync(sourceFile, 'DATA;KWOTA\n07.06.2024;1 234,56\n08.06.2024;2 345,67\n', 'utf8');

        const plan = await planSnowflakeStageImport(sourceFile, 'analytics.public.orders');

        expect(plan.detectedDecimalDelimiter).toBe(',');
        const kwota = plan.columns.find((column) => column.sourceColumn === 'KWOTA');
        expect(kwota?.sourceType).toMatch(/^NUMERIC/);
    });

    it('rejects an unknown worksheet before producing a plan', async () => {
        const sourceFile = path.join(tempDir, 'unknown-sheet.xlsx');
        const writer = new XlsxWriter(sourceFile);
        writer.startSheet('First', 1, ['ID']);
        writer.writeRow([1]);
        writer.endSheet();
        await writer.finalize();

        await expect(
            planSnowflakeStageImport(sourceFile, 'analytics.public.orders', {
                sheetName: 'Missing',
            }),
        ).rejects.toThrow(/Worksheet "Missing" was not found/);
    });

    it('returns actionable clipboard guidance for Snowflake', () => {
        const result = createSnowflakeClipboardImportResult('analytics.public.orders');

        expect(result.success).toBe(false);
        expect(result.message).toContain('clipboard import is not executed directly');
        expect(result.details?.snowflakeWorkflow?.workflowMarkdown).toContain('# Snowflake clipboard import guidance');
    });
});
