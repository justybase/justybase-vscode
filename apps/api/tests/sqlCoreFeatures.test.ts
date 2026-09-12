import { NetezzaWebLspCore, type WebLspMetadataRequestParams } from '../src/sqlCoreLsp';
import { getSqlAuthoring } from '../src/sqlAuthoring';

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

  it('keeps static completion available when catalog metadata fails', async () => {
    const uri = 'file:///metadata-unavailable.sql';
    const core = new NetezzaWebLspCore({
      requestMetadata: async params => {
        if (params.kind === 'context') return { databaseKind: 'netezza' };
        throw new Error('catalog unavailable');
      },
    });
    core.setContext(uri, { databaseKind: 'netezza', effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC' });

    const completion = await core.completion(uri, 1, 'SELECT NU', { line: 0, character: 9 });

    expect(completion.some(item => item.label === 'NULLIF')).toBe(true);
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

  it.each([
    ['postgresql', 'RETURNING', 'STRING_AGG('],
    ['db2', 'FETCH FIRST', 'VARCHAR('],
    ['mssql', 'TOP', 'GETDATE('],
    ['clickhouse', 'PREWHERE', 'argMax('],
    ['oracle', 'CONNECT BY', 'NVL('],
  ] as const)('uses the selected %s authoring profile for completion and signature help', async (databaseKind, keyword, signature) => {
    const uri = `file:///${databaseKind}.sql`;
    const core = new NetezzaWebLspCore({ requestMetadata: async params => params.kind === 'context' ? { databaseKind } : [], authoring: getSqlAuthoring(databaseKind) });
    core.setContext(uri, { databaseKind });
    const completion = await core.completion(uri, 1, 'SELECT ', { line: 0, character: 7 });
    expect(completion.some(item => item.label.toUpperCase() === keyword)).toBe(true);
    const help = await core.signatureHelp(uri, 1, `SELECT ${signature}`, { line: 0, character: `SELECT ${signature}`.length });
    expect(help).not.toBeNull();
  });

  it('runs dialect quality rules for non-Netezza documents without inventing parser errors', async () => {
    const uri = 'file:///clickhouse.sql';
    const core = new NetezzaWebLspCore({ requestMetadata: async params => params.kind === 'context' ? { databaseKind: 'clickhouse' } : [], authoring: getSqlAuthoring('clickhouse') });
    core.setContext(uri, { databaseKind: 'clickhouse' });
    const diagnostics = await core.diagnostics(uri, 1, 'ALTER TABLE orders DELETE WHERE id = 1');
    expect(diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['CH001']));
    expect(diagnostics.some(item => item.code?.toString().startsWith('PAR'))).toBe(false);
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

  it('turns parser fixes into LSP code actions with document edits', async () => {
    const core = createCore();
    const uri = 'file:///code-actions.sql';
    const sql = 'SELCT 1;';
    const diagnostics = await core.diagnostics(uri, 1, sql);
    const typo = diagnostics.find(diagnostic => diagnostic.code === 'PAR004' && diagnostic.data?.suggestedFix);
    expect(typo).toBeDefined();
    const actions = await core.codeActions(uri, 1, sql, typo ? [typo] : diagnostics);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining('Fix typo'),
        edit: { changes: { [uri]: [expect.objectContaining({ newText: typo?.data?.suggestedFix })] } },
      }),
    ]));
  });

  it('builds metadata-backed table qualification actions', async () => {
    const uri = 'file:///qualification-actions.sql';
    const core = new NetezzaWebLspCore({ requestMetadata: async params => {
      if (params.kind === 'context') return { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' };
      if (params.kind === 'tables') return [{ name: 'ORDERS', database: 'DB', schema: 'REPORTING', objectType: 'TABLE' }];
      if (params.kind === 'views') return [];
      if (params.kind === 'qualifyTable') return [{ database: 'DB', schema: 'REPORTING', name: 'ORDERS', qualifiedText: 'DB.REPORTING.ORDERS', isPreferred: false }];
      if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') return { exists: true, table: 'ORDERS', database: 'DB', schema: 'REPORTING', columns: [{ name: 'ID', type: 'INTEGER' }] };
      return [];
    } });
    core.setContext(uri, { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' });
    const sql = 'SELECT * FROM ORDERS';
    const diagnostic = { range: { start: { line: 0, character: sql.indexOf('ORDERS') }, end: { line: 0, character: sql.length } }, code: 'SQL007', message: 'Table is not qualified.' };
    const actions = await core.codeActions(uri, 1, sql, [diagnostic]);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Qualify as DB.REPORTING.ORDERS',
        edit: { changes: { [uri]: [expect.objectContaining({ newText: 'DB.REPORTING.ORDERS' })] } },
      }),
    ]));
  });

  it('keeps deterministic Netezza quick fixes aligned with the desktop Problems actions', async () => {
    const core = createCore();
    const point = (character: number) => ({ line: 0, character });
    const cases = [
      {
        code: 'NZ012',
        sql: "UPDATE DB..CUSTOMERS AS C SET NAME = 'X'",
        rangeStart: 21,
        rangeEnd: 23,
        title: 'Remove AS in UPDATE alias',
        newText: '',
      },
      {
        code: 'NZP012',
        sql: 'ELSEIF amount > 0 THEN',
        rangeStart: 0,
        rangeEnd: 6,
        title: 'Replace ELSEIF/ELSE IF with ELSIF',
        newText: 'ELSIF',
      },
      {
        code: 'NZ013',
        sql: 'SELECT 1 UNION SELECT 2',
        rangeStart: 9,
        rangeEnd: 14,
        title: 'Replace UNION with UNION ALL',
        newText: 'UNION ALL',
      },
      {
        code: 'NZ021',
        sql: 'SELECT 1,,2 FROM table1',
        rangeStart: 9,
        rangeEnd: 10,
        title: 'Remove extra comma (,, → ,)',
        newText: '',
      },
      {
        code: 'PAR003',
        sql: 'SELECT 1 FROM FROM table1',
        rangeStart: 14,
        rangeEnd: 18,
        title: 'Remove duplicate keyword',
        newText: '',
      },
    ];

    for (const item of cases) {
      const diagnostic = {
        range: { start: point(item.rangeStart), end: point(item.rangeEnd) },
        code: item.code,
        message: item.code,
      };
      const actions = await core.codeActions(item.code === 'PAR003' ? 'file:///code-actions-par.sql' : 'file:///code-actions.sql', 1, item.sql, [diagnostic]);
      expect(actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: item.title,
          edit: expect.objectContaining({
            changes: expect.objectContaining({
              [item.code === 'PAR003' ? 'file:///code-actions-par.sql' : 'file:///code-actions.sql']:
                [expect.objectContaining({ newText: item.newText })],
            }),
          }),
        }),
      ]));
    }
  });

  it('inserts guarded Netezza quick fixes at the statement boundary', async () => {
    const core = createCore();
    const sql = 'SELECT * FROM users ORDER BY created_at; DELETE FROM users;';
    const point = (character: number) => ({ line: 0, character });
    const orderDiagnostic = {
      range: { start: point(sql.indexOf('ORDER BY')), end: point(sql.indexOf('ORDER BY') + 8) },
      code: 'NZ006',
      message: 'NZ006',
    };
    const deleteDiagnostic = {
      range: { start: point(sql.indexOf('DELETE')), end: point(sql.indexOf('DELETE') + 6) },
      code: 'NZ002',
      message: 'NZ002',
    };
    const actions = await core.codeActions('file:///boundary-actions.sql', 1, sql, [orderDiagnostic, deleteDiagnostic]);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Add FETCH FIRST 100 ROWS ONLY',
        edit: { changes: { 'file:///boundary-actions.sql': [expect.objectContaining({
          range: { start: point(sql.indexOf(';')), end: point(sql.indexOf(';')) },
          newText: ' FETCH FIRST 100 ROWS ONLY',
        })] } },
      }),
      expect.objectContaining({
        title: 'Add safe WHERE guard (WHERE 1 = 0)',
        edit: { changes: { 'file:///boundary-actions.sql': [expect.objectContaining({
          range: { start: point(sql.length - 1), end: point(sql.length - 1) },
          newText: ' WHERE 1 = 0',
        })] } },
      }),
    ]));
  });

  it('inserts AS at the affected CTE opening parenthesis', async () => {
    const core = createCore();
    const uri = 'file:///cte-action.sql';
    const sql = 'WITH ABC1 (SELECT 1) SELECT * FROM ABC1';
    const diagnostics = await core.diagnostics(uri, 1, sql);
    const diagnostic = diagnostics.find(item => item.code === 'PAR101');
    expect(diagnostic).toBeDefined();
    const actions = await core.codeActions(uri, 1, sql, diagnostic ? [diagnostic] : []);
    const action = actions.find(item => item.title === 'Insert missing AS in CTE definition');
    expect(action).toBeDefined();
    expect(action?.edit.changes[uri]).toEqual([
      expect.objectContaining({
        range: {
          start: { line: 0, character: sql.indexOf('(') },
          end: { line: 0, character: sql.indexOf('(') },
        },
        newText: ' AS ',
      }),
    ]);
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
