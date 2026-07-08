import { oracleTuningAdvisor } from '../../extensions/oracle/src/oracleTuningAdvisor';

describe('OracleTuningAdvisor', () => {
    const advisor = oracleTuningAdvisor;

    it('returns Oracle-specific recommendations from a JSON explain plan', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders o, customers c WHERE c.id = o.customer_id',
            explainPlanText: JSON.stringify({
                plan: {
                    operation: 'SELECT STATEMENT',
                    cost: 150000,
                    cardinality: 125000,
                    children: [
                        {
                            operation: 'TABLE ACCESS',
                            options: 'FULL',
                            object_name: 'ORDERS',
                            cost: 100000,
                            cardinality: 100000,
                            children: [],
                        },
                        {
                            operation: 'NESTED LOOPS',
                            cost: 50000,
                            cardinality: 50000,
                            children: [],
                        },
                    ],
                },
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toEqual(
            expect.arrayContaining(['ORTA-001', 'ORTA-002', 'ORTA-003', 'ORTA-004']),
        );
    });

    it('detects cartesian joins', () => {
        const report = advisor.analyze({
            sql: 'SELECT a.id FROM t1 a, t2 b',
            explainPlanText: JSON.stringify({
                plan: {
                    operation: 'MERGE JOIN',
                    options: 'CARTESIAN',
                    cost: 500,
                    cardinality: 50000,
                    children: [],
                },
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toContain('ORTA-005');
    });

    it('returns empty recommendations for simple queries', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM t WHERE id = 1',
            explainPlanText: JSON.stringify({
                plan: {
                    operation: 'INDEX',
                    options: 'UNIQUE SCAN',
                    cost: 1,
                    cardinality: 1,
                    children: [],
                },
            }),
        });

        expect(report.recommendations).toHaveLength(0);
    });
});
