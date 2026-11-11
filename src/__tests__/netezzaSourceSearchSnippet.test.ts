import { netezzaMetadataProvider } from '../dialects/netezza/metadata/provider';

/**
 * Netezza source search can return a server-side snippet so Object Search does
 * not download whole procedure/view definitions. The snippet window is
 * 1-based `INSTR` based; `MATCH_OFFSET` stays zero-based for the editor.
 */
describe('Netezza source search snippet SQL', () => {
    const options = {
        rawTerm: 'CUSTOMER_ID',
        likePattern: '%CUSTOMER_ID%',
        useServerSideFilter: true,
        includeSnippet: true,
    };

    it('adds a snippet window and a zero-based match offset for views', () => {
        const sql = netezzaMetadataProvider.buildViewSourceSearchQuery('JUST_DATA', options);

        expect(sql).toContain('SUBSTR(DEFINITION');
        expect(sql).toContain("INSTR(UPPER(DEFINITION), 'CUSTOMER_ID')");
        expect(sql).toContain('AS SNIPPET');
        expect(sql).toContain('AS MATCH_OFFSET');
        expect(sql).toContain('THEN INSTR(UPPER(DEFINITION), \'CUSTOMER_ID\') - 1');
    });

    it('adds a snippet window for procedure sources', () => {
        const sql = netezzaMetadataProvider.buildProcedureSourceSearchQuery('JUST_DATA', options);

        expect(sql).toContain('SUBSTR(PROCEDURESOURCE');
        expect(sql).toContain('AS SNIPPET');
    });

    it('keeps the plain query shape when snippets are not requested', () => {
        const sql = netezzaMetadataProvider.buildViewSourceSearchQuery('JUST_DATA', {
            ...options,
            includeSnippet: false,
        });

        expect(sql).not.toContain('SNIPPET');
        expect(sql).not.toContain('MATCH_OFFSET');
        expect(sql).toContain("UPPER(DEFINITION) LIKE '%CUSTOMER_ID%'");
    });

    it('escapes single quotes in the search term', () => {
        const sql = netezzaMetadataProvider.buildProcedureSourceSearchQuery('JUST_DATA', {
            ...options,
            rawTerm: "O'BRIEN",
        });

        expect(sql).toContain("'O''BRIEN'");
    });
});
