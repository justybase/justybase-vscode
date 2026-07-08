import { Db2TuningAdvisor } from '../../extensions/db2/src/db2TuningAdvisor';

describe('Db2TuningAdvisor', () => {
    const advisor = new Db2TuningAdvisor();

    it('returns Db2-specific recommendations from a JSON explain plan', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
            explainPlanText: JSON.stringify({
                plan: {
                    operator_type: 'NLJOIN',
                    total_cost: 150000,
                    estimated_rows: 125000,
                    children: [
                        {
                            operator_type: 'TBSCAN',
                            object_name: 'ORDERS',
                            total_cost: 100000,
                            estimated_rows: 100000,
                            children: [],
                        },
                    ],
                },
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toEqual(
            expect.arrayContaining(['DB2TA-001', 'DB2TA-002', 'DB2TA-003', 'DB2TA-004']),
        );
    });

    it('detects sort with high cardinality', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM orders ORDER BY created_at',
            explainPlanText: JSON.stringify({
                plan: {
                    operator_type: 'SORT',
                    total_cost: 5000,
                    estimated_rows: 200000,
                    children: [],
                },
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toContain('DB2TA-005');
    });

    it('returns empty recommendations for simple queries', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM t WHERE id = 1',
            explainPlanText: JSON.stringify({
                plan: {
                    operator_type: 'IXSCAN',
                    total_cost: 2,
                    estimated_rows: 1,
                    children: [],
                },
            }),
        });

        expect(report.recommendations).toHaveLength(0);
    });
});
