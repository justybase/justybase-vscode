import type {
  DatabaseQueryCallbacks,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
} from '@justybase/contracts';

export {
  assertDesignerOperationSupported,
  assertDesignerPlanCurrent,
  assertDesignerPlanHasChanges,
  EmptyDesignerPlanError,
  getDesignerCapability,
  hasDesignerOperation,
  isDesignerOperationSupported,
  StaleDesignerSnapshotError,
  UnsupportedDesignerOperationError,
} from './designer';

/** Compatibility aliases retained for API consumers during the runtime move. */
export type QueryCallbacks = DatabaseQueryCallbacks;
export type QueryOptions = DatabaseQueryOptions;
export type QueryResult = DatabaseQueryResult;

export interface NetezzaConnectionDetails {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number;
  clientType?: number;
}

export {
  NetezzaRuntime,
  NetezzaRuntimeTargetChangedError,
  executeNetezzaQuery,
  getNetezzaConnectionConstructor,
  createNetezzaConnection,
  createConnectedNetezzaConnection,
  isReadOnlySql,
  listColumns,
  listDatabases,
  listObjects,
  listSchemas,
} from '@justybase/netezza-runtime';
export type {
  NetezzaConnectionDetails as RuntimeNetezzaConnectionDetails,
  NetezzaRuntimeOptions,
  NetezzaRuntimeTarget,
  NetezzaDriverCommand,
  NetezzaDriverConfig,
  NetezzaDriverConnection,
  NetezzaDriverReader,
  NetezzaDriverOptions,
} from '@justybase/netezza-runtime';

export type {
  DatabaseQueryCallbacks,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
};
