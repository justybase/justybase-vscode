import { extractTableDdlStatementEffect } from '../providers/parsers/tableDdlImpact';

jest.unmock('chevrotain');

describe('extractTableDdlStatementEffect', () => {
    it('extracts regular and global temporary CREATE TABLE targets', () => {
        expect(
            extractTableDdlStatementEffect(
                'CREATE TABLE JUST_DATA.ADMIN.T1 (ID INTEGER) DISTRIBUTE ON RANDOM',
            ).impacts,
        ).toEqual([
            {
                kind: 'create',
                objectType: 'TABLE',
                target: { database: 'JUST_DATA', schema: 'ADMIN', table: 'T1' },
            },
        ]);

        expect(
            extractTableDdlStatementEffect(
                'CREATE GLOBAL TEMP TABLE JUST_DATA..GTT1 AS SELECT 1 AS ID',
            ).impacts,
        ).toEqual([
            {
                kind: 'create',
                objectType: 'GLOBAL TEMP TABLE',
                target: { database: 'JUST_DATA', schema: undefined, table: 'GTT1' },
            },
        ]);
    });

    it('preserves quoted identifiers and excludes local temporary tables', () => {
        expect(
            extractTableDdlStatementEffect(
                'CREATE TABLE "Mixed Db"."Mixed Schema"."Table.Name" ("ID" INTEGER)',
            ).impacts[0],
        ).toEqual({
            kind: 'create',
            objectType: 'TABLE',
            target: {
                database: 'Mixed Db',
                schema: 'Mixed Schema',
                table: 'Table.Name',
            },
        });
        expect(
            extractTableDdlStatementEffect('CREATE TEMP TABLE TMP1 (ID INTEGER)').impacts,
        ).toEqual([]);
    });

    it('extracts ALTER rename, SET SCHEMA and ordinary ALTER targets', () => {
        expect(
            extractTableDdlStatementEffect('ALTER TABLE ADMIN.T1 RENAME TO T2').impacts,
        ).toEqual([
            {
                kind: 'alter',
                target: { schema: 'ADMIN', table: 'T1' },
                renamedTarget: { schema: 'ADMIN', table: 'T2' },
            },
        ]);
        expect(
            extractTableDdlStatementEffect('ALTER TABLE ADMIN.T1 SET SCHEMA STAGE').impacts,
        ).toEqual([
            {
                kind: 'alter',
                target: { schema: 'ADMIN', table: 'T1' },
                renamedTarget: { schema: 'STAGE', table: 'T1' },
            },
        ]);
        expect(
            extractTableDdlStatementEffect('ALTER TABLE T1 ADD COLUMN C2 INTEGER').impacts,
        ).toEqual([{ kind: 'alter', target: { table: 'T1' } }]);
    });

    it('extracts DROP TABLE targets but ignores other DROP object types', () => {
        expect(
            extractTableDdlStatementEffect('DROP TABLE IF EXISTS ADMIN.T1').impacts,
        ).toEqual([{ kind: 'drop', target: { schema: 'ADMIN', table: 'T1' } }]);
        expect(extractTableDdlStatementEffect('DROP VIEW ADMIN.V1').impacts).toEqual([]);
    });

    it('reports transaction control and ignores DDL inside procedures', () => {
        expect(extractTableDdlStatementEffect('BEGIN').transactionControl).toBe('begin');
        expect(extractTableDdlStatementEffect('COMMIT').transactionControl).toBe('commit');
        expect(extractTableDdlStatementEffect('ROLLBACK').transactionControl).toBe('rollback');
        expect(
            extractTableDdlStatementEffect(`
                CREATE OR REPLACE PROCEDURE P1()
                RETURNS INTEGER LANGUAGE NZPLSQL AS BEGIN_PROC
                BEGIN
                    CREATE TABLE INNER_T (ID INTEGER);
                    RETURN 1;
                END;
                END_PROC;
            `).impacts,
        ).toEqual([]);
    });
});
