import { netezzaMetadataProvider } from '../dialects/netezza/metadata/provider';

describe('netezzaMetadataProvider DDL synchronization', () => {
    it('builds an exact, escaped lookup for regular and global temp tables', () => {
        const sql = netezzaMetadataProvider.buildObjectByNameQuery(
            'JUST_DATA',
            "ADM'IN",
            "T'1",
            ['TABLE', 'GLOBAL TEMP TABLE'],
        );

        expect(sql).toContain('FROM JUST_DATA.._V_OBJECT_DATA');
        expect(sql).toContain("DBNAME = 'JUST_DATA'");
        expect(sql).toContain("SCHEMA = 'ADM''IN'");
        expect(sql).toContain("OBJNAME = 'T''1'");
        expect(sql).toContain("OBJTYPE IN ('TABLE', 'GLOBAL TEMP TABLE')");
    });

    it('includes EXTERNAL TABLE in buildListTablesQuery so the lazy cache write keeps external tables', () => {
        const scoped = netezzaMetadataProvider.buildListTablesQuery('JUST_DATA', 'ADMIN');
        const unscoped = netezzaMetadataProvider.buildListTablesQuery('JUST_DATA');

        for (const query of [scoped, unscoped]) {
            expect(query).toContain("O.OBJTYPE IN ('TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE')");
            expect(query).toContain('JUST_DATA.._V_OBJECT_DATA');
        }
        expect(scoped).toContain("SCHEMA = 'ADMIN'");
    });
});
