import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppStore } from '../src/store';

const encrypted = { ciphertext: '', iv: '', authTag: '' };

describe('AppStore administration and history migrations', () => {
  let dataDir: string;
  let store: AppStore;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-store-'));
    store = new AppStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('protects the last active administrator from role changes as well as disabling', () => {
    const admin = store.createUser('admin', 'admin-password', 'admin');
    expect(() => store.updateUser(admin.id, { active: false })).toThrow('last active administrator');
    expect(() => store.updateUser(admin.id, { role: 'user' })).toThrow('last active administrator');

    const secondAdmin = store.createUser('second-admin', 'admin-password', 'admin');
    expect(store.updateUser(admin.id, { role: 'user' })?.role).toBe('user');
    store.createUser('third-admin', 'admin-password', 'admin');
    expect(store.updateUser(secondAdmin.id, { active: false })?.active).toBe(false);
  });

  it('stores the selected database in history', () => {
    const user = store.createUser('history-user', 'password', 'admin');
    const connection = store.createConnection(user.id, {
      name: 'Netezza', host: 'localhost', port: 5480, database: 'system', user: 'admin', password: 'secret', dbType: 'netezza', readOnly: true,
    }, encrypted);
    store.addHistory(user.id, connection.id, 'analytics', 'SELECT 1', 'success', 4, 1);
    expect(store.listHistory(user.id)[0]).toEqual(expect.objectContaining({ connectionId: connection.id, database: 'analytics', sql: 'SELECT 1' }));
  });

  it('restores history from a backup made before database_name existed', () => {
    const sourcePath = path.join(dataDir, 'old-backup.sqlite');
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, database_name TEXT NOT NULL, db_user TEXT NOT NULL, encrypted_password TEXT NOT NULL, encryption_iv TEXT NOT NULL, encryption_tag TEXT NOT NULL, read_only INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE query_history (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, sql TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, row_count INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE query_audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, database_name TEXT NOT NULL, statement_index INTEGER NOT NULL, statement_count INTEGER NOT NULL, command_type TEXT NOT NULL, sql TEXT NOT NULL, status TEXT NOT NULL, rows_affected INTEGER, duration_ms INTEGER NOT NULL, confirmed INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE user_preferences (user_id TEXT PRIMARY KEY, editor_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    source.exec("INSERT INTO users VALUES ('u1', 'old-admin', 'hash', 'admin', 1, '2026-01-01T00:00:00.000Z')");
    source.exec("INSERT INTO connections VALUES ('c1', 'u1', 'Old connection', 'localhost', 5480, 'old-system', 'admin', '', '', '', 1, '2026-01-01T00:00:00.000Z')");
    source.exec("INSERT INTO query_history VALUES ('h1', 'u1', 'c1', 'SELECT old', 'success', 3, 1, '2026-01-01T00:00:00.000Z')");
    source.close();

    expect(store.restoreFrom(sourcePath)).toEqual({ restoredUsers: 1, restoredConnections: 1 });
    expect(store.listHistory('u1')[0]).toEqual(expect.objectContaining({ database: 'old-system', sql: 'SELECT old' }));
  });
});
