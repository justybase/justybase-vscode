/**
 * The schema tree and completions show `_V_TABLE.RELTUPLES`. Every Netezza
 * object query that can describe a table-like object must select it, otherwise
 * a refresh from that query erases the `~N rows` hint for those objects.
 */
import { netezzaMetadataProvider } from '../../dialects/netezza/metadata/provider';

describe('Netezza object queries keep the row estimate', () => {
    function rowEstimateQueryShape(query: string): void {
        expect(query).toContain('_V_TABLE');
        expect(query).toContain('T.OBJID = O.OBJID');
        expect(query).toContain('CASE WHEN T.RELTUPLES >= 0');
        expect(query).toContain('AS RELTUPLES');
    }

    it('selects RELTUPLES in the view query (materialized views)', () => {
        const scoped = netezzaMetadataProvider.buildListViewsQuery('JUST_DATA', 'ADMIN');
        const scopedQuery = scoped.toLowerCase();
        expect(scopedQuery).toContain("o.objtype = 'view'");
        expect(scoped).toContain("O.SCHEMA = 'ADMIN'");
        rowEstimateQueryShape(scoped);

        const allSchemas = netezzaMetadataProvider.buildListViewsQuery('JUST_DATA');
        rowEstimateQueryShape(allSchemas);
        expect(allSchemas).not.toContain('O.SCHEMA =');
    });

    it('selects RELTUPLES for the generic object-type query', () => {
        const query = netezzaMetadataProvider.buildObjectTypeQuery('JUST_DATA', 'GLOBAL TEMP TABLE');
        expect(query).toContain("O.OBJTYPE = 'GLOBAL TEMP TABLE'");
        rowEstimateQueryShape(query);
    });

    it('does not add the row estimate to procedures or synonyms', () => {
        expect(netezzaMetadataProvider.buildObjectTypeQuery('JUST_DATA', 'PROCEDURE'))
            .not.toContain('T.RELTUPLES');
        expect(netezzaMetadataProvider.buildObjectTypeQuery('JUST_DATA', 'SYNONYM'))
            .not.toContain('T.RELTUPLES');
    });
});
