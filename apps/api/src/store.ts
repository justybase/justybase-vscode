import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ConnectionProfileInput,
  ConnectionProfileUpdate,
  EditorPreferences,
  EditorPreferencesPatch,
  ConnectionProfileSummary,
  HistoryEntry,
  WebUser,
} from '@justybase/contracts';
import { hashPassword, hashSessionToken } from './security';
import { mergeEditorPreferences } from './preferences';

interface UserRow { id: string; username: string; password_hash: string; role: 'admin' | 'user'; active: number; }
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
  dbType: 'netezza';
  passwordCiphertext: string;
  passwordIv: string;
  passwordAuthTag: string;
  readOnly: boolean;
}

function toUser(row: UserRow): WebUser {
  return { id: row.id, username: row.username, role: row.role };
}

export class AppStore {
  private readonly db: DatabaseSync;

  public constructor(dataDir: string) {
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
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        editor_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public close(): void { this.db.close(); }

  public countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    return Number(row.count);
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
    return rows.map(row => ({ id: row.id, name: row.name, host: row.host, port: row.port, database: row.database_name, user: row.db_user, dbType: 'netezza', readOnly: row.read_only === 1 }));
  }

  public updateConnection(userId: string, id: string, input: ConnectionProfileUpdate, encrypted?: { ciphertext: string; iv: string; authTag: string }): ConnectionProfileSummary | undefined {
    const existing = this.db.prepare('SELECT * FROM connections WHERE user_id = ? AND id = ?').get(userId, id) as ConnectionRow | undefined;
    if (!existing || input.dbType !== undefined && input.dbType !== 'netezza') return undefined;
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
    if (!row || row.db_type !== 'netezza') return undefined;
    return { id: row.id, name: row.name, host: row.host, port: row.port, database: row.database_name, user: row.db_user, dbType: 'netezza', passwordCiphertext: row.encrypted_password, passwordIv: row.encryption_iv, passwordAuthTag: row.encryption_tag, readOnly: row.read_only === 1 };
  }

  public addHistory(userId: string, connectionId: string, sql: string, status: HistoryEntry['status'], durationMs: number, rowCount: number): void {
    this.db.prepare('INSERT INTO query_history (id, user_id, connection_id, sql, status, duration_ms, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), userId, connectionId, sql, status, durationMs, rowCount, new Date().toISOString());
  }

  public listHistory(userId: string): HistoryEntry[] {
    const rows = this.db.prepare('SELECT id, connection_id, sql, status, duration_ms, row_count, created_at FROM query_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as Array<{ id: string; connection_id: string; sql: string; status: HistoryEntry['status']; duration_ms: number; row_count: number; created_at: string }>;
    return rows.map(row => ({ id: row.id, connectionId: row.connection_id, sql: row.sql, status: row.status, durationMs: row.duration_ms, rowCount: row.row_count, createdAt: row.created_at }));
  }
}
