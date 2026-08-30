import { describe, expect, it } from '@jest/globals';
import {
    buildColumnMetadataQuery,
    buildListMaterializedViewsQuery,
    buildListViewsQuery,
    buildTableDefinitionQuery,
    buildTypeGroupsQuery,
} from '../../../../extensions/clickhouse/src/clickhouseSystemQueries';

function compact(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('ClickHouse system catalog queries', () => {
    it('preserves native storage fields in table and view listings', () => {
        const query = compact(buildListViewsQuery('analytics', 'analytics'));

        expect(query).toContain("engine = 'MaterializedView'");
        expect(query).toContain("'MATERIALIZED VIEW'");
        expect(query).toContain('CLICKHOUSE_ENGINE');
        expect(query).toContain('CLICKHOUSE_PARTITION_BY');
        expect(query).toContain('CLICKHOUSE_ORDER_BY');
    });

    it('can scope materialized views separately without losing their object type', () => {
        const query = compact(buildListMaterializedViewsQuery('analytics'));

        expect(query).toContain("engine = 'MaterializedView'");
        expect(query).toContain("'MATERIALIZED VIEW' AS `OBJTYPE`");
    });

    it('uses native primary-key expressions for column metadata', () => {
        const query = compact(buildColumnMetadataQuery('analytics', 'analytics', 'events'));

        expect(query).toContain('t.primary_key');
        expect(query).toContain('PRIMARY_KEY_EXPRESSION');
        expect(query).toContain("'MATERIALIZED VIEW'");
    });

    it('provides a lazy single-object definition query including the source DDL', () => {
        const query = compact(buildTableDefinitionQuery('analytics', 'analytics', 'events'));

        expect(query).toContain('create_table_query');
        expect(query).toContain('CLICKHOUSE_SOURCE_DDL');
        expect(query).toContain("database = 'analytics'");
        expect(query).toContain("name = 'events'");
    });

    it('advertises ClickHouse table-like object types to the metadata browser', () => {
        const query = compact(buildTypeGroupsQuery());

        expect(query).toContain("'TABLE'");
        expect(query).toContain("'VIEW'");
        expect(query).toContain("'MATERIALIZED VIEW'");
    });
});
