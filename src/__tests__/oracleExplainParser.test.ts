import {
    buildOracleExplainQuery,
    buildOracleExplainRetrieveQuery,
    isOracleExplainJson,
    parseOracleExplainJson,
    renderOracleExplainPlan,
} from '../../extensions/oracle/src/oracleExplainParser';

describe('oracleExplainParser', () => {
    const samplePlan = JSON.stringify({
        plan: {
            operation: 'SELECT STATEMENT',
            cost: 500,
            cardinality: 5000,
            bytes: 250000,
            children: [
                {
                    operation: 'TABLE ACCESS',
                    options: 'FULL',
                    object_name: 'ORDERS',
                    object_owner: 'HR',
                    cost: 450,
                    cardinality: 100000,
                    bytes: 4800000,
                    filter_predicates: "STATUS = 'OPEN'",
                    children: [],
                },
                {
                    operation: 'INDEX',
                    options: 'UNIQUE SCAN',
                    object_name: 'CUSTOMERS_PK',
                    cost: 1,
                    cardinality: 1,
                    bytes: 50,
                    children: [],
                },
            ],
        },
    });

    it('detects Oracle explain JSON payloads', () => {
        expect(isOracleExplainJson(samplePlan)).toBe(true);
        expect(isOracleExplainJson('Id | Operation | Name')).toBe(false);
    });

    it('parses Oracle explain JSON into a structured tree', () => {
        const parsed = parseOracleExplainJson(samplePlan);
        expect(parsed.root.operation).toBe('SELECT STATEMENT');
        expect(parsed.root.children).toHaveLength(2);
        expect(parsed.root.children[0].objectName).toBe('ORDERS');
    });

    it('renders Oracle explain plan as text', () => {
        const rendered = renderOracleExplainPlan(parseOracleExplainJson(samplePlan));
        expect(rendered).toContain('SELECT STATEMENT');
        expect(rendered).toContain('TABLE ACCESS');
        expect(rendered).toContain('ORDERS');
        expect(rendered).toContain('cost=');
    });

    it('builds Oracle EXPLAIN PLAN and retrieval queries', () => {
        expect(buildOracleExplainQuery('SELECT * FROM orders')).toContain('EXPLAIN PLAN FOR');
        expect(buildOracleExplainRetrieveQuery()).toContain('PLAN_TABLE');
    });
});
