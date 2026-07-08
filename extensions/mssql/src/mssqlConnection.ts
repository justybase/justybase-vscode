import { EventEmitter } from "events";
import { createRequire } from "node:module";
import type { ConnectionPool, IRecordSet, Request, config as SqlConfig } from "mssql";
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

const DROP_SESSION_QUERY = /^DROP\s+SESSION\s+(\d+)\s*$/i;

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

class MsSqlDataReader implements DatabaseDataReader {
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
        .query<{ CURRENT_SCHEMA: string }>("SELECT SCHEMA_NAME() AS CURRENT_SCHEMA");
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
  private _request?: Request;

  public constructor(
    private readonly _connection: MsSqlConnection,
    private readonly _sql: string,
  ) {}

  public async executeReader(): Promise<DatabaseDataReader> {
    const result = await this.executeInternal();
    this._recordsAffected = result.recordsAffected;
    return new MsSqlDataReader(result.resultSets);
  }

  public async cancel(): Promise<void> {
    this._cancelled = true;
    if (this._request) {
      this._request.cancel();
    }
  }

  public async execute(): Promise<void> {
    const reader = await this.executeReader();
    await reader.close();
  }

  private async executeInternal(): Promise<MsSqlExecutionResult> {
    const trimmedSql = stripTrailingSemicolons(this._sql);
    if (!trimmedSql) {
      return {
        resultSets: [{ columns: [], rows: [] }],
        recordsAffected: 0,
      };
    }

    if (this._cancelled) {
      throw new Error("Query cancelled.");
    }

    this._connection.beginCommand(this);
    try {
      return await this.runWithTimeout(async () => {
        const compatibilityResult =
          await this.tryExecuteCompatibilityCommand(trimmedSql);
        if (compatibilityResult) {
          return compatibilityResult;
        }

        await loadMsSql();
        this._request = this._connection.getPool().request();

        const rawResult = await this._request.query<MsSqlRecord>(trimmedSql);

        const resultSets: MsSqlResultSet[] = [];
        const recordsetsArray: IRecordSet<MsSqlRecord>[] = Array.isArray(rawResult.recordsets)
          ? rawResult.recordsets
          : rawResult.recordsets
            ? Object.values(rawResult.recordsets) as IRecordSet<MsSqlRecord>[]
            : [];

        for (const rs of recordsetsArray) {
          const cols = Object.keys(rs[0] || {}).map((k) => ({
            name: k,
            typeName: "Unknown",
          }));

          const columnsDefinition: MsSqlColumnDefinition[] = [];
          const castedRs = rs as {
            columns?: Record<string, { type?: { name?: string } }>;
          };
          if (castedRs.columns) {
            for (const key of Object.keys(castedRs.columns)) {
              columnsDefinition.push({
                name: key,
                typeName: getTypeName(castedRs.columns[key].type?.name),
              });
            }
          } else {
            columnsDefinition.push(...cols);
          }

          const rows = rs.map((row) => {
            return columnsDefinition.map((col) => row[col.name]);
          });

          resultSets.push({
            columns: columnsDefinition,
            rows,
          });
        }

        if (resultSets.length === 0 && rawResult.recordset) {
          const rs = rawResult.recordset;
          const columnsDefinition: MsSqlColumnDefinition[] = [];
          const castedRs = rs as {
            columns?: Record<string, { type?: { name?: string } }>;
          };
          if (castedRs.columns) {
            for (const key of Object.keys(castedRs.columns)) {
              columnsDefinition.push({
                name: key,
                typeName: getTypeName(castedRs.columns[key].type?.name),
              });
            }
          } else {
            const cols = Object.keys(rs[0] || {}).map((k) => ({
              name: k,
              typeName: "Unknown",
            }));
            columnsDefinition.push(...cols);
          }

          const rows = rs.map((row) => {
            return columnsDefinition.map((col) => row[col.name]);
          });

          resultSets.push({
            columns: columnsDefinition,
            rows,
          });
        }

        const recordsAffected = rawResult.rowsAffected
          ? rawResult.rowsAffected.reduce((a: number, b: number) => a + b, 0)
          : -1;

        return {
          resultSets,
          recordsAffected,
        };
      });
    } catch (error) {
      throw normalizeQueryError(error, this._cancelled);
    } finally {
      this._request = undefined;
      this._connection.endCommand(this);
    }
  }

  private async runWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    if (!(this.commandTimeout > 0)) {
      return operation();
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutHandle = setTimeout(
        () => {
          void this.cancel();
          if (!settled) {
            settled = true;
            reject(new Error(`Query timed out after ${this.commandTimeout}s`));
          }
        },
        Math.round(this.commandTimeout * 1000),
      );

      operation()
        .then((result) => {
          clearTimeout(timeoutHandle);
          if (!settled) {
            settled = true;
            resolve(result);
          }
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
    });
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
