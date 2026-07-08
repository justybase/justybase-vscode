import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createSnowflakeClipboardImportResult,
    createSnowflakeStagedImportResult,
    planSnowflakeStageImport,
    renderSnowflakeStageImportPlanMarkdown,
} from '../../../../extensions/snowflake/src/snowflakeImportPlanner';

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

    it('returns actionable clipboard guidance for Snowflake', () => {
        const result = createSnowflakeClipboardImportResult('analytics.public.orders');

        expect(result.success).toBe(false);
        expect(result.message).toContain('clipboard import is not executed directly');
        expect(result.details?.snowflakeWorkflow?.workflowMarkdown).toContain('# Snowflake clipboard import guidance');
    });
});
