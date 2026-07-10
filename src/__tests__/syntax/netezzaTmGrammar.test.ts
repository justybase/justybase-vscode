import {
  findTokenContaining,
  type FlatToken,
  isCommentToken,
  tokenizeSql,
  tokensMatching,
} from './netezzaTmGrammarHarness';

const FORBIDDEN_IN_COMMENT =
  /(?:\.netezza\b|constant\.other\.(?:database|schema|table)-name\.sql|variable\.other\.readwrite)/;

function hasScope(token: FlatToken | undefined, pattern: RegExp): boolean {
  return token?.scopes.some((scope) => pattern.test(scope)) ?? false;
}

function commentInjectionLeaks(tokens: readonly FlatToken[]): string[] {
  return tokensMatching(
    tokens,
    (token) =>
      isCommentToken(token) &&
      FORBIDDEN_IN_COMMENT.test(token.scopes.join(' ')),
  ).map((token) => `L${token.line} "${token.text.trim()}" ${token.scopes.join(' ')}`);
}

describe('Netezza TextMate injection (netezza.tmLanguage.json)', () => {
  it('loads and tokenizes without Oniguruma errors', async () => {
    const tokens = await tokenizeSql('SELECT 1');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('does not apply Netezza scopes inside line or block comments', async () => {
    const sql = [
      '--SELECT * FROM JUST_DATA..DIMACCOUNT',
      "-- CALL JUST_DATA..SP('x')",
      '-- DISTRIBUTE ON RANDOM',
      '-- ${COMMENT_VAR} CURRENT_DATE',
      '/*',
      'SELECT 123 FROM JUST_DATA.ADMIN.DIMDATE D',
      'JOIN ADMIN.DIMACCOUNT A ON A.ID = D.ID',
      'WHERE D.CALENDARQUARTER > 0',
      'CALL JUST_DATA..PROCEDURE();',
      'DISTRIBUTE ON RANDOM',
      '*/',
      'SELECT 1',
    ].join('\n');

    const tokens = await tokenizeSql(sql);
    expect(commentInjectionLeaks(tokens)).toEqual([]);
  });

  it('still highlights Netezza keywords in active SQL', async () => {
    const sql = [
      'SELECT CURRENT_DATE FROM t',
      'CREATE TABLE x (id INT) DISTRIBUTE ON RANDOM',
      'MERGE INTO tgt USING src ON 1=1',
      'CALL JUST_DATA..SP_GET_ACCOUNT_DETAILS()',
    ].join('\n');

    const tokens = await tokenizeSql(sql);
    const distribute = findTokenContaining(tokens, 'DISTRIBUTE', { onlyActiveCode: true });
    const current = findTokenContaining(tokens, 'CURRENT_DATE', { onlyActiveCode: true });
    const merge = findTokenContaining(tokens, 'MERGE', { onlyActiveCode: true });
    const call = findTokenContaining(tokens, 'CALL', { onlyActiveCode: true });

    expect(hasScope(distribute, /keyword\.other\.ddl\.netezza/)).toBe(true);
    expect(hasScope(current, /constant\.language\.netezza/)).toBe(true);
    expect(hasScope(merge, /keyword\.other\.ddl\.netezza/)).toBe(true);
    expect(hasScope(call, /keyword\.other\.nzplsql\.netezza/)).toBe(true);
  });

  it('colors code before trailing -- without applying injection to the comment tail', async () => {
    const sql = 'SELECT CURRENT_DATE FROM t -- DISTRIBUTE ON JUST_DATA..DIMACCOUNT CALL SP';
    const tokens = await tokenizeSql(sql);

    const select = findTokenContaining(tokens, 'SELECT');
    const current = findTokenContaining(tokens, 'CURRENT_DATE');
    const commentTail = findTokenContaining(tokens, 'DISTRIBUTE');

    expect(select && !isCommentToken(select)).toBe(true);
    expect(hasScope(current, /constant\.language\.netezza/)).toBe(true);
    expect(commentTail && isCommentToken(commentTail)).toBe(true);
    expect(commentInjectionLeaks(tokens)).toEqual([]);
  });

  it('does not treat comment markers inside strings as comments or injection targets', async () => {
    const sql = "SELECT '--', '/* JUST_DATA..DIMACCOUNT */', * FROM JUST_DATA..DIMACCOUNT";
    const tokens = await tokenizeSql(sql);

    const select = findTokenContaining(tokens, 'SELECT');
    const stringTable = findTokenContaining(tokens, '/* JUST_DATA..DIMACCOUNT */');
    const activeTable = findTokenContaining(tokens, 'DIMACCOUNT', { onlyActiveCode: true });

    expect(select && !isCommentToken(select)).toBe(true);
    expect(stringTable && !isCommentToken(stringTable)).toBe(true);
    expect(hasScope(stringTable, FORBIDDEN_IN_COMMENT)).toBe(false);
    expect(hasScope(activeTable, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it('highlights SAS-like macro directives, functions, and references', async () => {
    const sql = [
      '%LET dim_table = JUST_DATA.ADMIN.DIMDATE;',
      '%PUT table=${ dim_table };',
      "%EXPORT(format='xlsx', file='/tmp/out.xlsx', query=(SELECT * FROM &dim_table));",
      "%INCLUDE 'shared.sql';",
      "%IF &run = 1 %THEN %DO;",
      "%END;",
      'SELECT &as_of_key, $as_of_key, ${ as_of_key } FROM &dim_table',
      'WHERE DATEKEY >= %EVAL($as_of_key - 30)',
      '  AND CALENDARQUARTER IN (%SQLLIST(SELECT CALENDARQUARTER FROM &dim_table));',
      '-- %LET commented = 1; &commented %SQL(SELECT 1)',
      "SELECT '%PUT literal &x';",
    ].join('\n');

    const tokens = await tokenizeSql(sql);
    const letDirective = findTokenContaining(tokens, '%LET', { onlyActiveCode: true });
    const putDirective = findTokenContaining(tokens, '%PUT', { onlyActiveCode: true });
    const exportDirective = findTokenContaining(tokens, '%EXPORT', { onlyActiveCode: true });
    const includeDirective = findTokenContaining(tokens, '%INCLUDE', { onlyActiveCode: true });
    const ifDirective = findTokenContaining(tokens, '%IF', { onlyActiveCode: true });
    const doDirective = findTokenContaining(tokens, '%DO', { onlyActiveCode: true });
    const endDirective = findTokenContaining(tokens, '%END', { onlyActiveCode: true });
    const sqlListFunction = findTokenContaining(tokens, '%SQLLIST', { onlyActiveCode: true });
    const evalFunction = findTokenContaining(tokens, '%EVAL', { onlyActiveCode: true });
    const ampReference = findTokenContaining(tokens, '&as_of_key', { onlyActiveCode: true });
    const dollarReference = findTokenContaining(tokens, '$as_of_key', { onlyActiveCode: true });
    const braceReference = findTokenContaining(tokens, '${ as_of_key }', { onlyActiveCode: true });
    const commentedLet = findTokenContaining(tokens, 'commented = 1');
    const literalPut = findTokenContaining(tokens, '%PUT literal');

    expect(hasScope(letDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(putDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(exportDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(includeDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(ifDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(doDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(endDirective, /keyword\.control\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(sqlListFunction, /support\.function\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(evalFunction, /support\.function\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(ampReference, /variable\.other\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(dollarReference, /variable\.other\.macro\.sas\.sql/)).toBe(true);
    expect(hasScope(braceReference, /variable\.other\.macro\.sas\.sql/)).toBe(true);
    expect(commentedLet && isCommentToken(commentedLet)).toBe(true);
    expect(literalPut && !isCommentToken(literalPut)).toBe(true);
    expect(hasScope(literalPut, /keyword\.control\.macro\.sas\.sql/)).toBe(false);
  });

  it('still highlights DB..TABLE in active SQL (P15)', async () => {
    const sql = 'JOIN JUST_DATA..DIMACCOUNT a ON 1=1';
    const tokens = await tokenizeSql(sql);
    const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'DIMACCOUNT', { onlyActiveCode: true });
    expect(hasScope(db, /database-name/)).toBe(true);
    expect(hasScope(table, /table-name/)).toBe(true);
  });

  it('still highlights three-part names in active SQL (P16)', async () => {
    const sql = 'FROM JUST_DATA.ADMIN.DIMDATE d';
    const tokens = await tokenizeSql(sql);
    const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
    const schema = findTokenContaining(tokens, 'ADMIN', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'DIMDATE', { onlyActiveCode: true });

    expect(hasScope(db, /database-name/)).toBe(true);
    expect(hasScope(schema, /schema-name/)).toBe(true);
    expect(hasScope(table, /table-name/)).toBe(true);
  });

  it.each([
    [
      'CREATE TABLE',
      'CREATE TABLE JUST_DATA.ADMIN.TEST2 AS (SELECT * FROM DIMDATE);',
    ],
    [
      'CREATE TEMP TABLE',
      'CREATE TEMP TABLE JUST_DATA.ADMIN.TEST_TMP AS (SELECT * FROM DIMDATE);',
    ],
    [
      'CREATE GLOBAL TEMP TABLE',
      'CREATE GLOBAL TEMP TABLE JUST_DATA.ADMIN.TEST1 AS (SELECT * FROM DIMDATE) DISTRIBUTE ON RANDOM;',
    ],
  ])(
    'highlights %s CTAS qualified 3-part names (P0) instead of meta.create entity.name.function',
    async (_label, sql) => {
      const tokens = await tokenizeSql(sql);
      const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
      const schema = findTokenContaining(tokens, 'ADMIN', { onlyActiveCode: true });
      const table = findTokenContaining(tokens, 'TEST', { onlyActiveCode: true });

      expect(hasScope(db, /constant\.other\.database-name\.sql/)).toBe(true);
      expect(hasScope(schema, /constant\.other\.schema-name\.sql/)).toBe(true);
      expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
      expect(hasScope(db, /entity\.name\.function\.sql/)).toBe(false);
    },
  );

  it('highlights CREATE TABLE DB..TABLE notation (P0.2)', async () => {
    const sql = 'CREATE TABLE JUST_DATA..WORKING_SET AS (SELECT 1);';
    const tokens = await tokenizeSql(sql);
    const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'WORKING_SET', { onlyActiveCode: true });

    expect(hasScope(db, /constant\.other\.database-name\.sql/)).toBe(true);
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
    expect(hasScope(db, /entity\.name\.function\.sql/)).toBe(false);
  });

  it('highlights CREATE TABLE DB..TABLE with user-reported multiline CTAS (P0.2)', async () => {
    const sql = 'CREATE TABLE JUST_DATA..TEST2 AS (\n    SELECT * FROM DIMDATE\n);';
    const tokens = await tokenizeSql(sql);
    const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'TEST2', { onlyActiveCode: true });

    expect(hasScope(db, /constant\.other\.database-name\.sql/)).toBe(true);
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
    expect(hasScope(db, /entity\.name\.function\.sql/)).toBe(false);
  });

  it('highlights CREATE TEMP TABLE single unqualified name (P0.4/P0d)', async () => {
    const sql = 'CREATE TEMP TABLE TEST1 AS (\n    SELECT * FROM DIMDATE\n) DISTRIBUTE';
    const tokens = await tokenizeSql(sql);
    const table = findTokenContaining(tokens, 'TEST1', { onlyActiveCode: true });

    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it.each([
    {
      label: 'unqualified table',
      sql: 'CREATE TABLE TEST0 AS (SELECT 1);',
      names: { table: 'TEST0' },
      modifiers: [],
    },
    {
      label: 'temporary unqualified table',
      sql: 'CREATE TEMP TABLE TEST1 AS (SELECT 1);',
      names: { table: 'TEST1' },
      modifiers: ['TEMP'],
    },
    {
      label: 'temporary long-form unqualified table',
      sql: 'CREATE TEMPORARY TABLE TEST1_LONG AS (SELECT 1);',
      names: { table: 'TEST1_LONG' },
      modifiers: ['TEMPORARY'],
    },
    {
      label: 'database double-dot table',
      sql: 'CREATE TABLE JUST_DATA..TEST2 AS (SELECT 1);',
      names: { database: 'JUST_DATA', table: 'TEST2' },
      modifiers: [],
    },
    {
      label: 'three-part table',
      sql: 'CREATE TABLE JUST_DATA.ADMIN.TEST3 AS (SELECT 1);',
      names: { database: 'JUST_DATA', schema: 'ADMIN', table: 'TEST3' },
      modifiers: [],
    },
    {
      label: 'global temporary unqualified table',
      sql: 'CREATE GLOBAL TEMP TABLE TEST11 AS (SELECT 1);',
      names: { table: 'TEST11' },
      modifiers: ['GLOBAL', 'TEMP'],
    },
    {
      label: 'global temporary three-part table',
      sql: 'CREATE GLOBAL TEMP TABLE JUST_DATA.ADMIN.TEST12 AS (SELECT 1);',
      names: { database: 'JUST_DATA', schema: 'ADMIN', table: 'TEST12' },
      modifiers: ['GLOBAL', 'TEMP'],
    },
  ])('scopes the CREATE TABLE prefix and target for $label CTAS', async ({ sql, names, modifiers }) => {
    const tokens = await tokenizeSql(sql);
    const create = findTokenContaining(tokens, 'CREATE', { onlyActiveCode: true });
    const tableKeyword = findTokenContaining(tokens, 'TABLE', { onlyActiveCode: true });

    expect(hasScope(create, /keyword\.other\.ddl\.netezza/)).toBe(true);
    expect(hasScope(tableKeyword, /keyword\.other\.ddl\.netezza/)).toBe(true);

    for (const modifier of modifiers) {
      const token = findTokenContaining(tokens, modifier, { onlyActiveCode: true });
      expect(hasScope(token, /storage\.modifier\.netezza/)).toBe(true);
    }

    for (const [kind, identifier] of Object.entries(names)) {
      const token = findTokenContaining(tokens, identifier, { onlyActiveCode: true });
      expect(hasScope(token, new RegExp(`constant\\.other\\.${kind}-name\\.sql`))).toBe(true);
    }
  });

  it.each([
    ['OR REPLACE', 'CREATE OR REPLACE TABLE REPLACED_TABLE AS (SELECT 1);'],
    ['IF NOT EXISTS', 'CREATE TABLE IF NOT EXISTS NEW_TABLE AS (SELECT 1);'],
  ])('scopes the optional %s CREATE TABLE clause as DDL', async (clause, sql) => {
    const tokens = await tokenizeSql(sql);
    const token = findTokenContaining(tokens, clause, { onlyActiveCode: true });

    expect(hasScope(token, /keyword\.other\.ddl\.netezza/)).toBe(true);
  });

  it('highlights GROOM TABLE single unqualified name (P0g.4/P0gd)', async () => {
    const sql = 'GROOM TABLE DIMACCOUNT2 VERSIONS;';
    const tokens = await tokenizeSql(sql);
    const table = findTokenContaining(tokens, 'DIMACCOUNT2', { onlyActiveCode: true });

    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it('highlights GROOM TABLE DB..TABLE notation (P0g.2)', async () => {
    const sql = 'GROOM TABLE JUST_DATA..DIMACCOUNT2 VERSIONS;';
    const tokens = await tokenizeSql(sql);
    const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'DIMACCOUNT2', { onlyActiveCode: true });

    expect(hasScope(db, /constant\.other\.database-name\.sql/)).toBe(true);
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it.each([
    {
      label: 'unqualified table',
      sql: 'GROOM TABLE DIMACCOUNT2 VERSIONS;',
      names: { table: 'DIMACCOUNT2' },
    },
    {
      label: 'database double-dot table',
      sql: 'GROOM TABLE JUST_DATA..DIMACCOUNT2 VERSIONS;',
      names: { database: 'JUST_DATA', table: 'DIMACCOUNT2' },
    },
    {
      label: 'three-part table',
      sql: 'GROOM TABLE JUST_DATA.ADMIN.DIMACCOUNT2 VERSIONS;',
      names: { database: 'JUST_DATA', schema: 'ADMIN', table: 'DIMACCOUNT2' },
    },
  ])('scopes the GROOM TABLE prefix and target for $label', async ({ sql, names }) => {
    const tokens = await tokenizeSql(sql);
    const groom = findTokenContaining(tokens, 'GROOM', { onlyActiveCode: true });
    const tableKeyword = findTokenContaining(tokens, 'TABLE', { onlyActiveCode: true });

    expect(hasScope(groom, /keyword\.other\.ddl\.netezza/)).toBe(true);
    expect(hasScope(tableKeyword, /keyword\.other\.ddl\.netezza/)).toBe(true);

    for (const [kind, identifier] of Object.entries(names)) {
      const token = findTokenContaining(tokens, identifier, { onlyActiveCode: true });
      expect(hasScope(token, new RegExp(`constant\\.other\\.${kind}-name\\.sql`))).toBe(true);
      expect(hasScope(token, /meta\.ddl\.table-target\.netezza/)).toBe(true);
    }
  });

  it('still highlights schema.table in active FROM/JOIN SQL (P17)', async () => {
    const sql = 'JOIN ADMIN.DIMACCOUNT a ON 1=1';
    const tokens = await tokenizeSql(sql);
    const schema = findTokenContaining(tokens, 'ADMIN', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'DIMACCOUNT', { onlyActiveCode: true });

    expect(hasScope(schema, /schema-name/)).toBe(true);
    expect(hasScope(table, /table-name/)).toBe(true);
  });

  it('does not attach ddl.netezza scopes in block comments', async () => {
    const sql = '/*\nDISTRIBUTE ON RANDOM\n*/';
    const tokens = await tokenizeSql(sql);
    const distribute = findTokenContaining(tokens, 'DISTRIBUTE');
    expect(distribute && isCommentToken(distribute)).toBe(true);
    expect(hasScope(distribute, /keyword\.other\.ddl\.netezza/)).toBe(false);
    expect(commentInjectionLeaks(tokens)).toEqual([]);
  });

  it('keeps block comment interior on comment.block even with SQL-like text', async () => {
    const sql = '/*\nSELECT * FROM db..t\n*/\nSELECT 1';
    const tokens = await tokenizeSql(sql);

    const insideBlock = tokensMatching(
      tokens,
      (token) => token.line === 2 && token.text.includes('SELECT'),
    );
    expect(insideBlock.length).toBeGreaterThan(0);
    expect(insideBlock.every((token) => isCommentToken(token))).toBe(true);
    expect(commentInjectionLeaks(tokens)).toEqual([]);

    const activeSelect = findTokenContaining(tokens, 'SELECT', { onlyActiveCode: true });
    expect(activeSelect?.line).toBe(4);
  });
});
