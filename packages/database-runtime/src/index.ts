import { NzConnection } from '@justybase/netezza-driver';
import type { MetadataColumn, MetadataDatabase, MetadataObject, MetadataSchema, QueryColumn } from '@justybase/contracts';

export interface NetezzaConnectionDetails {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface QueryCallbacks {
  onColumns(columns: QueryColumn[]): void;
  onRows(rows: unknown[][], totalRows: number): void;
  onCommand(command: { cancel(): Promise<void> }): void;
}

export interface QueryOptions {
  maxRows: number;
  timeoutSeconds: number;
  readOnly?: boolean;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

function toColumns(reader: { fieldCount: number; getName(index: number): string; getTypeName(index: number): string }): QueryColumn[] {
  const columns: QueryColumn[] = [];
  for (let index = 0; index < reader.fieldCount; index += 1) columns.push({ name: reader.getName(index), type: reader.getTypeName(index) });
  return columns;
}

export async function executeNetezzaQuery(profile: NetezzaConnectionDetails, sql: string, options: QueryOptions, callbacks: QueryCallbacks): Promise<{ totalRows: number; limitReached: boolean; rowsAffected?: number }> {
  const connection = new NzConnection(profile);
  await connection.connect();
  let readOnlyTransaction = false;
  try {
    if (options.readOnly) {
      await connection.createCommand('BEGIN').executeNonQuery();
      await connection.createCommand('SET TRANSACTION READ ONLY').executeNonQuery();
      readOnlyTransaction = true;
    }
    const command = connection.createCommand(sql);
    command.commandTimeout = options.timeoutSeconds;
    callbacks.onCommand(command);
    const reader = await command.executeReader();
    let totalRows = 0;
    try {
      callbacks.onColumns(toColumns(reader));
      const rows: unknown[][] = [];
      while (totalRows < options.maxRows && await reader.read()) {
        rows.push(Array.from({ length: reader.fieldCount }, (_, index) => normalizeValue(reader.getValue(index))));
        totalRows += 1;
        if (rows.length >= 200) callbacks.onRows(rows.splice(0, rows.length), totalRows);
      }
      if (rows.length > 0) callbacks.onRows(rows, totalRows);
      return { totalRows, limitReached: totalRows >= options.maxRows, rowsAffected: command._recordsAffected };
    } finally {
      await reader.close();
    }
  } finally {
    if (readOnlyTransaction) {
      try { await connection.createCommand('ROLLBACK').executeNonQuery(); } catch { /* Closing the connection also abandons the transaction. */ }
    }
    connection.close();
  }
}

async function queryRows(profile: NetezzaConnectionDetails, sql: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  await executeNetezzaQuery(profile, sql, { maxRows: 100_000, timeoutSeconds: 90 }, {
    onColumns: () => undefined,
    onCommand: () => undefined,
    onRows: data => data.forEach(values => { const row: Record<string, unknown> = {}; values.forEach((value, index) => { row[String(index)] = value; }); rows.push(row); }),
  });
  return rows;
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new Error('Invalid database identifier.');
  return value;
}

function literal(value: string): string { return value.replace(/'/g, "''"); }

export async function listDatabases(profile: NetezzaConnectionDetails): Promise<MetadataDatabase[]> {
  const rows = await queryRows(profile, 'SELECT DATABASE FROM SYSTEM.._V_DATABASE ORDER BY DATABASE');
  return rows.map(row => ({ name: String(row['0'] ?? '') })).filter(row => row.name.length > 0);
}

export async function listSchemas(profile: NetezzaConnectionDetails, database: string): Promise<MetadataSchema[]> {
  const db = identifier(database);
  const rows = await queryRows(profile, `SELECT SCHEMA FROM ${db}.._V_SCHEMA ORDER BY SCHEMA`);
  return rows.map(row => ({ database, name: String(row['0'] ?? '') })).filter(row => row.name.length > 0);
}

export async function listObjects(profile: NetezzaConnectionDetails, database: string, schema?: string): Promise<MetadataObject[]> {
  const db = identifier(database);
  const schemaClause = schema ? ` AND UPPER(SCHEMA) = UPPER('${literal(schema)}')` : '';
  const rows = await queryRows(profile, `SELECT OBJNAME, SCHEMA, OBJTYPE, COALESCE(DESCRIPTION, '') FROM ${db}.._V_OBJECT_DATA WHERE DBNAME = '${literal(database)}'${schemaClause} AND OBJTYPE IN ('TABLE', 'VIEW', 'SYNONYM', 'EXTERNAL TABLE', 'PROCEDURE') ORDER BY SCHEMA, OBJNAME`);
  return rows.map(row => ({ name: String(row['0'] ?? ''), schema: String(row['1'] ?? ''), database, objectType: String(row['2'] ?? ''), description: String(row['3'] ?? '') }));
}

export async function listColumns(profile: NetezzaConnectionDetails, database: string, schema: string, table: string): Promise<MetadataColumn[]> {
  const db = identifier(database);
  const rows = await queryRows(profile, `SELECT C.ATTNAME, C.FORMAT_TYPE, COALESCE(C.DESCRIPTION, '') FROM ${db}.._V_RELATION_COLUMN C JOIN ${db}.._V_OBJECT_DATA O ON C.OBJID = O.OBJID WHERE UPPER(O.DBNAME) = UPPER('${literal(database)}') AND UPPER(O.SCHEMA) = UPPER('${literal(schema)}') AND UPPER(O.OBJNAME) = UPPER('${literal(table)}') ORDER BY C.ATTNUM`);
  return rows.map(row => ({ name: String(row['0'] ?? ''), type: String(row['1'] ?? ''), description: String(row['2'] ?? '') }));
}

export function isReadOnlySql(sql: string): boolean {
  const statements: string[] = [];
  let statement = '';
  let index = 0;
  let quote: "'" | '"' | undefined;
  let lineComment = false;
  let blockCommentDepth = 0;

  while (index < sql.length) {
    const character = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n') { lineComment = false; statement += ' '; }
      index += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') { blockCommentDepth += 1; index += 2; continue; }
      if (character === '*' && next === '/') { blockCommentDepth -= 1; index += 2; continue; }
      index += 1;
      continue;
    }
    if (quote) {
      statement += ' ';
      if (character === quote && next === quote) { statement += ' '; index += 2; continue; }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') { lineComment = true; statement += ' '; index += 2; continue; }
    if (character === '/' && next === '*') { blockCommentDepth = 1; statement += ' '; index += 2; continue; }
    if (character === "'" || character === '"') { quote = character; statement += ' '; index += 1; continue; }
    if (character === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
      index += 1;
      continue;
    }
    statement += character;
    index += 1;
  }
  if (quote || blockCommentDepth > 0) return false;
  if (statement.trim()) statements.push(statement.trim());
  if (statements.length === 0) return false;

  const mutatingKeyword = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|GROOM|GENERATE|NZLOAD|CALL|EXEC|EXECUTE|COPY|LOCK|SET|RESET|BEGIN|COMMIT|ROLLBACK)\b/i;
  return statements.every(current =>
    /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC)\b/i.test(current)
    && !mutatingKeyword.test(current),
  );
}
