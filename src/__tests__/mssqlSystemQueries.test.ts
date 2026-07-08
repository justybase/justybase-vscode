import {
    buildObjectSearchQuery,
    buildProcedureSourceSearchQuery,
    buildViewSourceSearchQuery
} from '../../extensions/mssql/src/mssqlSystemQueries';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

describe('mssqlSystemQueries', () => {
    it('builds MSSQL object and source search queries for the search contract', () => {
        const objectSearchQuery = compactSql(buildObjectSearchQuery('SalesDB', '%ORDER%'));
        const lowercasePatternQuery = compactSql(buildObjectSearchQuery('SalesDB', '%order%'));
        const serverFilteredViewSourceQuery = compactSql(buildViewSourceSearchQuery('SalesDB', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: true
        }));
        const serverFilteredProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('SalesDB', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: true
        }));
        const inMemoryProcedureSourceQuery = compactSql(buildProcedureSourceSearchQuery('SalesDB', {
            rawTerm: 'orders',
            likePattern: '%ORDERS%',
            useServerSideFilter: false
        }));

        expect(objectSearchQuery).toContain('SELECT TOP (200) *');
        expect(objectSearchQuery).toContain('FROM [SalesDB].sys.columns c');
        expect(objectSearchQuery).toContain("'COLUMN' AS TYPE");
        expect(objectSearchQuery).toContain('o.name AS PARENT');
        expect(objectSearchQuery).toContain("COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS DESCRIPTION");
        expect(objectSearchQuery).toContain("'NAME' AS MATCH_TYPE");
        expect(objectSearchQuery).toContain("UPPER(o.name) LIKE '%ORDER%' ESCAPE '\\'");
        expect(objectSearchQuery).toContain("UPPER(c.name) LIKE '%ORDER%' ESCAPE '\\'");
        expect(lowercasePatternQuery).toContain("UPPER(o.name) LIKE '%order%' ESCAPE '\\'");

        expect(serverFilteredViewSourceQuery).toContain("UPPER(COALESCE(sm.definition, '')) LIKE '%ORDERS%' ESCAPE '\\'");
        expect(serverFilteredViewSourceQuery).not.toContain("AND o.name = 'orders'");
        expect(serverFilteredViewSourceQuery).not.toContain('AS SOURCE');

        expect(serverFilteredProcedureSourceQuery).toContain("o.type IN ('P', 'FN', 'TF', 'IF')");
        expect(serverFilteredProcedureSourceQuery).toContain("UPPER(COALESCE(sm.definition, '')) LIKE '%ORDERS%' ESCAPE '\\'");
        expect(inMemoryProcedureSourceQuery).toContain('sm.definition AS SOURCE');
    });
});
