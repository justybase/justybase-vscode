jest.unmock('chevrotain');

import type { DatabaseKind } from '../contracts/database';
import {
  collectIdentifierOccurrences,
  type IdentifierSemanticRole,
} from '../providers/parsers/identifierRoleCollector';

function identifierOffsets(sql: string, identifier: string): number[] {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi');
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    offsets.push(match.index);
  }
  return offsets;
}

function roleAt(
  sql: string,
  identifier: string,
  occurrence = 0,
  databaseKind?: DatabaseKind,
): string | undefined {
  const offsets = identifierOffsets(sql, identifier);
  const offset = offsets[occurrence];
  if (offset === undefined) {
    return undefined;
  }
  return collectIdentifierOccurrences(sql, databaseKind).get(offset)?.role;
}

function allRolesAt(
  sql: string,
  identifier: string,
  databaseKind?: DatabaseKind,
): IdentifierSemanticRole[] {
  const roles = collectIdentifierOccurrences(sql, databaseKind);
  return identifierOffsets(sql, identifier)
    .map((offset) => roles.get(offset)?.role)
    .filter((role): role is IdentifierSemanticRole => role !== undefined);
}

describe('collectIdentifierOccurrences', () => {
  it('classifies alias.column separately from schema.table in FROM', () => {
    const sql = [
      'SELECT ALIAS_TABELI.ACCOUNTKEY FROM JUST_DATA.ADMIN.DIMACCOUNT ALIAS_TABELI',
      'WHERE ALIAS_TABELI.ACCOUNTKEY > 0',
    ].join('\n');

    expect(roleAt(sql, 'ALIAS_TABELI', 0)).toBe('alias');
    expect(roleAt(sql, 'ACCOUNTKEY', 0)).toBe('column');
    expect(roleAt(sql, 'JUST_DATA')).toBe('database');
    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'DIMACCOUNT')).toBe('table');
    expect(roleAt(sql, 'ALIAS_TABELI', 1)).toBe('alias');
    expect(roleAt(sql, 'ACCOUNTKEY', 1)).toBe('column');
  });

  it('classifies schema.table in FROM with both segments as table references', () => {
    const sql = 'SELECT * FROM ADMIN.ORDERS o WHERE o.ORDER_ID > 0';

    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'ORDERS')).toBe('table');
    expect(roleAt(sql, 'o')).toBe('alias');
    expect(roleAt(sql, 'ORDER_ID')).toBe('column');
  });

  it('classifies JOIN with db..table after nested block comments', () => {
    const sql = [
      '/* outer start',
      '   /* inner still comment */',
      'outer end */',
      '',
      'SELECT d.*',
      'FROM JUST_DATA.ADMIN.DIMDATE d',
      'JOIN JUST_DATA..DIMACCOUNT a ON a.id = d.id',
    ].join('\n');

    expect(roleAt(sql, 'DIMACCOUNT')).toBe('table');
    expect(roleAt(sql, 'JUST_DATA', 1)).toBe('database');
  });

  it('classifies db..table notation', () => {
    const sql = 'SELECT * FROM MYDB..MYTABLE t';

    expect(roleAt(sql, 'MYDB')).toBe('database');
    expect(roleAt(sql, 'MYTABLE')).toBe('table');
    expect(roleAt(sql, 't')).toBe('alias');
  });

  it('classifies CTE names', () => {
    const sql = 'WITH cte AS (SELECT 1 AS x) SELECT x FROM cte';

    expect(roleAt(sql, 'cte', 0)).toBe('cte');
  });

  it('classifies UPDATE target table as alias and SET/WHERE columns', () => {
    const sql = 'UPDATE t SET col = 1 WHERE t.id > 0';

    expect(roleAt(sql, 't', 0)).toBe('alias');
    expect(roleAt(sql, 'col')).toBe('column');
    expect(roleAt(sql, 't', 1)).toBe('alias');
    expect(roleAt(sql, 'id')).toBe('column');
  });

  it('classifies DELETE with schema.table and alias', () => {
    const sql = "DELETE FROM ADMIN.ORDERS o WHERE o.status = 'X'";

    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'ORDERS')).toBe('table');
    expect(roleAt(sql, 'o')).toBe('alias');
    expect(roleAt(sql, 'status')).toBe('column');
  });

  it('classifies INSERT target table and column list', () => {
    const sql = 'INSERT INTO MYDB..TARGET (COL_A, COL_B) VALUES (1, 2)';

    expect(roleAt(sql, 'MYDB')).toBe('database');
    expect(roleAt(sql, 'TARGET')).toBe('table');
    expect(roleAt(sql, 'COL_A')).toBe('column');
    expect(roleAt(sql, 'COL_B')).toBe('column');
  });

  it('classifies NZPLSQL procedure parameters and local variables separately from columns', () => {
    const sql = `CREATE PROCEDURE p(i INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v INT4;
BEGIN
  v := i + 1;
  RETURN v;
END;
END_PROC;`;

    expect(roleAt(sql, 'p')).toBe('table');
    expect(roleAt(sql, 'i')).toBe('localVariable');
    expect(roleAt(sql, 'v', 0)).toBe('localVariable');
    expect(roleAt(sql, 'v', 1)).toBe('localVariable');
    expect(roleAt(sql, 'v', 2)).toBe('localVariable');
  });

  it('classifies UPDATE with explicit AS alias without marking table name as alias', () => {
    const sql = 'UPDATE ADMIN.ORDERS AS o SET o.status = 1';

    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'ORDERS')).toBe('table');
    expect(roleAt(sql, 'o', 0)).toBe('alias');
    expect(roleAt(sql, 'status')).toBe('column');
    expect(allRolesAt(sql, 'o')).toEqual(['alias', 'alias']);
  });

  it('classifies UPDATE FROM with multiple table aliases', () => {
    const sql = 'UPDATE t SET t.col = o.other_col FROM other o WHERE t.id = o.id';

    expect(roleAt(sql, 't', 0)).toBe('alias');
    expect(roleAt(sql, 'col')).toBe('column');
    expect(roleAt(sql, 'other')).toBe('table');
    expect(roleAt(sql, 'o', 0)).toBe('alias');
    expect(roleAt(sql, 'other_col')).toBe('column');
    expect(roleAt(sql, 'id', 0)).toBe('column');
    expect(roleAt(sql, 'id', 1)).toBe('column');
  });

  it('classifies INSERT without column list and does not treat VALUES literals as columns', () => {
    const sql = 'INSERT INTO TARGET SELECT col_a FROM source s';

    expect(roleAt(sql, 'TARGET')).toBe('table');
    expect(roleAt(sql, 'col_a')).toBe('column');
    expect(roleAt(sql, 'source')).toBe('table');
    expect(roleAt(sql, 's')).toBe('alias');
  });

  it('classifies unqualified SELECT list columns and star qualifiers', () => {
    const sql = 'SELECT accountkey, t.* FROM tbl t';

    expect(roleAt(sql, 'accountkey')).toBe('column');
    expect(roleAt(sql, 't', 0)).toBe('alias');
    expect(roleAt(sql, 'tbl')).toBe('table');
  });

  it('classifies INNER JOIN table names, aliases, and ON clause columns', () => {
    const sql = 'SELECT T1.ID, T2.ID FROM T1 INNER JOIN T2 ON T1.ID = T2.ID';

    expect(roleAt(sql, 'T1', 0)).toBe('alias');
    expect(roleAt(sql, 'T2', 0)).toBe('alias');
    expect(roleAt(sql, 'T1', 1)).toBe('table');
    expect(roleAt(sql, 'T2', 1)).toBe('table');
    expect(allRolesAt(sql, 'ID')).toEqual(['column', 'column', 'column', 'column']);
  });

  it('classifies CREATE VIEW qualified names', () => {
    const sql = 'CREATE VIEW MYDB.ADMIN.MY_VIEW AS SELECT 1';

    expect(roleAt(sql, 'MYDB')).toBe('database');
    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'MY_VIEW')).toBe('table');
  });

  it('keeps CREATE TABLE database role when an NZPLSQL procedure follows', () => {
    const sql = `CREATE TABLE JUST_DATA.ADMIN.COLOR_CHECK_FACT (
  ID INT NOT NULL,
  ACCOUNTKEY INT8,
  STATUS NVARCHAR(20),
  CREATED_AT TIMESTAMPTZ
);

CREATE OR REPLACE PROCEDURE ADMIN.SP_COLOR_CHECK(IN p_account INT, OUT p_count INT)
RETURNS INT
LANGUAGE NZPLSQL
EXECUTE AS OWNER
AS BEGIN_PROC
DECLARE
  v_sql VARCHAR(2000);
BEGIN
  v_sql := 'SELECT COUNT(*) FROM JUST_DATA.ADMIN.COLOR_CHECK_FACT';
  EXECUTE IMMEDIATE v_sql;
  RAISE NOTICE 'color check ran';
  RETURN 1;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'color check failed';
    RETURN 0;
END;
END_PROC;`;

    expect(roleAt(sql, 'JUST_DATA', 0)).toBe('database');
    expect(roleAt(sql, 'ADMIN', 0)).toBe('schema');
    expect(roleAt(sql, 'COLOR_CHECK_FACT', 0)).toBe('table');
  });

  it('classifies DROP TABLE qualified target names', () => {
    const sql = 'DROP TABLE MYDB..OLD_TABLE;';

    expect(roleAt(sql, 'MYDB')).toBe('database');
    expect(roleAt(sql, 'OLD_TABLE')).toBe('table');
  });

  it('classifies ALTER TABLE qualified names', () => {
    const sql = 'ALTER TABLE MYDB.ADMIN.TARGET RENAME TO TARGET_NEW';

    expect(roleAt(sql, 'MYDB')).toBe('database');
    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'TARGET')).toBe('table');
  });

  it('classifies JOIN ON columns when column name is a SQL keyword token', () => {
    const sql = 'SELECT a.col1 FROM left_tbl a JOIN right_tbl b ON a.key = b.key';

    expect(roleAt(sql, 'key', 0)).toBe('column');
    expect(roleAt(sql, 'key', 1)).toBe('column');
  });

  it('classifies CALL procedure qualified names as table role', () => {
    const sql = 'CALL MYDB.ADMIN.MY_PROC(1)';

    expect(roleAt(sql, 'MYDB')).toBe('database');
    expect(roleAt(sql, 'ADMIN')).toBe('schema');
    expect(roleAt(sql, 'MY_PROC')).toBe('table');
  });

  it('classifies FOR loop variable declaration and RETURN reference as localVariable', () => {
    const sql = `CREATE PROCEDURE p()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  FOR loop_var IN 1 .. 10 LOOP
    RETURN loop_var;
  END LOOP;
END;
END_PROC;`;

    expect(allRolesAt(sql, 'loop_var')).toEqual(['localVariable', 'localVariable']);
  });

  it('classifies CTE definition, qualifier, and FROM reference roles', () => {
    const sql = 'WITH cte AS (SELECT 1 AS x) SELECT cte.row_id FROM cte';

    expect(roleAt(sql, 'cte', 0)).toBe('cte');
    expect(roleAt(sql, 'cte', 1)).toBe('alias');
    expect(roleAt(sql, 'cte', 2)).toBe('table');
    expect(roleAt(sql, 'row_id')).toBe('column');
  });

  it('returns empty map for unparseable SQL without throwing', () => {
    const occurrences = collectIdentifierOccurrences('SELECT FROM WHERE');
    expect(occurrences.size).toBe(0);
  });

  it('uses netezza databaseKind explicitly for NZPLSQL constructs', () => {
    const sql = `CREATE PROCEDURE p(i INT4)
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE v INT4;
BEGIN
  v := i;
END;
END_PROC;`;

    expect(roleAt(sql, 'i', 0, 'netezza')).toBe('localVariable');
    expect(roleAt(sql, 'v', 0, 'netezza')).toBe('localVariable');
  });
});
