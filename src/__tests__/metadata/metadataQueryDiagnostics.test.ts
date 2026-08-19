import { logMetadataQueryTiming } from '../../metadata/metadataQueryDiagnostics';
import { logWithFallback } from '../../utils/logger';

jest.mock('../../utils/logger', () => ({
  logWithFallback: jest.fn(),
}));

describe('metadata query diagnostics', () => {
  it('logs source, reason and the client-observed timing breakdown without SQL text', () => {
    logMetadataQueryTiming(
      {
        source: 'completion',
        kind: 'table-columns',
        connectionName: 'CONN',
        database: 'DB1',
        schema: 'PUBLIC',
        table: 'ORDERS',
        reason: 'completion-cache-miss',
        requestId: 'request-1',
      },
      {
        queueWaitMs: 4,
        executeReaderMs: 120,
        serverWaitToFirstRowMs: 800,
        rowFetchMs: 12,
        readerCloseMs: 3,
        rowsRead: 7,
        totalMs: 939,
        sessionId: 'SID-1',
        status: 'success',
      },
    );

    expect(logWithFallback).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('[MetadataTiming] source=completion kind=table-columns'),
    );
    const message = (logWithFallback as jest.Mock).mock.calls[0][1] as string;
    expect(message).toContain('reason=completion-cache-miss');
    expect(message).toContain('queueWaitMs=4');
    expect(message).toContain('serverWaitToFirstRowMs=800');
    expect(message).toContain('rowFetchMs=12');
    expect(message).toContain('sessionId=SID-1');
    expect(message).not.toContain('SELECT');
  });
});
