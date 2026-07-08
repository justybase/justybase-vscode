import {
    buildDb2ExplainQuery,
    buildDb2ExplainRetrieveQuery,
    isDb2ExplainJson,
    parseDb2ExplainJson,
    renderDb2ExplainPlan,
} from '../../extensions/db2/src/db2ExplainParser';

describe('db2ExplainParser', () => {
    const samplePlan = JSON.stringify({
        plan: {
            operator_type: 'RETURN',
            total_cost: 500,
            estimated_rows: 5000,
            children: [
                {
                    operator_type: 'TBSCAN',
                    object_name: 'ORDERS',
                    object_schema: 'SALES',
                    total_cost: 450,
                    estimated_rows: 100000,
                    children: [],
                },
                {
                    operator_type: 'IXSCAN',
                    object_name: 'CUSTOMERS_PK',
                    total_cost: 2,
                    estimated_rows: 1,
                    children: [],
                },
            ],
        },
    });

    it('detects Db2 explain JSON payloads', () => {
        expect(isDb2ExplainJson(samplePlan)).toBe(true);
        expect(isDb2ExplainJson('plain text')).toBe(false);
    });

    it('parses Db2 explain JSON into a structured tree', () => {
        const parsed = parseDb2ExplainJson(samplePlan);
        expect(parsed.root.operatorType).toBe('RETURN');
        expect(parsed.root.children).toHaveLength(2);
        expect(parsed.root.children[0].objectName).toBe('ORDERS');
    });

    it('renders Db2 explain plan as text', () => {
        const rendered = renderDb2ExplainPlan(parseDb2ExplainJson(samplePlan));
        expect(rendered).toContain('RETURN');
        expect(rendered).toContain('TBSCAN');
        expect(rendered).toContain('cost=');
    });

    it('builds Db2 explain queries', () => {
        expect(buildDb2ExplainQuery('SELECT * FROM orders')).toContain('EXPLAIN');
        expect(buildDb2ExplainRetrieveQuery()).toContain('EXPLAIN_OPERATOR');
    });
});
