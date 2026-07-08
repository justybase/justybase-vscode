jest.unmock('chevrotain');

import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { NetezzaSemanticTokensProvider } from '../providers/semanticTokensProvider';
import { parseSemanticScopeWithParser } from '../providers/parsers/parserSqlContext';
import { DocumentParseSession } from '../sqlParser/documentParseSession';
import * as parsingRuntime from '../sqlParser/parsingRuntime';

jest.mock('vscode', () => jest.requireActual('./__mocks__/vscode'));

const FUNCTION_IDX = 1;
const VARIABLE_IDX = 5;
const TYPE_IDX = 6;
const COLUMN_IDX = 7;
const TABLE_IDX = 8;
const ALIAS_IDX = 9;
const SCHEMA_IDX = 10;
const DATABASE_IDX = 11;
const LOCAL_VARIABLE_IDX = 12;
const READONLY_MASK = 1 << 0;
const ITALIC_MASK = 1 << 2;

function decodeSemanticTokens(data: Uint32Array): Array<{
  line: number;
  char: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}> {
  const tokens: Array<{
    line: number;
    char: number;
    length: number;
    tokenType: number;
    tokenModifiers: number;
  }> = [];

  for (let i = 0; i < data.length; i += 5) {
    tokens.push({
      line: data[i],
      char: data[i + 1],
      length: data[i + 2],
      tokenType: data[i + 3],
      tokenModifiers: data[i + 4],
    });
  }

  return tokens;
}

function findTokenAtOffset(
  tokens: ReturnType<typeof decodeSemanticTokens>,
  document: vscode.TextDocument,
  offset: number,
  length: number,
): ReturnType<typeof decodeSemanticTokens>[number] | undefined {
  const position = document.positionAt(offset);
  return tokens.find(
    (token) =>
      token.line === position.line &&
      token.char === position.character &&
      token.length === length,
  );
}

function identifierOffsets(text: string, identifier: string): number[] {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi');
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    offsets.push(match.index);
  }
  return offsets;
}

function findToken(
  tokens: ReturnType<typeof decodeSemanticTokens>,
  text: string,
  document: vscode.TextDocument,
  identifier: string,
  occurrence = 0,
): ReturnType<typeof decodeSemanticTokens>[number] | undefined {
  const offset = identifierOffsets(text, identifier)[occurrence];
  expect(offset).toBeDefined();
  return findTokenAtOffset(tokens, document, offset, identifier.length);
}

function createDocument(sql: string, version = 1): vscode.TextDocument {
  return {
    uri: vscode.Uri.parse('file:///test.sql'),
    languageId: 'sql',
    version,
    getText: () => sql,
    positionAt: (offset: number) => {
      const before = sql.slice(0, offset);
      const lines = before.split('\n');
      return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    },
    offsetAt: (position: vscode.Position) => {
      const lines = sql.split('\n');
      let offset = 0;
      for (let i = 0; i < position.line; i++) {
        offset += lines[i].length + 1;
      }
      return offset + position.character;
    },
  } as vscode.TextDocument;
}

function createMockConnectionManager(
  overrides: Partial<ConnectionManager> = {},
): ConnectionManager {
  return {
    getExecutionDatabaseKind: jest.fn().mockReturnValue('netezza'),
    getConnectionForExecution: jest.fn().mockReturnValue('CONN_1'),
    getDocumentDatabase: jest.fn().mockReturnValue(undefined),
    getConnectionMetadata: jest.fn().mockReturnValue({ database: 'MYDB' }),
    ...overrides,
  } as unknown as ConnectionManager;
}

function createMockMetadataCache(
  overrides: Partial<MetadataCache> = {},
): MetadataCache {
  return {
    getColumns: jest.fn(),
    getColumnsAnySchema: jest.fn().mockReturnValue([{ ATTNAME: 'KNOWN_COL' }]),
    ...overrides,
  } as unknown as MetadataCache;
}

function tokensFor(
  provider: NetezzaSemanticTokensProvider,
  sql: string,
): ReturnType<typeof decodeSemanticTokens> {
  const document = createDocument(sql);
  return decodeSemanticTokens(
    provider.provideDocumentSemanticTokens(
      document,
      new vscode.CancellationTokenSource().token,
    ).data,
  );
}

describe('NetezzaSemanticTokensProvider', () => {
  const provider = new NetezzaSemanticTokensProvider();

  it('uses a single parse for semantic token coloring when parse session is wired', () => {
    const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
    const session = new DocumentParseSession();
    const wiredProvider = new NetezzaSemanticTokensProvider(
      undefined,
      undefined,
      session,
    );
    const sql = 'SELECT t.id FROM src t WHERE t.id > 0;';
    const document = createDocument(sql);

    try {
      wiredProvider.provideDocumentSemanticTokens(
        document,
        new vscode.CancellationTokenSource().token,
      );
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('exposes semantic legend with SQL coloring token types', () => {
    const legend = provider.getLegend();
    expect(legend.tokenTypes).toEqual(
      expect.arrayContaining(['column', 'table', 'alias', 'schema', 'database', 'localVariable']),
    );
    expect(legend.tokenModifiers).toEqual(
      expect.arrayContaining(['readonly', 'italic']),
    );
  });

  it('colors table aliases as alias+italic and qualified columns as column', () => {
    const sql = [
      'SELECT ALIAS_TABELI.ACCOUNTKEY FROM JUST_DATA.ADMIN.DIMACCOUNT ALIAS_TABELI',
      'WHERE ALIAS_TABELI.ACCOUNTKEY > 0',
    ].join('\n');
    const document = createDocument(sql);

    const scope = parseSemanticScopeWithParser(sql);
    expect([...scope.globalAliasBindings.keys()]).toContain('ALIAS_TABELI');

    const semanticTokens = provider.provideDocumentSemanticTokens(
      document,
      new vscode.CancellationTokenSource().token,
    );
    const tokens = decodeSemanticTokens(semanticTokens.data);
    expect(tokens.length).toBeGreaterThan(0);

    const aliasInSelect = findToken(tokens, sql, document, 'ALIAS_TABELI');
    expect(aliasInSelect).toBeDefined();
    expect(aliasInSelect?.tokenType).toBe(ALIAS_IDX);
    expect((aliasInSelect?.tokenModifiers ?? 0) & ITALIC_MASK).toBe(ITALIC_MASK);

    const columnInSelect = findToken(tokens, sql, document, 'ACCOUNTKEY');
    expect(columnInSelect).toBeDefined();
    expect(columnInSelect?.tokenType).toBe(COLUMN_IDX);

    const aliasInWhere = findToken(tokens, sql, document, 'ALIAS_TABELI', 1);
    expect(aliasInWhere).toBeDefined();
    expect((aliasInWhere?.tokenModifiers ?? 0) & ITALIC_MASK).toBe(ITALIC_MASK);
  });

  it('colors qualified table references with database, schema, and table types', () => {
    const sql =
      'SELECT ALIAS_TABELI.ACCOUNTKEY FROM JUST_DATA.ADMIN.DIMACCOUNT ALIAS_TABELI';
    const document = createDocument(sql);

    const tokens = decodeSemanticTokens(
      provider.provideDocumentSemanticTokens(
        document,
        new vscode.CancellationTokenSource().token,
      ).data,
    );

    expect(findToken(tokens, sql, document, 'JUST_DATA')?.tokenType).toBe(DATABASE_IDX);
    expect(findToken(tokens, sql, document, 'ADMIN')?.tokenType).toBe(SCHEMA_IDX);
    expect(findToken(tokens, sql, document, 'DIMACCOUNT')?.tokenType).toBe(TABLE_IDX);
  });

  it('colors UPDATE and DELETE DML identifiers without metadata', () => {
    const updateSql = 'UPDATE t SET col = 1 WHERE t.id > 0';
    const updateDoc = createDocument(updateSql);
    const updateTokens = decodeSemanticTokens(
      provider.provideDocumentSemanticTokens(
        updateDoc,
        new vscode.CancellationTokenSource().token,
      ).data,
    );

    expect(findToken(updateTokens, updateSql, updateDoc, 't', 0)?.tokenType).toBe(ALIAS_IDX);
    expect(findToken(updateTokens, updateSql, updateDoc, 'col')?.tokenType).toBe(COLUMN_IDX);
    expect(findToken(updateTokens, updateSql, updateDoc, 'id')?.tokenType).toBe(COLUMN_IDX);

    const deleteSql = "DELETE FROM ADMIN.ORDERS o WHERE o.status = 'X'";
    const deleteDoc = createDocument(deleteSql);
    const deleteTokens = decodeSemanticTokens(
      provider.provideDocumentSemanticTokens(
        deleteDoc,
        new vscode.CancellationTokenSource().token,
      ).data,
    );

    expect(findToken(deleteTokens, deleteSql, deleteDoc, 'ADMIN')?.tokenType).toBe(SCHEMA_IDX);
    expect(findToken(deleteTokens, deleteSql, deleteDoc, 'ORDERS')?.tokenType).toBe(TABLE_IDX);
    expect(findToken(deleteTokens, deleteSql, deleteDoc, 'o')?.tokenType).toBe(ALIAS_IDX);
    expect(findToken(deleteTokens, deleteSql, deleteDoc, 'status')?.tokenType).toBe(COLUMN_IDX);
  });

  it('colors NZPLSQL local variables separately from SQL columns', () => {
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
    const document = createDocument(sql);
    const tokens = decodeSemanticTokens(
      provider.provideDocumentSemanticTokens(
        document,
        new vscode.CancellationTokenSource().token,
      ).data,
    );

    expect(findToken(tokens, sql, document, 'p')?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'i')?.tokenType).toBe(LOCAL_VARIABLE_IDX);
    expect(findToken(tokens, sql, document, 'v', 0)?.tokenType).toBe(LOCAL_VARIABLE_IDX);
    expect(findToken(tokens, sql, document, 'v', 1)?.tokenType).toBe(LOCAL_VARIABLE_IDX);
  });

  it('fires onDidChangeSemanticTokens when refresh is called', () => {
    const listener = jest.fn();
    const disposable = provider.onDidChangeSemanticTokens(listener);
    provider.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });

  it('colors INSERT target table and explicit column list', () => {
    const sql = 'INSERT INTO MYDB..TARGET (COL_A, COL_B) VALUES (1, 2)';
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'MYDB')?.tokenType).toBe(DATABASE_IDX);
    expect(findToken(tokens, sql, document, 'TARGET')?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'COL_A')?.tokenType).toBe(COLUMN_IDX);
    expect(findToken(tokens, sql, document, 'COL_B')?.tokenType).toBe(COLUMN_IDX);
  });

  it('colors UPDATE with explicit AS alias and keeps table name as table', () => {
    const sql = 'UPDATE ADMIN.ORDERS AS o SET o.status = 1';
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'ADMIN')?.tokenType).toBe(SCHEMA_IDX);
    expect(findToken(tokens, sql, document, 'ORDERS')?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'o', 0)?.tokenType).toBe(ALIAS_IDX);
    expect(findToken(tokens, sql, document, 'status')?.tokenType).toBe(COLUMN_IDX);
  });

  it('colors INNER JOIN tables, aliases, and ON clause columns', () => {
    const sql = 'SELECT T1.ID, T2.ID FROM T1 INNER JOIN T2 ON T1.ID = T2.ID';
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'T1', 1)?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'T2', 1)?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'T1', 0)?.tokenType).toBe(ALIAS_IDX);
    expect(findToken(tokens, sql, document, 'ID', 0)?.tokenType).toBe(COLUMN_IDX);
  });

  it('colors Netezza builtins without overriding SQL identifier roles', () => {
    const sql = 'SELECT BTRIM(name), BYTEINT FROM t WHERE ROWID > 0';
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'BTRIM')?.tokenType).toBe(FUNCTION_IDX);
    expect(findToken(tokens, sql, document, 'BYTEINT')?.tokenType).toBe(TYPE_IDX);
    const rowid = findToken(tokens, sql, document, 'ROWID');
    expect(rowid?.tokenType).toBe(VARIABLE_IDX);
    expect((rowid?.tokenModifiers ?? 0) & READONLY_MASK).toBe(READONLY_MASK);
    expect(findToken(tokens, sql, document, 'name')?.tokenType).toBe(COLUMN_IDX);
    expect(findToken(tokens, sql, document, 't')?.tokenType).toBe(TABLE_IDX);
  });

  it('queries metadata cache and execution database kind when connection is available', () => {
    const getColumns = jest.fn().mockReturnValue([{ ATTNAME: 'ACCOUNTKEY' }]);
    const metadataCache = createMockMetadataCache({ getColumns });
    const connectionManager = createMockConnectionManager();
    const wiredProvider = new NetezzaSemanticTokensProvider(
      metadataCache,
      connectionManager,
    );

    const sql =
      'SELECT ALIAS_TABELI.ACCOUNTKEY FROM JUST_DATA.ADMIN.DIMACCOUNT ALIAS_TABELI';
    tokensFor(wiredProvider, sql);

    expect(connectionManager.getExecutionDatabaseKind).toHaveBeenCalledWith(
      'file:///test.sql',
    );
    expect(connectionManager.getConnectionForExecution).toHaveBeenCalledWith(
      'file:///test.sql',
    );
    expect(getColumns).toHaveBeenCalled();
  });

  it('colors JOIN with DB..TABLE notation', () => {
    const sql = [
      'SELECT d.*',
      'FROM JUST_DATA.ADMIN.DIMDATE d',
      'JOIN JUST_DATA..DIMACCOUNT a ON a.id = d.id',
    ].join('\n');
    const document = createDocument(sql);

    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'JUST_DATA', 1)?.tokenType).toBe(DATABASE_IDX);
    expect(findToken(tokens, sql, document, 'DIMACCOUNT')?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'a', 0)?.tokenType).toBe(ALIAS_IDX);
  });

  it('colors JOIN DB..TABLE after nested block comments', () => {
    const sql = [
      '/* outer start',
      '   /* inner still comment */',
      'outer end */',
      '',
      'SELECT d.*',
      'FROM JUST_DATA.ADMIN.DIMDATE d',
      'JOIN JUST_DATA..DIMACCOUNT a ON a.id = d.id',
    ].join('\n');
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'DIMACCOUNT')?.tokenType).toBe(TABLE_IDX);
    expect(findToken(tokens, sql, document, 'JUST_DATA', 1)?.tokenType).toBe(DATABASE_IDX);
  });

  it('colors DROP TABLE qualified names with database and table semantic types', () => {
    const sql = 'DROP TABLE MYDB..OLD_TABLE;';
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'MYDB')?.tokenType).toBe(DATABASE_IDX);
    expect(findToken(tokens, sql, document, 'OLD_TABLE')?.tokenType).toBe(TABLE_IDX);
  });

  it('keeps CREATE TABLE database color when an NZPLSQL procedure follows', () => {
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
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);

    expect(findToken(tokens, sql, document, 'JUST_DATA', 0)?.tokenType).toBe(DATABASE_IDX);
    expect(findToken(tokens, sql, document, 'ADMIN', 0)?.tokenType).toBe(SCHEMA_IDX);
    expect(findToken(tokens, sql, document, 'COLOR_CHECK_FACT', 0)?.tokenType).toBe(TABLE_IDX);
  });

  it('does not query metadata cache when no alias bindings are available', () => {
    const getColumnsAnySchema = jest.fn();
    const metadataCache = createMockMetadataCache({ getColumnsAnySchema });
    const connectionManager = createMockConnectionManager();
    const wiredProvider = new NetezzaSemanticTokensProvider(
      metadataCache,
      connectionManager,
    );

    tokensFor(wiredProvider, 'SELECT 1');

    expect(getColumnsAnySchema).not.toHaveBeenCalled();
  });

  it('does not emit semantic tokens inside line or block comments', () => {
    const sql = [
      '--SELECT * FROM JUST_DATA..DIMACCOUNT',
      "-- CALL JUST_DATA..SP_GET_ACCOUNT_DETAILS('12345')",
      '-- DISTRIBUTE ON RANDOM',
      '/* SELECT * FROM MYDB..T */',
      '/*',
      'SELECT 123 FROM JUST_DATA.ADMIN.DIMDATE D',
      'CALL PROCEDURE();',
      '*/',
      'SELECT t.id FROM src t',
    ].join('\n');
    const document = createDocument(sql);
    const tokens = tokensFor(provider, sql);
    const activeCodeOffset = sql.lastIndexOf('SELECT t.id');

    for (const identifier of [
      'SELECT',
      'FROM',
      'DIMACCOUNT',
      'CALL',
      'DISTRIBUTE',
      'MYDB',
    ]) {
      for (const offset of identifierOffsets(sql, identifier)) {
        if (offset >= activeCodeOffset) {
          continue;
        }
        expect(
          findTokenAtOffset(tokens, document, offset, identifier.length),
        ).toBeUndefined();
      }
    }
  });

  it('still colors identifiers when -- appears only inside a string or block comment', () => {
    const blockCommentSql = 'SELECT * FROM /*--*/ JUST_DATA..DIMACCOUNT';
    const blockCommentDoc = createDocument(blockCommentSql);
    const blockCommentTokens = tokensFor(provider, blockCommentSql);

    expect(
      findToken(blockCommentTokens, blockCommentSql, blockCommentDoc, 'JUST_DATA')?.tokenType,
    ).toBe(DATABASE_IDX);
    expect(
      findToken(blockCommentTokens, blockCommentSql, blockCommentDoc, 'DIMACCOUNT')?.tokenType,
    ).toBe(TABLE_IDX);

    const stringSql = "SELECT '--', * FROM JUST_DATA..DIMACCOUNT";
    const stringDoc = createDocument(stringSql);
    const stringTokens = tokensFor(provider, stringSql);

    expect(findToken(stringTokens, stringSql, stringDoc, 'JUST_DATA')?.tokenType).toBe(
      DATABASE_IDX,
    );
    expect(findToken(stringTokens, stringSql, stringDoc, 'DIMACCOUNT')?.tokenType).toBe(
      TABLE_IDX,
    );
  });
});
