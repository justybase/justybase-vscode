import {
    buildPostgreSqlExplainQuery,
    isPostgreSqlExplainJson,
    parsePostgreSqlExplainJson,
    renderPostgreSqlExplainPlan,
} from '../../extensions/postgresql/src/postgresqlExplainParser';

describe('postgresqlExplainParser', () => {
    const samplePlan = JSON.stringify([
        {
            Plan: {
                'Node Type': 'Nested Loop',
                'Startup Cost': 12.45,
                'Total Cost': 456.78,
                'Plan Rows': 2500,
                'Plan Width': 64,
                Plans: [
                    {
                        'Node Type': 'Seq Scan',
                        'Relation Name': 'orders',
                        Schema: 'public',
                        'Startup Cost': 0,
                        'Total Cost': 120,
                        'Plan Rows': 100000,
                        'Plan Width': 48,
                        Filter: "(status = 'OPEN')",
                    },
                    {
                        'Node Type': 'Index Scan',
                        'Relation Name': 'customers',
                        Schema: 'public',
                        'Index Name': 'customers_pkey',
                        'Startup Cost': 0.15,
                        'Total Cost': 2.34,
                        'Plan Rows': 1,
                        'Plan Width': 16,
                    },
                ],
            },
            'Planning Time': 3.21,
            'Execution Time': 18.76,
        },
    ]);

    it('detects PostgreSQL explain JSON payloads', () => {
        expect(isPostgreSqlExplainJson(samplePlan)).toBe(true);
        expect(isPostgreSqlExplainJson('Nested Loop (cost=1..2 rows=3 width=4 conf=1)')).toBe(false);
    });

    it('parses PostgreSQL explain json into a structured tree', () => {
        const parsed = parsePostgreSqlExplainJson(samplePlan);

        expect(parsed.root.nodeType).toBe('Nested Loop');
        expect(parsed.root.children).toHaveLength(2);
        expect(parsed.root.children[0].relationName).toBe('orders');
        expect(parsed.root.children[1].indexName).toBe('customers_pkey');
        expect(parsed.planningTimeMs).toBeCloseTo(3.21);
        expect(parsed.executionTimeMs).toBeCloseTo(18.76);
    });

    it('renders PostgreSQL explain json into the shared explain text shape', () => {
        const rendered = renderPostgreSqlExplainPlan(parsePostgreSqlExplainJson(samplePlan));

        expect(rendered).toContain('Nested Loop (cost=12.45..456.78 rows=2500 width=64 conf=1.00)');
        expect(rendered).toContain('Seq Scan table "public.orders"');
        expect(rendered).toContain('Index: customers_pkey');
        expect(rendered).toContain('Execution Time: 18.760 ms');
    });

    it('builds PostgreSQL EXPLAIN FORMAT JSON statements', () => {
        const explainSql = buildPostgreSqlExplainQuery('SELECT * FROM orders', {
            verbose: true,
            analyze: false,
        });

        expect(explainSql).toBe(
            'EXPLAIN (FORMAT JSON, ANALYZE FALSE, VERBOSE TRUE, BUFFERS FALSE) SELECT * FROM orders',
        );
    });
});
