import {
    buildNetezzaMaterializedViewDdl,
    buildNetezzaRoutineDdl,
    buildNetezzaSequenceDdl,
} from '../dialects/netezza/ddl/catalogObjectDDL';

describe('Netezza catalog object DDL builders', () => {
    it('rebuilds a sequence from _VT_SEQUENCE values', () => {
        expect(buildNetezzaSequenceDdl('JUST_DATA', 'ADMIN', 'SEQUENCE1', {
            dataType: 'integer', minValue: '1', maxValue: '300', increment: 1, cycle: false,
            nextCacheValue: '7', owner: 'ADMIN', description: "Order's key",
        })).toBe([
            '-- Next cached value: 7. Use START WITH 7 to continue numbering.',
            'CREATE SEQUENCE JUST_DATA.ADMIN.SEQUENCE1 AS INTEGER',
            '    START WITH 1',
            '    INCREMENT BY 1',
            '    MINVALUE 1',
            '    MAXVALUE 300',
            '    NO CYCLE;',
            '',
            'ALTER SEQUENCE JUST_DATA.ADMIN.SEQUENCE1 OWNER TO ADMIN;',
            '',
            "COMMENT ON SEQUENCE JUST_DATA.ADMIN.SEQUENCE1 IS 'Order''s key';",
        ].join('\n'));
    });

    it('starts descending sequences at their maximum and quotes catalog names', () => {
        const ddl = buildNetezzaSequenceDdl('DB', 'ADMIN', 'down seq', {
            dataType: 'BIGINT', minValue: '-100', maxValue: '0', increment: -5, cycle: true,
        });
        expect(ddl).toContain('CREATE SEQUENCE DB.ADMIN."down seq" AS BIGINT');
        expect(ddl).toContain('START WITH 0');
        expect(ddl).toContain('    CYCLE;');
        expect(ddl).not.toContain('Next cached value');
    });

    it('wraps the stored materialized view SELECT', () => {
        expect(buildNetezzaMaterializedViewDdl('JUST_DATA', 'ADMIN', 'COLOR_CHECK_MV', 'SELECT D.DATEKEY FROM ADMIN.DIMDATE D;', 'ADMIN'))
            .toBe('-- Owner: ADMIN\nCREATE MATERIALIZED VIEW JUST_DATA.ADMIN.COLOR_CHECK_MV AS\nSELECT D.DATEKEY FROM ADMIN.DIMDATE D;');
    });

    it('builds UDX functions and aggregates with catalog attributes and object placeholders', () => {
        const fn = buildNetezzaRoutineDdl('DB', 'ADMIN', {
            kind: 'FUNCTION', name: 'CLEAN', arguments: '(CHARACTER VARYING(100))', returns: 'CHARACTER VARYING(100)',
            deterministic: false, returnsNullOnNullInput: false, fenced: true, externalName: 'CleanUdf', memory: '64m',
        });
        expect(fn).toContain('CREATE OR REPLACE FUNCTION DB.ADMIN.CLEAN(CHARACTER VARYING(100))');
        expect(fn).toContain('NOT DETERMINISTIC\nCALLED ON NULL INPUT');
        expect(fn).toContain("MEMORY '64m'");
        expect(fn).toContain("EXTERNAL CLASS NAME 'CleanUdf'");
        expect(fn).toContain("EXTERNAL HOST OBJECT '<path to host .o_x86>'");

        const agg = buildNetezzaRoutineDdl('DB', 'ADMIN', {
            kind: 'AGGREGATE', name: 'MEDIAN2', arguments: '(DOUBLE)', returns: 'DOUBLE', stateType: 'DOUBLE', varargs: false,
        });
        expect(agg).toContain('RETURNS DOUBLE\nSTATE (DOUBLE)');
        expect(agg).not.toContain('DETERMINISTIC');
    });
});
