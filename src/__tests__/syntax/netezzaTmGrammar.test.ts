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
