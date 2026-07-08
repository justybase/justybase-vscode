import {
    analyzeSnowflakeExplainPlan,
    buildSnowflakeExplainQuery,
    buildSnowflakeQueryOperatorStatsQuery,
    buildSnowflakeRecentQueryHistoryQuery,
    isSnowflakeExplainJson,
    parseSnowflakeExplainJson,
    renderSnowflakeExplainPlan,
    renderSnowflakeQueryProfileMarkdown,
} from '../../../../extensions/snowflake/src/snowflakeQueryProfile';

describe('snowflakeQueryProfile', () => {
    const explainJson = JSON.stringify({
        operation: 'Result',
        operations: [
            {
                operation: 'TableScan',
                objects: ['ANALYTICS.PUBLIC.ORDERS'],
                expressions: ['customer_id'],
                bytesScanned: 1024,
            },
            {
                operation: 'Repartition',
                children: [
                    {
                        operation: 'Sort',
                    },
                ],
            },
        ],
    });

    it('builds explain and profile helper SQL', () => {
        expect(buildSnowflakeExplainQuery('select * from orders')).toBe('EXPLAIN USING JSON select * from orders');
        expect(buildSnowflakeRecentQueryHistoryQuery(5)).toContain('QUERY_HISTORY_BY_SESSION');
        expect(buildSnowflakeQueryOperatorStatsQuery("'abc'")).toContain("GET_QUERY_OPERATOR_STATS('abc')");
    });

    it('parses and renders explain JSON', () => {
        expect(isSnowflakeExplainJson(explainJson)).toBe(true);

        const plan = parseSnowflakeExplainJson(explainJson);
        const rendered = renderSnowflakeExplainPlan(plan);

        expect(plan.root.operation).toBe('Result');
        expect(plan.root.children).toHaveLength(2);
        expect(rendered).toContain('- Result');
        expect(rendered).toContain('TableScan [ANALYTICS.PUBLIC.ORDERS]');
        expect(rendered).toContain('Repartition');
    });

    it('produces heuristic tuning recommendations from explain JSON', () => {
        const report = analyzeSnowflakeExplainPlan(explainJson, 'select * from analytics.public.orders');

        expect(report.metadata.recommendationCount).toBeGreaterThan(0);
        expect(report.recommendations.some((item) => item.id === 'SFTA-001')).toBe(true);
        expect(report.recommendations.some((item) => item.id === 'SFTA-003')).toBe(true);
    });

    it('renders query operator stats into markdown', () => {
        const markdown = renderSnowflakeQueryProfileMarkdown([
            {
                OPERATOR_NAME: 'TableScan',
                OUTPUT_ROWS: 100,
                BYTES_SCANNED: 2048,
                PARTITIONS_SCANNED: 2,
                PARTITIONS_TOTAL: 8,
                SPILLED_BYTES: 0,
                OBJECTS: 'ANALYTICS.PUBLIC.ORDERS',
            },
        ]);

        expect(markdown).toContain('| Operator | Output Rows | Bytes Scanned | Partitions | Spilled Bytes | Objects |');
        expect(markdown).toContain('TableScan');
        expect(markdown).toContain('ANALYTICS.PUBLIC.ORDERS');
    });
});
