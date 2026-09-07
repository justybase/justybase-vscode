import { requestMetadata } from '../src/lspProtocol';
import type { ApiConfig } from '../src/config';
import type { AppStore } from '../src/store';
import { listColumns, listObjects } from '../src/netezza';

jest.mock('../src/netezza', () => ({
  listColumns: jest.fn(),
  listDatabases: jest.fn(),
  listObjects: jest.fn(),
  listSchemas: jest.fn(),
}));

describe('web LSP metadata requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not query columns with an empty schema', async () => {
    const getConnection = jest.fn().mockReturnValue({ id: 'connection-1' });
    const store = { getConnection } as unknown as AppStore;
    const config = { masterKey: 'test-master-key' } as ApiConfig;
    const documents = new Map([['file:///query.sql', { text: '', version: 1, context: {} }]]);

    await expect(requestMetadata(
      { documentUri: 'file:///query.sql', kind: 'columns', database: 'DB', table: 'CUSTOMERS' },
      documents,
      store,
      config,
      'user-1',
    )).resolves.toEqual([]);

    expect(listColumns).not.toHaveBeenCalled();
  });

  it('maps matching objects to preferred Netezza qualification proposals', async () => {
    const profile = { id: 'connection-1' };
    const getConnection = jest.fn().mockReturnValue(profile);
    const store = { getConnection } as unknown as AppStore;
    const config = { masterKey: 'test-master-key' } as ApiConfig;
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
      config,
      'user-1',
    )).resolves.toEqual([
      { database: 'DB', schema: 'PUBLIC', name: 'ORDERS', qualifiedText: 'DB.PUBLIC.ORDERS', isPreferred: true },
      { database: 'DB', schema: 'REPORTING', name: 'ORDERS', qualifiedText: 'DB.REPORTING.ORDERS', isPreferred: false },
    ]);
    expect(listObjects).toHaveBeenCalledWith(profile, 'DB', undefined, 'test-master-key');
  });
});
