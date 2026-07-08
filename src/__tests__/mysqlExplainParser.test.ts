import {
    buildMysqlExplainQuery,
    isMysqlExplainJson,
    isMysqlExplainText,
    parseMysqlExplainJson,
    parseMysqlExplainPlan,
    parseMysqlExplainText,
    renderMysqlExplainPlan,
} from '../../extensions/mysql/src/mysqlExplainParser';

describe('mysqlExplainParser', () => {
    const sampleJsonV1 = JSON.stringify({
        query_block: {
            select_id: 1,
            cost_info: {
                query_cost: '25000.50'
            },
            nested_loop: [
                {
                    table: {
                        table_name: 'orders',
                        access_type: 'ALL',
                        possible_keys: ['idx_orders_status'],
                        rows_examined_per_scan: 120000,
                        rows_produced_per_join: 120000,
                        filtered: '10.00',
                        cost_info: {
                            read_cost: '1250.20',
                            prefix_cost: '2490.50',
                            data_read_per_join: '12M'
                        },
                        attached_condition: "(`analytics`.`orders`.`status` = 'OPEN')"
                    }
                },
                {
                    table: {
                        table_name: 'customers',
                        access_type: 'eq_ref',
                        key: 'PRIMARY',
                        rows_examined_per_scan: 1,
                        rows_produced_per_join: 120000,
                        cost_info: {
                            read_cost: '0.20',
                            prefix_cost: '25000.50',
                            data_read_per_join: '3M'
                        }
                    }
                }
            ]
        }
    });

    const sampleJsonV2 = JSON.stringify({
        query: '/* select#1 */ select `world`.`country`.`Name` AS `Name` from `world`.`country` where (`world`.`country`.`Code` like \'A%\')',
        operation: 'Filter: (country.`Code` like \'A%\')',
        access_type: 'filter',
        estimated_rows: 17.0,
        estimated_total_cost: 3.668778400708174,
        inputs: [
            {
                operation: 'Index range scan on country using PRIMARY over (\'A\' <= Code <= \'A????????\')',
                table_name: 'country',
                index_name: 'PRIMARY',
                access_type: 'index',
                estimated_rows: 17.0,
                estimated_total_cost: 3.668778400708174
            }
        ]
    });

    const sampleAnalyze = [
        'EXPLAIN: -> Filter: (orders.total > 1000)  (cost=540.5 rows=1200)',
        '    -> Table scan on orders  (cost=540.5 rows=120000)',
        '        (actual time=2.1..875.4 rows=118000 loops=1)'
    ].join('\n');

    it('detects MySQL explain payload variants', () => {
        expect(isMysqlExplainJson(sampleJsonV1)).toBe(true);
        expect(isMysqlExplainJson(sampleJsonV2)).toBe(true);
        expect(isMysqlExplainText(sampleAnalyze)).toBe(true);
        expect(isMysqlExplainText('Nested Loop (cost=1..2 rows=3 width=4 conf=1)')).toBe(false);
    });

    it('parses MySQL FORMAT=JSON version 1 plans into a structured tree', () => {
        const parsed = parseMysqlExplainJson(sampleJsonV1);

        expect(parsed.format).toBe('json-v1');
        expect(parsed.root.nodeType).toBe('Nested loop');
        expect(parsed.root.children).toHaveLength(2);
        expect(parsed.root.children[0].tableName).toBe('orders');
        expect(parsed.root.children[0].accessType).toBe('ALL');
        expect(parsed.root.children[1].indexName).toBe('PRIMARY');
    });

    it('parses MySQL FORMAT=JSON version 2 plans and renders shared explain text', () => {
        const parsed = parseMysqlExplainJson(sampleJsonV2);
        const rendered = renderMysqlExplainPlan(parsed);

        expect(parsed.format).toBe('json-v2');
        expect(parsed.root.nodeType).toBe('Filter');
        expect(parsed.root.children[0]?.nodeType).toBe('Index Range Scan');
        expect(rendered).toContain('Filter {FILTER}');
        expect(rendered).toContain('Index Range Scan table "country" {INDEX, key=PRIMARY');
    });

    it('parses MySQL EXPLAIN ANALYZE / TREE output and preserves actual metrics', () => {
        const parsed = parseMysqlExplainText(sampleAnalyze);
        const rendered = renderMysqlExplainPlan(parsed);

        expect(parsed.root.nodeType).toBe('Filter');
        expect(parsed.root.children[0]?.nodeType).toBe('Table Scan');
        expect(parsed.root.children[0]?.actualRows).toBe(118000);
        expect(rendered).toContain('Table Scan table "orders"');
        expect(rendered).toContain('Actual: firstRow=2.100 ms, total=875.400 ms, rows=118,000, loops=1');
    });

    it('builds MySQL EXPLAIN statements for JSON and ANALYZE modes', () => {
        expect(buildMysqlExplainQuery('SELECT * FROM orders')).toBe('EXPLAIN FORMAT=JSON SELECT * FROM orders');
        expect(buildMysqlExplainQuery('SELECT * FROM orders', { analyze: true })).toBe(
            'EXPLAIN ANALYZE FORMAT=TREE SELECT * FROM orders',
        );
    });

    it('auto-detects JSON and TREE payloads', () => {
        expect(parseMysqlExplainPlan(sampleJsonV1).format).toBe('json-v1');
        expect(parseMysqlExplainPlan(sampleAnalyze).format).toBe('tree');
    });
});
