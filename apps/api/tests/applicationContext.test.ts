import type { ExecutionOrchestrator } from '@justybase/database-runtime';
import { createApiApplicationContext } from '../src/applicationContext';
import type { ApiConfig } from '../src/config';
import type { ApiDatabaseRuntimeRegistry } from '../src/databaseRuntime/contracts';
import type { ApiMetadataService } from '../src/metadataCache';
import type { LspSession } from '../src/lspProtocol';
import type { QuerySessionManager } from '../src/querySessions';
import type { AppStore, StoredConnection } from '../src/store';

const config: ApiConfig = {
  host: '127.0.0.1',
  port: 0,
  dataDir: '/tmp/justybase-context-test',
  webDistDir: '/tmp/justybase-context-test-web',
  masterKey: 'context-test-key',
};

function createDependencies() {
  const disposeJobs = jest.fn().mockResolvedValue(undefined);
  const closeLspSessions = jest.fn();
  const querySessions = { closeAll: jest.fn() } as unknown as QuerySessionManager;
  const metadataService = { clear: jest.fn() } as unknown as ApiMetadataService;
  const executionOrchestrator = { dispose: jest.fn().mockResolvedValue(undefined) } as unknown as ExecutionOrchestrator<StoredConnection>;
  const rateLimiter = { clear: jest.fn() };
  const store = { close: jest.fn() } as unknown as AppStore;
  const lspSessions = new Set<LspSession>();
  return {
    config,
    store,
    databaseRuntimes: {} as ApiDatabaseRuntimeRegistry,
    executionOrchestrator,
    rateLimiter,
    metadataService,
    queryJobs: new Map<string, { id: string }>(),
    querySessions,
    lspSessions,
    disposeJobs,
    closeLspSessions,
  };
}

describe('API application context', () => {
  it('owns mutable resources per instance and disposes them exactly once', async () => {
    const firstDependencies = createDependencies();
    const secondDependencies = createDependencies();
    const first = createApiApplicationContext(firstDependencies);
    const second = createApiApplicationContext(secondDependencies);

    expect(first).not.toBe(second);
    expect(first.queryJobs).not.toBe(second.queryJobs);
    expect(first.querySessions).not.toBe(second.querySessions);
    expect(first.lspSessions).not.toBe(second.lspSessions);

    const disposal = first.dispose();
    expect(first.dispose()).toBe(disposal);
    await disposal;

    expect(firstDependencies.disposeJobs).toHaveBeenCalledTimes(1);
    expect(firstDependencies.closeLspSessions).toHaveBeenCalledTimes(1);
    expect((firstDependencies.querySessions.closeAll as jest.Mock).mock.calls).toHaveLength(1);
    expect((firstDependencies.metadataService.clear as jest.Mock).mock.calls).toHaveLength(1);
    expect((firstDependencies.executionOrchestrator.dispose as jest.Mock).mock.calls).toHaveLength(1);
    expect(firstDependencies.rateLimiter.clear).toHaveBeenCalledTimes(1);
    expect((firstDependencies.store.close as jest.Mock).mock.calls).toHaveLength(1);
    expect(secondDependencies.disposeJobs).not.toHaveBeenCalled();
  });

  it('attempts all cleanup stages and reports multiple failures together', async () => {
    const dependencies = createDependencies();
    dependencies.disposeJobs.mockRejectedValueOnce(new Error('jobs failed'));
    dependencies.closeLspSessions.mockImplementationOnce(() => { throw new Error('sockets failed'); });

    await expect(createApiApplicationContext(dependencies).dispose()).rejects.toBeInstanceOf(AggregateError);
    expect((dependencies.querySessions.closeAll as jest.Mock).mock.calls).toHaveLength(1);
    expect((dependencies.store.close as jest.Mock).mock.calls).toHaveLength(1);
  });
});
