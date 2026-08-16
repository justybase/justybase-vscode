import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ConnectionProfileInput,
  ConnectionProfileUpdate,
  DatabaseKind,
  AdminUserSummary,
  AdminUserUpdateRequest,
  EditorPreferences,
  EditorPreferencesPatch,
  ConnectionProfileSummary,
  QueryAuditEntry,
  QueryAuditStatus,
  HistoryEntry,
  WebUser,
} from '@justybase/contracts';
import { hashPassword, hashSessionToken } from './security';
import { mergeEditorPreferences } from './preferences';
import { resolveLocalDatabasePath } from './localDatabaseSandbox';

interface UserRow { id: string; username: string; password_hash: string; role: 'admin' | 'user'; active: number; created_at: string; }
interface ConnectionRow {
  id: string; name: string; host: string; port: number; database_name: string; db_user: string;
  db_type: string; encrypted_password: string; encryption_iv: string; encryption_tag: string; read_only: number;
}

export interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  dbType: DatabaseKind;
  passwordCiphertext: string;
  passwordIv: string;
  passwordAuthTag: string;
  readOnly: boolean;
  /** Runtime-only ownership information used by the local database sandbox. */
  userId?: string;
  localDbRoot?: string;
}

function toUser(row: UserRow): WebUser {
  return { id: row.id, username: row.username, role: row.role };
}

export class AppStore {
  private readonly db: DatabaseSync;
  private readonly localDbRoot: string;

  public constructor(dataDir: string, localDbRoot = path.join(dataDir, 'local-databases')) {
    this.localDbRoot = path.resolve(localDbRoot);
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'justybase-web.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT NOT NULL,
        db_user TEXT NOT NULL,
        db_type TEXT NOT NULL DEFAULT 'netezza',
        encrypted_password TEXT NOT NULL,
        encryption_iv TEXT NOT NULL,
        encryption_tag TEXT NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, name)
      );
      CREATE TABLE IF NOT EXISTS query_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        sql TEXT NOT NULL,
        database_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS query_audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        database_name TEXT NOT NULL,
        statement_index INTEGER NOT NULL,
        statement_count INTEGER NOT NULL,
        command_type TEXT NOT NULL,
        sql TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error', 'cancelled')),
        rows_affected INTEGER,
        duration_ms INTEGER NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        editor_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Databases created before web multi-database profiles did not have db_type.
    // Keep those installations upgradeable without requiring a manual migration.
    const connectionColumns = new Set((this.db.prepare('PRAGMA table_info(connections)').all() as Array<{ name?: unknown }>).map(column => String(column.name ?? '')));
    if (!connectionColumns.has('db_type')) this.db.exec("ALTER TABLE connections ADD COLUMN db_type TEXT NOT NULL DEFAULT 'netezza'");
    const historyColumns = new Set((this.db.prepare('PRAGMA table_info(query_history)').all() as Array<{ name?: unknown }>).map(column => String(column.name ?? '')));
    if (!historyColumns.has('database_name')) this.db.exec("ALTER TABLE query_history ADD COLUMN database_name TEXT NOT NULL DEFAULT ''");
  }

  public close(): void { this.db.close(); }

  public countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    return Number(row.count);
  }

  public listUsers(): AdminUserSummary[] {
    const rows = this.db.prepare('SELECT id, username, role, active, created_at FROM users ORDER BY username').all() as Array<Pick<UserRow, 'id' | 'username' | 'role' | 'active' | 'created_at'>>;
    return rows.map(row => ({ id: row.id, username: row.username, role: row.role, active: row.active === 1, createdAt: row.created_at }));
  }

  public updateUser(id: string, patch: AdminUserUpdateRequest): AdminUserSummary | undefined {
    const existing = this.db.prepare('SELECT id, username, role, active, created_at FROM users WHERE id = ?').get(id) as Pick<UserRow, 'id' | 'username' | 'role' | 'active' | 'created_at'> | undefined;
    if (!existing) return undefined;
    const nextRole = patch.role === 'admin' || patch.role === 'user' ? patch.role : existing.role;
    const nextActive = patch.active === undefined ? existing.active === 1 : patch.active;
    if (existing.role === 'admin' && existing.active === 1 && (nextRole !== 'admin' || !nextActive)) {
      const activeAdmins = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count: number };
      if (Number(activeAdmins.count) <= 1) throw new Error('The last active administrator must remain active.');
    }
    this.db.prepare('UPDATE users SET role = ?, active = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?').run(
      nextRole,
      nextActive ? 1 : 0,
      patch.password ? hashPassword(patch.password) : null,
      id,
    );
    return this.listUsers().find(user => user.id === id);
  }

  public backupTo(targetPath: string): void {
    const escapedPath = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escapedPath}'`);
  }

  public restoreFrom(sourcePath: string): { restoredUsers: number; restoredConnections: number } {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const integrity = source.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
      if (String(integrity?.integrity_check ?? '').toLowerCase() !== 'ok') throw new Error('The backup failed SQLite integrity validation.');
      const requiredTables = ['users', 'sessions', 'connections', 'query_history', 'query_audit_log', 'user_preferences'];
      for (const table of requiredTables) {
        const found = source.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { present?: number } | undefined;
        if (!found) throw new Error(`The backup is missing the ${table} table.`);
      }
      const activeAdmin = source.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get() as { count?: number };
      if (Number(activeAdmin.count ?? 0) < 1) throw new Error('The backup must contain at least one active administrator.');
      const restoredUsers = Number((source.prepare('SELECT COUNT(*) AS count FROM users').get() as { count?: number }).count ?? 0);
      const restoredConnections = Number((source.prepare('SELECT COUNT(*) AS count FROM connections').get() as { count?: number }).count ?? 0);
      const sourceConnectionColumns = new Set((source.prepare('PRAGMA table_info(connections)').all() as Array<{ name?: unknown }>).map(column => String(column.name ?? '')));
      const sourceHistoryColumns = new Set((source.prepare('PRAGMA table_info(query_history)').all() as Array<{ name?: unknown }>).map(column => String(column.name ?? '')));
      const sourceConnections = source.prepare(`SELECT user_id, database_name, ${sourceConnectionColumns.has('db_type') ? 'db_type' : "'netezza' AS db_type"} FROM connections`).all() as Array<{ user_id?: unknown; database_name?: unknown; db_type?: unknown }>;
      for (const connection of sourceConnections) {
        const dbType = sourceConnectionColumns.has('db_type') ? String(connection.db_type ?? 'netezza') : 'netezza';
        if (dbType === 'sqlite' || dbType === 'duckdb') resolveLocalDatabasePath(String(connection.database_name ?? ''), { root: this.localDbRoot, userId: String(connection.user_id ?? '') });
      }
      source.close();

      this.db.prepare('ATTACH DATABASE ? AS restore_source').run(sourcePath);
      try {
        this.db.exec('BEGIN IMMEDIATE');
        this.db.exec('DELETE FROM query_audit_log; DELETE FROM query_history; DELETE FROM sessions; DELETE FROM user_preferences; DELETE FROM connections; DELETE FROM users;');
        this.db.exec(`
          INSERT INTO users (id, username, password_hash, role, active, created_at)
            SELECT id, username, password_hash, role, active, created_at FROM restore_source.users;
          INSERT INTO connections (id, user_id, name, host, port, database_name, db_user, db_type, encrypted_password, encryption_iv, encryption_tag, read_only, created_at)
            SELECT id, user_id, name, host, port, database_name, db_user, ${sourceConnectionColumns.has('db_type') ? 'db_type' : "'netezza'"}, encrypted_password, encryption_iv, encryption_tag, read_only, created_at FROM restore_source.connections;
          INSERT INTO query_history (id, user_id, connection_id, sql, database_name, status, duration_ms, row_count, created_at)
            SELECT q.id, q.user_id, q.connection_id, q.sql, ${sourceHistoryColumns.has('database_name') ? 'q.database_name' : "COALESCE((SELECT c.database_name FROM restore_source.connections c WHERE c.id = q.connection_id), '')"}, q.status, q.duration_ms, q.row_count, q.created_at FROM restore_source.query_history q;
          INSERT INTO query_audit_log (id, user_id, connection_id, database_name, statement_index, statement_count, command_type, sql, status, rows_affected, duration_ms, confirmed, created_at)
            SELECT id, user_id, connection_id, database_name, statement_index, statement_count, command_type, sql, status, rows_affected, duration_ms, confirmed, created_at FROM restore_source.query_audit_log;
          INSERT INTO user_preferences (user_id, editor_json, updated_at)
            SELECT user_id, editor_json, updated_at FROM restore_source.user_preferences;
          INSERT INTO sessions (token_hash, user_id, expires_at)
            SELECT token_hash, user_id, expires_at FROM restore_source.sessions;
        `);
        this.db.exec('COMMIT');
      } catch (error: unknown) {
        try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original restore error. */ }
        throw error;
      } finally {
        this.db.exec('DETACH DATABASE restore_source');
      }
      return { restoredUsers, restoredConnections };
    } finally {
      try { source.close(); } catch { /* The validation path may already have closed it. */ }
    }
  }

  public createUser(username: string, password: string, role: 'admin' | 'user' = 'user'): WebUser {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, username, hashPassword(password), role, new Date().toISOString());
    return { id, username, role };
  }

  public findUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username) as UserRow | undefined;
  }

  public findUserById(id: string): WebUser | undefined {
    const row = this.db.prepare('SELECT id, username, role FROM users WHERE id = ? AND active = 1').get(id) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  public createSession(userId: string, token: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionToken(token), userId, expiresAt);
  }

  public findUserBySession(token: string): WebUser | undefined {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(hashSessionToken(token), Date.now()) as UserRow | undefined;
    return row ? toUser(row) : undefined;
  }

  public deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }

  public getEditorPreferences(userId: string): EditorPreferences {
    const row = this.db.prepare('SELECT editor_json FROM user_preferences WHERE user_id = ?').get(userId) as { editor_json: string } | undefined;
    if (!row) return mergeEditorPreferences(undefined);
    try { return mergeEditorPreferences(JSON.parse(row.editor_json)); } catch { return mergeEditorPreferences(undefined); }
  }

  public updateEditorPreferences(userId: string, patch: EditorPreferencesPatch): EditorPreferences {
    const preferences = mergeEditorPreferences(this.getEditorPreferences(userId), patch);
    this.db.prepare(`INSERT INTO user_preferences (user_id, editor_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET editor_json = excluded.editor_json, updated_at = excluded.updated_at`).run(userId, JSON.stringify(preferences), new Date().toISOString());
    return preferences;
  }

  public createConnection(userId: string, input: ConnectionProfileInput, encrypted: { ciphertext: string; iv: string; authTag: string }): ConnectionProfileSummary {
    this.validateLocalDatabase(userId, input.dbType ?? 'netezza', input.database);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO connections
        (id, user_id, name, host, port, database_name, db_user, db_type, encrypted_password, encryption_iv, encryption_tag, read_only, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, input.name.trim(), input.host.trim(), input.port ?? 5480, input.database.trim(), input.user.trim(), input.dbType ?? 'netezza', encrypted.ciphertext, encrypted.iv, encrypted.authTag, input.readOnly === false ? 0 : 1, new Date().toISOString());
    return {
      id, name: input.name.trim(), host: input.host.trim(), port: input.port ?? 5480,
      database: input.database.trim(), user: input.user.trim(), dbType: input.dbType ?? 'netezza', readOnly: input.readOnly !== false,
    };
  }

  public listConnections(userId: string): ConnectionProfileSummary[] {
    const rows = this.db.prepare('SELECT id, name, host, port, database_name, db_user, db_type, read_only FROM connections WHERE user_id = ? ORDER BY name').all(userId) as Array<Pick<ConnectionRow, 'id' | 'name' | 'host' | 'port' | 'database_name' | 'db_user' | 'db_type' | 'read_only'>>;
    return rows.map(row => ({ id: row.id, name: row.name, host: row.host, port: row.port, database: row.database_name, user: row.db_user, dbType: (row.db_type || 'netezza') as DatabaseKind, readOnly: row.read_only === 1 }));
  }

  public updateConnection(userId: string, id: string, input: ConnectionProfileUpdate, encrypted?: { ciphertext: string; iv: string; authTag: string }): ConnectionProfileSummary | undefined {
    const existing = this.db.prepare('SELECT * FROM connections WHERE user_id = ? AND id = ?').get(userId, id) as ConnectionRow | undefined;
    if (!existing) return undefined;
    this.validateLocalDatabase(userId, input.dbType ?? 'netezza', input.database);
    this.db.prepare(`
      UPDATE connections
      SET name = ?, host = ?, port = ?, database_name = ?, db_user = ?, db_type = ?,
          encrypted_password = ?, encryption_iv = ?, encryption_tag = ?, read_only = ?
      WHERE user_id = ? AND id = ?
    `).run(
      input.name.trim(), input.host.trim(), input.port ?? 5480, input.database.trim(), input.user.trim(), input.dbType ?? 'netezza',
      encrypted?.ciphertext ?? existing.encrypted_password, encrypted?.iv ?? existing.encryption_iv, encrypted?.authTag ?? existing.encryption_tag,
      input.readOnly === false ? 0 : 1, userId, id,
    );
    return this.listConnections(userId).find(connection => connection.id === id);
  }

  public deleteConnection(userId: string, id: string): boolean {
    const result = this.db.prepare('DELETE FROM connections WHERE user_id = ? AND id = ?').run(userId, id);
    return result.changes > 0;
  }

  public getConnection(userId: string, id: string): StoredConnection | undefined {
    const row = this.db.prepare('SELECT * FROM connections WHERE user_id = ? AND id = ?').get(userId, id) as ConnectionRow | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, host: row.host, port: row.port, database: row.database_name, user: row.db_user, dbType: (row.db_type || 'netezza') as DatabaseKind, passwordCiphertext: row.encrypted_password, passwordIv: row.encryption_iv, passwordAuthTag: row.encryption_tag, readOnly: row.read_only === 1, userId, localDbRoot: this.localDbRoot };
  }

  public addHistory(userId: string, connectionId: string, database: string, sql: string, status: HistoryEntry['status'], durationMs: number, rowCount: number): void {
    this.db.prepare('INSERT INTO query_history (id, user_id, connection_id, sql, database_name, status, duration_ms, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), userId, connectionId, sql, database, status, durationMs, rowCount, new Date().toISOString());
  }

  public listHistory(userId: string): HistoryEntry[] {
    const rows = this.db.prepare('SELECT q.id, q.connection_id, COALESCE(NULLIF(q.database_name, \'\'), c.database_name, \'\') AS database_name, q.sql, q.status, q.duration_ms, q.row_count, q.created_at FROM query_history q LEFT JOIN connections c ON c.id = q.connection_id WHERE q.user_id = ? ORDER BY q.created_at DESC LIMIT 100').all(userId) as Array<{ id: string; connection_id: string; database_name: string; sql: string; status: HistoryEntry['status']; duration_ms: number; row_count: number; created_at: string }>;
    return rows.map(row => ({ id: row.id, connectionId: row.connection_id, database: row.database_name, sql: row.sql, status: row.status, durationMs: row.duration_ms, rowCount: row.row_count, createdAt: row.created_at }));
  }

  public addAudit(userId: string, entry: Omit<QueryAuditEntry, 'id'>): void {
    this.db.prepare(`INSERT INTO query_audit_log
      (id, user_id, connection_id, database_name, statement_index, statement_count, command_type, sql, status, rows_affected, duration_ms, confirmed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), userId, entry.connectionId, entry.database, entry.statementIndex, entry.statementCount,
      entry.commandType, entry.sql, entry.status, entry.rowsAffected ?? null, entry.durationMs,
      entry.confirmed ? 1 : 0, new Date(entry.createdAt).toISOString(),
    );
  }

  public listAudit(userId: string, limit = 200): QueryAuditEntry[] {
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT id, connection_id, database_name, statement_index, statement_count,
      command_type, sql, status, rows_affected, duration_ms, confirmed, created_at
      FROM query_audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, safeLimit) as Array<{
        id: string;
        connection_id: string;
        database_name: string;
        statement_index: number;
        statement_count: number;
        command_type: string;
        sql: string;
        status: QueryAuditStatus;
        rows_affected: number | null;
        duration_ms: number;
        confirmed: number;
        created_at: string;
      }>;
    return rows.map(row => ({
      id: row.id,
      connectionId: row.connection_id,
      database: row.database_name,
      statementIndex: row.statement_index,
      statementCount: row.statement_count,
      commandType: row.command_type,
      sql: row.sql,
      status: row.status,
      rowsAffected: row.rows_affected ?? undefined,
      durationMs: row.duration_ms,
      confirmed: row.confirmed === 1,
      createdAt: row.created_at,
    }));
  }

  private validateLocalDatabase(userId: string, dbType: DatabaseKind, database: string): void {
    if (dbType === 'sqlite' || dbType === 'duckdb') resolveLocalDatabasePath(database, { root: this.localDbRoot, userId });
  }
}
