import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { SqliteSession } from '../src';

describe('SqliteSession ownership', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'justybase-sqlite-session-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('owns an in-memory database and closes idempotently', () => {
    const session = new SqliteSession(':memory:');
    expect(session.isClosed).toBe(false);

    session.database.exec('CREATE TABLE records (id INTEGER)');
    session.close();

    expect(session.isClosed).toBe(true);
    // The native handle rejects a second close, so the wrapper must absorb it.
    expect(() => session.close()).not.toThrow();
    expect(session.isClosed).toBe(true);
  });

  it('releases the file handle on close so the database can be reopened', () => {
    const databasePath = path.join(root, 'owned.sqlite');
    const session = new SqliteSession(databasePath);
    session.database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT)');
    session.database.prepare('INSERT INTO records (label) VALUES (?)').run('kept');
    session.close();

    // A fresh handle must be able to open the file (Windows blocks locked files).
    const reopened = new DatabaseSync(databasePath);
    try {
      const row = reopened.prepare('SELECT label FROM records').get() as { label?: string } | undefined;
      expect(row?.label).toBe('kept');
    } finally {
      reopened.close();
    }
  });

  it('stays closable after an execution error', () => {
    const session = new SqliteSession(':memory:');
    expect(() => session.database.prepare('SELECT * FROM missing_table')).toThrow(/no such table/i);
    expect(session.isClosed).toBe(false);

    session.close();
    expect(session.isClosed).toBe(true);
    expect(() => session.close()).not.toThrow();
  });

  it('creates the database file only when a file path is used', () => {
    const databasePath = path.join(root, 'lazy.sqlite');
    const memorySession = new SqliteSession(':memory:');
    const fileSession = new SqliteSession(databasePath);

    memorySession.close();
    fileSession.close();

    expect(existsSync(databasePath)).toBe(true);
  });
});

describe('SqliteSession value mode', () => {
  it('reads integers beyond Number.MAX_SAFE_INTEGER losslessly with readBigInts', () => {
    const session = new SqliteSession(':memory:', { readBigInts: true });
    try {
      session.database.exec('CREATE TABLE values_table (id INTEGER)');
      session.database.prepare('INSERT INTO values_table VALUES (?)').run(9007199254740993n);

      const row = session.database.prepare('SELECT id FROM values_table').get() as { id?: unknown } | undefined;
      expect(row?.id).toBe(9007199254740993n);
    } finally {
      session.close();
    }
  });

  it('rejects out-of-range integers when readBigInts is disabled', () => {
    const session = new SqliteSession(':memory:');
    try {
      session.database.exec('CREATE TABLE values_table (id INTEGER)');
      session.database.prepare('INSERT INTO values_table VALUES (?)').run(9007199254740993n);
      expect(() => session.database.prepare('SELECT id FROM values_table').get()).toThrow(/too large/i);
    } finally {
      session.close();
    }
  });
});