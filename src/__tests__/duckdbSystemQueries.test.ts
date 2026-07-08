import {
    buildListDatabasesQuery,
    buildListSchemasQuery,
    buildLookupColumnsQuery,
    buildTableColumnsQuery,
    buildTypeGroupsQuery
} from '../../extensions/duckdb/src/duckdbSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('duckdbSystemQueries', () => {
    it('builds catalog-aware listing queries', () => {
        expect(compactSql(buildListDatabasesQuery())).toContain('duckdb_databases()');

        const schemasQuery = compactSql(buildListSchemasQuery('analytics'));
        expect(schemasQuery).toContain('information_schema.schemata');
        expect(schemasQuery).toContain("catalog_name = 'analytics'");

        expect(compactSql(buildTypeGroupsQuery())).toContain(`SELECT 'TABLE' AS "OBJTYPE"`);
        expect(compactSql(buildTypeGroupsQuery())).toContain(`UNION ALL SELECT 'VIEW' AS "OBJTYPE"`);
    });

    it('builds DuckDB column lookup queries with shared metadata aliases', () => {
        const tableColumnsQuery = compactSql(buildTableColumnsQuery('bridge_catalog', 'main', 'results'));
        const lookupQuery = compactSql(buildLookupColumnsQuery({ database: 'bridge_catalog', tableName: 'results' }));

        expect(tableColumnsQuery).toContain('c.column_name AS ATTNAME');
        expect(tableColumnsQuery).toContain('c.data_type AS FORMAT_TYPE');
        expect(tableColumnsQuery).toContain("c.table_schema = 'main'");
        expect(tableColumnsQuery).toContain("c.table_name = 'results'");

        expect(lookupQuery).toContain('column_name AS ATTNAME');
        expect(lookupQuery).toContain('data_type AS FORMAT_TYPE');
        expect(lookupQuery).toContain('ordinal_position AS ATTNUM');
        expect(lookupQuery).toContain("table_catalog = 'bridge_catalog'");
        expect(lookupQuery).toContain("table_schema = 'main'");
        expect(lookupQuery).toContain("table_name = 'results'");
    });
});
