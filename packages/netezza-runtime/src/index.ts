import type {
  DatabaseDdlColumnInfo,
  DatabaseDdlKeyInfo,
  DatabaseExternalTableDdlMetadata,
  DatabaseExternalTableInfo,
  DatabaseProcedureInfo,
  DatabaseTableDdlMetadata,
  DatabaseSynonymInfo,
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

function normalizeCatalogText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeCatalogObjectType(value: unknown): string {
  return normalizeCatalogText(value).toUpperCase();
}

/** Netezza uses -1 as an unknown row-count sentinel for SELECT commands. */
function normalizeRowsAffected(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

type NetezzaColumnReader = Pick<NetezzaDriverReader, 'fieldCount' | 'getName' | 'getTypeName'> & {
  getDeclaredTypeName?: (index: number) => string;
  getColumnMetadata?: (index: number) => { numericScale?: unknown } | null;
  getSchemaTable?: () => { Rows?: Array<{ NumericScale?: unknown }> } | Array<{ NumericScale?: unknown }>;
};

function numericScale(reader: NetezzaColumnReader, index: number): number | undefined {
  let value: unknown;
  try {
    value = reader.getColumnMetadata?.(index)?.numericScale;
  } catch {
    value = undefined;
  }
  if (typeof value !== 'number') {
    try {
      const schema = reader.getSchemaTable?.();
      const rows = Array.isArray(schema) ? schema : schema?.Rows;
      value = rows?.[index]?.NumericScale;
    } catch {
      value = undefined;
    }
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : undefined;
}

function toColumns(reader: NetezzaColumnReader): QueryColumn[] {
  return Array.from({ length: reader.fieldCount }, (_, index) => {
    const declaredType = reader.getDeclaredTypeName?.(index)?.trim();
    const scale = numericScale(reader, index);
    return {
      name: reader.getName(index),
      type: declaredType || reader.getTypeName(index),
      ...(scale === undefined ? {} : { scale }),
    };
  });
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

function optionalNumberValue(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fixProcedureReturnType(returns: string): string {
  switch (returns.trim().toUpperCase()) {
    case 'CHARACTER VARYING': return 'CHARACTER VARYING(ANY)';
    case 'NATIONAL CHARACTER VARYING': return 'NATIONAL CHARACTER VARYING(ANY)';
    case 'NATIONAL CHARACTER': return 'NATIONAL CHARACTER(ANY)';
    case 'CHARACTER': return 'CHARACTER(ANY)';
    default: return returns;
  }
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
          ...(normalizeRowsAffected(command._recordsAffected) === undefined ? {} : { rowsAffected: normalizeRowsAffected(command._recordsAffected) }),
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
    return this.queryMetadata(target, 'SELECT DATABASE FROM _V_DATABASE ORDER BY DATABASE', values => ({ name: normalizeCatalogText(values[0]) })).then(items => {
      const seen = new Set<string>();
      return items.filter(item => item.name.length > 0 && !seen.has(item.name) && seen.add(item.name));
    });
  }

  public listSchemas(target: NetezzaRuntimeTarget, database: string): Promise<MetadataSchema[]> {
    const db = identifier(database);
    return this.queryMetadata(target, `SELECT SCHEMA FROM ${db}.._V_SCHEMA ORDER BY SCHEMA`, values => ({ database, name: normalizeCatalogText(values[0]) })).then(items => items.filter(item => item.name.length > 0));
  }

  public listObjects(target: NetezzaRuntimeTarget, database: string, schema?: string): Promise<MetadataObject[]> {
    const db = identifier(database);
    const schemaClause = schema ? ` AND UPPER(SCHEMA) = UPPER('${literal(schema)}')` : '';
    return this.queryMetadata(target, `SELECT OBJNAME, SCHEMA, OBJTYPE, COALESCE(DESCRIPTION, '') FROM ${db}.._V_OBJECT_DATA WHERE DBNAME = '${literal(database)}'${schemaClause} AND OBJTYPE IN ('TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE', 'PROCEDURE') ORDER BY SCHEMA, OBJNAME`, values => ({
      name: normalizeCatalogText(values[0]),
      schema: normalizeCatalogText(values[1]),
      database,
      objectType: normalizeCatalogObjectType(values[2]),
      description: normalizeCatalogText(values[3]),
    })).then(items => items.filter(item => item.name.length > 0 && item.schema !== ''));
  }

  public listColumns(target: NetezzaRuntimeTarget, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
    const db = identifier(database);
    return this.queryMetadata(target, `SELECT C.ATTNAME, C.FORMAT_TYPE, COALESCE(C.DESCRIPTION, '') FROM ${db}.._V_RELATION_COLUMN C JOIN ${db}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID WHERE UPPER(O.DBNAME) = UPPER('${literal(database)}') AND UPPER(O.SCHEMA) = UPPER('${literal(schema)}') AND UPPER(O.OBJNAME) = UPPER('${literal(table)}') ORDER BY C.ATTNUM`, values => ({
      name: normalizeCatalogText(values[0]),
      type: normalizeCatalogText(values[1]),
      description: normalizeCatalogText(values[2]),
    })).then(items => items.filter(item => item.name.length > 0));
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
    const connection = await this.connectionFactory({ ...target.details, database: unquoteNetezzaIdentifier(database) });
    try {
      const queryOnConnection = async <T>(sql: string, map: (values: unknown[]) => T): Promise<T[]> => {
        const rows: T[] = [];
        const command = connection.createCommand(sql);
        command.commandTimeout = 90;
        const reader = await command.executeReader();
        try {
          while (await reader.read()) rows.push(map(Array.from({ length: reader.fieldCount }, (_, index) => reader.getValue(index))));
        } finally {
          await reader.close();
        }
        return rows;
      };
      const columns = (await queryOnConnection(`
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
      WHERE ${identifierEquality('D.DBNAME', database)}
        AND D.OBJTYPE IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')
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
      }))).filter(row => row.name.length > 0);

      let metadataComplete = true;
      const readAncillary = async <T>(sql: string, map: (values: unknown[]) => T): Promise<T[]> => {
        try {
          return await queryOnConnection(sql, map);
        } catch {
          metadataComplete = false;
          return [];
        }
      };
      const distributionColumns = await readAncillary(`
      SELECT ATTNAME
      FROM ${db}.._V_TABLE_DIST_MAP
      WHERE ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('TABLENAME', table)}
      ORDER BY DISTSEQNO
      `.trim(), values => rawStringValue(values[0]));

      const organizeColumns = await readAncillary(`
      SELECT ATTNAME
      FROM ${db}.._V_TABLE_ORGANIZE_COLUMN
      WHERE ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('TABLENAME', table)}
      ORDER BY ORGSEQNO
      `.trim(), values => rawStringValue(values[0]));

      const keyRows = await readAncillary(`
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
      }));
      const keys = (() => {
        const keys = new Map<string, DatabaseDdlKeyInfo>();
        for (const row of keyRows) {
          if (!row.column.trim()) continue;
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
      })();

      const commentRows = await readAncillary(`
      SELECT DESCRIPTION
      FROM ${db}.._V_OBJECT_DATA
      WHERE ${identifierEquality('DBNAME', database)}
        AND ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('OBJNAME', table)}
        AND OBJTYPE = 'TABLE'
      `.trim(), values => optionalStringValue(values[0]));
      return { columns, distributionColumns, organizeColumns, keys, tableComment: commentRows[0] ?? null, metadataComplete };
    } finally {
      await connection.close();
    }
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
    `.trim(), values => String(values[0] ?? ''), unquoteNetezzaIdentifier(database));
    if (rows.length === 0) throw new Error(`View ${database}.${schema}.${view} not found`);
    return rows[0] ?? '';
  }

  /** Loads the serializable procedure catalog payload for the shared DDL formatter. */
  public async getProcedureDdlMetadata(
    target: NetezzaRuntimeTarget,
    database: string,
    schema: string,
    procedureSignature: string,
  ): Promise<DatabaseProcedureInfo> {
    const db = formatNetezzaIdentifier(database);
    const rows = await this.queryMetadata(target, `
      SELECT
        SCHEMA,
        PROCEDURESOURCE,
        OBJID::INT,
        RETURNS,
        EXECUTEDASOWNER,
        DESCRIPTION,
        PROCEDURESIGNATURE,
        PROCEDURE,
        ARGUMENTS
      FROM ${db}.._V_PROCEDURE
      WHERE ${identifierEquality('DATABASE', database)}
        AND ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('PROCEDURESIGNATURE', procedureSignature)}
      ORDER BY OBJID
    `.trim(), values => ({
      schema: stringValue(values[0]),
      procedureSource: String(values[1] ?? ''),
      objId: Number(values[2] ?? 0),
      returns: fixProcedureReturnType(String(values[3] ?? '')),
      executeAsOwner: booleanValue(values[4]),
      description: optionalDescription(values[5]),
      procedureSignature: stringValue(values[6]),
      procedureName: stringValue(values[7]),
      arguments: optionalStringValue(values[8]),
    }), unquoteNetezzaIdentifier(database));
    const procedure = rows[0];
    if (!procedure) throw new Error(`Procedure ${database}.${schema}.${procedureSignature} not found`);
    return procedure;
  }

  /** Loads external-table options and typed columns for the shared formatter. */
  public async getExternalTableDdlMetadata(
    target: NetezzaRuntimeTarget,
    database: string,
    schema: string,
    table: string,
  ): Promise<DatabaseExternalTableDdlMetadata> {
    const db = formatNetezzaIdentifier(database);
    interface ExternalRow {
      schema: string;
      tableName: string;
      dataObject: string | null;
      delimiter: string | null;
      encoding: string | null;
      timeStyle: string | null;
      remoteSource: string | null;
      skipRows: number | null;
      maxErrors: number | null;
      escapeChar: string | null;
      logDir: string | null;
      decimalDelim: string | null;
      quotedValue: string | null;
      nullValue: string | null;
      crInString: boolean | null;
      truncString: boolean | null;
      ctrlChars: boolean | null;
      ignoreZero: boolean | null;
      timeExtraZeros: boolean | null;
      y2Base: number | null;
      fillRecord: boolean | null;
      compress: boolean | null;
      includeHeader: boolean | null;
      lfInString: boolean | null;
      dateStyle: string | null;
      dateDelim: string | null;
      timeDelim: string | null;
      boolStyle: string | null;
      format: string | null;
      socketBufSize: number | null;
      recordDelim: string | null;
      maxRows: number | null;
      requireQuotes: boolean | null;
      recordLength: string | null;
      dateTimeDelim: string | null;
      rejectFile: string | null;
    }
    const rows = await this.queryMetadata(target, `
      SELECT
        E1.SCHEMA,
        E1.TABLENAME,
        E2.EXTOBJNAME,
        E1.DELIM,
        E1.ENCODING,
        E1.TIMESTYLE,
        E1.REMOTESOURCE,
        E1.SKIPROWS,
        E1.MAXERRORS,
        E1.ESCAPE,
        E1.LOGDIR,
        E1.DECIMALDELIM,
        E1.QUOTEDVALUE,
        E1.NULLVALUE,
        E1.CRINSTRING,
        E1.TRUNCSTRING,
        E1.CTRLCHARS,
        E1.IGNOREZERO,
        E1.TIMEEXTRAZEROS,
        E1.Y2BASE,
        E1.FILLRECORD,
        E1.COMPRESS,
        E1.INCLUDEHEADER,
        E1.LFINSTRING,
        E1.DATESTYLE,
        E1.DATEDELIM,
        E1.TIMEDELIM,
        E1.BOOLSTYLE,
        E1.FORMAT,
        E1.SOCKETBUFSIZE,
        E1.RECORDDELIM,
        E1.MAXROWS,
        E1.REQUIREQUOTES,
        E1.RECORDLENGTH,
        E1.DATETIMEDELIM,
        E1.REJECTFILE
      FROM ${db}.._V_EXTERNAL E1
      INNER JOIN ${db}.._V_EXTOBJECT E2 ON E1.RELID = E2.OBJID
      WHERE ${identifierEquality('E1.DATABASE', database)}
        AND ${identifierEquality('E1.SCHEMA', schema)}
        AND ${identifierEquality('E1.TABLENAME', table)}
    `.trim(), values => {
      const booleanAt = (index: number): boolean | null => values[index] === null || values[index] === undefined
        ? null
        : booleanValue(values[index]);
      const stringAt = (index: number): string | null => optionalStringValue(values[index]);
      return {
        schema: stringValue(values[0]),
        tableName: stringValue(values[1]),
        dataObject: stringAt(2),
        delimiter: stringAt(3),
        encoding: stringAt(4),
        timeStyle: stringAt(5),
        remoteSource: stringAt(6),
        skipRows: optionalNumberValue(values[7]),
        maxErrors: optionalNumberValue(values[8]),
        escapeChar: stringAt(9),
        logDir: stringAt(10),
        decimalDelim: stringAt(11),
        quotedValue: stringAt(12),
        nullValue: stringAt(13),
        crInString: booleanAt(14),
        truncString: booleanAt(15),
        ctrlChars: booleanAt(16),
        ignoreZero: booleanAt(17),
        timeExtraZeros: booleanAt(18),
        y2Base: optionalNumberValue(values[19]),
        fillRecord: booleanAt(20),
        compress: booleanAt(21),
        includeHeader: booleanAt(22),
        lfInString: booleanAt(23),
        dateStyle: stringAt(24),
        dateDelim: stringAt(25),
        timeDelim: stringAt(26),
        boolStyle: stringAt(27),
        format: stringAt(28),
        socketBufSize: optionalNumberValue(values[29]),
        recordDelim: stringAt(30)?.replace(/\r/gu, '\\r').replace(/\n/gu, '\\n') ?? null,
        maxRows: optionalNumberValue(values[31]),
        requireQuotes: booleanAt(32),
        recordLength: stringAt(33),
        dateTimeDelim: stringAt(34),
        rejectFile: stringAt(35),
      } satisfies ExternalRow;
    }, unquoteNetezzaIdentifier(database));
    const external = rows[0];
    if (!external) throw new Error(`External table ${database}.${schema}.${table} not found`);

    const columns = await this.queryMetadata(target, `
      SELECT
        C.ATTNAME,
        C.DESCRIPTION,
        C.FORMAT_TYPE,
        C.ATTNOTNULL,
        C.COLDEFAULT
      FROM ${db}.._V_RELATION_COLUMN C
      INNER JOIN ${db}.._V_EXTERNAL E ON C.OBJID = E.RELID
      WHERE ${identifierEquality('E.DATABASE', database)}
        AND ${identifierEquality('E.SCHEMA', schema)}
        AND ${identifierEquality('E.TABLENAME', table)}
      ORDER BY C.ATTNUM
    `.trim(), values => ({
      name: stringValue(values[0]),
      description: optionalDescription(values[1]),
      fullTypeName: stringValue(values[2]),
      notNull: booleanValue(values[3]),
      defaultValue: values[4] ? String(values[4]) : null,
    } satisfies DatabaseDdlColumnInfo), unquoteNetezzaIdentifier(database));

    const info: DatabaseExternalTableInfo = external;
    return { info, columns: columns.filter(column => column.name.length > 0), metadataComplete: true };
  }

  /** Loads and resolves a synonym target so the shared formatter can emit a runnable definition. */
  public async getSynonymDdlMetadata(
    target: NetezzaRuntimeTarget,
    database: string,
    schema: string,
    synonym: string,
  ): Promise<DatabaseSynonymInfo> {
    const db = formatNetezzaIdentifier(database);
    const rows = await this.queryMetadata(target, `
      SELECT SCHEMA, OWNER, SYNONYM_NAME, REFOBJNAME, DESCRIPTION
      FROM ${db}.._V_SYNONYM
      WHERE ${identifierEquality('DATABASE', database)}
        AND ${identifierEquality('SCHEMA', schema)}
        AND ${identifierEquality('SYNONYM_NAME', synonym)}
    `.trim(), values => ({
      schema: stringValue(values[0]),
      owner: stringValue(values[1]),
      synonymName: stringValue(values[2]),
      referenceObjectName: stringValue(values[3]),
      description: optionalDescription(values[4]),
    }), unquoteNetezzaIdentifier(database));
    const row = rows[0];
    if (!row) throw new Error(`Synonym ${database}.${schema}.${synonym} not found`);
    return {
      ...row,
      referenceObjectName: await this.resolveSynonymTarget(target, database, row.referenceObjectName),
    };
  }

  private async resolveSynonymTarget(
    target: NetezzaRuntimeTarget,
    synonymDatabase: string,
    referenceObjectName: string,
  ): Promise<string> {
    const trimmed = referenceObjectName.trim();
    if (!trimmed || trimmed.includes('.')) return trimmed;

    const targetInDatabase = async (database: string): Promise<{
      database: string;
      schema: string;
      name: string;
    } | undefined> => {
      const db = formatNetezzaIdentifier(database);
      const rows = await this.queryMetadata(target, `
        SELECT DBNAME, SCHEMA, OBJNAME
        FROM ${db}.._V_OBJECT_DATA
        WHERE UPPER(OBJNAME) = UPPER('${literal(trimmed)}')
          AND OBJTYPE IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')
        ORDER BY OBJID
        LIMIT 1
      `.trim(), values => ({
        database: stringValue(values[0]),
        schema: stringValue(values[1]),
        name: stringValue(values[2]),
      }), unquoteNetezzaIdentifier(database));
      return rows[0];
    };

    try {
      const local = await targetInDatabase(synonymDatabase);
      if (local) return `${local.database}.${local.schema}.${local.name}`;

      const databases = await this.queryMetadata(target, `
        SELECT DATABASE
        FROM SYSTEM.._V_DATABASE
        WHERE DATABASE <> '${literal(unquoteNetezzaIdentifier(synonymDatabase))}'
        ORDER BY DATABASE
      `.trim(), values => stringValue(values[0]));
      for (const database of databases) {
        const match = await targetInDatabase(database);
        if (match) return `${match.database}.${match.schema}.${match.name}`;
      }
    } catch {
      // A synonym can still be reconstructed from its catalog reference when
      // a cross-database lookup is unavailable to the current user.
    }

    return trimmed;
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
