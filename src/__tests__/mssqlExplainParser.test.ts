import {
    buildMsSqlExplainQuery,
    isMsSqlExplainJson,
    parseMsSqlExplainJson,
    renderMsSqlExplainPlan,
} from '../../extensions/mssql/src/mssqlExplainParser';

describe('mssqlExplainParser', () => {
    const samplePlan = JSON.stringify({
        PhysicalOp: 'Nested Loops',
        LogicalOp: 'Inner Join',
        EstimateRows: 5000,
        EstimatedTotalSubtreeCost: 15.5,
        EstimateIO: 0.5,
        EstimateCPU: 0.1,
        children: [
            {
                PhysicalOp: 'Clustered Index Scan',
                LogicalOp: 'Clustered Index Scan',
                EstimateRows: 100000,
                EstimatedTotalSubtreeCost: 10.2,
                Object: '[dbo].[orders]',
                children: [],
            },
            {
                PhysicalOp: 'Index Seek',
                LogicalOp: 'Index Seek',
                EstimateRows: 1,
                EstimatedTotalSubtreeCost: 0.003,
                Object: '[dbo].[customers]',
                children: [],
            },
        ],
    });

    it('detects MSSQL explain JSON payloads', () => {
        expect(isMsSqlExplainJson(samplePlan)).toBe(true);
        expect(isMsSqlExplainJson('plain text')).toBe(false);
    });

    it('parses MSSQL explain JSON into a structured tree', () => {
        const parsed = parseMsSqlExplainJson(samplePlan);
        expect(parsed.root.physicalOp).toContain('Nested Loops');
        expect(parsed.root.children).toHaveLength(2);
    });

    it('renders MSSQL explain plan as text', () => {
        const rendered = renderMsSqlExplainPlan(parseMsSqlExplainJson(samplePlan));
        expect(rendered).toContain('Nested Loops');
        expect(rendered).toContain('cost=');
    });

    it('builds MSSQL SHOWPLAN query', () => {
        const query = buildMsSqlExplainQuery('SELECT * FROM orders');
        expect(query).toContain('SHOWPLAN');
    });
});
