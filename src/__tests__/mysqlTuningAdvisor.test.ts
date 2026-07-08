import { MysqlTuningAdvisor } from '../../extensions/mysql/src/mysqlTuningAdvisor';

describe('MysqlTuningAdvisor', () => {
    const advisor = new MysqlTuningAdvisor();

    it('returns MySQL-specific recommendations from FORMAT=JSON plans', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders WHERE status = "OPEN" ORDER BY created_at',
            explainPlanText: JSON.stringify({
                query_block: {
                    select_id: 1,
                    cost_info: {
                        query_cost: '150000'
                    },
                    ordering_operation: {
                        using_filesort: true,
                        using_temporary_table: true,
                        nested_loop: [
                            {
                                table: {
                                    table_name: 'orders',
                                    access_type: 'ALL',
                                    possible_keys: ['idx_orders_status_created'],
                                    rows_examined_per_scan: 250000,
                                    rows_produced_per_join: 250000,
                                    filtered: '15.00',
                                    cost_info: {
                                        read_cost: '1200',
                                        prefix_cost: '145000',
                                        data_read_per_join: '48M'
                                    },
                                    attached_condition: "(`analytics`.`orders`.`status` = 'OPEN')"
                                }
                            }
                        ]
                    }
                }
            })
        });

        expect(report.recommendations.map((item) => item.id)).toEqual(
            expect.arrayContaining(['MYTA-001', 'MYTA-002', 'MYTA-003', 'MYTA-004', 'MYTA-005']),
        );
    });

    it('uses EXPLAIN ANALYZE output for row-misestimation and slow-iterator advice', () => {
        const report = advisor.analyze({
            sql: 'SELECT id FROM orders WHERE total > 1000',
            explainPlanText: [
                'EXPLAIN: -> Filter: (orders.total > 1000)  (cost=540.5 rows=1200)',
                '    -> Table scan on orders  (cost=540.5 rows=1200)',
                '        (actual time=2.1..875.4 rows=118000 loops=1)'
            ].join('\n')
        });

        expect(report.recommendations.map((item) => item.id)).toEqual(expect.arrayContaining(['MYTA-006', 'MYTA-007']));
        expect(report.recommendations.find((item) => item.id === 'MYTA-007')?.summary).toContain('875.4 ms');
    });

    it('still emits SQL-only advice when no MySQL explain text is available', () => {
        const report = advisor.analyze({
            sql: 'SELECT * FROM orders',
            explainPlanText: 'not a mysql explain payload'
        });

        expect(report.recommendations.map((item) => item.id)).toEqual(['MYTA-001']);
    });
});
