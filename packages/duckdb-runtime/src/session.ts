import {
  createDuckDbModuleResolver,
  type DuckDbConnection,
  type DuckDbInstance,
  type DuckDbModuleResolver,
  type DuckDbResultReader,
} from './resolver';

export type { DuckDbConnection, DuckDbInstance, DuckDbResultReader, DuckDbModule, DuckDbModuleResolver } from './resolver';

export interface DuckDbSessionOptions {
  databasePath?: string;
  /** Cached file instances are shared by DuckDB; memory instances are owned. */
  instanceOwnership?: 'cached-file' | 'owned-memory';
  resolver?: DuckDbModuleResolver;
}

/** One DuckDB instance/connection pair with explicit ownership semantics. */
export class DuckDbSession {
  private instance?: DuckDbInstance;
  private connection?: DuckDbConnection;
  private closed = false;
  private connecting?: Promise<void>;

  public constructor(
    public readonly options: DuckDbSessionOptions = {},
  ) {}

  public get isOpen(): boolean {
    return Boolean(this.connection) && !this.closed;
  }

  public get nativeInstance(): DuckDbInstance | undefined {
    return this.instance;
  }

  public get nativeConnection(): DuckDbConnection {
    if (!this.connection || this.closed) throw new Error('DuckDB session is not open.');
    return this.connection;
  }

  public async connect(): Promise<void> {
    if (this.isOpen) return;
    if (this.closed) throw new Error('DuckDB session has been closed.');
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const resolver = this.options.resolver ?? createDuckDbModuleResolver();
    const module = await resolver.load();
    if (this.closed) throw new Error('DuckDB session has been closed.');
    const instance = this.options.instanceOwnership === 'cached-file'
      ? await module.DuckDBInstance.fromCache(this.options.databasePath)
      : await module.DuckDBInstance.create(this.options.databasePath);
    try {
      const connection = await instance.connect();
      if (this.closed) {
        connection.disconnectSync();
        throw new Error('DuckDB session has been closed.');
      }
      this.connection = connection;
      this.instance = instance;
    } catch (error: unknown) {
      if (this.options.instanceOwnership !== 'cached-file') {
        try { instance.closeSync(); } catch { /* preserve connection error */ }
      }
      throw error;
    }
  }

  public run(sql: string): Promise<{ rowsChanged?: number }> {
    return this.nativeConnection.run(sql);
  }

  public runAndReadAll(sql: string): Promise<DuckDbResultReader> {
    return this.nativeConnection.runAndReadAll(sql);
  }

  public streamAndReadUntil(sql: string, targetRowCount: number): Promise<DuckDbResultReader> {
    return this.nativeConnection.streamAndReadUntil(sql, targetRowCount);
  }

  public interrupt(): void {
    this.connection?.interrupt();
  }

  public disconnect(): void {
    const connection = this.connection;
    const instance = this.instance;
    this.connection = undefined;
    this.instance = undefined;
    try {
      connection?.disconnectSync();
    } finally {
      if (instance && this.options.instanceOwnership !== 'cached-file') instance.closeSync();
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
  }
}
