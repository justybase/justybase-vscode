import { getSqlStatementAtPosition, NetezzaWebLspCore, splitSqlStatements } from '../src/sqlCoreLsp';
import { provideSqlCompletion } from '../src/lsp';
import { ApiMetadataService } from '../src/metadataCache';
import type { ApiDatabaseRuntimeRegistry } from '../src/databaseRuntime/contracts';
import type { AppStore } from '../src/store';

const listObjects = jest.fn();
const runtimes = {
  isReadOnlySql: jest.fn(),
  listColumns: jest.fn(),
  listDatabases: jest.fn(),
  listObjects,
  listSchemas: jest.fn(),
} as unknown as ApiDatabaseRuntimeRegistry;
const metadataService = new ApiMetadataService();

describe('shared Netezza web SQL core', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    metadataService.clear();
  });

  it('routes HTTP completion through the shared Netezza authoring core', async () => {
    const result = await provideSqlCompletion(
      {} as AppStore,
      runtimes,
      'user-1',
      { sql: 'SELECT NV', offset: 'SELECT NV'.length, databaseKind: 'netezza' },
    );

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'NVL', kind: 'function' }),
    ]));
  });

  it('warms referenced table metadata before completing a qualified column', async () => {
    const uri = 'file:///qualified-completion.sql';
    const core = new NetezzaWebLspCore({ requestMetadata: async params => {
      if (params.kind === 'context') return { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' };
      if (params.kind === 'tables') return [{ name: 'ORDERS', database: 'DB', schema: 'PUBLIC', objectType: 'table' }];
      if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') {
        return { exists: true, table: 'ORDERS', database: 'DB', schema: 'PUBLIC', columns: [{ name: 'ID', type: 'INTEGER' }] };
      }
      return [];
    } });
    core.setContext(uri, { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'PUBLIC', databaseKind: 'netezza' });

    const sql = 'SELECT O.I FROM ORDERS O';
    const items = await core.completion(uri, 1, sql, { line: 0, character: 'SELECT O.I'.length });

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'ID', kind: 5, detail: 'INTEGER' }),
    ]));
  });

  it('completes columns after a trailing alias dot in a fully qualified Netezza query', async () => {
    const uri = 'file:///netezza-qualified-column.sql';
    const core = new NetezzaWebLspCore({ requestMetadata: async params => {
      if (params.kind === 'context') return {
        connectionName: 'connection-1',
        effectiveDatabase: 'JUST_DATA',
        effectiveSchema: 'ADMIN',
        databaseKind: 'netezza',
      };
      if (params.kind === 'tables') return [{ name: 'DIMDATE', database: 'JUST_DATA', schema: 'ADMIN', objectType: 'TABLE' }];
      if (params.kind === 'views') return [];
      if (params.kind === 'cachedTableInfo' || params.kind === 'tableInfo') return {
        exists: true,
        table: 'DIMDATE',
        database: 'JUST_DATA',
        schema: 'ADMIN',
        objectType: 'TABLE',
        columns: [
          { name: 'DATEKEY', type: 'INTEGER' },
          { name: 'FULLDATEALTERNATEKEY', type: 'TIMESTAMP' },
        ],
      };
      return [];
    } });
    core.setContext(uri, {
      connectionName: 'connection-1',
      effectiveDatabase: 'JUST_DATA',
      effectiveSchema: 'ADMIN',
      databaseKind: 'netezza',
    });

    const sql = 'SELECT *\nFROM JUST_DATA.ADMIN.DIMDATE D\nWHERE D.';
    const items = await core.completion(uri, 1, sql, { line: 2, character: 'WHERE D.'.length });

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'DATEKEY', kind: 5, detail: 'INTEGER' }),
      expect.objectContaining({ label: 'FULLDATEALTERNATEKEY', kind: 5, detail: 'TIMESTAMP' }),
    ]));
  });

  it('completes Netezza schemas after a known database dot', async () => {
    const uri = 'file:///netezza-database-path.sql';
    const core = new NetezzaWebLspCore({ requestMetadata: async params => {
      if (params.kind === 'context') return { effectiveDatabase: 'SYSTEM', databaseKind: 'netezza' };
      if (params.kind === 'databases') return [{ name: 'JUST_DATA' }, { name: 'SYSTEM' }];
      if (params.kind === 'schemas' && params.database === 'JUST_DATA') return [
        { name: 'ADMIN', database: 'JUST_DATA' },
        { name: 'PUBLIC', database: 'JUST_DATA' },
      ];
      return [];
    } });
    core.setContext(uri, { effectiveDatabase: 'SYSTEM', databaseKind: 'netezza' });

    const sql = 'SELECT * FROM JUST_DATA.';
    const items = await core.completion(uri, 1, sql, { line: 0, character: sql.length });

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'ADMIN', kind: 9, detail: 'Schema in JUST_DATA' }),
      expect.objectContaining({ label: 'PUBLIC', kind: 9, detail: 'Schema in JUST_DATA' }),
    ]));
  });

  it('isolates HTTP metadata cache by connection and invalidates the matching entry', async () => {
    const store = { getConnection: jest.fn().mockReturnValue({ id: 'connection-1' }) } as unknown as AppStore;
    (listObjects as jest.Mock).mockResolvedValue([
      { name: 'ORDERS', schema: 'PUBLIC', objectType: 'TABLE' },
    ]);
    const request = {
      sql: 'SELECT OR',
      offset: 'SELECT OR'.length,
      connectionId: 'connection-1',
      database: 'DB',
      schema: 'PUBLIC',
      databaseKind: 'netezza' as const,
    };

    await provideSqlCompletion(store, runtimes, 'user-1', request, metadataService);
    await provideSqlCompletion(store, runtimes, 'user-1', request, metadataService);
    expect(listObjects).toHaveBeenCalledTimes(1);

    metadataService.invalidate('user-1', 'connection-1');
    await provideSqlCompletion(store, runtimes, 'user-1', request, metadataService);
    expect(listObjects).toHaveBeenCalledTimes(2);
  });

  it('provides parser-backed completion and diagnostics without a database connection', async () => {
    const core = new NetezzaWebLspCore({ requestMetadata: async params => params.kind === 'context' ? { databaseKind: 'netezza' } : [] });
    core.setContext('file:///query.sql', { databaseKind: 'netezza' });
    const completions = await core.completion('file:///query.sql', 1, 'SELECT COU', { line: 0, character: 10 });
    expect(completions.some(item => item.label === 'COUNT')).toBe(true);
    const diagnostics = await core.diagnostics('file:///query.sql', 1, 'SELECT (');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('preserves metadata caches when an unchanged context is resent', async () => {
    let tableRequests = 0;
    const core = new NetezzaWebLspCore({ requestMetadata: async params => {
      if (params.kind === 'context') return { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'ADMIN', databaseKind: 'netezza', netezzaSchemasEnabled: true };
      if (params.kind === 'tables') { tableRequests += 1; return [{ name: 'CUSTOMERS', database: 'DB', schema: 'ADMIN', objectType: 'table' }]; }
      return [];
    } });
    const context = { connectionName: 'connection-1', effectiveDatabase: 'DB', effectiveSchema: 'ADMIN', databaseKind: 'netezza' as const, netezzaSchemasEnabled: true };
    core.setContext('file:///cached.sql', context);
    await core.completion('file:///cached.sql', 1, 'SELECT * FROM C', { line: 0, character: 15 });
    core.setContext('file:///cached.sql', { ...context });
    await core.completion('file:///cached.sql', 2, 'SELECT * FROM CU', { line: 0, character: 16 });
    expect(tableRequests).toBe(1);
  });

  it('splits scripts with offsets without breaking strings, comments, or NZPLSQL bodies', () => {
    const sql = `-- header;\nSELECT 'value; still one literal';\nCREATE PROCEDURE P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC\n  SELECT 1;\n  RETURN 1;\nEND_PROC;\nSELECT 3;`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain("'value; still one literal'");
    expect(statements[1].sql).toContain('RETURN 1;');
    expect(statements[2].sql).toBe('SELECT 3');
    expect(sql.slice(statements[1].startOffset, statements[1].endOffset).trim()).toBe(statements[1].sql);
  });

  it('resolves the statement under the cursor using parser boundaries', () => {
    const sql = 'SELECT 1; /* ; */ SELECT 2; SELECT \'3;\';';
    expect(getSqlStatementAtPosition(sql, sql.indexOf('SELECT 2'))?.sql).toBe('/* ; */ SELECT 2');
    expect(getSqlStatementAtPosition(sql, sql.indexOf('3;'))?.sql).toBe("SELECT '3;'");
  });

  it('keeps semicolons inside quoted identifiers out of statement boundaries', () => {
    const statements = splitSqlStatements('SELECT "semi;column" FROM "quoted;table"; SELECT 4;');
    expect(statements.map(statement => statement.sql)).toEqual(['SELECT "semi;column" FROM "quoted;table"', 'SELECT 4']);
  });
});
