import { EventEmitter } from "events";
import { createRequire } from "node:module";
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
  getOptionNumber,
  stripTrailingSemicolons,
} from "../../../src/core/connectionUtils";

interface MysqlQueryResultSetHeader {
  affectedRows?: number;
}

export interface MysqlFieldPacket {
  name: string;
  columnType?: number;
  decimals?: number;
  typeName?: string;
}

interface MysqlQueryOptions {
  sql: string;
  rowsAsArray?: boolean;
}

type MysqlQueryCallback = (
  error: unknown,
  rows: unknown,
  fields?: MysqlFieldPacket[],
) => void;

interface MysqlReadableStream {
  read(): unknown | null;
  on(event: "readable" | "end" | "close", listener: () => void): this;
  on(event: "fields", listener: (fields: MysqlFieldPacket[]) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  destroy(): void;
}

interface MysqlQuery {
  stream(options?: { highWaterMark?: number }): MysqlReadableStream;
}

interface MysqlRuntimeConnection {
  query(sql: string, callback: MysqlQueryCallback): MysqlQuery;
  query(options: MysqlQueryOptions): MysqlQuery;
  connect(callback: (error?: unknown) => void): void;
  end(callback: (error?: unknown) => void): void;
  destroy(): void;
  on(
    event: "error" | "end" | "close",
    listener: (arg?: unknown) => void,
  ): void;
}

interface MysqlModule {
  createConnection(config: {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    connectTimeout?: number;
    multipleStatements?: boolean;
  }): MysqlRuntimeConnection;
}

interface MysqlExecutionResult {
  rows: Record<string, unknown>[];
  fields: MysqlFieldPacket[];
}

const MYSQL_STREAM_HIGH_WATER_MARK = 32;
const _extensionRequire = createRequire(__filename);
let _mysqlModulePromise: Promise<MysqlModule> | undefined;

/** MySQL protocol type numbers used by mysql2 FieldPacket.columnType. */
export function mysqlColumnTypeName(columnType: number | undefined): string {
  switch (columnType) {
    case 0:
      return "DECIMAL";
    case 1:
      return "TINYINT";
    case 2:
      return "SMALLINT";
    case 3:
      return "INT";
    case 4:
      return "FLOAT";
    case 5:
      return "DOUBLE";
    case 6:
      return "NULL";
    case 7:
      return "TIMESTAMP";
    case 8:
      return "BIGINT";
    case 9:
      return "MEDIUMINT";
    case 10:
      return "DATE";
    case 11:
      return "TIME";
    case 12:
      return "DATETIME";
    case 13:
      return "YEAR";
    case 14:
      return "DATE";
    case 15:
      return "VARCHAR";
    case 16:
      return "BIT";
    case 245:
      return "JSON";
    case 246:
      return "DECIMAL";
    case 247:
      return "ENUM";
    case 248:
      return "SET";
    case 249:
    case 250:
    case 251:
    case 252:
      return "BLOB";
    case 253:
      return "VARCHAR";
    case 254:
      return "CHAR";
    case 255:
      return "GEOMETRY";
    default:
      return "TEXT";
  }
}

function inferTypeName(value: unknown): string {
  if (value == null) {
    return "TEXT";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "BIGINT" : "DOUBLE";
  }
  if (typeof value === "boolean") {
    return "TINYINT";
  }
  if (value instanceof Date) {
    return "DATETIME";
  }
  if (Buffer.isBuffer(value)) {
    return "BLOB";
  }
  return "TEXT";
}

function getColumnTypeName(
  field: MysqlFieldPacket,
  value: unknown,
): string {
  if (field.typeName) {
    return field.typeName;
  }
  return field.columnType === undefined
    ? inferTypeName(value)
    : mysqlColumnTypeName(field.columnType);
}

function normalizeQueryError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeRows(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) =>
    row && typeof row === "object"
      ? { ...(row as Record<string, unknown>) }
      : { VALUE: row },
  );
}

function queryRows(
  connection: MysqlRuntimeConnection,
  sql: string,
): Promise<MysqlExecutionResult> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error, rows, fields) => {
      if (error) {
        reject(normalizeQueryError(error));
        return;
      }
      resolve({
        rows: normalizeRows(rows),
        fields: fields ?? [],
      });
    });
  });
}

function createBufferedReader(
  rows: Record<string, unknown>[],
  fields: MysqlFieldPacket[],
): DatabaseDataReader {
  const columns = fields.length > 0
    ? fields.map((field, index) => ({
        name: field.name || `COLUMN_${index + 1}`,
        typeName: getColumnTypeName(
          field,
          rows.find((row) => row[field.name] != null)?.[field.name],
        ),
      }))
    : Object.keys(rows[0] ?? {}).map((name) => ({
        name,
        typeName: inferTypeName(rows.find((row) => row[name] != null)?.[name]),
      }));

  let rowIndex = -1;
  return {
    fieldCount: columns.length,
    async read(): Promise<boolean> {
      const nextIndex = rowIndex + 1;
      if (nextIndex >= rows.length) {
        return false;
      }
      rowIndex = nextIndex;
      return true;
    },
    async nextResult(): Promise<boolean> {
      return false;
    },
    async close(): Promise<void> {
      return undefined;
    },
    getName(index: number): string {
      return columns[index]?.name ?? "";
    },
    getTypeName(index: number): string {
      return columns[index]?.typeName ?? "TEXT";
    },
    getValue(index: number): unknown {
      if (rowIndex < 0) {
        return undefined;
      }
      return rows[rowIndex]?.[columns[index]?.name];
    },
  };
}

/**
 * Bounded async reader over mysql2's native Readable query stream.
 * The stream itself pauses the mysql2 connection when its highWaterMark is
 * reached, so rows are never accumulated in an unbounded application queue.
 */
export class MysqlStreamingDataReader implements DatabaseDataReader {
  private columns: MysqlFieldPacket[];
  private currentRow: unknown[] | undefined;
  private closed = false;
  private ended = false;
  private streamError: Error | undefined;
  private closeNotified = false;
  private readonly waiters: Array<() => void> = [];

  public constructor(
    private readonly stream: MysqlReadableStream,
    columns: MysqlFieldPacket[] = [],
    private readonly onClose: () => void = () => undefined,
  ) {
    this.columns = columns;
    stream.on("readable", () => this.wake());
    stream.on("end", () => {
      this.ended = true;
      this.wake();
      this.notifyClose();
    });
    stream.on("close", () => {
      this.ended = true;
      this.wake();
      this.notifyClose();
    });
    stream.on("error", (error) => {
      this.streamError = normalizeQueryError(error);
      this.ended = true;
      this.wake();
      this.notifyClose();
    });
  }

  public setColumns(columns: MysqlFieldPacket[]): void {
    this.columns = columns;
  }

  public get fieldCount(): number {
    return this.columns.length;
  }

  public async read(): Promise<boolean> {
    if (this.closed) {
      return false;
    }

    while (!this.closed) {
      if (this.streamError) {
        throw this.streamError;
      }

      const row = this.stream.read();
      if (row !== null) {
        this.currentRow = Array.isArray(row)
          ? row
          : this.columns.map((field) =>
              (row as Record<string, unknown>)[field.name],
            );
        return true;
      }

      if (this.ended) {
        this.currentRow = undefined;
        return false;
      }

      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    this.currentRow = undefined;
    return false;
  }

  public async nextResult(): Promise<boolean> {
    return false;
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.currentRow = undefined;
    this.stream.destroy();
    this.wake();
    this.notifyClose();
  }

  public getName(index: number): string {
    return this.columns[index]?.name ?? "";
  }

  public getTypeName(index: number): string {
    const field = this.columns[index];
    return field ? getColumnTypeName(field, undefined) : "TEXT";
  }

  public getValue(index: number): unknown {
    return this.currentRow?.[index];
  }

  private wake(): void {
    const pending = this.waiters.splice(0);
    for (const resolve of pending) {
      resolve();
    }
  }

  private notifyClose(): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.onClose();
  }
}

async function loadMysql(): Promise<MysqlModule> {
  if (!_mysqlModulePromise) {
    _mysqlModulePromise = Promise.resolve()
      .then(() => _extensionRequire("mysql2") as MysqlModule)
      .catch((error: unknown) => {
        _mysqlModulePromise = undefined;
        throw new Error(
          'MySQL runtime dependency "mysql2" is not installed. Run "npm install" inside extensions/mysql before using or packaging this extension.',
          { cause: error },
        );
      });
  }
  return _mysqlModulePromise;
}

function connectMysql(
  connection: MysqlRuntimeConnection,
): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.connect((error) => {
      if (error) {
        reject(normalizeQueryError(error));
        return;
      }
      resolve();
    });
  });
}

function endMysql(connection: MysqlRuntimeConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.end((error) => {
      if (error) {
        reject(normalizeQueryError(error));
        return;
      }
      resolve();
    });
  });
}

export class MysqlConnection extends EventEmitter implements DatabaseConnection {
  public _connected = false;
  private connection?: MysqlRuntimeConnection;
  private activeQuery?: MysqlQuery;
  private activeStream?: MysqlReadableStream;
  private currentDatabase = "";
  private currentSid = 0;

  public constructor(public readonly config: DatabaseConnectionConfig) {
    super();
  }

  public async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const mysql = await loadMysql();
    const connectTimeout = getOptionNumber(this.config, "connectTimeout");
    const database = this.config.database?.trim() || "";
    const connection = mysql.createConnection({
      host: this.config.host,
      port: this.config.port ?? 3306,
      database,
      user: this.config.user,
      password: this.config.password,
      ...(connectTimeout !== undefined ? { connectTimeout } : {}),
      multipleStatements: false,
    });

    connection.on("error", (error) => this.emit("error", error));
    connection.on("end", () => this.emit("end"));
    connection.on("close", () => this.emit("close"));

    await connectMysql(connection);
    this.connection = connection;
    this._connected = true;

    const current = await queryRows(
      connection,
      "SELECT DATABASE() AS CURRENT_CATALOG, DATABASE() AS CURRENT_SCHEMA, CONNECTION_ID() AS CURRENT_SID",
    );
    this.currentDatabase = typeof current.rows[0]?.CURRENT_CATALOG === "string" &&
        current.rows[0].CURRENT_CATALOG.trim().length > 0
      ? String(current.rows[0].CURRENT_CATALOG)
      : database;
    this.currentSid = Number(current.rows[0]?.CURRENT_SID ?? 0) || 0;
  }

  public async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.activeQuery = undefined;
    this.activeStream?.destroy();
    this.activeStream = undefined;
    this._connected = false;
    this.currentDatabase = "";
    this.currentSid = 0;

    if (!connection) {
      return;
    }

    try {
      await endMysql(connection);
    } catch {
      connection.destroy();
    }
  }

  public createCommand(sql: string): DatabaseCommand {
    return new MysqlCommand(this, sql);
  }

  public getCurrentDatabase(): string {
    return this.currentDatabase || this.config.database;
  }

  public getCurrentSid(): number {
    return this.currentSid;
  }

  public async executeSql(sql: string): Promise<MysqlExecutionResult> {
    return queryRows(this.requireConnection(), sql);
  }

  public async executeStatement(sql: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.requireConnection().query(sql, (error, result) => {
        if (error) {
          reject(normalizeQueryError(error));
          return;
        }
        const header = result as MysqlQueryResultSetHeader | undefined;
        resolve(header?.affectedRows ?? 0);
      });
    });
  }

  public async setCurrentDatabase(database: string): Promise<void> {
    const normalizedDatabase = normalizeMysqlIdentifier(database);
    if (!normalizedDatabase) {
      throw new Error("MySQL database name cannot be empty.");
    }
    await this.executeStatement(`USE ${quoteMysqlIdentifier(normalizedDatabase)}`);
    this.currentDatabase = normalizedDatabase;
  }

  public registerActiveQuery(query: MysqlQuery): void {
    this.activeQuery = query;
  }

  public clearActiveQuery(query: MysqlQuery): void {
    if (this.activeQuery === query) {
      this.activeQuery = undefined;
    }
  }

  public registerActiveStream(stream: MysqlReadableStream): void {
    this.activeStream = stream;
  }

  public clearActiveStream(stream: MysqlReadableStream): void {
    if (this.activeStream === stream) {
      this.activeStream = undefined;
    }
  }

  public async cancelActiveCommand(): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      return;
    }

    this.activeQuery = undefined;
    this.activeStream?.destroy();
    this.activeStream = undefined;
    this.emit("close");
    connection.destroy();
    this.connection = undefined;
    this._connected = false;
  }

  private requireConnection(): MysqlRuntimeConnection {
    if (!this.connection) {
      throw new Error("MySQL connection is not open.");
    }
    return this.connection;
  }

  public createStreamingQuery(sql: string): MysqlQuery {
    const query = this.requireConnection().query({
      sql,
      rowsAsArray: true,
    });
    this.registerActiveQuery(query);
    return query;
  }
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function normalizeMysqlIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/``/g, "`")
      .replace(/""/g, '"')
      .replace(/''/g, "'");
  }
  return trimmed;
}

function isCompatibilityQuery(sql: string, pattern: RegExp): boolean {
  return pattern.test(stripTrailingSemicolons(sql));
}

class MysqlCommand implements DatabaseCommand {
  public commandTimeout = 0;
  public _recordsAffected = 0;
  private cancelled = false;
  private reader?: MysqlStreamingDataReader;
  private timeoutHandle?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly connection: MysqlConnection,
    private readonly sqlText: string,
  ) {}

  public async executeReader(): Promise<DatabaseDataReader> {
    if (this.cancelled) {
      throw new Error("Query cancelled.");
    }

    const sql = stripTrailingSemicolons(this.sqlText);
    const compatibilityReader = this.tryCompatibilityReader(sql);
    if (compatibilityReader) {
      return compatibilityReader;
    }

    const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
    if (setCatalogMatch) {
      await this.connection.setCurrentDatabase(setCatalogMatch[1]);
      return createBufferedReader([], []);
    }

    const query = this.connection.createStreamingQuery(sql);
    const stream = query.stream({ highWaterMark: MYSQL_STREAM_HIGH_WATER_MARK });
    this.connection.registerActiveStream(stream);
    const reader = new MysqlStreamingDataReader(stream, [], () => {
      this.connection.clearActiveQuery(query);
      this.connection.clearActiveStream(stream);
    });
    this.reader = reader;

    const opened = new Promise<void>((resolve, reject) => {
      let settled = false;
      stream.on("fields", (fields) => {
        reader.setColumns(fields ?? []);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      stream.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      stream.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(normalizeQueryError(error));
        }
      });
      stream.on("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Query cancelled."));
        }
      });
    });

    if (this.commandTimeout > 0) {
      this.timeoutHandle = setTimeout(() => {
        void this.cancel();
      }, Math.round(this.commandTimeout * 1000));
    }

    try {
      await opened;
      if (this.cancelled) {
        await reader.close();
        throw new Error("Query cancelled.");
      }
      return reader;
    } catch (error) {
      await reader.close();
      throw normalizeQueryError(error);
    } finally {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }
    }
  }

  public async execute(): Promise<void> {
    const reader = await this.executeReader();
    try {
      while (await reader.read()) {
        // Drain the first result set for statement execution.
      }
      while (await reader.nextResult()) {
        while (await reader.read()) {
          // The MySQL connection uses multipleStatements=false, so this is a
          // defensive compatibility loop for alternative drivers/mocks.
        }
      }
    } finally {
      await reader.close();
    }
  }

  public async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    await this.reader?.close();
    await this.connection.cancelActiveCommand();
  }

  private tryCompatibilityReader(sql: string): DatabaseDataReader | undefined {
    if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)) {
      const database = this.connection.getCurrentDatabase();
      return createBufferedReader(
        [{ CURRENT_CATALOG: database, CURRENT_SCHEMA: database }],
        [
          { name: "CURRENT_CATALOG", typeName: "VARCHAR" },
          { name: "CURRENT_SCHEMA", typeName: "VARCHAR" },
        ],
      );
    }
    if (isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)) {
      return createBufferedReader(
        [{ CURRENT_CATALOG: this.connection.getCurrentDatabase() }],
        [{ name: "CURRENT_CATALOG", typeName: "VARCHAR" }],
      );
    }
    if (isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)) {
      return createBufferedReader(
        [{ CURRENT_SCHEMA: this.connection.getCurrentDatabase() }],
        [{ name: "CURRENT_SCHEMA", typeName: "VARCHAR" }],
      );
    }
    if (isCompatibilityQuery(sql, CURRENT_SID_QUERY)) {
      return createBufferedReader(
        [{ CURRENT_SID: this.connection.getCurrentSid() }],
        [{ name: "CURRENT_SID", typeName: "BIGINT" }],
      );
    }

    return undefined;
  }
}
