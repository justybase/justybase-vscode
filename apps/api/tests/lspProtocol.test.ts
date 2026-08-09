import { requestMetadata } from '../src/lspProtocol';
import type { ApiConfig } from '../src/config';
import type { AppStore } from '../src/store';
import { listColumns } from '../src/netezza';

jest.mock('../src/netezza', () => ({
  listColumns: jest.fn(),
  listDatabases: jest.fn(),
  listObjects: jest.fn(),
  listSchemas: jest.fn(),
}));

describe('web LSP metadata requests', () => {
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
});
