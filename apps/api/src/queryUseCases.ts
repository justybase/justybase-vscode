import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DesignerSnapshotRequest,
  ExecutionEvent,
  QueryAuditStatus,
  QueryEditPreviewRequest,
  QueryEditRequest,
  QueryEvent,
  QueryFileImportPreviewRequest,
  QueryFileImportRequest,
  QueryImportPreviewRequest,
  QueryImportRequest,
  QueryPreviewResponse,
  QueryPreviewStatement,
  QueryStartRequest,
  QueryExecutionMode,
  QueryWriteResponse,
  WriteOperationPreviewResponse,
} from '@justybase/contracts';
import { StaleDesignerSnapshotError, type ExecutionOrchestrator } from '@justybase/database-runtime';
import { getSqlStatementAtPosition, splitSqlStatements } from '@justybase/sql-core';
import type { ApiConfig } from './config';
import type { AppStore, StoredConnection } from './store';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { QuerySessionManager } from './querySessions';
import type { LspSession } from './lspProtocol';
import type { ApiMetadataService } from './metadataCache';
import { getDesignerSnapshotResponse } from './designerSnapshotService';

const DEFAULT_ROW_LIMIT = 200_000;
const DEFAULT_TIMEOUT_SECONDS = 1_800;
const QUERY_JOB_TTL_MS = 60 * 60 * 1000;
const WRITE_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

export interface PlannedStatement {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
}

export interface QueryJob {
  id: string;
  userId: string;
  connectionId: string;
  database: string;
  mode: QueryExecutionMode;
  statements: PlannedStatement[];
  events: QueryEvent[];
  subscribers: Set<{ send(data: string): void; readyState: number; close?: () => void }>;
  cancel?: () => Promise<void>;
  sessionIds: Map<number, string>;
  sequence: number;
  activeStatementIndex?: number;
  cancelRequested: boolean;
  done: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export interface QueryUseCaseLogger {
  debug(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface QueryUseCaseContext {
  config: ApiConfig;
  store: AppStore;
  databaseRuntimes: ApiDatabaseRuntimeRegistry;
  executionOrchestrator: ExecutionOrchestrator<StoredConnection>;
  metadataService: ApiMetadataService;
  queryJobs: Map<string, QueryJob>;
  querySessions: QuerySessionManager;
  lspSessions: Set<LspSession>;
  log: QueryUseCaseLogger;
}

function effectiveDatabase(runtimes: ApiDatabaseRuntimeRegistry, profile: StoredConnection, requested: string | undefined): string {
  const value = requested?.trim() || (profile.dbType === 'sqlite' ? 'main' : profile.database.trim());
  return runtimes.normalizeDatabase(profile, value);
}

function emit(job: QueryJob, event: QueryEvent): void {
  const sequenced: QueryEvent = { ...event, sequence: ++job.sequence };
  job.events.push(sequenced);
  const payload = JSON.stringify(sequenced);
  for (const socket of job.subscribers) if (socket.readyState === 1) socket.send(payload);
}

function statementCommandType(sql: string): string {
  return /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() ?? 'SQL';
}

function isSchemaMutation(commandType: string): boolean {
  return /^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|RENAME|GRANT|REVOKE|GROOM|ATTACH|DETACH)$/i.test(commandType);
}

function plannedDigest(mode: QueryExecutionMode, statements: PlannedStatement[]): string {
  return createHash('sha256').update(JSON.stringify({ mode, statements: statements.map(statement => ({ index: statement.index, startOffset: statement.startOffset, endOffset: statement.endOffset, sql: statement.sql })) })).digest('hex');
}

function designerTargetDigest(target: NonNullable<QueryStartRequest['designer']>['target']): string {
  const normalized = {
    connectionId: target.connectionId,
    database: target.database,
    schema: target.schema,
    objectName: target.objectName,
    objectType: target.objectType,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

interface WritePreviewClaims {
  userId: string;
  connectionId: string;
  database: string;
  mode: QueryExecutionMode;
  statementsDigest: string;
  designerFingerprint?: string;
  designerTargetDigest?: string;
  cursorOffset?: number;
  expiresAt: number;
}

function signPreviewClaims(claims: WritePreviewClaims, masterKey: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', masterKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyPreviewClaims(token: string, masterKey: string): WritePreviewClaims | undefined {
  const [payload, signature] = token.split('.', 2);
  if (!payload || !signature) return undefined;
  const expected = createHmac('sha256', masterKey).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WritePreviewClaims;
    return typeof claims.userId === 'string' && typeof claims.connectionId === 'string' && typeof claims.database === 'string'
      && (claims.mode === 'single' || claims.mode === 'script' || claims.mode === 'explain')
      && typeof claims.statementsDigest === 'string' && (claims.cursorOffset === undefined || (typeof claims.cursorOffset === 'number' && Number.isFinite(claims.cursorOffset)))
      && (claims.designerFingerprint === undefined || typeof claims.designerFingerprint === 'string')
      && (claims.designerTargetDigest === undefined || typeof claims.designerTargetDigest === 'string')
      && typeof claims.expiresAt === 'number' && claims.expiresAt > Date.now()
      ? claims
      : undefined;
  } catch {
    return undefined;
  }
}

function statementWarnings(commandType: string, readOnly: boolean): string[] {
  if (readOnly) return [];
  if (/^(DROP|TRUNCATE)$/i.test(commandType)) return ['Destructive operation: objects or rows may be removed.'];
  if (/^(DELETE|UPDATE|MERGE)$/i.test(commandType)) return ['Data-changing operation: verify the target and filter before execution.'];
  if (/^(CREATE|ALTER|COMMENT|RENAME|GRANT|REVOKE|GROOM)$/i.test(commandType)) return ['Schema, permissions, or storage metadata may change.'];
  if (/^(INSERT|CALL|EXEC|EXECUTE|COPY|GENERATE)$/i.test(commandType)) return ['The statement may write data or invoke a procedure with side effects.'];
  return ['This statement is not classified as read-only and requires confirmation.'];
}

function quoteWriteIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) throw new Error(`${field} is required.`);
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function quoteWriteTarget(database: string | undefined, schema: string, table: string, dbType: StoredConnection['dbType'] = 'netezza'): string {
  if (dbType === 'sqlite') {
    const catalog = database?.trim() || schema.trim();
    return `${quoteWriteIdentifier(catalog, 'database')}.${quoteWriteIdentifier(table, 'table')}`;
  }
  return [database, schema, table].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part, index) => quoteWriteIdentifier(part, index === 0 && database ? 'database' : index === 1 || !database ? 'schema' : 'table'))
    .join('.');
}

function sqlWriteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `'${text.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function sqlWritePredicate(column: string, value: unknown, field: string): string {
  const identifier = quoteWriteIdentifier(column, field);
  return value === null || value === undefined ? `${identifier} IS NULL` : `${identifier} = ${sqlWriteLiteral(value)}`;
}

function sortedWriteEntries(values: Record<string, unknown>, field: string): Array<[string, unknown]> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${field} is required.`);
  const entries = Object.entries(values).filter(([key]) => key.trim().length > 0).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error(`${field} must contain at least one column.`);
  return entries;
}

function buildUpdateSql(input: QueryEditPreviewRequest, dbType: StoredConnection['dbType'] = 'netezza'): string {
  const target = quoteWriteTarget(input.database, input.schema, input.table, dbType);
  const changes = sortedWriteEntries(input.changes, 'changes');
  const keys = sortedWriteEntries(input.key, 'key');
  const setClause = changes.map(([column, value]) => `${quoteWriteIdentifier(column, 'column')} = ${sqlWriteLiteral(value)}`).join(', ');
  const whereClause = keys.map(([column, value]) => sqlWritePredicate(column, value, 'key column')).join(' AND ');
  return `UPDATE ${target} SET ${setClause} WHERE ${whereClause};`;
}

function buildInsertSql(input: QueryImportPreviewRequest, dbType: StoredConnection['dbType'] = 'netezza'): string {
  if (!Array.isArray(input.columns) || input.columns.length === 0) throw new Error('At least one import column is required.');
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new Error('At least one import row is required.');
  if (input.rows.length > 10_000) throw new Error('Imports are limited to 10,000 rows per operation.');
  const columns = input.columns.map(column => quoteWriteIdentifier(column, 'column'));
  const rows = input.rows.map(row => {
    if (!Array.isArray(row) || row.length !== input.columns.length) throw new Error('Every import row must match the column count.');
    return `(${row.map(sqlWriteLiteral).join(', ')})`;
  });
  if (rows.length === 0) throw new Error('At least one import row is required.');
  const target = quoteWriteTarget(input.database, input.schema, input.table, dbType);
  return `INSERT INTO ${target} (${columns.join(', ')}) VALUES\n  ${rows.join(',\n  ')};`;
}

interface SpreadsheetReader {
  open(filePath: string): Promise<void>;
  read(): Promise<boolean> | boolean;
  close(): Promise<void>;
  _currentRow?: unknown[];
  /** Internal selection cursor exposed by the package's reader contract. */
  _currentSheetIndex?: number;
  getSheetNames?: () => string[];
  _initSheet?: (index: number) => Promise<void> | void;
}

interface SpreadsheetTasksModule {
  ReaderFactory?: { create(filePath: string): SpreadsheetReader };
}

function parseCsvImport(text: string, delimiter: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && next === '\n') index += 1;
      row.push(field);
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some(value => value.length > 0)) rows.push(row);
  }
  return rows;
}

function importColumnNames(header: unknown[] | undefined, width: number, targetColumns?: string[]): string[] {
  const used = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const original = header?.[index] ?? targetColumns?.[index];
    const base = String(original ?? '').trim() || `column_${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

async function readSpreadsheetImport(filePath: string, sheetName?: string): Promise<unknown[][]> {
  let spreadsheet: SpreadsheetTasksModule;
  try {
    spreadsheet = require('@justybase/spreadsheet-tasks') as SpreadsheetTasksModule;
  } catch (error: unknown) {
    throw new Error(`Spreadsheet import is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const factory = spreadsheet.ReaderFactory;
  if (!factory) throw new Error('Spreadsheet import is unavailable in this installation.');
  const reader = factory.create(filePath);
  try {
    await reader.open(filePath);
    if (sheetName) {
      const sheets = reader.getSheetNames?.() ?? [];
      const sheetIndex = sheets.indexOf(sheetName);
      if (sheetIndex < 0) throw new Error(`Worksheet "${sheetName}" was not found.`);
      if (!reader._initSheet) throw new Error('This spreadsheet reader cannot select a worksheet.');
      await reader._initSheet(sheetIndex);
      // spreadsheet-tasks initializes the cursor to sheet 0 on the first
      // read(). Keep the selected sheet index in sync with the initialized
      // reader so the first read cannot silently switch worksheets.
      reader._currentSheetIndex = sheetIndex;
    }
    const rows: unknown[][] = [];
    while (await reader.read()) {
      const values = reader._currentRow;
      if (Array.isArray(values)) rows.push([...values]);
      if (rows.length > 10_000) throw new Error('Imports are limited to 10,000 rows per operation.');
    }
    return rows;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function materializeFileImport(input: QueryFileImportPreviewRequest, targetColumns?: string[]): Promise<QueryImportPreviewRequest> {
  if (typeof input.fileName !== 'string' || input.fileName.trim().length === 0) throw new Error('fileName is required.');
  if (input.format !== 'csv' && input.format !== 'xlsx' && input.format !== 'xlsb') throw new Error('format must be csv, xlsx, or xlsb.');
  const expectedExtension = ({ csv: 'csv', xlsx: 'xlsx', xlsb: 'xlsb' } as const)[input.format];
  const actualExtension = path.extname(path.basename(input.fileName)).slice(1).toLowerCase();
  if (actualExtension !== expectedExtension) throw new Error(`fileName must use the .${expectedExtension} extension for ${input.format} imports.`);
  if (input.hasHeader !== undefined && typeof input.hasHeader !== 'boolean') throw new Error('hasHeader must be a boolean.');
  if (typeof input.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw new Error('contentBase64 is invalid.');
  const content = Buffer.from(input.contentBase64, 'base64');
  if (content.length === 0) throw new Error('The import file is empty.');
  if (content.length > MAX_IMPORT_FILE_BYTES) throw new Error('Import files are limited to 25 MB.');
  const extension = expectedExtension;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-web-import-'));
  const tempPath = path.join(tempDir, `upload.${extension}`);
  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    const rawRows = input.format === 'csv'
      ? parseCsvImport(content.toString('utf8'), typeof input.delimiter === 'string' && input.delimiter.length === 1 ? input.delimiter : ',')
      : await readSpreadsheetImport(tempPath, input.sheetName);
    if (rawRows.length === 0) throw new Error('The import file does not contain any rows.');
    const width = rawRows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    if (width === 0) throw new Error('The import file does not contain any columns.');
    const hasHeader = input.hasHeader !== false;
    const header = hasHeader ? rawRows[0] : undefined;
    const dataRows = (hasHeader ? rawRows.slice(1) : rawRows).map(row => Array.from({ length: width }, (_, index) => row[index] ?? null));
    if (dataRows.length === 0) throw new Error('The import file contains a header but no data rows.');
    if (!hasHeader && (!targetColumns || targetColumns.length < width)) throw new Error('A headerless import must fit the target table columns.');
    return {
      connectionId: input.connectionId,
      database: input.database,
      schema: input.schema,
      table: input.table,
      columns: importColumnNames(header, width, hasHeader ? undefined : targetColumns),
      rows: dataRows,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function operationPreview(
  context: QueryUseCaseContext,
  userId: string,
  input: { connectionId: string; database?: string; sql: string; rowCount: number; warnings: string[]; dbType?: StoredConnection['dbType'] },
): WriteOperationPreviewResponse {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  if (profile.readOnly) throw new Error('This connection is read-only. Enable write mode for data changes.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const expiresAt = Date.now() + WRITE_PREVIEW_TTL_MS;
  const statement: PlannedStatement = { index: 0, startOffset: 0, endOffset: input.sql.length, sql: input.sql };
  const previewToken = signPreviewClaims({ userId, connectionId: input.connectionId, database, mode: 'single', statementsDigest: plannedDigest('single', [statement]), expiresAt }, context.config.masterKey);
  return { sql: input.sql, previewToken, expiresAt, warnings: input.warnings, rowCount: input.rowCount };
}

function verifyWriteOperation(
  context: QueryUseCaseContext,
  userId: string,
  profile: ReturnType<AppStore['getConnection']>,
  input: { connectionId: string; database: string; sql: string; writeConfirmed: boolean; writePreviewToken: string; dbType?: StoredConnection['dbType'] },
): void {
  if (!profile) throw new Error('Connection profile not found.');
  if (profile.readOnly) throw new Error('This connection is read-only. Enable write mode for data changes.');
  const claims = verifyPreviewClaims(input.writePreviewToken, context.config.masterKey);
  if (!input.writeConfirmed || !claims) throw new Error('Write confirmation required before executing the operation.');
  const statement: PlannedStatement = { index: 0, startOffset: 0, endOffset: input.sql.length, sql: input.sql };
  if (claims.userId !== userId || claims.connectionId !== input.connectionId || claims.database !== input.database || claims.mode !== 'single' || claims.statementsDigest !== plannedDigest('single', [statement])) {
    throw new Error('Write preview is stale. Preview the exact operation again before execution.');
  }
}

async function executeConfirmedWrite(
  context: QueryUseCaseContext,
  userId: string,
  profile: NonNullable<ReturnType<AppStore['getConnection']>>,
  input: { connectionId: string; database: string; sql: string; statementIndex?: number; statementCount?: number; confirmed: boolean },
): Promise<QueryWriteResponse> {
  const startedAt = Date.now();
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const commandType = statementCommandType(input.sql);
  const statementIndex = input.statementIndex ?? 0;
  const statementCount = input.statementCount ?? 1;
  try {
    const execution = context.executionOrchestrator.start({
      executionId: randomUUID(),
      sourceKey: `${userId}:${input.connectionId}:write`,
      target: profile,
      database,
      statements: [{ index: 0, sql: input.sql, originalSql: input.sql, expandedSql: input.sql }],
      delivery: 'buffered',
      connectionMode: 'persistent',
      maxRows: DEFAULT_ROW_LIMIT,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      readOnly: false,
      retryPolicy: 'disabled',
      continueOnError: false,
    });
    const summary = await execution.settled;
    if (summary.status !== 'success') {
      throw summary.error?.cause ?? new Error(summary.error?.message ?? 'Write execution failed.');
    }
    const result = summary.statements[0];
    const rowsAffected = result?.rowsAffected ?? result?.totalRows ?? 0;
    const message = `${commandType} completed · ${rowsAffected.toLocaleString()} row(s) affected.`;
    context.store.addHistory(userId, input.connectionId, database, input.sql, 'success', Date.now() - startedAt, rowsAffected);
    recordAudit(context, userId, { connectionId: input.connectionId, database, statementIndex, statementCount, commandType, sql: input.sql, status: 'success', rowsAffected, durationMs: Date.now() - startedAt, confirmed: input.confirmed });
    if (isSchemaMutation(commandType)) {
      context.metadataService.invalidate(userId, input.connectionId);
      for (const session of context.lspSessions) session.invalidateConnection(input.connectionId);
    }
    return { sql: input.sql, rowsAffected, message };
  } catch (error: unknown) {
    recordAudit(context, userId, { connectionId: input.connectionId, database, statementIndex, statementCount, commandType, sql: input.sql, status: 'error', rowsAffected: 0, durationMs: Date.now() - startedAt, confirmed: input.confirmed });
    throw error;
  }
}

async function previewEdit(
  context: QueryUseCaseContext,
  userId: string,
  input: QueryEditPreviewRequest,
): Promise<WriteOperationPreviewResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const sql = buildUpdateSql({ ...input, database }, profile.dbType);
  return operationPreview(context, userId, {
    connectionId: input.connectionId,
    database,
    sql,
    rowCount: 1,
    warnings: ['The selected row will be updated. Verify the key columns and new values before execution.'],
  });
}

async function executeEdit(context: QueryUseCaseContext, userId: string, input: QueryEditRequest): Promise<QueryWriteResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const sql = buildUpdateSql({ ...input, database }, profile.dbType);
  verifyWriteOperation(context, userId, profile, {
    connectionId: input.connectionId,
    database,
    sql,
    writeConfirmed: input.writeConfirmed,
    writePreviewToken: input.writePreviewToken,
  });
  return executeConfirmedWrite(context, userId, profile, {
    connectionId: input.connectionId,
    database,
    sql,
    confirmed: input.writeConfirmed,
  });
}

async function previewImport(
  context: QueryUseCaseContext,
  userId: string,
  input: QueryImportPreviewRequest,
): Promise<WriteOperationPreviewResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const sql = buildInsertSql({ ...input, database }, profile.dbType);
  return operationPreview(context, userId, {
    connectionId: input.connectionId,
    database,
    sql,
    rowCount: input.rows.length,
    warnings: [`${input.rows.length.toLocaleString()} row(s) will be inserted. Verify the target table and column mapping before execution.`],
  });
}

async function executeImport(context: QueryUseCaseContext, userId: string, input: QueryImportRequest): Promise<QueryWriteResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const sql = buildInsertSql({ ...input, database }, profile.dbType);
  verifyWriteOperation(context, userId, profile, {
    connectionId: input.connectionId,
    database,
    sql,
    writeConfirmed: input.writeConfirmed,
    writePreviewToken: input.writePreviewToken,
  });
  return executeConfirmedWrite(context, userId, profile, {
    connectionId: input.connectionId,
    database,
    sql,
    confirmed: input.writeConfirmed,
  });
}

async function previewFileImport(
  context: QueryUseCaseContext,
  userId: string,
  input: QueryFileImportPreviewRequest,
): Promise<WriteOperationPreviewResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const targetColumns = input.hasHeader === false
    ? (await context.databaseRuntimes.listColumns(profile, database, input.schema, input.table)).map(column => column.name)
    : undefined;
  const materialized = await materializeFileImport(input, targetColumns);
  const sql = buildInsertSql({ ...materialized, database }, profile.dbType);
  return operationPreview(context, userId, {
    connectionId: materialized.connectionId,
    database,
    sql,
    rowCount: materialized.rows.length,
    warnings: [`${materialized.rows.length.toLocaleString()} row(s) from ${input.fileName.trim()} will be inserted. Verify the target table and column mapping before execution.`],
  });
}

async function executeFileImport(context: QueryUseCaseContext, userId: string, input: QueryFileImportRequest): Promise<QueryWriteResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const previewDatabase = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const targetColumns = input.hasHeader === false
    ? (await context.databaseRuntimes.listColumns(profile, previewDatabase, input.schema, input.table)).map(column => column.name)
    : undefined;
  const materialized = await materializeFileImport(input, targetColumns);
  const database = effectiveDatabase(context.databaseRuntimes, profile, materialized.database);
  const sql = buildInsertSql({ ...materialized, database }, profile.dbType);
  verifyWriteOperation(context, userId, profile, {
    connectionId: materialized.connectionId,
    database,
    sql,
    writeConfirmed: input.writeConfirmed,
    writePreviewToken: input.writePreviewToken,
  });
  return executeConfirmedWrite(context, userId, profile, {
    connectionId: materialized.connectionId,
    database,
    sql,
    confirmed: input.writeConfirmed,
  });
}

function recordAudit(
  context: QueryUseCaseContext,
  userId: string,
  entry: {
    connectionId: string;
    database: string;
    statementIndex: number;
    statementCount: number;
    commandType: string;
    sql: string;
    status: QueryAuditStatus;
    rowsAffected?: number;
    durationMs: number;
    confirmed: boolean;
  },
): void {
  try {
    context.store.addAudit(userId, { ...entry, createdAt: new Date().toISOString() });
  } catch (error: unknown) {
    context.log.warn({ error }, 'Could not persist query audit entry.');
  }
}

function statementMessage(commandType: string, result: { totalRows: number; limitReached: boolean; rowsAffected?: number }): string | undefined {
  if (result.limitReached) return `Row limit reached (${result.totalRows.toLocaleString()} rows).`;
  if (!['SELECT', 'WITH', 'VALUES', 'PRAGMA', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC'].includes(commandType)) {
    return result.rowsAffected !== undefined
      ? `${commandType} completed · ${result.rowsAffected.toLocaleString()} row(s) affected.`
      : `${commandType} completed.`;
  }
  return undefined;
}

function hasExecutableSql(sql: string): boolean {
  let remaining = sql.trim();
  while (remaining) {
    if (remaining.startsWith('--')) {
      const newline = remaining.search(/[\r\n]/);
      remaining = newline < 0 ? '' : remaining.slice(newline).trimStart();
      continue;
    }
    if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      remaining = end < 0 ? '' : remaining.slice(end + 2).trimStart();
      continue;
    }
    return true;
  }
  return false;
}

function explainSql(sql: string, dbType: StoredConnection['dbType']): string {
  if (dbType === 'duckdb') return `EXPLAIN ${sql.trim()}`;
  if (dbType === 'sqlite' && /^(?:SELECT|WITH)\b/i.test(sql.trim())) return `EXPLAIN QUERY PLAN ${sql.trim()}`;
  if (dbType === 'sqlite') return `EXPLAIN ${sql.trim()}`;
  return `EXPLAIN VERBOSE ${sql.trim()}`;
}

export function planStatements(input: QueryStartRequest, dbType: StoredConnection['dbType'] = 'netezza'): { mode: QueryExecutionMode; statements: PlannedStatement[] } {
  const requestedMode = input.mode ?? 'single';
  if (requestedMode !== 'single' && requestedMode !== 'script' && requestedMode !== 'explain') throw new Error('mode must be single, script, or explain.');
  if (input.cursorOffset !== undefined && (!Number.isInteger(input.cursorOffset) || input.cursorOffset < 0 || input.cursorOffset > input.sql.length)) throw new Error('cursorOffset must be a valid SQL character offset.');
  const mode: QueryExecutionMode = requestedMode;
  if (mode === 'script') {
    const statements = splitSqlStatements(input.sql).filter(statement => hasExecutableSql(statement.sql)).map((statement, index) => ({
      index,
      startOffset: statement.startOffset,
      endOffset: statement.endOffset,
      sql: statement.sql,
    }));
    if (statements.length === 0) throw new Error('SQL script does not contain an executable statement.');
    return { mode, statements };
  }

  if (typeof input.cursorOffset === 'number' && Number.isFinite(input.cursorOffset)) {
    const statement = getSqlStatementAtPosition(input.sql, input.cursorOffset);
    if (statement && hasExecutableSql(statement.sql)) {
      const sql = mode === 'explain' ? explainSql(statement.sql, dbType) : statement.sql;
      return { mode, statements: [{ index: 0, startOffset: statement.start, endOffset: statement.end, sql }] };
    }
  }

  const sql = input.sql.trim();
  if (!hasExecutableSql(sql)) throw new Error('SQL is required.');
  return { mode, statements: [{ index: 0, startOffset: input.sql.indexOf(sql), endOffset: input.sql.indexOf(sql) + sql.length, sql: mode === 'explain' ? explainSql(sql, dbType) : sql }] };
}

async function assertDesignerSnapshotCurrent(
  context: QueryUseCaseContext,
  profile: StoredConnection,
  input: QueryStartRequest,
): Promise<void> {
  const designer = input.designer;
  if (!designer) return;
  if (designer.target.connectionId && designer.target.connectionId !== input.connectionId) {
    throw new Error('Designer target does not belong to the selected connection.');
  }
  const target: DesignerSnapshotRequest = {
    connectionId: input.connectionId,
    database: designer.target.database ?? input.database,
    schema: designer.target.schema,
    objectName: designer.target.objectName,
    objectType: designer.target.objectType,
  };
  const response = await getDesignerSnapshotResponse(profile, target, context.databaseRuntimes);
  if (response.snapshot.fingerprint !== designer.baseFingerprint) {
    throw new StaleDesignerSnapshotError(designer.baseFingerprint, response.snapshot.fingerprint);
  }
}

export async function previewQuery(context: QueryUseCaseContext, userId: string, input: QueryStartRequest): Promise<QueryPreviewResponse> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const planned = planStatements(input, profile.dbType);
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const statements: QueryPreviewStatement[] = planned.statements.map(statement => {
    const commandType = statementCommandType(statement.sql);
    const readOnly = context.databaseRuntimes.isReadOnlySql(profile, statement.sql);
    return {
      index: statement.index,
      startOffset: statement.startOffset,
      endOffset: statement.endOffset,
      sql: statement.sql,
      commandType,
      readOnly,
      warnings: statementWarnings(commandType, readOnly),
    };
  });
  const containsWrite = statements.some(statement => !statement.readOnly);
  if (containsWrite) await assertDesignerSnapshotCurrent(context, profile, input);
  const expiresAt = Date.now() + WRITE_PREVIEW_TTL_MS;
  const previewToken = signPreviewClaims({
    userId,
    connectionId: input.connectionId,
    database,
    mode: planned.mode,
    cursorOffset: input.cursorOffset,
    statementsDigest: plannedDigest(planned.mode, planned.statements),
    ...(input.designer ? { designerFingerprint: input.designer.baseFingerprint, designerTargetDigest: designerTargetDigest(input.designer.target) } : {}),
    expiresAt,
  }, context.config.masterKey);
  return { database, readOnly: profile.readOnly, containsWrite, previewToken, expiresAt, statements };
}

async function startQuery(context: QueryUseCaseContext, userId: string, input: QueryStartRequest): Promise<{ queryId: string; statementCount: number }> {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  if (!input.sql.trim()) throw new Error('SQL is required.');
  const planned = planStatements(input, profile.dbType);
  const containsWrite = planned.statements.some(statement => !context.databaseRuntimes.isReadOnlySql(profile, statement.sql));
  if (profile.readOnly && containsWrite) throw new Error('This connection is read-only. Enable write mode for DDL or DML.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  if (!profile.readOnly && containsWrite) {
    const claims = typeof input.writePreviewToken === 'string' ? verifyPreviewClaims(input.writePreviewToken, context.config.masterKey) : undefined;
    if (input.writeConfirmed !== true || !claims) throw new Error('Write confirmation required before executing DML or DDL.');
    if (claims.userId !== userId || claims.connectionId !== input.connectionId || claims.database !== database || claims.mode !== planned.mode || claims.cursorOffset !== input.cursorOffset || claims.statementsDigest !== plannedDigest(planned.mode, planned.statements) || claims.designerFingerprint !== input.designer?.baseFingerprint || claims.designerTargetDigest !== (input.designer ? designerTargetDigest(input.designer.target) : undefined)) {
      throw new Error('Write preview is stale. Preview the exact SQL again before execution.');
    }
    await assertDesignerSnapshotCurrent(context, profile, input);
  }

  const queryId = randomUUID();
  let resolveJobSettled!: () => void;
  const jobSettled = new Promise<void>(resolve => { resolveJobSettled = resolve; });
  const job: QueryJob = {
    id: queryId,
    userId,
    connectionId: input.connectionId,
    database,
    mode: planned.mode,
    statements: planned.statements,
    events: [],
    subscribers: new Set(),
    sessionIds: new Map(),
    sequence: 0,
    cancelRequested: false,
    done: false,
    settled: jobSettled,
    resolveSettled: resolveJobSettled,
  };
  context.queryJobs.set(queryId, job);
  const startedAt = Date.now();
  const statementStates = new Map<number, {
    sessionId: string;
    statementStartedAt: number;
    commandType: string;
    totalRows: number;
    terminalized: boolean;
  }>();
  let completedStatements = 0;
  let cleanupScheduled = false;

  const scheduleJobCleanup = (): void => {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    job.cleanupTimer = setTimeout(() => {
      job.cleanupTimer = undefined;
      context.queryJobs.delete(queryId);
    }, QUERY_JOB_TTL_MS);
    job.cleanupTimer.unref();
  };

  const execution = context.executionOrchestrator.start({
    executionId: queryId,
    sourceKey: `${userId}:${input.connectionId}`,
    target: profile,
    database,
    statements: planned.statements.map(statement => ({
      index: statement.index,
      sql: statement.sql,
      originalSql: statement.sql,
      expandedSql: statement.sql,
    })),
    delivery: 'streaming',
    connectionMode: 'persistent',
    maxRows: input.maxRows ?? DEFAULT_ROW_LIMIT,
    timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    readOnly: profile.readOnly,
    retryPolicy: 'safe-read-only-on-broken-connection',
    continueOnError: false,
  }, {
    onEvent: async (event: ExecutionEvent): Promise<void> => {
      switch (event.type) {
        case 'execution-started':
          emit(job, { type: 'started', queryId, startedAt, mode: job.mode, statementCount: job.statements.length });
          return;
        case 'statement-started': {
          const statementIndex = event.context.statementIndex;
          const statement = job.statements[statementIndex];
          if (!statement) throw new Error(`Execution started unknown statement ${statementIndex}.`);
          const sessionId = context.querySessions.create(queryId, userId, input.connectionId, [], statementIndex, job.statements.length);
          const state = {
            sessionId,
            statementStartedAt: Date.now(),
            commandType: statementCommandType(statement.sql),
            totalRows: 0,
            terminalized: false,
          };
          statementStates.set(statementIndex, state);
          job.sessionIds.set(statementIndex, sessionId);
          job.activeStatementIndex = statementIndex;
          emit(job, { type: 'statement-started', queryId, statementIndex, statementCount: job.statements.length, statementSql: statement.sql });
          emit(job, { type: 'session', queryId, statementIndex, statementCount: job.statements.length, sessionId, totalRows: 0 });
          return;
        }
        case 'columns': {
          const statementIndex = event.context.statementIndex;
          const state = statementStates.get(statementIndex);
          if (!state) throw new Error(`Received columns before statement ${statementIndex} started.`);
          context.querySessions.setColumns(userId, state.sessionId, event.columns);
          emit(job, { type: 'columns', queryId, statementIndex, statementCount: job.statements.length, columns: event.columns });
          return;
        }
        case 'rows': {
          const statementIndex = event.context.statementIndex;
          const state = statementStates.get(statementIndex);
          if (!state) throw new Error(`Received rows before statement ${statementIndex} started.`);
          state.totalRows = context.querySessions.appendRows(userId, state.sessionId, event.rows);
          emit(job, { type: 'progress', queryId, statementIndex, statementCount: job.statements.length, totalRows: state.totalRows });
          return;
        }
        case 'statement-completed': {
          const statementIndex = event.context.statementIndex;
          const statement = job.statements[statementIndex];
          const state = statementStates.get(statementIndex);
          if (!statement || !state) throw new Error(`Completed unknown statement ${statementIndex}.`);
          const result = event.summary;
          const message = statementMessage(state.commandType, result);
          state.totalRows = context.querySessions.complete(userId, state.sessionId, {
            limitReached: result.limitReached,
            message,
            ...(result.rowsAffected === undefined ? {} : { rowsAffected: result.rowsAffected }),
          });
          state.terminalized = true;
          emit(job, {
            type: 'complete',
            queryId,
            statementIndex,
            statementCount: job.statements.length,
            totalRows: state.totalRows,
            limitReached: result.limitReached,
            ...(result.rowsAffected === undefined ? {} : { rowsAffected: result.rowsAffected }),
            ...(message === undefined ? {} : { message }),
            commandType: state.commandType,
          });
          context.store.addHistory(userId, input.connectionId, database, statement.sql, 'success', Date.now() - startedAt, result.rowsAffected ?? state.totalRows);
          recordAudit(context, userId, {
            connectionId: input.connectionId,
            database,
            statementIndex,
            statementCount: job.statements.length,
            commandType: state.commandType,
            sql: statement.sql,
            status: 'success',
            rowsAffected: result.rowsAffected ?? state.totalRows,
            durationMs: Date.now() - state.statementStartedAt,
            confirmed: input.writeConfirmed === true,
          });
          if (isSchemaMutation(state.commandType)) {
            context.metadataService.invalidate(userId, input.connectionId);
            for (const session of context.lspSessions) session.invalidateConnection(input.connectionId);
          }
          completedStatements += 1;
          return;
        }
        case 'statement-failed': {
          const statementIndex = event.context.statementIndex;
          const statement = job.statements[statementIndex];
          const state = statementStates.get(statementIndex);
          if (state?.terminalized) return;
          if (!statement) throw new Error(`Failed unknown statement ${statementIndex}.`);
          const cancelled = event.failure.kind === 'cancellation';
          const message = cancelled ? 'Query cancelled.' : event.failure.message;
          const totalRows = state?.totalRows ?? 0;
          if (state) {
            context.querySessions.complete(userId, state.sessionId, { message });
            state.terminalized = true;
          }
          if (cancelled) {
            emit(job, { type: 'cancelled', queryId, statementIndex, statementCount: job.statements.length, totalRows, scope: job.mode === 'script' ? 'batch' : 'statement' });
          } else {
            emit(job, { type: 'error', queryId, statementIndex, statementCount: job.statements.length, message });
          }
          const status: QueryAuditStatus = cancelled ? 'cancelled' : 'error';
          context.store.addHistory(userId, input.connectionId, database, statement.sql, status, Date.now() - startedAt, totalRows);
          recordAudit(context, userId, {
            connectionId: input.connectionId,
            database,
            statementIndex,
            statementCount: job.statements.length,
            commandType: state?.commandType ?? statementCommandType(statement.sql),
            sql: statement.sql,
            status,
            rowsAffected: totalRows,
            durationMs: Date.now() - (state?.statementStartedAt ?? startedAt),
            confirmed: input.writeConfirmed === true,
          });
          return;
        }
        case 'execution-terminal': {
          if (event.summary.status === 'success') return;
          const statementIndex = job.activeStatementIndex ?? job.statements[0]?.index ?? 0;
          const statement = job.statements[statementIndex];
          const state = statementStates.get(statementIndex);
          const cleanupFailure = event.summary.error?.kind === 'cleanup';
          if (state?.terminalized && !cleanupFailure) return;
          const cancelled = event.summary.status === 'cancelled';
          const message = cancelled ? 'Query cancelled.' : event.summary.error?.message ?? 'Query failed.';
          const totalRows = state?.totalRows ?? 0;
          if (state && !state.terminalized) {
            context.querySessions.complete(userId, state.sessionId, { message });
            state.terminalized = true;
          }
          if (cancelled) {
            emit(job, { type: 'cancelled', queryId, statementIndex, statementCount: job.statements.length, totalRows, scope: job.mode === 'script' ? 'batch' : 'statement' });
          } else {
            emit(job, { type: 'error', queryId, statementIndex, statementCount: job.statements.length, message });
          }
          if (statement) {
            const status: QueryAuditStatus = cancelled ? 'cancelled' : 'error';
            context.store.addHistory(userId, input.connectionId, database, statement.sql, status, Date.now() - startedAt, totalRows);
            recordAudit(context, userId, {
              connectionId: input.connectionId,
              database,
              statementIndex,
              statementCount: job.statements.length,
              commandType: state?.commandType ?? statementCommandType(statement.sql),
              sql: statement.sql,
              status,
              rowsAffected: totalRows,
              durationMs: Date.now() - (state?.statementStartedAt ?? startedAt),
              confirmed: input.writeConfirmed === true,
            });
          }
          return;
        }
        case 'batch-completed': {
          const status = event.summary.status === 'success' ? 'complete' : event.summary.status;
          const message = status === 'cancelled'
            ? 'Query batch cancelled.'
            : status === 'error'
              ? `Statement ${(job.activeStatementIndex ?? Math.max(0, completedStatements)) + 1} failed; subsequent statements were not executed.`
              : undefined;
          emit(job, {
            type: 'batch-complete',
            queryId,
            statementCount: job.statements.length,
            status,
            completedStatements,
            ...(message === undefined ? {} : { message }),
          });
          job.done = true;
          job.cancel = undefined;
          job.activeStatementIndex = undefined;
          job.resolveSettled();
          scheduleJobCleanup();
          return;
        }
        case 'retrying':
          context.log.debug({ queryId, statementIndex: event.context.statementIndex, attempt: event.retry.attempt }, 'Retrying a safe read-only query after a broken connection.');
          return;
        case 'progress':
          return;
      }
    },
  });
  job.cancel = () => execution.cancel();
  void execution.settled.then(() => {
    job.done = true;
    job.cancel = undefined;
    job.activeStatementIndex = undefined;
    job.resolveSettled();
    scheduleJobCleanup();
  });
  return { queryId, statementCount: job.statements.length };
}

export interface ApiQueryUseCases {
  previewQuery(userId: string, input: QueryStartRequest): Promise<QueryPreviewResponse>;
  startQuery(userId: string, input: QueryStartRequest): Promise<{ queryId: string; statementCount: number }>;
  editPreview(userId: string, input: QueryEditPreviewRequest): Promise<WriteOperationPreviewResponse>;
  edit(userId: string, input: QueryEditRequest): Promise<QueryWriteResponse>;
  importPreview(userId: string, input: QueryImportPreviewRequest): Promise<WriteOperationPreviewResponse>;
  importRows(userId: string, input: QueryImportRequest): Promise<QueryWriteResponse>;
  importFilePreview(userId: string, input: QueryFileImportPreviewRequest): Promise<WriteOperationPreviewResponse>;
  importFile(userId: string, input: QueryFileImportRequest): Promise<QueryWriteResponse>;
}

export function createApiQueryUseCases(context: QueryUseCaseContext): ApiQueryUseCases {
  return {
    previewQuery: (userId, input) => previewQuery(context, userId, input),
    startQuery: (userId, input) => startQuery(context, userId, input),
    editPreview: (userId, input) => previewEdit(context, userId, input),
    edit: (userId, input) => executeEdit(context, userId, input),
    importPreview: (userId, input) => previewImport(context, userId, input),
    importRows: (userId, input) => executeImport(context, userId, input),
    importFilePreview: (userId, input) => previewFileImport(context, userId, input),
    importFile: (userId, input) => executeFileImport(context, userId, input),
  };
}
