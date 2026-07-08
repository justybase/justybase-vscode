import { MsSqlTuningAdvisor } from '../../extensions/mssql/src/mssqlTuningAdvisor';

describe('MsSqlTuningAdvisor', () => {
    const advisor = new MsSqlTuningAdvisor();

    it('returns MSSQL-specific recommendations from a JSON explain plan', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
            explainPlanText: JSON.stringify({
                PhysicalOp: 'Nested Loops',
                LogicalOp: 'Inner Join',
                EstimateRows: 5000,
                EstimatedTotalSubtreeCost: 150,
                children: [
                    {
                        PhysicalOp: 'Clustered Index Scan',
                        LogicalOp: 'Clustered Index Scan',
                        EstimateRows: 100000,
                        EstimatedTotalSubtreeCost: 80,
                        children: [],
                    },
                ],
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toEqual(
            expect.arrayContaining(['MSTA-001', 'MSTA-002', 'MSTA-004']),
        );
    });

    it('detects key lookup operators', () => {
        const report = advisor.analyze({
            sql: 'SELECT col FROM t WHERE id = 1',
            explainPlanText: JSON.stringify({
                PhysicalOp: 'Nested Loops',
                LogicalOp: 'Inner Join',
                EstimateRows: 1,
                EstimatedTotalSubtreeCost: 0.01,
                children: [
                    {
                        PhysicalOp: 'Key Lookup',
                        LogicalOp: 'Key Lookup',
                        EstimateRows: 1,
                        EstimatedTotalSubtreeCost: 0.005,
                        children: [],
                    },
                ],
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toContain('MSTA-003');
    });

    it('detects plan warnings', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM t WHERE CAST(col AS INT) = 1',
            explainPlanText: JSON.stringify({
                PhysicalOp: 'Table Scan',
                LogicalOp: 'Table Scan',
                EstimateRows: 10,
                EstimatedTotalSubtreeCost: 0.5,
                Warnings: 'Type conversion in expression',
                children: [],
            }),
        });

        expect(report.recommendations.map((r) => r.id)).toContain('MSTA-007');
    });

    it('returns empty recommendations for simple queries', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM t WHERE id = 1',
            explainPlanText: JSON.stringify({
                PhysicalOp: 'Index Seek',
                LogicalOp: 'Index Seek',
                EstimateRows: 1,
                EstimatedTotalSubtreeCost: 0.003,
                children: [],
            }),
        });

        expect(report.recommendations).toHaveLength(0);
    });
});
