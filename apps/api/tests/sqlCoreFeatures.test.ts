import { NetezzaWebLspCore, type WebLspMetadataRequestParams } from '../src/sqlCoreLsp';

const NO_CONNECTION_METADATA = async (params: WebLspMetadataRequestParams): Promise<unknown> =>
  params.kind === 'context' ? { databaseKind: 'netezza' } : [];

function createCore(requestMetadata: (params: WebLspMetadataRequestParams) => Promise<unknown> = NO_CONNECTION_METADATA): NetezzaWebLspCore {
  const core = new NetezzaWebLspCore({ requestMetadata });
  core.setContext('file:///features.sql', { databaseKind: 'netezza' });
  return core;
}

describe('shared Netezza web SQL core — LSP feature parity (D1)', () => {
  it('exposes signature help for netezza functions', async () => {
    const core = createCore();
    const help = await core.signatureHelp('file:///features.sql', 1, 'SELECT NVL(', { line: 0, character: 12 });
    expect(help).not.toBeNull();
    expect(help?.signatures.some(signature => signature.label === 'NVL(value, replacement)')).toBe(true);
    const complete = await core.completion('file:///features.sql', 1, 'SELECT ', { line: 0, character: 7 });
    expect(complete.some(item => item.label === 'NULLIF')).toBe(true);
    expect(complete.some(item => item.label === 'SUBSTR')).toBe(true);
    expect(complete.some(item => item.label === 'NVL2')).toBe(true);
    expect(complete.some(item => item.label === 'DECODE')).toBe(true);
  });

  it('formats SQL using the shared netezza formatter', async () => {
    const core = createCore();
    const formatted = await core.format('select a, b from t where x = 1', { keywordCase: 'upper' });
    expect(formatted).toContain('SELECT');
    expect(formatted).toContain('FROM t');
    expect(formatted).toContain('WHERE');
  });

  it('returns document symbols for CTEs and tables', async () => {
    const core = createCore();
    const sql = 'WITH cte AS (SELECT 1 AS x) SELECT * FROM cte;';
    const symbols = await core.documentSymbols('file:///features.sql', 1, sql);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.some(symbol => symbol.name === 'cte')).toBe(true);
  });

  it('goes to definition, finds references and renames a CTE symbol', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    const sql = 'WITH sales AS (SELECT qty FROM orders) SELECT * FROM sales WHERE qty > 0;';
    const position = { line: 0, character: sql.indexOf('FROM sales') + 'FROM '.length + 'sales'.length };
    const definition = await core.definition(uri, 1, sql, position);
    expect(definition).not.toBeNull();
    expect(definition!.uri).toBe(uri);

    const references = await core.references(uri, 1, sql, position, true);
    expect(references).not.toBeNull();
    expect(references!.length).toBeGreaterThanOrEqual(2);

    const edit = await core.rename(uri, 1, sql, position, 'sales_final');
    expect(edit).not.toBeNull();
    expect(edit!.changes[uri].length).toBeGreaterThanOrEqual(2);
    expect(edit!.changes[uri].every(change => change.newText === 'sales_final')).toBe(true);
  });

  it('provides hover markdown for a CTE reference', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    const sql = 'WITH sales AS (SELECT qty FROM orders) SELECT * FROM sales WHERE qty > 0;';
    const position = { line: 0, character: sql.indexOf('FROM sales') + 'FROM '.length };
    const hover = await core.hover(uri, 1, sql, position);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain('sales');
  });

  it('retains metadata-backed table and column hover responses', async () => {
    const uri = 'file:///metadata-hover.sql';
    const core = new NetezzaWebLspCore({
      requestMetadata: async params => {
        if (params.kind === 'context') return { effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' };
        if (params.kind === 'tables') return [{ name: 'ORDERS', database: 'DB', schema: 'PUBLIC', objectType: 'TABLE', description: 'Orders table' }];
        if (params.kind === 'views') return [];
        if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') return {
          exists: true,
          table: 'ORDERS',
          database: 'DB',
          schema: 'PUBLIC',
          objectType: 'TABLE',
          description: 'Orders table',
          columns: [{ name: 'ID', type: 'INTEGER', description: 'Order identifier' }],
        };
        return [];
      },
    });
    core.setContext(uri, { effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' });
    const sql = 'SELECT O.ID FROM ORDERS O';
    const columnHover = await core.hover(uri, 1, sql, { line: 0, character: sql.indexOf('O.ID') + 2 });
    expect(columnHover?.contents.value).toContain('INTEGER');
    expect(columnHover?.contents.value).toContain('Order identifier');
    const tableHover = await core.hover(uri, 1, sql, { line: 0, character: sql.indexOf('ORDERS') + 2 });
    expect(tableHover?.contents.value).toContain('Orders table');
  });

  it('does not offer completion inside comments or string literals', async () => {
    const core = createCore();
    expect(await core.completion('file:///features.sql', 1, '-- SEL', { line: 0, character: 5 })).toEqual([]);
    expect(await core.completion('file:///features.sql', 1, "SELECT 'SEL", { line: 0, character: 10 })).toEqual([]);
  });

  it('preserves quoted identifier style during rename and rejects empty names', async () => {
    const core = createCore();
    const uri = 'file:///quoted-rename.sql';
    const sql = 'SELECT "Sales Alias".ID FROM orders AS "Sales Alias"';
    const position = { line: 0, character: sql.indexOf('"Sales Alias"') + 3 };
    const edit = await core.rename(uri, 1, sql, position, 'Quarter "A"');
    expect(edit?.changes[uri].every(change => change.newText === '"Quarter ""A"""')).toBe(true);
    expect(await core.rename(uri, 1, sql, position, '   ')).toBeNull();
  });

  it('dispatches non-Netezza documents without Netezza parser diagnostics', async () => {
    const core = createCore();
    const uri = 'file:///sqlite.sql';
    core.setContext(uri, { databaseKind: 'sqlite' });
    const diagnostics = await core.diagnostics(uri, 1, "SELECT datetime('now')");
    expect(diagnostics).toEqual([]);
    expect(await core.format('select datetime(\'now\')', { databaseKind: 'sqlite', keywordCase: 'upper' })).toBe("SELECT\n    datetime('now')");
  });

  it('keeps macro symbols and skips outlines for large scripts', async () => {
    const core = createCore();
    const symbols = await core.documentSymbols('file:///features.sql', 1, '%let cutoff = 5;\nSELECT &cutoff;');
    expect(symbols.some(symbol => symbol.name === 'cutoff' && symbol.kind === 13)).toBe(true);
    const large = 'SELECT 1;\n'.repeat(3001);
    expect(await core.documentSymbols('file:///large.sql', 1, large)).toEqual([]);
  });

  it('emits semantic tokens for keywords, functions and CTE references', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    const sql = 'WITH sales AS (SELECT qty FROM orders) SELECT COUNT(*) FROM sales WHERE qty > 0;';
    const result = await core.semanticTokens(uri, 1, sql);
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.types).toContain('keyword');
    const types = result.tokens.map(token => token.type);
    expect(types).toContain('keyword');
    expect(types).toContain('table');
    expect(types).toContain('column');
    const keywordToken = result.tokens.find(token => token.type === 'keyword');
    expect(keywordToken).toBeDefined();
    expect(keywordToken!.length).toBeGreaterThan(0);
  });

  it('navigates to the previous statement window from the middle of a script', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    const sql = 'SELECT 1;\n\nSELECT 2;\nSELECT 3;';
    const offset = sql.indexOf('SELECT 3;');
    const previous = await core.window(uri, 1, sql, offset, 'sentence', 'before');
    expect(previous).not.toBeNull();
    expect(sql.slice(previous!, previous! + 'SELECT'.length).toUpperCase()).toBe('SELECT');
    expect(previous!).toBeLessThan(offset);

    const next = await core.window(uri, 1, sql, 0, 'sentence', 'after');
    expect(next).not.toBeNull();
    expect(sql.slice(next!, next! + 'SELECT'.length).toUpperCase()).toBe('SELECT');
  });

  it('includes NZ quality diagnostics (SELECT *) alongside SQL/PAR diagnostics', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    const sql = 'SELECT * FROM t;';
    const diagnostics = await core.diagnostics(uri, 1, sql);
    const nz001 = diagnostics.find(diag => diag.code === 'NZ001');
    expect(nz001).toBeDefined();
    expect(nz001!.message).toContain('NZ001');
    expect(nz001!.range.start.line).toBe(0);
    // LintSeverity Warning (1) is converted to LSP severity 2 — same convention
    // as parser diagnostics so Monaco's severity===1 -> Error mapping stays correct.
    expect(nz001!.severity).toBe(2);
  });

  it('flags a CROSS JOIN using the NZ004 quality rule', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    const sql = 'SELECT a FROM t CROSS JOIN u;';
    const diagnostics = await core.diagnostics(uri, 1, sql);
    expect(diagnostics.some(diag => diag.code === 'NZ004')).toBe(true);
  });

  it('carries a parser suggestedFix through diagnostics data', async () => {
    const core = createCore();
    const uri = 'file:///features.sql';
    // PAR004 (keyword typo) produces a suggestedFix from the parser.
    const sql = 'SELCT 1;';
    const diagnostics = await core.diagnostics(uri, 1, sql);
    const withFix = diagnostics.find(diag => diag.data?.suggestedFix);
    expect(withFix).toBeDefined();
    expect(typeof withFix!.data!.suggestedFix).toBe('string');
  });

  it('preserves typed metadata for SQL025 and SQL026 through the API core', async () => {
    const uri = 'file:///typed-features.sql';
    const core = new NetezzaWebLspCore({
      requestMetadata: async params => {
        if (params.kind === 'context') {
          return {
            connectionName: 'typed-connection',
            effectiveDatabase: 'DB',
            effectiveSchema: 'PUBLIC',
            databaseKind: 'netezza',
          };
        }
        if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') {
          return {
            exists: true,
            table: 'ORDERS',
            database: 'DB',
            schema: 'PUBLIC',
            columns: [
              { name: 'ORDER_ID', type: 'INTEGER' },
              { name: 'DESCRIPTION', type: 'VARCHAR(80)' },
            ],
          };
        }
        return [];
      },
    });
    core.setContext(uri, {
      connectionName: 'typed-connection',
      effectiveDatabase: 'DB',
      effectiveSchema: 'PUBLIC',
      databaseKind: 'netezza',
    });

    const diagnostics = await core.diagnostics(
      uri,
      1,
      "SELECT * FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1' AND DESCRIPTION > 10",
    );

    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(
      expect.arrayContaining(['SQL025', 'SQL026']),
    );
    expect(diagnostics.every(diagnostic => diagnostic.range.start.line >= 0)).toBe(true);
  });

  it('provides typed inlay hints through the API metadata adapter', async () => {
    const uri = 'file:///inlay-features.sql';
    const core = new NetezzaWebLspCore({
      requestMetadata: async params => {
        if (params.kind === 'context') {
          return {
            connectionName: 'inlay-connection',
            effectiveDatabase: 'DB',
            effectiveSchema: 'PUBLIC',
            databaseKind: 'netezza',
          };
        }
        if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') {
          return {
            exists: true,
            table: params.table,
            database: 'DB',
            schema: 'PUBLIC',
            columns: [{ name: 'ID', type: 'INTEGER' }],
          };
        }
        return [];
      },
    });
    core.setContext(uri, {
      connectionName: 'inlay-connection',
      effectiveDatabase: 'DB',
      effectiveSchema: 'PUBLIC',
      databaseKind: 'netezza',
    });

    const sql = 'SELECT O.ID FROM ORDERS O;';
    const hints = await core.inlayHints(uri, 1, sql);

    expect(hints).toEqual([
      expect.objectContaining({
        label: ' INTEGER',
        kind: 'type',
        position: { line: 0, character: sql.indexOf('O.ID') + 'O.ID'.length },
      }),
    ]);
  });

  it('warms qualification proposals and understands DB..TABLE references', async () => {
    const uri = 'file:///qualification.sql';
    const requests: string[] = [];
    const core = new NetezzaWebLspCore({
      requestMetadata: async params => {
        requests.push(params.kind);
        if (params.kind === 'context') {
          return { connectionName: 'qualification-connection', effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' };
        }
        if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') {
          return { exists: true, table: params.table, database: 'DB', schema: 'PUBLIC', columns: [{ name: 'ID', type: 'INTEGER' }] };
        }
        if (params.kind === 'qualifyTable') {
          return [{ database: 'DB', schema: 'PUBLIC', name: params.table, qualifiedText: `DB.PUBLIC.${params.table}`, isPreferred: true }];
        }
        return [];
      },
    });
    core.setContext(uri, {
      connectionName: 'qualification-connection',
      effectiveDatabase: 'DB',
      effectiveSchema: 'PUBLIC',
      databaseKind: 'netezza',
    });

    const diagnostics = await core.diagnostics(uri, 1, 'SELECT * FROM ORDERS; SELECT * FROM DB..ORDERS;');
    expect(diagnostics.some(diagnostic => diagnostic.code === 'NZ023')).toBe(true);
    expect(requests).toContain('qualifyTable');
  });
});
