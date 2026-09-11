import type {
  DatabaseQueryCallbacks,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  DatabaseTableDdlMetadata,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
} from '@justybase/contracts';
import type { StoredConnection } from '../store';

export type QueryCallbacks = DatabaseQueryCallbacks;
export type ApiQueryOptions = DatabaseQueryOptions;
export type ApiQueryResult = DatabaseQueryResult;

export type ApiDatabaseRuntimeKind = 'netezza' | 'sqlite' | 'duckdb';

export interface ApiDatabaseRuntime {
  readonly kind: ApiDatabaseRuntimeKind;

  isAvailable(): boolean;
  isReadOnlySql(sql: string): boolean;
  normalizeDatabase(database: string): string;
  execute(
    profile: StoredConnection,
    sql: string,
    options: ApiQueryOptions,
    callbacks: QueryCallbacks,
  ): Promise<ApiQueryResult>;
  listDatabases(profile: StoredConnection): Promise<MetadataDatabase[]>;
  listSchemas(profile: StoredConnection, database: string): Promise<MetadataSchema[]>;
  listObjects(profile: StoredConnection, database: string, schema?: string): Promise<MetadataObject[]>;
  listColumns(
    profile: StoredConnection,
    database: string,
    schema: string,
    table: string,
  ): Promise<MetadataColumn[]>;
  /** Optional native catalog payload used by an exact dialect DDL adapter. */
  getTableDdlMetadata?(
    profile: StoredConnection,
    database: string,
    schema: string,
    table: string,
  ): Promise<DatabaseTableDdlMetadata>;
  /** Optional source lookup for dialects whose view definition is catalog-owned. */
  getViewDefinition?(
    profile: StoredConnection,
    database: string,
    schema: string,
    view: string,
  ): Promise<string>;
  closeConnection(connectionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ApiDatabaseRuntimeRegistry {
  forProfile(profile: Pick<StoredConnection, 'dbType'>): ApiDatabaseRuntime;
  isAvailable(profile: Pick<StoredConnection, 'dbType'>): boolean;
  isReadOnlySql(profile: Pick<StoredConnection, 'dbType'>, sql: string): boolean;
  normalizeDatabase(profile: Pick<StoredConnection, 'dbType'>, database: string): string;
  execute(
    profile: StoredConnection,
    sql: string,
    options: ApiQueryOptions,
    callbacks: QueryCallbacks,
  ): Promise<ApiQueryResult>;
  listDatabases(profile: StoredConnection): Promise<MetadataDatabase[]>;
  listSchemas(profile: StoredConnection, database: string): Promise<MetadataSchema[]>;
  listObjects(profile: StoredConnection, database: string, schema?: string): Promise<MetadataObject[]>;
  listColumns(
    profile: StoredConnection,
    database: string,
    schema: string,
    table: string,
  ): Promise<MetadataColumn[]>;
  closeConnection(connectionId: string): Promise<void>;
  closeAll(): Promise<void>;
}
