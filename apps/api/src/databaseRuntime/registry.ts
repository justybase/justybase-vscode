import type { StoredConnection } from '../store';
import type {
  ApiDatabaseRuntime,
  ApiDatabaseRuntimeKind,
  ApiDatabaseRuntimeRegistry,
  ApiQueryOptions,
  QueryCallbacks,
} from './contracts';
import { DuckDbApiDatabaseRuntime } from './duckDbRuntime';
import { NetezzaApiDatabaseRuntime } from './netezzaRuntime';
import { SqliteApiDatabaseRuntime } from './sqliteRuntime';

export interface ApiDatabaseRuntimeRegistryOptions {
  masterKey: string;
  runtimes?: readonly ApiDatabaseRuntime[];
}

async function closeEvery(
  runtimes: readonly ApiDatabaseRuntime[],
  close: (runtime: ApiDatabaseRuntime) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    runtimes.map(runtime => Promise.resolve().then(() => close(runtime))),
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Multiple database runtimes failed to close.');
}

class DefaultApiDatabaseRuntimeRegistry implements ApiDatabaseRuntimeRegistry {
  private readonly runtimes: readonly ApiDatabaseRuntime[];
  private readonly byKind: ReadonlyMap<ApiDatabaseRuntime['kind'], ApiDatabaseRuntime>;

  public constructor(options: ApiDatabaseRuntimeRegistryOptions) {
    this.runtimes = options.runtimes ?? [
      new NetezzaApiDatabaseRuntime(options.masterKey),
      new SqliteApiDatabaseRuntime(),
      new DuckDbApiDatabaseRuntime(),
    ];
    this.byKind = new Map(this.runtimes.map(runtime => [runtime.kind, runtime]));
    for (const kind of ['netezza', 'sqlite', 'duckdb'] as const) {
      if (!this.byKind.has(kind)) throw new Error(`Database runtime ${kind} is not registered.`);
    }
  }

  public forProfile(profile: Pick<StoredConnection, 'dbType'>): ApiDatabaseRuntime {
    const kind: ApiDatabaseRuntimeKind | undefined = profile.dbType === 'netezza'
      ? 'netezza'
      : profile.dbType === 'sqlite'
        ? 'sqlite'
        : profile.dbType === 'duckdb'
          ? 'duckdb'
          : undefined;
    if (!kind) throw new Error(`No API database runtime is registered for '${profile.dbType}'.`);
    const runtime = this.byKind.get(kind);
    if (!runtime) throw new Error(`Database runtime ${kind} is not registered.`);
    return runtime;
  }

  public isReadOnlySql(profile: Pick<StoredConnection, 'dbType'>, sql: string): boolean {
    return this.forProfile(profile).isReadOnlySql(sql);
  }

  public isAvailable(profile: Pick<StoredConnection, 'dbType'>): boolean {
    if (profile.dbType !== 'netezza' && profile.dbType !== 'sqlite' && profile.dbType !== 'duckdb') return false;
    return this.forProfile(profile).isAvailable();
  }

  public normalizeDatabase(profile: Pick<StoredConnection, 'dbType'>, database: string): string {
    return this.forProfile(profile).normalizeDatabase(database);
  }

  public execute(profile: StoredConnection, sql: string, options: ApiQueryOptions, callbacks: QueryCallbacks) {
    return this.forProfile(profile).execute(profile, sql, options, callbacks);
  }

  public listDatabases(profile: StoredConnection) {
    return this.forProfile(profile).listDatabases(profile);
  }

  public listSchemas(profile: StoredConnection, database: string) {
    return this.forProfile(profile).listSchemas(profile, database);
  }

  public listObjects(profile: StoredConnection, database: string, schema?: string) {
    return this.forProfile(profile).listObjects(profile, database, schema);
  }

  public listColumns(profile: StoredConnection, database: string, schema: string, table: string) {
    return this.forProfile(profile).listColumns(profile, database, schema, table);
  }

  public closeConnection(connectionId: string): Promise<void> {
    return closeEvery(this.runtimes, runtime => runtime.closeConnection(connectionId));
  }

  public closeAll(): Promise<void> {
    return closeEvery(this.runtimes, runtime => runtime.closeAll());
  }
}

export function createApiDatabaseRuntimeRegistry(
  options: ApiDatabaseRuntimeRegistryOptions,
): ApiDatabaseRuntimeRegistry {
  return new DefaultApiDatabaseRuntimeRegistry(options);
}
