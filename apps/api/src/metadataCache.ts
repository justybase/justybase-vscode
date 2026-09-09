import {
  TimedMetadataCache,
  buildMetadataKey,
  casePreservingIdentifierPolicy,
  GenerationTracker,
  netezzaMetadataIdentifierPolicy,
  metadataIdentifier,
  STALE_TTL_MULTIPLIER,
  type MetadataIdentifierPolicy,
  type TimedMetadataEntry,
} from '@justybase/metadata-core';
import type { MetadataColumn, MetadataDatabase, MetadataObject, MetadataSchema } from '@justybase/contracts';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { StoredConnection } from './store';

const DEFAULT_SCHEMA_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_LSP_TTL_MS = 5 * 60 * 1000;

interface ContextEntry<T> extends TimedMetadataEntry<T> {
  scopeKey: string;
}

export interface ApiMetadataServiceOptions {
  now?: () => number;
  schemaTtlMs?: number;
  lspTtlMs?: number;
}

export interface ApiMetadataLoadOptions {
  ttlMs?: number;
  staleTtlMs?: number;
  staleOnError?: boolean;
}

export interface ApiMetadataLoadResult<T> {
  value: T;
  stale: boolean;
}

/**
 * Owns all metadata state for one API server instance.
 *
 * The service is deliberately constructed by buildServer. It must not be a
 * module singleton: authenticated owner and connection identity are part of
 * every key and invalidation token.
 */
export class ApiMetadataService {
  public readonly schemaTtlMs: number;
  public readonly lspTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new TimedMetadataCache();
  private readonly generations = new GenerationTracker();
  private readonly keyScopes = new Map<string, string>();
  private readonly contexts = new Map<string, ContextEntry<unknown>>();

  public constructor(options: ApiMetadataServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schemaTtlMs = options.schemaTtlMs ?? DEFAULT_SCHEMA_TTL_MS;
    this.lspTtlMs = options.lspTtlMs ?? DEFAULT_LSP_TTL_MS;
  }

  public async listDatabases(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
  ): Promise<MetadataDatabase[]> {
    return (await this.listDatabasesWithState(runtimes, ownerId, profile)).value;
  }

  public listDatabasesWithState(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
  ): Promise<ApiMetadataLoadResult<MetadataDatabase[]>> {
    return this.loadWithState(ownerId, profile, 'databases', [], () => runtimes.listDatabases(profile));
  }

  public async listSchemas(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
    database: string,
  ): Promise<MetadataSchema[]> {
    return (await this.listSchemasWithState(runtimes, ownerId, profile, database)).value;
  }

  public listSchemasWithState(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
    database: string,
  ): Promise<ApiMetadataLoadResult<MetadataSchema[]>> {
    return this.loadWithState(ownerId, profile, 'schemas', [database], () => runtimes.listSchemas(profile, database));
  }

  public async listObjects(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
    database: string,
    schema?: string,
    options?: ApiMetadataLoadOptions,
  ): Promise<MetadataObject[]> {
    return (await this.listObjectsWithState(runtimes, ownerId, profile, database, schema, options)).value;
  }

  public listObjectsWithState(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
    database: string,
    schema?: string,
    options?: ApiMetadataLoadOptions,
  ): Promise<ApiMetadataLoadResult<MetadataObject[]>> {
    return this.loadWithState(ownerId, profile, 'objects', [database, schema], () => runtimes.listObjects(profile, database, schema), { staleOnError: true, ...options });
  }

  public async listColumns(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
    database: string,
    schema: string,
    table: string,
    options?: ApiMetadataLoadOptions,
  ): Promise<MetadataColumn[]> {
    return (await this.listColumnsWithState(runtimes, ownerId, profile, database, schema, table, options)).value;
  }

  public listColumnsWithState(
    runtimes: ApiDatabaseRuntimeRegistry,
    ownerId: string,
    profile: StoredConnection,
    database: string,
    schema: string,
    table: string,
    options?: ApiMetadataLoadOptions,
  ): Promise<ApiMetadataLoadResult<MetadataColumn[]>> {
    return this.loadWithState(ownerId, profile, 'columns', [database, schema, table], () => runtimes.listColumns(profile, database, schema, table), { staleOnError: true, ...options });
  }

  public async load<T>(
    ownerId: string,
    profile: Pick<StoredConnection, 'id'> & Partial<Pick<StoredConnection, 'dbType'>>,
    layer: string,
    parts: readonly (string | undefined)[],
    loader: () => Promise<T>,
    options: ApiMetadataLoadOptions = {},
  ): Promise<T> {
    return (await this.loadWithState(ownerId, profile, layer, parts, loader, options)).value;
  }

  public async loadWithState<T>(
    ownerId: string,
    profile: Pick<StoredConnection, 'id'> & Partial<Pick<StoredConnection, 'dbType'>>,
    layer: string,
    parts: readonly (string | undefined)[],
    loader: () => Promise<T>,
    options: ApiMetadataLoadOptions = {},
  ): Promise<ApiMetadataLoadResult<T>> {
    const scopeKey = this.scopeKey(ownerId, profile.id);
    const key = this.key(ownerId, profile, layer, parts);
    this.keyScopes.set(key, scopeKey);
    const ttlMs = options.ttlMs ?? this.schemaTtlMs;
    const staleTtlMs = options.staleTtlMs ?? ttlMs * STALE_TTL_MULTIPLIER;
    const current = this.cache.read<T>(key, this.now(), ttlMs, staleTtlMs);
    if (current?.state === 'fresh') return { value: current.value, stale: false };

    const existing = this.cache.getInFlight<T>(key);
    if (existing) {
      try {
        return { value: await existing, stale: false };
      } catch (error: unknown) {
        if (current?.state === 'stale' && options.staleOnError !== false && this.isCurrent(this.capture(scopeKey))) return { value: current.value, stale: true };
        throw error;
      }
    }

    const token = this.capture(scopeKey);
    const promise = (async (): Promise<T> => {
      const value = await loader();
      if (this.isCurrent(token)) this.cache.write(key, value, this.now());
      return value;
    })();
    this.cache.setInFlight(key, promise);
    try {
      return { value: await promise, stale: false };
    } catch (error: unknown) {
      if (current?.state === 'stale' && options.staleOnError !== false && this.isCurrent(token)) return { value: current.value, stale: true };
      throw error;
    }
  }

  public getOrCreateContext<T>(
    ownerId: string,
    profile: Pick<StoredConnection, 'id'> & Partial<Pick<StoredConnection, 'dbType'>>,
    layer: string,
    parts: readonly (string | undefined)[],
    factory: () => T,
    ttlMs = this.lspTtlMs,
  ): T {
    const scopeKey = this.scopeKey(ownerId, profile.id);
    const key = this.key(ownerId, profile, layer, parts);
    const now = this.now();
    const current = this.contexts.get(key) as ContextEntry<T> | undefined;
    if (current && now - current.timestamp < ttlMs && this.isCurrent(this.capture(scopeKey))) {
      current.timestamp = now;
      return current.value;
    }
    const value = factory();
    this.contexts.set(key, { value, timestamp: now, scopeKey });
    this.keyScopes.set(key, scopeKey);
    return value;
  }

  public invalidate(ownerId?: string, connectionId?: string): void {
    if (ownerId === undefined || connectionId === undefined) {
      this.generations.invalidate();
      this.cache.clear();
      this.contexts.clear();
      this.keyScopes.clear();
      return;
    }
    const scopeKey = this.scopeKey(ownerId, connectionId);
    this.generations.invalidate(scopeKey);
    const matches = (key: string): boolean => this.keyScopes.get(key) === scopeKey;
    this.cache.clearWhere(matches);
    for (const [key, entry] of this.contexts) if (entry.scopeKey === scopeKey) this.contexts.delete(key);
    for (const [key, entryScope] of this.keyScopes) if (entryScope === scopeKey) this.keyScopes.delete(key);
  }

  public clear(): void {
    this.invalidate();
  }

  public size(): number {
    return this.cache.size() + this.contexts.size;
  }

  private capture(scopeKey: string): { connectionId: string; generation: number } {
    return this.generations.capture(scopeKey);
  }

  private isCurrent(token: { connectionId: string; generation: number }): boolean {
    return this.generations.isCurrent(token);
  }

  private scopeKey(ownerId: string, connectionId: string): string {
    return `${ownerId}\u0000${connectionId}`;
  }

  private key(
    ownerId: string,
    profile: Pick<StoredConnection, 'id'> & Partial<Pick<StoredConnection, 'dbType'>>,
    layer: string,
    parts: readonly (string | undefined)[],
  ): string {
    const policy = identifierPolicy(profile.dbType);
    const identifiers = parts.map(value => value === undefined ? undefined : metadataIdentifier(value, 'user', isQuoted(value)));
    return buildMetadataKey({
      namespace: 'api',
      ownerId,
      connectionId: profile.id,
      layer,
      database: identifiers[0],
      schema: identifiers[1],
      objectName: identifiers[2],
      columnName: identifiers[3],
    }, policy);
  }
}

function isQuoted(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

function identifierPolicy(dbType: StoredConnection['dbType'] | undefined): MetadataIdentifierPolicy {
  if (dbType === 'netezza') {
    return netezzaMetadataIdentifierPolicy;
  }
  return casePreservingIdentifierPolicy;
}

export function createApiMetadataService(options: ApiMetadataServiceOptions = {}): ApiMetadataService {
  return new ApiMetadataService(options);
}

export function apiMetadataKey(
  ownerId: string,
  profile: Pick<StoredConnection, 'id' | 'dbType'>,
  layer: string,
  parts: readonly (string | undefined)[],
): string {
  const policy = identifierPolicy(profile.dbType);
  const identifiers = parts.map(value => value === undefined ? undefined : metadataIdentifier(value, 'user', isQuoted(value)));
  return buildMetadataKey({
    namespace: 'api',
    ownerId,
    connectionId: profile.id,
    layer,
    database: identifiers[0],
    schema: identifiers[1],
    objectName: identifiers[2],
    columnName: identifiers[3],
  }, policy);
}

export { DEFAULT_LSP_TTL_MS, DEFAULT_SCHEMA_TTL_MS };
