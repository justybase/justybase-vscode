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
        expect(sql).toContain("UPPER(DBNAME) = UPPER('JUST_DATA')");
        expect(sql).toContain("UPPER(SCHEMA) = UPPER('ADM''IN')");
        expect(sql).toContain("UPPER(OBJNAME) = UPPER('T''1')");
        expect(sql).toContain("OBJTYPE IN ('TABLE', 'GLOBAL TEMP TABLE')");
    });
});
