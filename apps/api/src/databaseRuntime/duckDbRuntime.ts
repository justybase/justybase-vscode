import path from 'node:path';
import {
  createDuckDbModuleResolver,
  DuckDbRuntime,
  normalizeDuckDbCatalog,
} from '@justybase/duckdb-runtime';
import { isReadOnlySql as isRuntimeReadOnlySql } from '@justybase/database-runtime';
import { resolveLocalDatabasePath } from '../localDatabaseSandbox';
import type { StoredConnection } from '../store';
import type { ApiDatabaseRuntime, ApiQueryOptions, QueryCallbacks } from './contracts';

const moduleCandidates = (): string[] => [
  process.env.JUSTYBASE_DUCKDB_MODULE_PATH,
  '@duckdb/node-api',
  path.resolve(process.cwd(), 'extensions/duckdb/node_modules/@duckdb/node-api'),
  path.resolve(process.cwd(), '../extensions/duckdb/node_modules/@duckdb/node-api'),
  path.resolve(process.cwd(), '../../extensions/duckdb/node_modules/@duckdb/node-api'),
  path.resolve(__dirname, '../../../../extensions/duckdb/node_modules/@duckdb/node-api'),
].filter((candidate): candidate is string => Boolean(candidate?.trim()));

function isDuckDbReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/u, '');
  const withoutLeadingComments = trimmed.replace(/^(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u, '').trim();
  if (/^VALUES\b/iu.test(withoutLeadingComments)) return !/;/u.test(withoutLeadingComments);
  if (/^PRAGMA\b/iu.test(withoutLeadingComments) && !/\s*=/u.test(withoutLeadingComments)) return true;
  return isRuntimeReadOnlySql(trimmed);
}

function createResolver() {
  return createDuckDbModuleResolver({
    resolveFrom: __filename,
    candidates: moduleCandidates(),
    missingDependencyMessage: 'DuckDB runtime dependency "@duckdb/node-api" is not installed. Install the optional DuckDB extension or set JUSTYBASE_DUCKDB_MODULE_PATH.',
  });
}

export class DuckDbApiDatabaseRuntime implements ApiDatabaseRuntime {
  public readonly kind = 'duckdb' as const;
  private readonly runtime: DuckDbRuntime;

  public constructor() {
    this.runtime = new DuckDbRuntime({ resolver: createResolver(), isReadOnlySql: isDuckDbReadOnlySql });
  }

  public isReadOnlySql(sql: string): boolean { return isDuckDbReadOnlySql(sql); }
  public isAvailable(): boolean { return this.runtime.isAvailable(); }
  public normalizeDatabase(database: string): string { return normalizeDuckDbCatalog(database); }

  public execute(profile: StoredConnection, sql: string, options: ApiQueryOptions, callbacks: QueryCallbacks) {
    const target = this.targetFor(profile);
    return this.runtime.execute(target, this.rewriteAttach(profile, sql), options, callbacks);
  }

  public listDatabases(profile: StoredConnection) { return this.runtime.listDatabases(this.targetFor(profile)); }
  public listSchemas(profile: StoredConnection, database: string) { return this.runtime.listSchemas(this.targetFor(profile), database); }
  public listObjects(profile: StoredConnection, database: string, schema?: string) { return this.runtime.listObjects(this.targetFor(profile), database, schema); }
  public listColumns(profile: StoredConnection, database: string, schema: string, table: string) { return this.runtime.listColumns(this.targetFor(profile), database, schema, table); }
  public closeConnection(connectionId: string): Promise<void> { return this.runtime.closeConnection(connectionId); }
  public closeAll(): Promise<void> { return this.runtime.closeAll(); }

  private targetFor(profile: StoredConnection) {
    const requested = profile.database.trim();
    if (!requested || requested === ':memory:') return { connectionId: profile.id, instanceOwnership: 'owned-memory' as const };
    if (!profile.localDbRoot || !profile.userId) throw new Error('Local DuckDB profiles require an application-owned sandbox.');
    return {
      connectionId: profile.id,
      databasePath: resolveLocalDatabasePath(requested, { root: profile.localDbRoot, userId: profile.userId }),
      instanceOwnership: 'cached-file' as const,
    };
  }

  private rewriteAttach(profile: StoredConnection, sql: string): string {
    const leadingComments = /^\s*(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u.exec(sql)?.[0] ?? '';
    const command = sql.slice(leadingComments.length);
    if (!/^ATTACH\b/iu.test(command)) return sql;
    const pattern = /^(\bATTACH(?:\s+DATABASE)?\s+)(['"])(.*?)\2(\s+AS\s+)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\5/iu;
    if (!pattern.test(command)) throw new Error('DuckDB ATTACH requires a sandboxed literal database path.');
    const normalized = command.replace(pattern, (full, prefix: string, quote: string, requested: string, asClause: string, nameQuote: string, name: string) => {
      if (requested === ':memory:') return full;
      if (!profile.localDbRoot || !profile.userId) throw new Error('DuckDB ATTACH requires an application-owned sandbox.');
      const resolved = resolveLocalDatabasePath(requested, { root: profile.localDbRoot, userId: profile.userId });
      const escaped = quote === "'" ? resolved.replace(/'/g, "''") : resolved.replace(/"/g, '""');
      return `${prefix}${quote}${escaped}${quote}${asClause}${nameQuote}${name}${nameQuote}`;
    });
    return `${leadingComments}${normalized}`;
  }
}

export { isDuckDbReadOnlySql };
