jest.unmock('chevrotain');

import * as vscode from 'vscode';
import { collectIdentifierOccurrences } from '../providers/parsers/identifierRoleCollector';
import { NetezzaSemanticTokensProvider } from '../providers/semanticTokensProvider';
import { tokenizeSql, findTokenContaining, type FlatToken } from './syntax/netezzaTmGrammarHarness';

jest.mock('vscode', () => jest.requireActual('./__mocks__/vscode'));

const TABLE_IDX = 8;
const DATABASE_IDX = 11;

function hasScope(token: FlatToken | undefined, pattern: RegExp): boolean {
  return token?.scopes.some((scope) => pattern.test(scope)) ?? false;
}

function decodeSemantic(data: Uint32Array): Array<{ line: number; char: number; length: number; type: number }> {
  const tokens = [];
  for (let i = 0; i < data.length; i += 5) {
    tokens.push({ line: data[i], char: data[i + 1], length: data[i + 2], type: data[i + 3] });
  }
  return tokens;
}

function semanticTypeAt(sql: string, id: string, provider: NetezzaSemanticTokensProvider): number | undefined {
  const offset = sql.indexOf(id);
  const before = sql.slice(0, offset);
  const lines = before.split('\n');
  const line = lines.length - 1;
  const char = lines[lines.length - 1].length;
  const document = {
    uri: vscode.Uri.parse('file:///probe.sql'),
    languageId: 'sql',
    version: 1,
    getText: () => sql,
    positionAt: (o: number) => {
      const b = sql.slice(0, o).split('\n');
      return new vscode.Position(b.length - 1, b[b.length - 1].length);
    },
  };
  const sem = decodeSemantic(provider.provideDocumentSemanticTokens(document as vscode.TextDocument, {} as vscode.CancellationToken).data);
  return sem.find((t) => t.line === line && t.char === char && t.length === id.length)?.type;
}

describe('DDL color probe (user-reported cases)', () => {
  const provider = new NetezzaSemanticTokensProvider();

  it('CREATE TABLE db..table', async () => {
    const sql = 'CREATE TABLE JUST_DATA..TEST2 AS (\n    SELECT * FROM DIMDATE\n);';
    const roles = collectIdentifierOccurrences(sql);
    expect(roles.get(sql.indexOf('JUST_DATA'))?.role).toBe('database');
    expect(roles.get(sql.indexOf('TEST2'))?.role).toBe('table');
    expect(semanticTypeAt(sql, 'JUST_DATA', provider)).toBe(DATABASE_IDX);

    const tokens = await tokenizeSql(sql);
    const db = findTokenContaining(tokens, 'JUST_DATA', { onlyActiveCode: true });
    const table = findTokenContaining(tokens, 'TEST2', { onlyActiveCode: true });
    expect(hasScope(db, /constant\.other\.database-name\.sql/)).toBe(true);
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
    expect(hasScope(db, /entity\.name\.function\.sql/)).toBe(false);
  });

  it('CREATE TEMP TABLE single name (TextMate even when parse incomplete)', async () => {
    const sql = 'CREATE TEMP TABLE TEST1 AS (\n    SELECT * FROM DIMDATE\n) DISTRIBUTE';
    const roles = collectIdentifierOccurrences(sql);
    // Trailing incomplete DISTRIBUTE prevents strict CST — TextMate still colors the target.
    expect(roles.get(sql.indexOf('TEST1'))?.role).toBeUndefined();

    const tokens = await tokenizeSql(sql);
    const table = findTokenContaining(tokens, 'TEST1', { onlyActiveCode: true });
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it('CREATE TEMP TABLE single name with valid DISTRIBUTE (semantic + TextMate)', async () => {
    const sql =
      'CREATE TEMP TABLE TEST1 AS (\n    SELECT * FROM DIMDATE\n) DISTRIBUTE ON RANDOM;';
    const roles = collectIdentifierOccurrences(sql);
    expect(roles.get(sql.indexOf('TEST1'))?.role).toBe('table');
    expect(semanticTypeAt(sql, 'TEST1', provider)).toBe(TABLE_IDX);

    const tokens = await tokenizeSql(sql);
    const table = findTokenContaining(tokens, 'TEST1', { onlyActiveCode: true });
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it('GROOM TABLE unqualified name (semantic + TextMate)', async () => {
    const sql = 'groom table DIMACCOUNT2 VERSIONS;';
    const roles = collectIdentifierOccurrences(sql);
    expect(roles.get(sql.indexOf('DIMACCOUNT2'))?.role).toBe('table');
    expect(semanticTypeAt(sql, 'DIMACCOUNT2', provider)).toBe(TABLE_IDX);

    const tokens = await tokenizeSql(sql);
    const table = findTokenContaining(tokens, 'DIMACCOUNT2', { onlyActiveCode: true });
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });

  it('GROOM TABLE three-part qualified name (semantic + TextMate)', async () => {
    const sql = 'GROOM TABLE JUST_DATA.ADMIN.DIMACCOUNT2 VERSIONS;';
    const roles = collectIdentifierOccurrences(sql);
    expect(roles.get(sql.indexOf('JUST_DATA'))?.role).toBe('database');
    expect(roles.get(sql.indexOf('ADMIN'))?.role).toBe('schema');
    expect(roles.get(sql.indexOf('DIMACCOUNT2'))?.role).toBe('table');
    expect(semanticTypeAt(sql, 'DIMACCOUNT2', provider)).toBe(TABLE_IDX);

    const tokens = await tokenizeSql(sql);
    const table = findTokenContaining(tokens, 'DIMACCOUNT2', { onlyActiveCode: true });
    expect(hasScope(table, /constant\.other\.table-name\.sql/)).toBe(true);
  });
});
