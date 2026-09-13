import { requestMetadata } from '../src/lspProtocol';
import type { ApiDatabaseRuntimeRegistry } from '../src/databaseRuntime/contracts';
import type { AppStore } from '../src/store';

const listColumns = jest.fn();
const listObjects = jest.fn();
const runtimes = {
  listColumns,
  listDatabases: jest.fn(),
  listObjects,
  listSchemas: jest.fn(),
} as unknown as ApiDatabaseRuntimeRegistry;

describe('web LSP metadata requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not query columns with an empty schema', async () => {
    const getConnection = jest.fn().mockReturnValue({ id: 'connection-1' });
    const store = { getConnection } as unknown as AppStore;
    const documents = new Map([['file:///query.sql', { text: '', version: 1, context: {} }]]);

    await expect(requestMetadata(
      { documentUri: 'file:///query.sql', kind: 'columns', database: 'DB', table: 'CUSTOMERS' },
      documents,
      store,
      runtimes,
      'user-1',
    )).resolves.toEqual([]);

    expect(listColumns).not.toHaveBeenCalled();
  });

  it('maps matching objects to preferred Netezza qualification proposals', async () => {
    const profile = { id: 'connection-1' };
    const getConnection = jest.fn().mockReturnValue(profile);
    const store = { getConnection } as unknown as AppStore;
    const documents = new Map([['file:///query.sql', { text: '', version: 1, context: { connectionId: 'connection-1', database: 'DB', schema: 'PUBLIC' } }]]);
    (listObjects as jest.Mock).mockResolvedValue([
      { name: 'ORDERS', schema: 'REPORTING', objectType: 'TABLE' },
      { name: 'ORDERS', schema: 'PUBLIC', objectType: 'VIEW' },
      { name: 'ORDERS', schema: 'PUBLIC', objectType: 'PROCEDURE' },
    ]);

    await expect(requestMetadata(
      { documentUri: 'file:///query.sql', kind: 'qualifyTable', table: 'ORDERS' },
      documents,
      store,
      runtimes,
      'user-1',
    )).resolves.toEqual([
      { database: 'DB', schema: 'PUBLIC', name: 'ORDERS', qualifiedText: 'DB.PUBLIC.ORDERS', isPreferred: true },
      { database: 'DB', schema: 'REPORTING', name: 'ORDERS', qualifiedText: 'DB.REPORTING.ORDERS', isPreferred: false },
    ]);
    expect(listObjects).toHaveBeenCalledWith(profile, 'DB', undefined);
  });

  it('resolves DB..TABLE columns from the table schema instead of the default schema', async () => {
    const profile = { id: 'connection-1' };
    const getConnection = jest.fn().mockReturnValue(profile);
    const store = { getConnection } as unknown as AppStore;
    const documents = new Map([['file:///query.sql', {
      text: '',
      version: 1,
      context: { connectionId: 'connection-1', database: 'SYSTEM', schema: 'PUBLIC' },
    }]]);
    (listObjects as jest.Mock).mockResolvedValue([
      { name: 'DIMDATE', database: 'JUST_DATA', schema: 'ADMIN', objectType: 'TABLE' },
    ]);
    (listColumns as jest.Mock).mockResolvedValue([
      { name: 'DATEKEY', type: 'INTEGER' },
    ]);

    await expect(requestMetadata(
      { documentUri: 'file:///query.sql', kind: 'tableInfo', database: 'JUST_DATA', table: 'DIMDATE' },
      documents,
      store,
      runtimes,
      'user-1',
    )).resolves.toEqual(expect.objectContaining({
      exists: true,
      database: 'JUST_DATA',
      schema: 'ADMIN',
      columns: [{ name: 'DATEKEY', type: 'INTEGER' }],
    }));

    expect(listObjects).toHaveBeenCalledWith(profile, 'JUST_DATA', undefined);
    expect(listColumns).toHaveBeenCalledWith(profile, 'JUST_DATA', 'ADMIN', 'DIMDATE');
  });
});
