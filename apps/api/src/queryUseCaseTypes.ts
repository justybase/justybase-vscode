import type {
  QueryEvent,
  QueryExecutionMode,
} from '@justybase/contracts';
import type { ApiConfig } from './config';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { LspSession } from './lspProtocol';
import type { ApiMetadataService } from './metadataCache';
import type { QuerySessionManager } from './querySessions';
import type { AppStore, StoredConnection } from './store';
import type { ExecutionOrchestrator } from '@justybase/database-runtime';

export interface PlannedStatement {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
}

export interface QueryJob {
  id: string;
  userId: string;
  connectionId: string;
  database: string;
  mode: QueryExecutionMode;
  statements: PlannedStatement[];
  events: QueryEvent[];
  subscribers: Set<{ send(data: string): void; readyState: number; close?: () => void }>;
  cancel?: () => Promise<void>;
  sessionIds: Map<number, string>;
  sequence: number;
  activeStatementIndex?: number;
  cancelRequested: boolean;
  done: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export interface QueryUseCaseLogger {
  debug(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface QueryUseCaseContext {
  config: ApiConfig;
  store: AppStore;
  databaseRuntimes: ApiDatabaseRuntimeRegistry;
  executionOrchestrator: ExecutionOrchestrator<StoredConnection>;
  metadataService: ApiMetadataService;
  queryJobs: Map<string, QueryJob>;
  querySessions: QuerySessionManager;
  lspSessions: Set<LspSession>;
  log: QueryUseCaseLogger;
}
