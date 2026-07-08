import { PostgreSqlTuningAdvisor } from '../../extensions/postgresql/src/postgresqlTuningAdvisor';

describe('PostgreSqlTuningAdvisor', () => {
    const advisor = new PostgreSqlTuningAdvisor();

    it('returns PostgreSQL-specific recommendations from a JSON explain plan', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
            explainPlanText: JSON.stringify([
                {
                    Plan: {
                        'Node Type': 'Nested Loop',
                        'Startup Cost': 0,
                        'Total Cost': 250000,
                        'Plan Rows': 125000,
                        'Plan Width': 64,
                        Plans: [
                            {
                                'Node Type': 'Seq Scan',
                                'Relation Name': 'orders',
                                Schema: 'public',
                                'Startup Cost': 0,
                                'Total Cost': 100000,
                                'Plan Rows': 100000,
                                'Plan Width': 48,
                            },
                        ],
                    },
                },
            ]),
        });

        expect(report.recommendations.map((item) => item.id)).toEqual(
            expect.arrayContaining(['PGTA-001', 'PGTA-002', 'PGTA-003', 'PGTA-004']),
        );
    });

    it('uses EXPLAIN ANALYZE execution time when present', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM orders',
            explainPlanText: JSON.stringify([
                {
                    Plan: {
                        'Node Type': 'Index Scan',
                        'Startup Cost': 0.15,
                        'Total Cost': 15.25,
                        'Plan Rows': 10,
                        'Plan Width': 8,
                        'Actual Rows': 1000,
                        'Actual Startup Time': 0.05,
                        'Actual Total Time': 850.5,
                    },
                    'Planning Time': 1.2,
                    'Execution Time': 850.5,
                },
            ]),
        });

        expect(report.recommendations.map((item) => item.id)).toEqual(expect.arrayContaining(['PGTA-005', 'PGTA-006']));
    });

    it('warns when PostgreSQL spills sort work to disk', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders ORDER BY created_at',
            explainPlanText: JSON.stringify([
                {
                    Plan: {
                        'Node Type': 'Sort',
                        'Startup Cost': 1200,
                        'Total Cost': 2400,
                        'Plan Rows': 75000,
                        'Plan Width': 64,
                        'Sort Method': 'external merge',
                        'Sort Space Type': 'Disk',
                        'Disk Usage': 32768,
                        Plans: [
                            {
                                'Node Type': 'Seq Scan',
                                'Relation Name': 'orders',
                                Schema: 'public',
                                'Startup Cost': 0,
                                'Total Cost': 900,
                                'Plan Rows': 75000,
                                'Plan Width': 64,
                            },
                        ],
                    },
                },
            ]),
        });

        expect(report.recommendations.map((item) => item.id)).toContain('PGTA-007');
        expect(report.recommendations.find((item) => item.id === 'PGTA-007')?.summary).toContain('spilled to disk');
    });
});
