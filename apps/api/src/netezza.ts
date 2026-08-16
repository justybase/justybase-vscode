import type { MetadataColumn, MetadataDatabase, MetadataObject, MetadataSchema, QueryColumn } from '@justybase/contracts';
import {
  executeNetezzaQuery as executeRuntimeQuery,
  isReadOnlySql,
  listColumns as listRuntimeColumns,
  listDatabases as listRuntimeDatabases,
  listObjects as listRuntimeObjects,
  listSchemas as listRuntimeSchemas,
  type QueryCallbacks,
} from '@justybase/database-runtime';
import type { StoredConnection } from './store';
import { decryptSecret } from './security';
import { closeSqliteDatabases, executeSqliteQuery, isSqliteReadOnlySql, listSqliteColumns, listSqliteDatabases, listSqliteObjects, listSqliteSchemas } from './sqlite';
import { closeDuckDbDatabases, executeDuckDbQuery, isDuckDbReadOnlySql, listDuckDbColumns, listDuckDbDatabases, listDuckDbObjects, listDuckDbSchemas } from './duckdb';

export { isReadOnlySql };
export function isProfileReadOnlySql(profile: Pick<StoredConnection, 'dbType'>, sql: string): boolean {
  if (profile.dbType === 'sqlite') return isSqliteReadOnlySql(sql);
  if (profile.dbType === 'duckdb') return isDuckDbReadOnlySql(sql);
  return isReadOnlySql(sql);
}
export type { QueryCallbacks };

export interface QueryOptions {
  masterKey: string;
  maxRows: number;
  timeoutSeconds: number;
  readOnly?: boolean;
  database?: string;
}

interface RuntimeProfile {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function runtimeProfile(profile: StoredConnection, masterKey: string): RuntimeProfile {
  return {
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    password: decryptSecret({ ciphertext: profile.passwordCiphertext, iv: profile.passwordIv, authTag: profile.passwordAuthTag }, masterKey),
  };
}

export async function executeNetezzaQuery(profile: StoredConnection, sql: string, options: QueryOptions, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean; rowsAffected?: number }> {
  if (profile.dbType === 'sqlite') return executeSqliteQuery(profile, sql, options, callbacks);
  if (profile.dbType === 'duckdb') return executeDuckDbQuery(profile, sql, options, callbacks);
  return executeRuntimeQuery(runtimeProfile(profile, options.masterKey), sql, { maxRows: options.maxRows, timeoutSeconds: options.timeoutSeconds, readOnly: options.readOnly, database: options.database }, callbacks);
}

export async function listDatabases(profile: StoredConnection, masterKey: string): Promise<MetadataDatabase[]> {
  if (profile.dbType === 'sqlite') return listSqliteDatabases(profile);
  if (profile.dbType === 'duckdb') return listDuckDbDatabases(profile);
  return listRuntimeDatabases(runtimeProfile(profile, masterKey));
}

export async function listSchemas(profile: StoredConnection, database: string, masterKey: string): Promise<MetadataSchema[]> {
  if (profile.dbType === 'sqlite') return listSqliteSchemas(profile, database);
  if (profile.dbType === 'duckdb') return listDuckDbSchemas(profile, database);
  return listRuntimeSchemas(runtimeProfile(profile, masterKey), database);
}

export async function listObjects(profile: StoredConnection, database: string, schema: string | undefined, masterKey: string): Promise<MetadataObject[]> {
  if (profile.dbType === 'sqlite') return listSqliteObjects(profile, database, schema);
  if (profile.dbType === 'duckdb') return listDuckDbObjects(profile, database, schema);
  return listRuntimeObjects(runtimeProfile(profile, masterKey), database, schema);
}

export async function listColumns(profile: StoredConnection, database: string, schema: string, table: string, masterKey: string): Promise<MetadataColumn[]> {
  if (profile.dbType === 'sqlite') return listSqliteColumns(profile, database, schema, table);
  if (profile.dbType === 'duckdb') return listDuckDbColumns(profile, database, schema, table);
  return listRuntimeColumns(runtimeProfile(profile, masterKey), database, schema, table);
}

export async function closeEmbeddedDatabases(): Promise<void> {
  await closeDuckDbDatabases();
  closeSqliteDatabases();
}

export { closeSqliteDatabase, closeSqliteDatabases } from './sqlite';
export { closeDuckDbDatabase } from './duckdb';
export { normalizeDuckDbCatalog } from './duckdb';

export type { QueryColumn };
