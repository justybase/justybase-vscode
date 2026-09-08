import { DatabaseSync } from 'node:sqlite';

/** Native SQLite handle exposed only to platform adapters that need it. */
export type SqliteDatabase = DatabaseSync;

export interface SqliteSessionOptions {
  /** Keep 64-bit integers lossless in the API/runtime boundary. */
  readBigInts?: boolean;
}

/**
 * Small lifecycle wrapper around Node's built-in SQLite implementation.
 *
 * The session deliberately contains no product policy (sandboxing, URI
 * resolution, or query safety). Those concerns stay in the API/desktop
 * adapters while both platforms share the same native handle ownership.
 */
export class SqliteSession {
  public readonly database: SqliteDatabase;
  private closed = false;

  public constructor(
    public readonly databasePath: string,
    options: SqliteSessionOptions = {},
  ) {
    this.database = new DatabaseSync(databasePath, {
      ...(options.readBigInts === undefined ? {} : { readBigInts: options.readBigInts }),
    });
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
