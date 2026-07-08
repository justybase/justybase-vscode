import {
    buildDuckDbExplainQuery,
    isDuckDbExplainJson,
    parseDuckDbExplainJson,
    renderDuckDbExplainPlan,
} from '../../extensions/duckdb/src/duckdbExplainParser';

describe('duckdbExplainParser', () => {
    const samplePlan = JSON.stringify({
        type: 'QUERY',
        name: 'Query',
        estimated_cardinality: 5000,
        children: [
            {
                type: 'SEQ_SCAN',
                name: 'Seq Scan',
                table_name: 'orders',
                extra_info: 'orders',
                estimated_cardinality: 100000,
                children: [],
            },
            {
                type: 'HASH_JOIN',
                name: 'Hash Join',
                estimated_cardinality: 5000,
                children: [
                    {
                        type: 'SEQ_SCAN',
                        name: 'Seq Scan',
                        table_name: 'customers',
                        estimated_cardinality: 200,
                        children: [],
                    },
                ],
            },
        ],
    });

    it('detects DuckDB explain JSON payloads', () => {
        expect(isDuckDbExplainJson(samplePlan)).toBe(true);
        expect(isDuckDbExplainJson('plain text output')).toBe(false);
    });

    it('parses DuckDB explain JSON into a structured tree', () => {
        const parsed = parseDuckDbExplainJson(samplePlan);
        expect(parsed.root.nodeType).toContain('QUERY');
        expect(parsed.root.children).toHaveLength(2);
        expect(parsed.root.children[0].estimatedCardinality).toBe(100000);
    });

    it('renders DuckDB explain plan as text', () => {
        const rendered = renderDuckDbExplainPlan(parseDuckDbExplainJson(samplePlan));
        expect(rendered).toContain('QUERY');
        expect(rendered).toContain('SEQ_SCAN');
        expect(rendered).toContain('est=');
    });

    it('builds DuckDB EXPLAIN queries', () => {
        expect(buildDuckDbExplainQuery('SELECT * FROM t')).toContain('EXPLAIN');
        expect(buildDuckDbExplainQuery('SELECT * FROM t', { analyze: true })).toContain('EXPLAIN ANALYZE');
    });
});
