import type {
  DatabaseDdlKeyInfo,
  DatabaseTableDdlMetadata,
  DatabaseQueryCallbacks,
  DatabaseQueryCommand,
  DatabaseQueryOptions,
  DatabaseQueryResult,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
  QueryColumn,
} from '@justybase/contracts';
import { createHash } from 'node:crypto';
import {
  createConnectedNetezzaConnection,
  getNetezzaConnectionConstructor,
  type NetezzaDriverCommand,
  type NetezzaDriverConfig,
  type NetezzaDriverConnection,
  type NetezzaDriverReader,
} from './driver';

export {
  createConnectedNetezzaConnection,
  createNetezzaConnection,
  getNetezzaConnectionConstructor,
} from './driver';
export type {
  NetezzaDriverCommand,
  NetezzaDriverConfig,
  NetezzaDriverConnection,
  NetezzaDriverReader,
  NetezzaDriverOptions,
} from './driver';

export interface NetezzaConnectionDetails {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeout?: number;
  clientType?: number;
}

export interface NetezzaRuntimeTarget {
  connectionId: string;
  details: NetezzaConnectionDetails;
}

export type NetezzaTableDdlMetadata = DatabaseTableDdlMetadata;

export interface NetezzaRuntimeOptions {
  isReadOnlySql?: (sql: string) => boolean;
  connectionFactory?: (
    details: NetezzaConnectionDetails,
  ) => Promise<NetezzaDriverConnection>;
}

export type NetezzaQueryCallbacks = DatabaseQueryCallbacks;
export type NetezzaQueryOptions = DatabaseQueryOptions;

export class NetezzaRuntimeTargetChangedError extends Error {
  public readonly code = 'NETEZZA_RUNTIME_TARGET_CHANGED';

  public constructor(connectionId: string) {
    super(`Netezza connection ${connectionId} changed its target without being closed.`);
    this.name = 'NetezzaRuntimeTargetChangedError';
  }
}

interface ActiveNetezzaOperation {
  readonly command: DatabaseQueryCommand;
  readonly finished: Promise<void>;
  complete(): void;
}

interface NetezzaSession {
  readonly connectionId: string;
  readonly targetKey: string;
  readonly operations: Set<ActiveNetezzaOperation>;
  closing?: Promise<void>;
}

const FALLBACK_ROW_LIMIT = 200_000;

function rowLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : FALLBACK_ROW_LIMIT;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

function toColumns(reader: Pick<NetezzaDriverReader, 'fieldCount' | 'getName' | 'getTypeName'>): QueryColumn[] {
  return Array.from({ length: reader.fieldCount }, (_, index) => ({
    name: reader.getName(index),
    type: reader.getTypeName(index),
  }));
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(value)) throw new Error('Invalid database identifier.');
  return value;
}

function literal(value: string): string {
  return value.replace(/'/g, "''");
}

function unquoteNetezzaIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toUpperCase();
}

function formatNetezzaIdentifier(value: string): string {
  const normalized = unquoteNetezzaIdentifier(value);
  if (/^[A-Z_][A-Z0-9_]*$/u.test(normalized)) return normalized;
  return `"${normalized.replace(/"/g, '""')}"`;
}

function identifierEquality(columnExpression: string, value: string): string {
  return `${columnExpression} = '${literal(unquoteNetezzaIdentifier(value))}'`;
}

function booleanValue(value: unknown): boolean {
  return value === true
    || value === 1
    || ['1', 't', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function optionalDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stringValue(value: unknown): string {
  return String(value ?? '').trim();
}

function optionalStringValue(value: unknown): string | null {
  return value ? String(value) : null;
}

function rawStringValue(value: unknown): string {
  return String(value ?? '');
}

function defaultReadOnlySql(sql: string): boolean {
  const statements: string[] = [];
  let statement = '';
  let quote: "'" | '"' | undefined;
  let lineComment = false;
  let blockComment = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n') { lineComment = false; statement += ' '; }
      continue;
    }
    if (blockComment > 0) {
      if (character === '/' && next === '*') { blockComment += 1; index += 1; }
      else if (character === '*' && next === '/') { blockComment -= 1; index += 1; }
      continue;
    }
    if (quote) {
      statement += ' ';
      if (character === quote && next === quote) { statement += ' '; index += 1; }
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '-' && next === '-') { lineComment = true; statement += ' '; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = 1; statement += ' '; index += 1; continue; }
    if (character === "'" || character === '"') { quote = character; statement += ' '; continue; }
    if (character === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
    } else statement += character;
  }
  if (quote || blockComment > 0) return false;
  if (statement.trim()) statements.push(statement.trim());
  if (statements.length === 0) return false;
  const mutating = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|GROOM|GENERATE|NZLOAD|CALL|EXEC|EXECUTE|COPY|LOCK|SET|RESET|BEGIN|COMMIT|ROLLBACK)\b/iu;
  return statements.every(current => /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC)\b/iu.test(current) && !mutating.test(current));
}

function driverConfig(details: NetezzaConnectionDetails): NetezzaDriverConfig {
  return {
    host: details.host,
    port: details.port,
    database: details.database,
    user: details.user,
    password: details.password,
    ...(details.connectionTimeout === undefined ? {} : { connectionTimeout: details.connectionTimeout }),
    ...(details.clientType === undefined ? {} : { clientType: details.clientType }),
  };
}

class RuntimeOperation implements ActiveNetezzaOperation {
  private resolveFinished!: () => void;
  public readonly finished = new Promise<void>(resolve => { this.resolveFinished = resolve; });

  private activeCommand?: NetezzaDriverCommand;
  private completed = false;
  private cancelled = false;
  public readonly command: DatabaseQueryCommand = {
    cancel: async () => {
      if (this.completed || this.cancelled) return;
      this.cancelled = true;
      await this.activeCommand?.cancel();
    },
  };

  public checkCancelled(): void {
    if (this.cancelled) throw new Error('Netezza query cancelled.');
  }

  public activate(command: NetezzaDriverCommand): void {
    this.checkCancelled();
    this.activeCommand = command;
  }

  public deactivate(): void {
    this.activeCommand = undefined;
  }

  public complete(): void {
    this.completed = true;
    this.deactivate();
    this.resolveFinished();
  }
}

/**
 * Tracks executions by profile id without retaining credentials. Each execution
 * owns a fresh connection; closing a profile cancels and drains its operations,
 * including operations still connecting.
 */
export class NetezzaRuntime {
  private readonly sessions = new Map<string, NetezzaSession>();
  private readonly isReadOnly: (sql: string) => boolean;
  private closingAll?: Promise<void>;

  public constructor(options: NetezzaRuntimeOptions = {}) {
    this.isReadOnly = options.isReadOnlySql ?? defaultReadOnlySql;
    this.connectionFactory = options.connectionFactory ?? (details => createConnectedNetezzaConnection(driverConfig(details), {
      connectionTimeout: details.connectionTimeout,
      clientType: details.clientType,
    }));
  }

  private readonly connectionFactory: (details: NetezzaConnectionDetails) => Promise<NetezzaDriverConnection>;

  public async execute(
    target: NetezzaRuntimeTarget,
    sql: string,
    options: DatabaseQueryOptions,
    callbacks: DatabaseQueryCallbacks,
  ): Promise<DatabaseQueryResult> {
    const session = this.getSession(target);
    const operation = new RuntimeOperation();
    session.operations.add(operation);
    let connection: NetezzaDriverConnection | undefined;
    let readOnlyTransaction = false;
    try {
      callbacks.onCommand(operation.command);
      operation.checkCancelled();
      if (options.readOnly && !this.isReadOnly(sql)) throw new Error('This Netezza connection is read-only.');
      connection = await this.connectionFactory({ ...target.details, database: options.database ?? target.details.database });
      operation.checkCancelled();
      const command = connection.createCommand(sql);
      command.commandTimeout = options.timeoutSeconds;
      if (options.readOnly) {
        const begin = connection.createCommand('BEGIN');
        operation.activate(begin);
        await begin.executeNonQuery();
        readOnlyTransaction = true;
        const readOnly = connection.createCommand('SET TRANSACTION READ ONLY');
        operation.activate(readOnly);
        await readOnly.executeNonQuery();
      }
      operation.activate(command);
      const reader = await command.executeReader();
      let totalRows = 0;
      try {
        callbacks.onColumns(toColumns(reader));
        const maxRows = rowLimit(options.maxRows);
        const rows: unknown[][] = [];
        while (totalRows < maxRows && await reader.read()) {
          operation.checkCancelled();
          rows.push(Array.from({ length: reader.fieldCount }, (_, index) => normalizeValue(reader.getValue(index))));
          totalRows += 1;
          if (rows.length >= 200) callbacks.onRows(rows.splice(0, rows.length), totalRows);
        }
        if (rows.length > 0) callbacks.onRows(rows, totalRows);
        operation.checkCancelled();
        return {
          totalRows,
          limitReached: totalRows >= maxRows,
          rowsAffected: command._recordsAffected,
        };
      } finally {
        operation.deactivate();
        await reader.close();
      }
    } finally {
      operation.deactivate();
      try {
        if (connection) {
          try {
            if (readOnlyTransaction) await connection.createCommand('ROLLBACK').executeNonQuery();
          } finally {
            await connection.close();
          }
        }
      } finally {
        session.operations.delete(operation);
        operation.complete();
      }
    }
  }

  public listDatabases(target: NetezzaRuntimeTarget): Promise<MetadataDatabase[]> {
    return this.queryMetadata(target, 'SELECT DATABASE FROM SYSTEM.._V_DATABASE ORDER BY DATABASE', values => ({ name: String(values[0] ?? '') }));
  }

  public listSchemas(target: NetezzaRuntimeTarget, database: string): Promise<MetadataSchema[]> {
    const db = identifier(database);
    return this.queryMetadata(target, `SELECT SCHEMA FROM ${db}.._V_SCHEMA ORDER BY SCHEMA`, values => ({ database, name: String(values[0] ?? '') }));
  }

  public listObjects(target: NetezzaRuntimeTarget, database: string, schema?: string): Promise<MetadataObject[]> {
    const db = identifier(database);
    const schemaClause = schema ? ` AND UPPER(SCHEMA) = UPPER('${literal(schema)}')` : '';
    return this.queryMetadata(target, `SELECT OBJNAME, SCHEMA, OBJTYPE, COALESCE(DESCRIPTION, '') FROM ${db}.._V_OBJECT_DATA WHERE DBNAME = '${literal(database)}'${schemaClause} AND OBJTYPE IN ('TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE', 'PROCEDURE') ORDER BY SCHEMA, OBJNAME`, values => ({
      name: String(values[0] ?? ''),
      schema: String(values[1] ?? ''),
      database,
      objectType: String(values[2] ?? ''),
      description: String(values[3] ?? ''),
    }));
  }

  public listColumns(target: NetezzaRuntimeTarget, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
    const db = identifier(database);
    return this.queryMetadata(target, `SELECT C.ATTNAME, C.FORMAT_TYPE, COALESCE(C.DESCRIPTION, '') FROM ${db}.._V_RELATION_COLUMN C JOIN ${db}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID WHERE UPPER(O.DBNAME) = UPPER('${literal(database)}') AND UPPER(O.SCHEMA) = UPPER('${literal(schema)}') AND UPPER(O.OBJNAME) = UPPER('${literal(table)}') ORDER BY C.ATTNUM`, values => ({
      name: String(values[0] ?? ''),
      type: String(values[1] ?? ''),
      description: String(values[2] ?? ''),
    }));
  }

  /**
   * Loads the catalog fields required by the canonical Netezza table DDL
   * formatter.  The result is serializable so API and desktop adapters can
   * pass it across their own transport boundaries without sharing a driver
   * connection or a Map instance.
   */
  public async getTableDdlMetadata(
    target: NetezzaRuntimeTarget,
    database: string,
    schema: string,
    table: string,
  ): Promise<NetezzaTableDdlMetadata> {
    const db = formatNetezzaIdentifier(database);
    const columns = await this.queryMetadata(target, `
      SELECT
        X.OBJID::INT AS OBJID,
        X.ATTNUM,
        X.ATTNAME,
        X.DESCRIPTION,
        X.FORMAT_TYPE AS FULL_TYPE,
        X.ATTNOTNULL::BOOL AS ATTNOTNULL,
        X.COLDEFAULT
      FROM ${db}.._V_RELATION_COLUMN X
      INNER JOIN ${db}.._V_OBJECT_DATA D ON X.OBJID = D.OBJID
      WHERE X.TYPE IN ('TABLE','VIEW','SEQUENCE','SYSTEM VIEW','SYSTEM TABLE')
        AND X.OBJID NOT IN (4,5)
        AND ${identifierEquality('D.SCHEMA', schema)}
        AND ${identifierEquality('D.OBJNAME', table)}
      ORDER BY OBJID, ATTNUM
    `.trim(), values => ({
      name: stringValue(values[2]),
      description: optionalDescription(values[3]),
      fullTypeName: stringValue(values[4]),
      notNull: booleanValue(values[5]),
      defaultValue: values[6] ? String(values[6]) : null,
    }), database).then(rows => rows.filter(row => row.name.length > 0));

    if (columns.length === 0) {
      throw new Error(`Table ${database}.${schema}.${table} not found or has no columns`);
    }

    const distributionPromise = this.queryMetadata(target, `
      SELECT ATTNAME
      FROM ${db}.._V_TABLE_DIST_MAP
      WHERE ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('TABLENAME', table)}
      ORDER BY DISTSEQNO
    `.trim(), values => rawStringValue(values[0]), database).catch(() => [] as string[]);

    const organizePromise = this.queryMetadata(target, `
      SELECT ATTNAME
      FROM ${db}.._V_TABLE_ORGANIZE_COLUMN
      WHERE ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('TABLENAME', table)}
      ORDER BY ORGSEQNO
    `.trim(), values => rawStringValue(values[0]), database).catch(() => [] as string[]);

    const keysPromise = this.queryMetadata(target, `
      SELECT
        X.CONSTRAINTNAME,
        X.CONTYPE,
        X.ATTNAME,
        X.PKDATABASE,
        X.PKSCHEMA,
        X.PKRELATION,
        X.PKATTNAME,
        X.UPDT_TYPE,
        X.DEL_TYPE
      FROM ${db}.._V_RELATION_KEYDATA X
      WHERE X.OBJID NOT IN (4,5)
        AND ${identifierEquality('X.SCHEMA', schema)}
        AND ${identifierEquality('X.RELATION', table)}
      ORDER BY X.SCHEMA, X.RELATION, X.CONSEQ
    `.trim(), values => ({
      name: stringValue(values[0]),
      typeChar: rawStringValue(values[1]),
      column: rawStringValue(values[2]),
      pkDatabase: optionalStringValue(values[3]),
      pkSchema: optionalStringValue(values[4]),
      pkRelation: optionalStringValue(values[5]),
      pkColumn: optionalStringValue(values[6]),
      updateType: optionalStringValue(values[7]) || 'NO ACTION',
      deleteType: optionalStringValue(values[8]) || 'NO ACTION',
    }), database).then(rows => {
      const keys = new Map<string, DatabaseDdlKeyInfo>();
      for (const row of rows) {
        if (!keys.has(row.name)) {
          const type = row.typeChar === 'p'
            ? 'PRIMARY KEY'
            : row.typeChar === 'f'
              ? 'FOREIGN KEY'
              : row.typeChar === 'u'
                ? 'UNIQUE'
                : 'UNKNOWN';
          keys.set(row.name, {
            type,
            typeChar: row.typeChar,
            columns: [],
            pkDatabase: row.pkDatabase,
            pkSchema: row.pkSchema,
            pkRelation: row.pkRelation,
            pkColumns: [],
            updateType: row.updateType,
            deleteType: row.deleteType,
          });
        }
        const key = keys.get(row.name);
        if (!key) continue;
        key.columns.push(row.column);
        if (row.pkColumn) key.pkColumns.push(row.pkColumn);
      }
      return [...keys.entries()].map(([name, info]) => ({ name, info }));
    }).catch(() => [] as Array<{ name: string; info: DatabaseDdlKeyInfo }>);

    const tableCommentPromise = this.queryMetadata(target, `
      SELECT DESCRIPTION
      FROM ${db}.._V_OBJECT_DATA
      WHERE ${identifierEquality('DBNAME', database)}
        AND ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('OBJNAME', table)}
        AND OBJTYPE = 'TABLE'
    `.trim(), values => optionalStringValue(values[0]), database).then(rows => rows[0] ?? null).catch(async () => {
      try {
        const rows = await this.queryMetadata(target, `
          SELECT DESCRIPTION
          FROM ${db}.._V_OBJECT_DATA
          WHERE ${identifierEquality('DBNAME', database)}
            AND ${identifierEquality('SCHEMA', schema)}
            AND ${identifierEquality('OBJNAME', table)}
        `.trim(), values => optionalStringValue(values[0]), database);
        return rows[0] ?? null;
      } catch {
        return null;
      }
    });

    const [distributionColumns, organizeColumns, keys, tableComment] = await Promise.all([
      distributionPromise,
      organizePromise,
      keysPromise,
      tableCommentPromise,
    ]);
    return { columns, distributionColumns, organizeColumns, keys, tableComment };
  }

  /**
   * Netezza exposes view source only when the connection is established to
   * the database containing that view.  `queryMetadata` therefore receives an
   * explicit database override here.
   */
  public async getViewDefinition(
    target: NetezzaRuntimeTarget,
    database: string,
    schema: string,
    view: string,
  ): Promise<string> {
    const db = formatNetezzaIdentifier(database);
    const rows = await this.queryMetadata(target, `
      SELECT DEFINITION
      FROM ${db}.._V_VIEW
      WHERE ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('VIEWNAME', view)}
    `.trim(), values => String(values[0] ?? ''), database);
    if (rows.length === 0) throw new Error(`View ${database}.${schema}.${view} not found`);
    return rows[0] ?? '';
  }

  public async closeConnection(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    if (session.closing) return session.closing;
    session.closing = this.closeSession(session);
    return session.closing;
  }

  public async closeAll(): Promise<void> {
    if (this.closingAll) return this.closingAll;
    const pending = Promise.allSettled([...this.sessions.keys()].map(id => this.closeConnection(id))).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Multiple Netezza connections failed to close.');
    });
    this.closingAll = pending.finally(() => { this.closingAll = undefined; });
    return this.closingAll;
  }

  public isAvailable(): boolean {
    return typeof getNetezzaConnectionConstructor() === 'function';
  }

  private getSession(target: NetezzaRuntimeTarget): NetezzaSession {
    if (this.closingAll) throw new Error('Netezza runtime is closing all connections.');
    if (!target.connectionId.trim()) throw new Error('Netezza runtime requires a connection identifier.');
    const existing = this.sessions.get(target.connectionId);
    const targetKey = createHash('sha256').update(JSON.stringify(driverConfig(target.details))).digest('hex');
    if (existing) {
      if (existing.closing) throw new Error(`Netezza connection ${target.connectionId} is closing.`);
      if (existing.targetKey !== targetKey) throw new NetezzaRuntimeTargetChangedError(target.connectionId);
      return existing;
    }
    const session: NetezzaSession = { connectionId: target.connectionId, targetKey, operations: new Set() };
    this.sessions.set(target.connectionId, session);
    return session;
  }

  private async queryMetadata<T>(
    target: NetezzaRuntimeTarget,
    sql: string,
    map: (values: unknown[]) => T,
    databaseOverride?: string,
  ): Promise<T[]> {
    const rows: T[] = [];
    await this.execute(target, sql, {
      maxRows: 100_000,
      timeoutSeconds: 90,
      ...(databaseOverride === undefined ? {} : { database: databaseOverride }),
    }, {
      onColumns: () => undefined,
      onCommand: () => undefined,
      onRows: values => values.forEach(row => rows.push(map(row))),
    });
    return rows;
  }

  private async closeSession(session: NetezzaSession): Promise<void> {
    const errors: unknown[] = [];
    const cancellations = await Promise.allSettled([...session.operations].map(operation => operation.command.cancel()));
    errors.push(...cancellations.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason as unknown));
    await Promise.allSettled([...session.operations].map(operation => operation.finished));
    if (this.sessions.get(session.connectionId) === session) this.sessions.delete(session.connectionId);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Netezza connection ${session.connectionId} failed to close cleanly.`);
  }
}

async function ephemeralRuntime<T>(
  profile: NetezzaConnectionDetails,
  operation: (runtime: NetezzaRuntime, target: NetezzaRuntimeTarget) => Promise<T>,
): Promise<T> {
  const runtime = new NetezzaRuntime();
  const target = { connectionId: `ephemeral-${Date.now()}-${Math.random()}`, details: profile };
  try { return await operation(runtime, target); }
  finally { await runtime.closeAll(); }
}

export async function executeNetezzaQuery(
  profile: NetezzaConnectionDetails,
  sql: string,
  options: DatabaseQueryOptions,
  callbacks: DatabaseQueryCallbacks,
): Promise<DatabaseQueryResult> {
  return ephemeralRuntime(profile, (runtime, target) => runtime.execute(target, sql, options, callbacks));
}

export function isReadOnlySql(sql: string): boolean {
  return defaultReadOnlySql(sql);
}

export function listDatabases(profile: NetezzaConnectionDetails): Promise<MetadataDatabase[]> {
  return ephemeralRuntime(profile, (runtime, target) => runtime.listDatabases(target));
}

export function listSchemas(profile: NetezzaConnectionDetails, database: string): Promise<MetadataSchema[]> {
  return ephemeralRuntime(profile, (runtime, target) => runtime.listSchemas(target, database));
}

export function listObjects(profile: NetezzaConnectionDetails, database: string, schema?: string): Promise<MetadataObject[]> {
  return ephemeralRuntime(profile, (runtime, target) => runtime.listObjects(target, database, schema));
}

export function listColumns(profile: NetezzaConnectionDetails, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
  return ephemeralRuntime(profile, (runtime, target) => runtime.listColumns(target, database, schema, table));
}

export type { DatabaseQueryCommand };
