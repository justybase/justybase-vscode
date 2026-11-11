import { extractMetadataDdlStatementEffect } from '../../providers/parsers/metadataDdlImpact';

jest.unmock('chevrotain');

describe('metadataDdlImpact', () => {
    it('extracts a table comment', () => {
        expect(extractMetadataDdlStatementEffect(
            "COMMENT ON TABLE ADMIN.ORDERS IS 'orders table'",
            'netezza',
        )).toEqual({
            impacts: [{
                kind: 'comment',
                objectType: 'TABLE',
                target: { schema: 'ADMIN', table: 'ORDERS' },
                column: undefined,
                comment: 'orders table',
            }],
        });
    });

    it('extracts a column comment with database and empty schema', () => {
        expect(extractMetadataDdlStatementEffect(
            "COMMENT ON COLUMN JUST_DATA..ORDERS.AMOUNT IS 'total amount'",
            'netezza',
        )).toEqual({
            impacts: [{
                kind: 'comment',
                objectType: 'COLUMN',
                target: { database: 'JUST_DATA', schema: undefined, table: 'ORDERS' },
                column: 'AMOUNT',
                comment: 'total amount',
            }],
        });
    });

    it('extracts a view comment and a NULL comment reset', () => {
        expect(extractMetadataDdlStatementEffect(
            "COMMENT ON VIEW ADMIN.V_ORDERS IS 'view'",
            'netezza',
        ).impacts[0]).toEqual(expect.objectContaining({
            kind: 'comment',
            objectType: 'VIEW',
            comment: 'view',
        }));

        expect(extractMetadataDdlStatementEffect(
            'COMMENT ON TABLE ADMIN.ORDERS IS NULL',
            'netezza',
        ).impacts[0]).toEqual(expect.objectContaining({
            kind: 'comment',
            comment: '',
        }));
    });

    it('extracts a procedure comment without its argument list', () => {
        expect(extractMetadataDdlStatementEffect(
            "COMMENT ON PROCEDURE ADMIN.P_LOAD(INT) IS 'loader'",
            'netezza',
        ).impacts[0]).toEqual(expect.objectContaining({
            kind: 'comment',
            objectType: 'PROCEDURE',
            target: { schema: 'ADMIN', table: 'P_LOAD' },
            comment: 'loader',
        }));
    });

    it('extracts CREATE VIEW, DROP VIEW and DROP PROCEDURE', () => {
        expect(extractMetadataDdlStatementEffect(
            'CREATE VIEW ADMIN.V_ACTIVE AS SELECT 1 AS ID',
            'netezza',
        ).impacts).toEqual([{
            kind: 'create',
            objectType: 'VIEW',
            target: { schema: 'ADMIN', table: 'V_ACTIVE' },
        }]);

        expect(extractMetadataDdlStatementEffect(
            'DROP VIEW ADMIN.V_ACTIVE',
            'netezza',
        ).impacts).toEqual([{
            kind: 'drop',
            objectType: 'VIEW',
            target: { schema: 'ADMIN', table: 'V_ACTIVE' },
        }]);

        expect(extractMetadataDdlStatementEffect(
            'DROP PROCEDURE ADMIN.P_LOAD(INT)',
            'netezza',
        ).impacts[0]).toEqual(expect.objectContaining({
            kind: 'drop',
            objectType: 'PROCEDURE',
        }));
    });

    it('falls back to token parsing for ALTER VIEW and ALTER PROCEDURE', () => {
        expect(extractMetadataDdlStatementEffect(
            'ALTER VIEW ADMIN.V_ACTIVE RENAME TO ADMIN.V_ACTIVE_2',
            'netezza',
        ).impacts).toEqual([{
            kind: 'alter',
            objectType: 'VIEW',
            target: { schema: 'ADMIN', table: 'V_ACTIVE' },
        }]);

        expect(extractMetadataDdlStatementEffect(
            'ALTER PROCEDURE ADMIN.P_LOAD(INT) OWNER TO ADMIN',
            'netezza',
        ).impacts).toEqual([{
            kind: 'alter',
            objectType: 'PROCEDURE',
            target: { schema: 'ADMIN', table: 'P_LOAD' },
        }]);
    });

    it('ignores SELECT, DML and table DDL handled by the table synchronizer', () => {
        expect(extractMetadataDdlStatementEffect('SELECT * FROM ORDERS', 'netezza').impacts).toEqual([]);
        expect(extractMetadataDdlStatementEffect("INSERT INTO T VALUES (1)", 'netezza').impacts).toEqual([]);
        expect(extractMetadataDdlStatementEffect('ALTER TABLE T ADD COLUMN C INT', 'netezza').impacts).toEqual([]);
        expect(extractMetadataDdlStatementEffect('DROP TABLE T', 'netezza').impacts).toEqual([]);
    });
});
