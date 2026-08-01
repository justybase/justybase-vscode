import { EventEmitter } from "events";
import { createRequire } from "node:module";
import type {
  ConnectionPool,
  IColumnMetadata,
  config as SqlConfig,
} from "mssql";
import type {
  DatabaseCommand,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseDataReader,
} from "@justybase/contracts";
import {
  CURRENT_CATALOG_AND_SCHEMA_QUERY,
  CURRENT_CATALOG_QUERY,
  CURRENT_SCHEMA_QUERY,
  CURRENT_SID_QUERY,
  SET_CATALOG_QUERY,
  getErrorMessage,
  getOptionNumber as getNumberOption,
  getOptionString as getStringOption,
  normalizeCatalogIdentifier,
  stripTrailingSemicolons,
} from "../../../src/core/connectionUtils";

interface MsSqlColumnDefinition {
  name: string;
  typeName: string;
}

interface MsSqlResultSet {
  columns: MsSqlColumnDefinition[];
  rows: unknown[][];
}

interface MsSqlExecutionResult {
  resultSets: MsSqlResultSet[];
  recordsAffected: number;
}

type MsSqlModule = typeof import("mssql");
type MsSqlRecord = Record<string, unknown>;

/** Controllable streaming request surface used by production and unit tests. */
export interface MsSqlStreamRequest {
  stream: boolean;
  cancel(): void;
  pause(): boolean;
  resume(): boolean;
  query(command: string): Promise<unknown>;
  on(event: "recordset", listener: (columns: Record<string, IColumnMetadata>) => void): this;
  on(event: "row", listener: (row: MsSqlRecord) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "done", listener: (result: { rowsAffected: number[] }) => void): this;
  removeAllListeners(event?: string): this;
}

type StreamQueueItem =
  | { kind: "recordset"; columns: MsSqlColumnDefinition[] }
  | { kind: "row"; values: unknown[] }
  | { kind: "error"; error: Error }
  | { kind: "done"; rowsAffected: number };

const DROP_SESSION_QUERY = /^DROP\s+SESSION\s+(\d+)\s*$/i;
const DEFAULT_STREAM_HIGH_WATER = 256;

const _extensionRequire = createRequire(__filename);
let _mssqlModulePromise: Promise<MsSqlModule> | undefined;

function buildClientConfig(config: DatabaseConnectionConfig): SqlConfig {
  const domain = getStringOption(config, "domain");
  const encryptOpt = getStringOption(config, "encrypt");
  const trustOpt = getStringOption(config, "trustServerCertificate");
  const connectTimeout = getNumberOption(config, "connectTimeout");
  const requestTimeout = getNumberOption(config, "requestTimeout");

  const sqlConfig: SqlConfig = {
    server: config.host,
    port: config.port ?? 1433,
    database: config.database,
    user: config.user,
    password: config.password,
    domain: domain,
    options: {
      encrypt: encryptOpt === "true" || encryptOpt === undefined,
      trustServerCertificate: trustOpt === "true" || trustOpt === undefined,
      connectTimeout: connectTimeout ?? 15000,
      appName: "JustyBase MSSQL",
    },
    requestTimeout: requestTimeout ?? 15000,
  };

  return sqlConfig;
}

function isQueryCancellationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("cancel") || message.includes("abort");
}

function normalizeQueryError(error: unknown, cancelled: boolean): Error {
  if (cancelled || isQueryCancellationError(error)) {
    return new Error("Query cancelled.", {
      cause: error instanceof Error ? error : undefined,
    });
  }

  return error instanceof Error ? error : new Error(String(error));
}

function getTypeName(typeId: unknown): string {
  return String(typeId || "unknown");
}

function columnTypeName(meta: IColumnMetadata): string {
  const type = meta.type;
  if (typeof type === "function") {
    try {
      return getTypeName(type()?.name);
    } catch {
      return "unknown";
    }
  }
  return getTypeName(type?.name);
}

function columnsFromMetadata(
  columns: Record<string, IColumnMetadata>,
): MsSqlColumnDefinition[] {
  return Object.keys(columns).map((name) => ({
    name,
    typeName: columnTypeName(columns[name]),
  }));
}

function rowToValues(
  row: MsSqlRecord,
  columns: readonly MsSqlColumnDefinition[],
): unknown[] {
  return columns.map((column) => row[column.name]);
}

async function loadMsSql(): Promise<MsSqlModule> {
  if (!_mssqlModulePromise) {
    _mssqlModulePromise = Promise.resolve()
      .then(() => _extensionRequire("mssql") as MsSqlModule)
      .catch((error) => {
        _mssqlModulePromise = undefined;
        throw new Error(
          'MSSQL runtime dependency "mssql" is not installed. ' +
            'Run "npm install" inside extensions/mssql before using or packaging this extension.',
          { cause: error },
        );
      });
  }

  return _mssqlModulePromise;
}

/**
 * Bounded async queue with pause/resume backpressure for node-mssql streaming.
 * Exported for unit tests.
 */
export class MsSqlStreamQueue {
  private readonly _items: StreamQueueItem[] = [];
  private _waiters: Array<(item: StreamQueueItem | undefined) => void> = [];
  private _closed = false;
  private _paused = false;

  public constructor(
    private readonly _highWater: number,
    private readonly _onPause: () => void,
    private readonly _onResume: () => void,
  ) {}

  public get length(): number {
    return this._items.length;
  }

  public push(item: StreamQueueItem): void {
    if (this._closed) {
      return;
    }

    const waiter = this._waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    this._items.push(item);
    if (!this._paused && this._items.length >= this._highWater) {
      this._paused = true;
      this._onPause();
    }
  }

  public async take(): Promise<StreamQueueItem | undefined> {
    if (this._items.length > 0) {
      const item = this._items.shift();
      if (this._paused && this._items.length <= this._highWater / 2) {
        this._paused = false;
        this._onResume();
      }
      return item;
    }

    if (this._closed) {
      return undefined;
    }

    return await new Promise<StreamQueueItem | undefined>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  public close(): void {
    if (this._closed) {
      return;
    }

    this._closed = true;
    const waiters = this._waiters.splice(0);
    for (const waiter of waiters) {
      waiter(undefined);
    }
  }
}

class MsSqlBufferedDataReader implements DatabaseDataReader {
  private _resultSetIndex = 0;
  private _rowIndex = -1;

  public constructor(private readonly _resultSets: readonly MsSqlResultSet[]) {}

  public get fieldCount(): number {
    return this._resultSets[this._resultSetIndex]?.columns.length ?? 0;
  }

  public async read(): Promise<boolean> {
    const currentRows = this._resultSets[this._resultSetIndex]?.rows ?? [];
    const nextIndex = this._rowIndex + 1;
    if (nextIndex >= currentRows.length) {
      return false;
    }

    this._rowIndex = nextIndex;
    return true;
  }

  public async nextResult(): Promise<boolean> {
    const nextResultIndex = this._resultSetIndex + 1;
    if (nextResultIndex >= this._resultSets.length) {
      return false;
    }

    this._resultSetIndex = nextResultIndex;
    this._rowIndex = -1;
    return true;
  }

  public async close(): Promise<void> {
    return undefined;
  }

  public getName(index: number): string {
    return this._resultSets[this._resultSetIndex]?.columns[index]?.name ?? "";
  }

  public getTypeName(index: number): string {
    return (
      this._resultSets[this._resultSetIndex]?.columns[index]?.typeName ?? ""
    );
  }

  public getValue(index: number): unknown {
    if (this._rowIndex < 0) {
      return undefined;
    }

    return this._resultSets[this._resultSetIndex]?.rows[this._rowIndex]?.[
      index
    ];
  }
}

/**
 * Streaming reader over node-mssql request events. Exported for unit tests.
 */
export class MsSqlStreamingDataReader implements DatabaseDataReader {
  private _columns: MsSqlColumnDefinition[] = [];
  private _currentRow: unknown[] | undefined;
  private _closed = false;
  private _aborted = false;
  private _done = false;
  private _pendingResultSets: MsSqlColumnDefinition[][] = [];
  private _rowsAffected = -1;

  public constructor(
    private readonly _queue: MsSqlStreamQueue,
    private readonly _isCommandCancelled: () => boolean,
    private readonly _onClose: () => void,
    private readonly _request: MsSqlStreamRequest | undefined,
    initialColumns?: readonly MsSqlColumnDefinition[],
  ) {
    if (initialColumns) {
      this._columns = [...initialColumns];
    }
  }

  public get fieldCount(): number {
    return this._columns.length;
  }

  public get rowsAffected(): number {
    return this._rowsAffected;
  }

  public async read(): Promise<boolean> {
    if (this._closed || this._aborted || this._isCommandCancelled()) {
      this._currentRow = undefined;
      await this.close();
      return false;
    }

    while (true) {
      const item = await this._queue.take();
      if (
        this._closed ||
        this._aborted ||
        this._isCommandCancelled() ||
        item === undefined
      ) {
        this._currentRow = undefined;
        await this.close();
        return false;
      }

      if (item.kind === "error") {
        this._currentRow = undefined;
        await this.close();
        if (this._aborted || this._isCommandCancelled()) {
          return false;
        }
        throw normalizeQueryError(item.error, false);
      }

      if (item.kind === "done") {
        this._rowsAffected = item.rowsAffected;
        this._done = true;
        this._currentRow = undefined;
        await this.close();
        return false;
      }

      if (item.kind === "recordset") {
        // Extra result sets are consumed via nextResult(); stash and stop current set.
        this._pendingResultSets.push(item.columns);
        this._currentRow = undefined;
        return false;
      }

      this._currentRow = item.values;
      return true;
    }
  }

  public async nextResult(): Promise<boolean> {
    if (this._closed || this._aborted || this._isCommandCancelled()) {
      return false;
    }

    if (this._pendingResultSets.length > 0) {
      this._columns = this._pendingResultSets.shift()!;
      this._currentRow = undefined;
      return true;
    }

    // Drain remaining rows of the current set until the next recordset or done.
    while (true) {
      const item = await this._queue.take();
      if (
        this._closed ||
        this._aborted ||
        this._isCommandCancelled() ||
        item === undefined
      ) {
        await this.close();
        return false;
      }

      if (item.kind === "error") {
        await this.close();
        if (this._aborted || this._isCommandCancelled()) {
          return false;
        }
        throw normalizeQueryError(item.error, false);
      }

      if (item.kind === "done") {
        this._rowsAffected = item.rowsAffected;
        this._done = true;
        await this.close();
        return false;
      }

      if (item.kind === "recordset") {
        this._columns = item.columns;
        this._currentRow = undefined;
        return true;
      }

      // Skip leftover rows from the previous result set.
    }
  }

  public async close(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._queue.close();
    if (this._request) {
      try {
        this._request.cancel();
      } catch {
        /* ignore */
      }
    }
    this._onClose();
  }

  public async abort(): Promise<void> {
    this._aborted = true;
    this._currentRow = undefined;
    await this.close();
  }

  public getName(index: number): string {
    return this._columns[index]?.name ?? "";
  }

  public getTypeName(index: number): string {
    return this._columns[index]?.typeName ?? "";
  }

  public getValue(index: number): unknown {
    return this._currentRow?.[index];
  }

  public get isDone(): boolean {
    return this._done;
  }
}

export class MsSqlConnection
  extends EventEmitter
  implements DatabaseConnection
{
  public _connected = false;
  private _pool?: ConnectionPool;
  private _backendPid?: number;
  private _currentSchema?: string;
  private _activeCommand?: MsSqlCommand;
  private readonly _clientConfig: SqlConfig;
  /** Optional factory for unit tests (inject mock stream requests). */
  public createStreamRequest?: () => MsSqlStreamRequest;

  public constructor(public readonly config: DatabaseConnectionConfig) {
    super();
    this._clientConfig = buildClientConfig(config);
  }

  public async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const mssql = await loadMsSql();

    try {
      this._pool = new mssql.ConnectionPool(this._clientConfig);
      this._pool.on("error", (err: unknown) => {
        this.emit("error", err);
      });
      await this._pool.connect();
      this._connected = true;
      this._currentSchema = await this.readCurrentSchema();
      this._backendPid = await this.readBackendPid();
    } catch (error) {
      if (this._pool) {
        try {
          await this._pool.close();
        } catch {
          /* ignore */
        }
      }
      this._pool = undefined;
      this._connected = false;
      this._backendPid = undefined;
      this._currentSchema = undefined;
      throw new Error(
        `Failed to connect to MS SQL Server: ${getErrorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  public async close(): Promise<void> {
    const pool = this._pool;
    this._pool = undefined;
    this._backendPid = undefined;
    this._currentSchema = undefined;
    this._activeCommand = undefined;
    this._connected = false;

    if (!pool) {
      return;
    }

    try {
      await pool.close();
    } catch {
      // Ignore close errors
    }
  }

  public createCommand(sql: string): DatabaseCommand {
    return new MsSqlCommand(this, sql);
  }

  public getPool(): ConnectionPool {
    if (!this._pool) {
      throw new Error("MSSQL connection is not open.");
    }

    return this._pool;
  }

  public createNativeStreamRequest(): MsSqlStreamRequest {
    if (this.createStreamRequest) {
      return this.createStreamRequest();
    }

    return this.getPool().request() as unknown as MsSqlStreamRequest;
  }

  public getCurrentDatabaseName(): string {
    return this.config.database;
  }

  public getCurrentSchemaName(): string {
    return this._currentSchema || "dbo";
  }

  public async ensureBackendPid(): Promise<number | undefined> {
    if (this._backendPid !== undefined) {
      return this._backendPid;
    }

    this._backendPid = await this.readBackendPid();
    return this._backendPid;
  }

  public beginCommand(command: MsSqlCommand): void {
    if (this._activeCommand && this._activeCommand !== command) {
      throw new Error("Connection is already executing a command");
    }

    this._activeCommand = command;
  }

  public endCommand(command: MsSqlCommand): void {
    if (this._activeCommand === command) {
      this._activeCommand = undefined;
    }
  }

  public async terminateBackend(processId: number): Promise<boolean> {
    const mssql = await loadMsSql();
    const adminPool = new mssql.ConnectionPool(this._clientConfig);
    await adminPool.connect();
    try {
      await adminPool.request().query(`KILL ${processId}`);
      return true;
    } catch {
      return false;
    } finally {
      try {
        await adminPool.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async readBackendPid(): Promise<number | undefined> {
    try {
      const result = await this.getPool()
        .request()
        .query<{ CURRENT_SID: number }>("SELECT @@SPID AS CURRENT_SID");
      if (result.recordset && result.recordset.length > 0) {
        return result.recordset[0].CURRENT_SID;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private async readCurrentSchema(): Promise<string | undefined> {
    try {
      const result = await this.getPool()
        .request()
        .query<{ CURRENT_SCHEMA: string }>(
          "SELECT SCHEMA_NAME() AS CURRENT_SCHEMA",
        );
      if (result.recordset && result.recordset.length > 0) {
        return result.recordset[0].CURRENT_SCHEMA;
      }
    } catch {
      /* ignore */
    }
    return "dbo";
  }
}

class MsSqlCommand implements DatabaseCommand {
  public commandTimeout = 0;
  public _recordsAffected = -1;
  private _cancelled = false;
  private _request?: MsSqlStreamRequest;
  private _activeReader?: MsSqlStreamingDataReader;
  private _timeoutHandle?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly _connection: MsSqlConnection,
    private readonly _sql: string,
  ) {}

  public async executeReader(): Promise<DatabaseDataReader> {
    if (this._cancelled) {
      throw new Error("Query cancelled.");
    }

    const trimmedSql = stripTrailingSemicolons(this._sql);
    if (!trimmedSql) {
      this._recordsAffected = 0;
      return new MsSqlBufferedDataReader([{ columns: [], rows: [] }]);
    }

    this._connection.beginCommand(this);
    try {
      const compatibilityResult =
        await this.tryExecuteCompatibilityCommand(trimmedSql);
      if (compatibilityResult) {
        this._recordsAffected = compatibilityResult.recordsAffected;
        this._connection.endCommand(this);
        return new MsSqlBufferedDataReader(compatibilityResult.resultSets);
      }

      return await this.executeStreamingReader(trimmedSql);
    } catch (error) {
      this._connection.endCommand(this);
      throw normalizeQueryError(error, this._cancelled);
    }
  }

  public async cancel(): Promise<void> {
    this._cancelled = true;
    if (this._request) {
      try {
        this._request.cancel();
      } catch {
        /* ignore */
      }
    }
    await this._activeReader?.abort();
  }

  public async execute(): Promise<void> {
    const reader = await this.executeReader();
    try {
      while (await reader.read()) {
        // Drain rows for non-query side effects / DML.
      }
      while (await reader.nextResult()) {
        while (await reader.read()) {
          // Drain additional result sets.
        }
      }
    } finally {
      await reader.close();
    }
  }

  private async executeStreamingReader(
    trimmedSql: string,
  ): Promise<DatabaseDataReader> {
    await loadMsSql();
    const request = this._connection.createNativeStreamRequest();
    this._request = request;
    request.stream = true;

    const queue = new MsSqlStreamQueue(
      DEFAULT_STREAM_HIGH_WATER,
      () => {
        try {
          request.pause();
        } catch {
          /* ignore */
        }
      },
      () => {
        try {
          request.resume();
        } catch {
          /* ignore */
        }
      },
    );

    let currentColumns: MsSqlColumnDefinition[] = [];
    let settledOpen = false;
    let openError: Error | undefined;
    let resolveOpen: ((columns: MsSqlColumnDefinition[] | null) => void) | undefined;
    let rejectOpen: ((error: Error) => void) | undefined;

    const openPromise = new Promise<MsSqlColumnDefinition[] | null>(
      (resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      },
    );

    const finishOpen = (
      columns: MsSqlColumnDefinition[] | null,
      error?: Error,
    ): void => {
      if (settledOpen) {
        return;
      }
      settledOpen = true;
      if (error) {
        openError = error;
        rejectOpen?.(error);
        return;
      }
      resolveOpen?.(columns);
    };

    const cleanupRequest = (): void => {
      if (this._timeoutHandle) {
        clearTimeout(this._timeoutHandle);
        this._timeoutHandle = undefined;
      }
      try {
        request.removeAllListeners();
      } catch {
        /* ignore */
      }
      this._request = undefined;
      this._activeReader = undefined;
      this._connection.endCommand(this);
    };

    request.on("recordset", (columnsMeta) => {
      const columns = columnsFromMetadata(columnsMeta);
      currentColumns = columns;
      // First recordset opens the reader; later sets go through the queue for nextResult().
      if (!settledOpen) {
        finishOpen(columns);
      } else {
        queue.push({ kind: "recordset", columns });
      }
    });

    request.on("row", (row) => {
      if (this._cancelled) {
        return;
      }
      queue.push({
        kind: "row",
        values: rowToValues(row, currentColumns),
      });
    });

    request.on("error", (error) => {
      const normalized = normalizeQueryError(error, this._cancelled);
      queue.push({ kind: "error", error: normalized });
      finishOpen(null, normalized);
      queue.close();
    });

    request.on("done", (result) => {
      const rowsAffected = Array.isArray(result?.rowsAffected)
        ? result.rowsAffected.reduce((a, b) => a + b, 0)
        : -1;
      this._recordsAffected = rowsAffected;
      queue.push({ kind: "done", rowsAffected });
      finishOpen(currentColumns.length > 0 ? currentColumns : null);
      queue.close();
    });

    if (this.commandTimeout > 0) {
      this._timeoutHandle = setTimeout(
        () => {
          void this.cancel();
        },
        Math.round(this.commandTimeout * 1000),
      );
    }

    // Fire query without awaiting full completion — rows stream via events.
    void request.query(trimmedSql).catch((error: unknown) => {
      const normalized = normalizeQueryError(error, this._cancelled);
      queue.push({ kind: "error", error: normalized });
      finishOpen(null, normalized);
      queue.close();
    });

    if (this._cancelled) {
      try {
        request.cancel();
      } catch {
        /* ignore */
      }
      queue.close();
      cleanupRequest();
      throw new Error("Query cancelled.");
    }

    let initialColumns: MsSqlColumnDefinition[] | null;
    try {
      initialColumns = await openPromise;
    } catch (error) {
      cleanupRequest();
      throw normalizeQueryError(error, this._cancelled);
    }

    if (this._cancelled || openError) {
      cleanupRequest();
      throw new Error("Query cancelled.");
    }

    // DML / empty result: still return a reader (possibly empty).
    const reader = new MsSqlStreamingDataReader(
      queue,
      () => this._cancelled,
      cleanupRequest,
      request,
      initialColumns ?? [],
    );
    this._activeReader = reader;
    return reader;
  }

  private async tryExecuteCompatibilityCommand(
    trimmedSql: string,
  ): Promise<MsSqlExecutionResult | undefined> {
    if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(trimmedSql)) {
      return {
        resultSets: [
          {
            columns: [
              { name: "CURRENT_CATALOG", typeName: "NVARCHAR" },
              { name: "CURRENT_SCHEMA", typeName: "NVARCHAR" },
            ],
            rows: [
              [
                this._connection.getCurrentDatabaseName(),
                this._connection.getCurrentSchemaName(),
              ],
            ],
          },
        ],
        recordsAffected: -1,
      };
    }

    if (CURRENT_CATALOG_QUERY.test(trimmedSql)) {
      return {
        resultSets: [
          {
            columns: [{ name: "CURRENT_CATALOG", typeName: "NVARCHAR" }],
            rows: [[this._connection.getCurrentDatabaseName()]],
          },
        ],
        recordsAffected: -1,
      };
    }

    if (CURRENT_SCHEMA_QUERY.test(trimmedSql)) {
      return {
        resultSets: [
          {
            columns: [{ name: "CURRENT_SCHEMA", typeName: "NVARCHAR" }],
            rows: [[this._connection.getCurrentSchemaName()]],
          },
        ],
        recordsAffected: -1,
      };
    }

    if (CURRENT_SID_QUERY.test(trimmedSql)) {
      const backendPid = await this._connection.ensureBackendPid();
      return {
        resultSets: [
          {
            columns: [{ name: "CURRENT_SID", typeName: "INTEGER" }],
            rows: [[backendPid ?? null]],
          },
        ],
        recordsAffected: -1,
      };
    }

    const dropSessionMatch = trimmedSql.match(DROP_SESSION_QUERY);
    if (dropSessionMatch) {
      const processId = Number(dropSessionMatch[1]);
      const terminated = await this._connection.terminateBackend(processId);
      if (!terminated) {
        throw new Error(
          `Failed to terminate MS SQL Server session ${processId}.`,
        );
      }

      return {
        resultSets: [
          {
            columns: [{ name: "TERMINATED", typeName: "BIT" }],
            rows: [[true]],
          },
        ],
        recordsAffected: 0,
      };
    }

    const setCatalogMatch = trimmedSql.match(SET_CATALOG_QUERY);
    if (setCatalogMatch) {
      const requestedDatabase = normalizeCatalogIdentifier(setCatalogMatch[1]);
      await this._connection
        .getPool()
        .request()
        .query(`USE [${requestedDatabase}]`);
      return {
        resultSets: [
          {
            columns: [],
            rows: [],
          },
        ],
        recordsAffected: 0,
      };
    }

    return undefined;
  }
}
