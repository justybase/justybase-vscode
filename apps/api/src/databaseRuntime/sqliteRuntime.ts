import { isReadOnlySql as isRuntimeReadOnlySql } from '@justybase/database-runtime';
import {
  rewriteSqliteAttachTarget,
  SqliteRuntime,
  type SqliteRuntimeTarget,
} from '@justybase/sqlite-runtime';
import { resolveLocalDatabasePath } from '../localDatabaseSandbox';
import type { StoredConnection } from '../store';
import type {
  ApiDatabaseRuntime,
  ApiQueryOptions,
  QueryCallbacks,
} from './contracts';

const READ_ONLY_PRAGMA_FUNCTIONS = new Set([
  'collation_list',
  'compile_options',
  'database_list',
  'foreign_key_check',
  'foreign_key_list',
  'function_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'module_list',
  'pragma_list',
  'quick_check',
  'stats',
  'table_info',
  'table_list',
  'table_xinfo',
]);

export function isSqliteReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/u, '');
  const withoutLeadingComments = trimmed.replace(/^(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/u, '').trim();
  if (/^VALUES\b/i.test(withoutLeadingComments)) return !/;/.test(withoutLeadingComments);
  const pragma = /^PRAGMA\s+(?:(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])+")\s*\.\s*)?(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*([\s\S]*)$/iu.exec(withoutLeadingComments);
  if (pragma) {
    const pragmaName = (pragma[1] ?? pragma[2] ?? '').replace(/""/g, '"').toLowerCase();
    const suffix = pragma[3]?.trim() ?? '';
    if (suffix.startsWith('=')) return false;
    if (suffix.startsWith('(')) return READ_ONLY_PRAGMA_FUNCTIONS.has(pragmaName) && /^\([\s\S]*\)$/u.test(suffix);
    return true;
  }
  return isRuntimeReadOnlySql(trimmed);
}

export class SqliteApiDatabaseRuntime implements ApiDatabaseRuntime {
  public readonly kind = 'sqlite' as const;
  private readonly runtime = new SqliteRuntime({ isReadOnlySql: isSqliteReadOnlySql });

  public isReadOnlySql(sql: string): boolean {
    return isSqliteReadOnlySql(sql);
  }

  public isAvailable(): boolean {
    return true;
  }

  public normalizeDatabase(database: string): string {
    return database.trim();
  }

  public execute(
    profile: StoredConnection,
    sql: string,
    options: ApiQueryOptions,
    callbacks: QueryCallbacks,
  ) {
    const executableSql = rewriteSqliteAttachTarget(sql, requestedPath => this.resolveAttachment(profile, requestedPath));
    return this.runtime.execute(this.targetFor(profile), executableSql, options, callbacks);
  }

  public listDatabases(profile: StoredConnection) {
    return this.runtime.listDatabases(this.targetFor(profile));
  }

  public listSchemas(profile: StoredConnection, database: string) {
    return this.runtime.listSchemas(this.targetFor(profile), database);
  }

  public listObjects(profile: StoredConnection, database: string, schema?: string) {
    return this.runtime.listObjects(this.targetFor(profile), database, schema);
  }

  public listColumns(profile: StoredConnection, database: string, schema: string, table: string) {
    return this.runtime.listColumns(this.targetFor(profile), database, schema, table);
  }

  public async closeConnection(connectionId: string): Promise<void> {
    await this.runtime.closeConnection(connectionId);
  }

  public async closeAll(): Promise<void> {
    await this.runtime.closeAll();
  }

  private targetFor(profile: StoredConnection): SqliteRuntimeTarget {
    const requested = profile.database.trim();
    if (requested === ':memory:') return { connectionId: profile.id, databasePath: requested };
    return {
      connectionId: profile.id,
      databasePath: this.resolveSandboxedPath(profile, requested),
    };
  }

  private resolveAttachment(profile: StoredConnection, requestedPath: string): string {
    if (requestedPath === ':memory:') return requestedPath;
    return this.resolveSandboxedPath(profile, requestedPath);
  }

  private resolveSandboxedPath(profile: StoredConnection, requestedPath: string): string {
    if (!profile.localDbRoot || !profile.userId) {
      throw new Error('Local SQLite profiles require an application-owned sandbox.');
    }
    return resolveLocalDatabasePath(requestedPath, {
      root: profile.localDbRoot,
      userId: profile.userId,
    });
  }
}
