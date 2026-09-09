import type { ExecutionOrchestrator } from '@justybase/database-runtime';
import type { ApiConfig } from './config';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { ApiMetadataService } from './metadataCache';
import type { LspSession } from './lspProtocol';
import type { QuerySessionManager } from './querySessions';
import type { AppStore, StoredConnection } from './store';

export interface ApiRateLimiter {
  clear(): void;
}

export interface ApiApplicationContext<Job> {
  readonly config: ApiConfig;
  readonly store: AppStore;
  readonly databaseRuntimes: ApiDatabaseRuntimeRegistry;
  readonly executionOrchestrator: ExecutionOrchestrator<StoredConnection>;
  readonly rateLimiter: ApiRateLimiter;
  readonly metadataService: ApiMetadataService;
  readonly queryJobs: Map<string, Job>;
  readonly querySessions: QuerySessionManager;
  readonly lspSessions: Set<LspSession>;
  dispose(): Promise<void>;
}

export interface ApiApplicationContextDependencies<Job> {
  config: ApiConfig;
  store: AppStore;
  databaseRuntimes: ApiDatabaseRuntimeRegistry;
  executionOrchestrator: ExecutionOrchestrator<StoredConnection>;
  rateLimiter: ApiRateLimiter;
  metadataService: ApiMetadataService;
  queryJobs: Map<string, Job>;
  querySessions: QuerySessionManager;
  lspSessions: Set<LspSession>;
  disposeJobs(): Promise<void>;
  closeLspSessions(): void;
}

/**
 * Owns all mutable resources created by one API server instance. Keeping this
 * object separate from Fastify makes lifecycle and instance isolation testable
 * without relying on framework decorations.
 */
export function createApiApplicationContext<Job>(dependencies: ApiApplicationContextDependencies<Job>): ApiApplicationContext<Job> {
  let disposal: Promise<void> | undefined;
  const {
    disposeJobs,
    closeLspSessions,
    ...publicDependencies
  } = dependencies;

  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      const failures: unknown[] = [];
      const attempt = async (action: () => void | Promise<void>): Promise<void> => {
        try { await action(); } catch (error: unknown) { failures.push(error); }
      };

      await attempt(disposeJobs);
      await attempt(closeLspSessions);
      await attempt(() => dependencies.querySessions.closeAll());
      await attempt(() => dependencies.metadataService.clear());
      await attempt(() => dependencies.executionOrchestrator.dispose());
      await attempt(() => dependencies.rateLimiter.clear());
      await attempt(() => dependencies.store.close());

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Multiple API resources failed to close.');
    })();
    return disposal;
  };

  return { ...publicDependencies, dispose };
}
