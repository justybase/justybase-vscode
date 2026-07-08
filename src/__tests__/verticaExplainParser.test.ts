import {
    buildVerticaExplainQuery,
    isVerticaExplainJson,
    parseVerticaExplainJson,
    renderVerticaExplainPlan,
} from '../../extensions/vertica/src/verticaExplainParser';

describe('verticaExplainParser', () => {
    const samplePlan = JSON.stringify({
        plan: {
            path_id: 1,
            operation: 'Root',
            cost: 500,
            estimated_rows: 5000,
            children: [
                {
                    path_id: 2,
                    operation: 'STORAGE ACCESS',
                    object_name: 'orders',
                    object_schema: 'public',
                    cost: 450,
                    estimated_rows: 100000,
                    width: 48,
                    filter: "status = 'OPEN'",
                    children: [],
                },
                {
                    path_id: 3,
                    operation: 'JOIN',
                    cost: 50,
                    estimated_rows: 5000,
                    children: [],
                },
            ],
        },
    });

    it('detects Vertica explain JSON payloads', () => {
        expect(isVerticaExplainJson(samplePlan)).toBe(true);
        expect(isVerticaExplainJson('Vertica text plan output')).toBe(false);
    });

    it('parses Vertica explain JSON into a structured tree', () => {
        const parsed = parseVerticaExplainJson(samplePlan);
        expect(parsed.root.operation).toBe('Root');
        expect(parsed.root.children).toHaveLength(2);
        expect(parsed.root.children[0].objectName).toBe('orders');
    });

    it('renders Vertica explain plan as text', () => {
        const rendered = renderVerticaExplainPlan(parseVerticaExplainJson(samplePlan));
        expect(rendered).toContain('Root');
        expect(rendered).toContain('STORAGE ACCESS');
        expect(rendered).toContain('cost=');
    });

    it('builds Vertica EXPLAIN queries', () => {
        expect(buildVerticaExplainQuery('SELECT * FROM t')).toBe('EXPLAIN SELECT * FROM t');
        expect(buildVerticaExplainQuery('SELECT * FROM t', { verbose: true })).toBe('EXPLAIN VERBOSE SELECT * FROM t');
    });
});
