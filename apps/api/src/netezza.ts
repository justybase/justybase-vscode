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

export { isReadOnlySql };
export type { QueryCallbacks };

export interface QueryOptions {
  masterKey: string;
  maxRows: number;
  timeoutSeconds: number;
  readOnly?: boolean;
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
  return executeRuntimeQuery(runtimeProfile(profile, options.masterKey), sql, { maxRows: options.maxRows, timeoutSeconds: options.timeoutSeconds, readOnly: options.readOnly }, callbacks);
}

export async function listDatabases(profile: StoredConnection, masterKey: string): Promise<MetadataDatabase[]> {
  return listRuntimeDatabases(runtimeProfile(profile, masterKey));
}

export async function listSchemas(profile: StoredConnection, database: string, masterKey: string): Promise<MetadataSchema[]> {
  return listRuntimeSchemas(runtimeProfile(profile, masterKey), database);
}

export async function listObjects(profile: StoredConnection, database: string, schema: string | undefined, masterKey: string): Promise<MetadataObject[]> {
  return listRuntimeObjects(runtimeProfile(profile, masterKey), database, schema);
}

export async function listColumns(profile: StoredConnection, database: string, schema: string, table: string, masterKey: string): Promise<MetadataColumn[]> {
  return listRuntimeColumns(runtimeProfile(profile, masterKey), database, schema, table);
}

export type { QueryColumn };
