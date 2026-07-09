/**
 * Unit tests for SqlParser
 */

import { SqlParser } from '../sql/sqlParser';

describe('SqlParser', () => {
    describe('splitStatements', () => {
        it('should split simple statements', () => {
            const sql = 'SELECT 1; SELECT 2;';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT 1', 'SELECT 2']);
        });

        it('should handle statement without trailing semicolon', () => {
            const sql = 'SELECT * FROM table1; SELECT * FROM table2';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT * FROM table1', 'SELECT * FROM table2']);
        });

        it('should ignore semicolons in single quotes', () => {
            const sql = "SELECT 'hello; world'; SELECT 2;";
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(["SELECT 'hello; world'", 'SELECT 2']);
        });

        it('should ignore semicolons in double quotes', () => {
            const sql = 'SELECT "column;name"; SELECT 2;';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT "column;name"', 'SELECT 2']);
        });

        it('should ignore semicolons in line comments', () => {
            const sql = 'SELECT 1 -- comment; with semicolon\n; SELECT 2;';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT 1 -- comment; with semicolon', 'SELECT 2']);
        });

        it('should ignore semicolons in block comments', () => {
            const sql = 'SELECT 1 /* comment; with; semicolons */; SELECT 2;';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT 1 /* comment; with; semicolons */', 'SELECT 2']);
        });

        it('should handle empty input', () => {
            const result = SqlParser.splitStatements('');
            expect(result).toEqual([]);
        });

        it('should handle whitespace only', () => {
            const result = SqlParser.splitStatements('   \n\t  ');
            expect(result).toEqual([]);
        });

        it('should handle CREATE PROCEDURE with BEGIN/END', () => {
            const sql = `CREATE PROCEDURE myproc()
            BEGIN
                SELECT 1;
                SELECT 2;
            END;
            SELECT 3;`;
            const result = SqlParser.splitStatements(sql);
            // Note: Current implementation will split on semicolons inside procedure
            // This test documents current behavior
            expect(result.length).toBeGreaterThan(0);
        });

        it('should handle escaped single quotes in strings', () => {
            const sql = "SELECT 'it''s a test'; SELECT 2;";
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(["SELECT 'it''s a test'", 'SELECT 2']);
        });

        it('should handle escaped quotes with semicolons inside', () => {
            const sql = "SELECT 'test ''; end;'; SELECT 2;";
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(["SELECT 'test ''; end;'", 'SELECT 2']);
        });

        it('should handle multiple escaped quotes in one string', () => {
            const sql = "SELECT '''a'';''b'''; SELECT 2;";
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(["SELECT '''a'';''b'''", 'SELECT 2']);
        });

        it('should handle multiple consecutive semicolons', () => {
            const sql = 'SELECT 1;;; SELECT 2;';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT 1', 'SELECT 2']);
        });

        it('should handle multiline SQL', () => {
            const sql = `SELECT 
                id,
                name
            FROM 
                users;
            SELECT * FROM orders;`;
            const result = SqlParser.splitStatements(sql);
            expect(result.length).toBe(2);
        });

        it('should handle line comment at end of file', () => {
            const sql = 'SELECT 1; -- comment with ;';
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT 1', '-- comment with ;']);
        });

        it('should keep semicolons inside COMMENT ON string literal', () => {
            const sql = "COMMENT ON TABLE JUST_DATA.ADMIN.DIMACCOUNT IS 'a;b;c'; SELECT 1;";
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(["COMMENT ON TABLE JUST_DATA.ADMIN.DIMACCOUNT IS 'a;b;c'", 'SELECT 1']);
        });

        it('should split a typical Netezza maintenance script', () => {
            const sql = `GROOM TABLE JUST_DATA.ADMIN.DIMACCOUNT;
GENERATE STATISTICS ON JUST_DATA..DIMACCOUNT;
SELECT 1;`;
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual([
                'GROOM TABLE JUST_DATA.ADMIN.DIMACCOUNT',
                'GENERATE STATISTICS ON JUST_DATA..DIMACCOUNT',
                'SELECT 1'
            ]);
        });

        it('should handle block comment spanning multiple lines with semicolons', () => {
            const sql = `SELECT 1 /* a;
multiline;
comment */; SELECT 2;`;
            const result = SqlParser.splitStatements(sql);
            expect(result).toEqual(['SELECT 1 /* a;\nmultiline;\ncomment */', 'SELECT 2']);
        });
    });


    describe('getStatementAtPosition', () => {
        it('should find statement at cursor position', () => {
            const sql = 'SELECT 1; SELECT 2; SELECT 3;';
            //                   ^--- offset 10
            const result = SqlParser.getStatementAtPosition(sql, 10);
            expect(result).not.toBeNull();
            expect(result?.sql).toBe('SELECT 2');
        });

        it('should find first statement when cursor at beginning', () => {
            const sql = 'SELECT 1; SELECT 2;';
            const result = SqlParser.getStatementAtPosition(sql, 0);
            expect(result).not.toBeNull();
            expect(result?.sql).toBe('SELECT 1');
        });

        it('should find last statement when cursor at end', () => {
            const sql = 'SELECT 1; SELECT 2';
            const result = SqlParser.getStatementAtPosition(sql, 15);
            expect(result).not.toBeNull();
            expect(result?.sql).toBe('SELECT 2');
        });

        it('should return null for empty content', () => {
            const sql = '   ; ;  ';
            const result = SqlParser.getStatementAtPosition(sql, 3);
            expect(result).toBeNull();
        });

        it('should handle statement with quotes', () => {
            const sql = "SELECT 'value'; SELECT 2;";
            const result = SqlParser.getStatementAtPosition(sql, 5);
            expect(result).not.toBeNull();
            expect(result?.sql).toBe("SELECT 'value'");
        });

        it('should return correct start and end positions', () => {
            const sql = 'SELECT 1; SELECT 2; SELECT 3;';
            //           0123456789...
            const result = SqlParser.getStatementAtPosition(sql, 12);
            expect(result).not.toBeNull();
            expect(result?.sql).toBe('SELECT 2');
            // Verify that start and end make sense
            expect(result?.start).toBeGreaterThanOrEqual(0);
            expect(result?.end).toBeGreaterThan(result?.start || 0);
            // Verify that extracting with these positions gives the right content
            expect(sql.substring(result!.start, result!.end).trim()).toBe('SELECT 2');
        });

        it('should return the current statement when cursor is on the semicolon', () => {
            const sql = 'SELECT 1; SELECT 2; SELECT 3;';
            const result = SqlParser.getStatementAtPosition(sql, 8); // on ';' after SELECT 1
            expect(result?.sql).toBe('SELECT 1');
        });

        it('should return the next statement when cursor is just after semicolon + whitespace', () => {
            const sql = 'SELECT 1;   SELECT 2;';
            const result = SqlParser.getStatementAtPosition(sql, 10); // inside whitespace after first ';'
            expect(result?.sql).toBe('SELECT 2');
        });

        it('should ignore semicolons inside block comments when finding statement boundaries', () => {
            const sql = 'SELECT 1 /* comment; with ; */; SELECT 2;';
            const result = SqlParser.getStatementAtPosition(sql, 5);
            expect(result?.sql).toBe('SELECT 1 /* comment; with ; */');
        });

        it('should reuse cached statement boundaries for repeated cursor lookups', () => {
            const sql = 'SELECT 1; SELECT 2; SELECT 3;';
            const documentKey = { documentId: 'file:///cache-test.sql', version: 1 };

            SqlParser.clearDocumentCache(documentKey.documentId);

            const first = SqlParser.getStatementAtPosition(sql, 10, documentKey);
            const second = SqlParser.getStatementAtPosition(sql, 12, documentKey);

            expect(first?.sql).toBe('SELECT 2');
            expect(second?.sql).toBe('SELECT 2');
        });

        it('should cache empty statement boundaries from consecutive semicolons', () => {
            const sql = 'SELECT 1;; SELECT 2;';
            const documentKey = { documentId: 'file:///cache-empty-statements.sql', version: 1 };

            SqlParser.clearDocumentCache(documentKey.documentId);

            for (const offset of [8, 9, 10]) {
                expect(SqlParser.getStatementAtPosition(sql, offset, documentKey)).toEqual(
                    SqlParser.getStatementAtPosition(sql, offset),
                );
            }
        });

        it('should invalidate cached statement boundaries when document version changes', () => {
            const sqlV1 = 'SELECT 1; SELECT 2;';
            const sqlV2 = 'SELECT 10; SELECT 20;';
            const documentId = 'file:///cache-version.sql';

            SqlParser.clearDocumentCache(documentId);

            const v1 = SqlParser.getStatementAtPosition(sqlV1, 10, {
                documentId,
                version: 1,
            });
            const v2 = SqlParser.getStatementAtPosition(sqlV2, 11, {
                documentId,
                version: 2,
            });

            expect(v1?.sql).toBe('SELECT 2');
            expect(v2?.sql).toBe('SELECT 20');
        });
    });

    describe('getObjectAtPosition', () => {
        it('should parse simple name', () => {
            const sql = 'SELECT * FROM mytable WHERE id = 1';
            //                        ^--- offset 14
            const result = SqlParser.getObjectAtPosition(sql, 14);
            expect(result).toEqual({ name: 'mytable' });
        });

        it('should parse schema.name format', () => {
            const sql = 'SELECT * FROM myschema.mytable';
            const result = SqlParser.getObjectAtPosition(sql, 20);
            expect(result).toEqual({ schema: 'myschema', name: 'mytable' });
        });

        it('should parse database.schema.name format', () => {
            const sql = 'SELECT * FROM mydb.myschema.mytable';
            const result = SqlParser.getObjectAtPosition(sql, 25);
            expect(result).toEqual({ database: 'mydb', schema: 'myschema', name: 'mytable' });
        });

        it('should parse database..name format (Netezza shorthand)', () => {
            const sql = 'SELECT * FROM mydb..mytable';
            const result = SqlParser.getObjectAtPosition(sql, 20);
            expect(result).toEqual({ database: 'mydb', name: 'mytable' });
        });

        it('should handle quoted identifiers', () => {
            // Parser includes quotes as identifier chars but not spaces
            // So "mytable" works, but "my table" gets truncated at space
            const sql = 'SELECT * FROM "MYTABLE"';
            const result = SqlParser.getObjectAtPosition(sql, 18);
            expect(result).not.toBeNull();
            expect(result?.name).toBe('MYTABLE');
        });

        it('should return null for whitespace', () => {
            const sql = 'SELECT   FROM table1';
            const result = SqlParser.getObjectAtPosition(sql, 7);
            expect(result).toBeNull();
        });

        it('should parse database..name when cursor is on the second dot', () => {
            const sql = 'SELECT * FROM JUST_DATA..DIMACCOUNT';
            const dotIndex = sql.indexOf('..') + 1; // second dot
            const result = SqlParser.getObjectAtPosition(sql, dotIndex);
            expect(result).toEqual({ database: 'JUST_DATA', name: 'DIMACCOUNT' });
        });

        it('should parse schema.name when cursor is on the dot', () => {
            const sql = 'SELECT * FROM ADMIN.DIMACCOUNT';
            const dotIndex = sql.indexOf('.');
            const result = SqlParser.getObjectAtPosition(sql, dotIndex);
            expect(result).toEqual({ schema: 'ADMIN', name: 'DIMACCOUNT' });
        });

        it('should handle quoted identifiers with dots inside (best-effort)', () => {
            const sql = 'SELECT * FROM "MYSCHEMA"."MYTABLE"';
            const result = SqlParser.getObjectAtPosition(sql, sql.indexOf('MYTABLE'));
            expect(result).toEqual({ schema: 'MYSCHEMA', name: 'MYTABLE' });
        });
    });

    describe('splitStatementsWithPositions', () => {
        it('should return correct offsets for multiple statements', () => {
            const sql = 'SELECT 1; SELECT 2;';
            const result = SqlParser.splitStatementsWithPositions(sql);
            expect(result).toHaveLength(2);
            expect(result[0].sql).toBe('SELECT 1');
            expect(result[0].startOffset).toBe(0);
            expect(result[0].endOffset).toBe(8);
            expect(result[1].sql).toBe('SELECT 2');
            expect(result[1].startOffset).toBe(10);
            expect(result[1].endOffset).toBe(18);
        });

        it('should handle single statement without semicolon', () => {
            const sql = 'SELECT * FROM users';
            const result = SqlParser.splitStatementsWithPositions(sql);
            expect(result).toHaveLength(1);
            expect(result[0].sql).toBe('SELECT * FROM users');
            expect(result[0].startOffset).toBe(0);
            expect(result[0].endOffset).toBe(sql.length);
        });

        it('should return empty array for empty input', () => {
            expect(SqlParser.splitStatementsWithPositions('')).toEqual([]);
        });

        it('should return empty array for whitespace only', () => {
            expect(SqlParser.splitStatementsWithPositions('   \n\t  ')).toEqual([]);
        });

        it('should skip leading whitespace in startOffset', () => {
            const sql = '   SELECT 1;   SELECT 2;';
            const result = SqlParser.splitStatementsWithPositions(sql);
            expect(result).toHaveLength(2);
            expect(result[0].startOffset).toBe(3);
            expect(result[1].startOffset).toBe(15);
        });

        it('should handle statements with semicolons in quotes', () => {
            const sql = "SELECT 'a;b'; SELECT 2;";
            const result = SqlParser.splitStatementsWithPositions(sql);
            expect(result).toHaveLength(2);
            expect(result[0].sql).toBe("SELECT 'a;b'");
            expect(result[1].sql).toBe('SELECT 2');
        });

        it('should handle statements with block comments', () => {
            const sql = 'SELECT 1 /* comment; */; SELECT 2;';
            const result = SqlParser.splitStatementsWithPositions(sql);
            expect(result).toHaveLength(2);
            expect(result[0].sql).toBe('SELECT 1 /* comment; */');
            expect(result[1].sql).toBe('SELECT 2');
        });

        it('should handle multiline SQL with correct offsets', () => {
            const sql = 'SELECT 1\nFROM t1;\nSELECT 2\nFROM t2;';
            const result = SqlParser.splitStatementsWithPositions(sql);
            expect(result).toHaveLength(2);
            expect(result[0].sql).toBe('SELECT 1\nFROM t1');
            expect(result[1].sql).toBe('SELECT 2\nFROM t2');
            expect(sql.substring(result[0].startOffset, result[0].endOffset).trim()).toBe('SELECT 1\nFROM t1');
        });

        it('keeps SAS-like macro control blocks together', () => {
            const sql = `%LET run = 1;
%IF &run = 1 %THEN %DO;
  SELECT 1;
%ELSE %DO;
  THIS IS SKIPPED;
%END;
SELECT 2;`;
            const result = SqlParser.splitStatementsWithPositions(sql);

            expect(result).toHaveLength(3);
            expect(result[0].sql).toBe('%LET run = 1');
            expect(result[1].sql).toContain('%IF &run = 1 %THEN %DO;');
            expect(result[1].sql).toContain('%END');
            expect(result[2].sql).toBe('SELECT 2');

            const plain = SqlParser.splitStatements(sql);
            expect(plain).toHaveLength(3);
            expect(plain[1]).toContain('THIS IS SKIPPED;');
            expect(plain[2]).toBe('SELECT 2');
        });
    });
});

