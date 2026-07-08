import { DuckDbTuningAdvisor } from '../../extensions/duckdb/src/duckdbTuningAdvisor';

describe('DuckDbTuningAdvisor', () => {
    const advisor = new DuckDbTuningAdvisor();

    it('returns DuckDB-specific recommendations from a JSON explain plan', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
            explainPlanText: JSON.stringify({
                type: 'NESTED_LOOP_JOIN',
                name: 'Nested Loop Join',
                estimated_cardinality: 125000,
                children: [
                    {
                        type: 'SEQ_SCAN',
                        name: 'Sequential Scan',
                        estimated_cardinality: 100000,
                        children: [],
                    },
                ],
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toEqual(
            expect.arrayContaining(['DKTA-001', 'DKTA-002', 'DKTA-003']),
        );
    });

    it('detects cardinality divergence when actual rows available', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM orders',
            explainPlanText: JSON.stringify({
                type: 'SEQ_SCAN',
                name: 'Seq Scan',
                estimated_cardinality: 10,
                actual_rows: 50000,
                children: [],
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toContain('DKTA-005');
    });

    it('returns empty recommendations for simple queries', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM t WHERE id = 1',
            explainPlanText: JSON.stringify({
                type: 'INDEX_SCAN',
                name: 'Index Scan',
                estimated_cardinality: 1,
                children: [],
            }),
        });

        expect(report.recommendations).toHaveLength(0);
    });
});
