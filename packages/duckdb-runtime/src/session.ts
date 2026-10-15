import {
  createDuckDbModuleResolver,
  type DuckDbConnection,
  type DuckDbInstance,
  type DuckDbModuleResolver,
  type DuckDbResultReader,
} from './resolver';
import { acquireFileInstance } from './fileInstances';

export type { DuckDbConnection, DuckDbInstance, DuckDbResultReader, DuckDbModule, DuckDbModuleResolver } from './resolver';

export interface DuckDbSessionOptions {
  databasePath?: string;
  /** File instances are shared until the last session releases them. */
  instanceOwnership?: 'cached-file' | 'owned-memory';
  resolver?: DuckDbModuleResolver;
}

/** One DuckDB instance/connection pair with explicit ownership semantics. */
export class DuckDbSession {
  private instance?: DuckDbInstance;
  private connection?: DuckDbConnection;
  private releaseInstance?: () => void;
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
    const databasePath = this.options.databasePath;
    const lease = this.options.instanceOwnership === 'cached-file' && databasePath && databasePath !== ':memory:'
      ? await acquireFileInstance(module, databasePath)
      : await module.DuckDBInstance.create(databasePath).then(instance => ({
        instance,
        release: () => instance.closeSync(),
      }));
    const instance = lease.instance;
    try {
      if (this.closed) throw new Error('DuckDB session has been closed.');
      const connection = await instance.connect();
      if (this.closed) {
        connection.disconnectSync();
        throw new Error('DuckDB session has been closed.');
      }
      this.connection = connection;
      this.instance = instance;
      this.releaseInstance = lease.release;
    } catch (error: unknown) {
      try { lease.release(); } catch { /* preserve connection error */ }
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
    const releaseInstance = this.releaseInstance;
    this.connection = undefined;
    this.instance = undefined;
    this.releaseInstance = undefined;
    try {
      connection?.disconnectSync();
    } finally {
      releaseInstance?.();
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
  }
}
