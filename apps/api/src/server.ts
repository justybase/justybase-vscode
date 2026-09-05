import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { AdminRestoreRequest, AdminUserCreateRequest, AdminUserUpdateRequest, ConnectionProfileInput, ConnectionProfileUpdate, DesignerSnapshotRequest, QueryAuditStatus, QueryEditPreviewRequest, QueryEditRequest, QueryEvent, QueryFileImportPreviewRequest, QueryFileImportRequest, QueryImportPreviewRequest, QueryImportRequest, QueryPreviewResponse, QueryPreviewStatement, QueryStartRequest, QueryExecutionMode, QueryWriteResponse, WriteOperationPreviewResponse } from '@justybase/contracts';
import { StaleDesignerSnapshotError } from '@justybase/database-runtime';
import { getSqlStatementAtPosition, splitSqlStatements } from '@justybase/sql-core';
import { type ApiConfig } from './config';
import { encryptSecret, verifyPassword } from './security';
import { AppStore, type StoredConnection } from './store';
import { closeEmbeddedDatabases, closeDuckDbDatabase, closeSqliteDatabase, executeNetezzaQuery, isProfileReadOnlySql, listColumns, listDatabases, listObjects, listSchemas, normalizeDuckDbCatalog } from './netezza';
import { formatSqlDocument, invalidateSqlMetadataCache, provideSqlCompletion, provideSqlDiagnostics } from './lsp';
import { QuerySessionManager } from './querySessions';
import { getSchemaTree, invalidateSchemaCache, searchSchema } from './schemaService';
import { attachLspSocket, type LspSession } from './lspProtocol';
import { createQueryExportStream } from './queryExport';
import { loadNetezzaSnippets } from './snippets';
import { getDesignerCapabilitiesResponse } from './designerService';
import { DesignerSnapshotUnavailableError, getDesignerSnapshotResponse } from './designerSnapshotService';
import {
  parseDesignerCapabilitiesRequest,
  parseQueryAggregateRequest,
  parseQueryExportRequest,
  parseQueryGroupRequest,
  parseQueryPageRequest,
  parseQueryStartRequest,
  RequestValidationError,
} from './requestValidation';

const SESSION_COOKIE = 'justybase_session';
const CSRF_COOKIE = 'justybase_csrf';
const DEFAULT_ROW_LIMIT = 200_000;
const DEFAULT_TIMEOUT_SECONDS = 1_800;
const QUERY_JOB_TTL_MS = 60 * 60 * 1000;
const WRITE_PREVIEW_TTL_MS = 5 * 60 * 1000;
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 60_000 };
const QUERY_RATE_LIMIT = { max: 120, windowMs: 60_000 };
const MAX_ADMIN_BACKUP_BYTES = 100 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
const REQUEST_BODY_OVERHEAD_BYTES = 1024 * 1024;
const MAX_ADMIN_RESTORE_BODY_BYTES = Math.ceil(MAX_ADMIN_BACKUP_BYTES / 3) * 4 + REQUEST_BODY_OVERHEAD_BYTES;
const MAX_IMPORT_BODY_BYTES = Math.ceil(MAX_IMPORT_FILE_BYTES / 3) * 4 + REQUEST_BODY_OVERHEAD_BYTES;

interface RateLimitBucket { count: number; resetAt: number; }
const rateLimitBuckets = new Map<string, RateLimitBucket>();

interface QueryJob {
  id: string;
  userId: string;
  connectionId: string;
  database: string;
  mode: QueryExecutionMode;
  statements: PlannedStatement[];
  events: QueryEvent[];
  subscribers: Set<{ send(data: string): void; readyState: number }>;
  cancel?: () => Promise<void>;
  sessionIds: Map<number, string>;
  sequence: number;
  activeStatementIndex?: number;
  cancelRequested: boolean;
  done: boolean;
}

export interface PlannedStatement {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
}

interface LoginBody { username?: string; password?: string; }

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError('request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function clientErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number'
    && Number.isInteger(statusCode)
    && statusCode >= 400
    && statusCode < 500
    ? statusCode
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required.`);
  return value.trim();
}

function connectionKind(value: unknown): 'netezza' | 'sqlite' | 'duckdb' {
  return value === 'sqlite' || value === 'duckdb' ? value : 'netezza';
}

function optionalLocalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function effectiveDatabase(profile: StoredConnection, requested: string | undefined): string {
  const value = requested?.trim() || profile.database.trim();
  if (profile.dbType === 'sqlite') return requested?.trim() || 'main';
  if (profile.dbType === 'duckdb') return normalizeDuckDbCatalog(value);
  return value;
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
  reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), { httpOnly: false, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  const user = token ? request.server.store.findUserBySession(token) : undefined;
  if (!user) {
    await reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'Login required.' });
    return;
  }
  request.user = user;
  request.sessionId = token ?? null;
}

async function validateCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers['x-justybase-csrf'];
  if (!cookieToken || typeof headerToken !== 'string' || cookieToken !== headerToken) {
    await reply.code(403).send({ code: 'CSRF_FAILED', message: 'CSRF validation failed.' });
  }
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user?.role !== 'admin') await reply.code(403).send({ code: 'FORBIDDEN', message: 'Administrator role required.' });
}

function rateLimit(key: string, max: number, windowMs: number): number | undefined {
  const now = Date.now();
  if (rateLimitBuckets.size > 1_000) {
    for (const [bucketKey, bucket] of rateLimitBuckets) if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey);
  }
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return undefined;
  }
  existing.count += 1;
  if (existing.count <= max) return undefined;
  return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
}

async function loginRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const retryAfter = rateLimit(`login:${request.ip}`, LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs);
  if (retryAfter !== undefined) {
    reply.header('Retry-After', String(retryAfter));
    await reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' });
  }
}

async function queryRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const retryAfter = rateLimit(`query:${request.user?.id ?? request.ip}`, QUERY_RATE_LIMIT.max, QUERY_RATE_LIMIT.windowMs);
  if (retryAfter !== undefined) {
    reply.header('Retry-After', String(retryAfter));
    await reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many query requests. Try again later.' });
  }
}

function decodeBase64Upload(value: unknown, field: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${field} is invalid.`);
  const content = Buffer.from(value, 'base64');
  if (content.length === 0) throw new Error(`${field} is empty.`);
  if (content.length > maxBytes) throw new Error(`${field} exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`);
  return content;
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
  app: FastifyInstance,
  userId: string,
  input: { connectionId: string; database?: string; sql: string; rowCount: number; warnings: string[]; dbType?: StoredConnection['dbType'] },
): WriteOperationPreviewResponse {
  const profile = app.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  if (profile.readOnly) throw new Error('This connection is read-only. Enable write mode for data changes.');
  const database = effectiveDatabase(profile, input.database);
  const expiresAt = Date.now() + WRITE_PREVIEW_TTL_MS;
  const statement: PlannedStatement = { index: 0, startOffset: 0, endOffset: input.sql.length, sql: input.sql };
  const previewToken = signPreviewClaims({ userId, connectionId: input.connectionId, database, mode: 'single', statementsDigest: plannedDigest('single', [statement]), expiresAt }, app.apiConfig.masterKey);
  return { sql: input.sql, previewToken, expiresAt, warnings: input.warnings, rowCount: input.rowCount };
}

function verifyWriteOperation(
  app: FastifyInstance,
  userId: string,
  profile: ReturnType<FastifyInstance['store']['getConnection']>,
  input: { connectionId: string; database: string; sql: string; writeConfirmed: boolean; writePreviewToken: string; dbType?: StoredConnection['dbType'] },
): void {
  if (!profile) throw new Error('Connection profile not found.');
  if (profile.readOnly) throw new Error('This connection is read-only. Enable write mode for data changes.');
  const claims = verifyPreviewClaims(input.writePreviewToken, app.apiConfig.masterKey);
  if (!input.writeConfirmed || !claims) throw new Error('Write confirmation required before executing the operation.');
  const statement: PlannedStatement = { index: 0, startOffset: 0, endOffset: input.sql.length, sql: input.sql };
  if (claims.userId !== userId || claims.connectionId !== input.connectionId || claims.database !== input.database || claims.mode !== 'single' || claims.statementsDigest !== plannedDigest('single', [statement])) {
    throw new Error('Write preview is stale. Preview the exact operation again before execution.');
  }
}

async function executeConfirmedWrite(
  app: FastifyInstance,
  userId: string,
  profile: NonNullable<ReturnType<FastifyInstance['store']['getConnection']>>,
  input: { connectionId: string; database: string; sql: string; statementIndex?: number; statementCount?: number; confirmed: boolean },
): Promise<QueryWriteResponse> {
  const startedAt = Date.now();
  const database = effectiveDatabase(profile, input.database);
  const commandType = statementCommandType(input.sql);
  const statementIndex = input.statementIndex ?? 0;
  const statementCount = input.statementCount ?? 1;
  try {
    const result = await executeNetezzaQuery(profile, input.sql, {
      masterKey: app.apiConfig.masterKey,
      maxRows: DEFAULT_ROW_LIMIT,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      readOnly: false,
      database,
    }, { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined });
    const rowsAffected = result.rowsAffected ?? result.totalRows;
    const message = `${commandType} completed · ${rowsAffected.toLocaleString()} row(s) affected.`;
    app.store.addHistory(userId, input.connectionId, database, input.sql, 'success', Date.now() - startedAt, rowsAffected);
    recordAudit(app, userId, { connectionId: input.connectionId, database, statementIndex, statementCount, commandType, sql: input.sql, status: 'success', rowsAffected, durationMs: Date.now() - startedAt, confirmed: input.confirmed });
    if (isSchemaMutation(commandType)) {
      invalidateSchemaCache(input.connectionId);
      invalidateSqlMetadataCache(input.connectionId);
      for (const session of app.lspSessions) session.invalidateConnection(input.connectionId);
    }
    return { sql: input.sql, rowsAffected, message };
  } catch (error: unknown) {
    recordAudit(app, userId, { connectionId: input.connectionId, database, statementIndex, statementCount, commandType, sql: input.sql, status: 'error', rowsAffected: 0, durationMs: Date.now() - startedAt, confirmed: input.confirmed });
    throw error;
  }
}

function recordAudit(
  app: FastifyInstance,
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
    app.store.addAudit(userId, { ...entry, createdAt: new Date().toISOString() });
  } catch (error: unknown) {
    app.log.warn({ error }, 'Could not persist query audit entry.');
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
  app: FastifyInstance,
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
  const response = await getDesignerSnapshotResponse(profile, target, app.apiConfig.masterKey);
  if (response.snapshot.fingerprint !== designer.baseFingerprint) {
    throw new StaleDesignerSnapshotError(designer.baseFingerprint, response.snapshot.fingerprint);
  }
}

export async function previewQuery(app: FastifyInstance, userId: string, input: QueryStartRequest): Promise<QueryPreviewResponse> {
  const profile = app.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  const planned = planStatements(input, profile.dbType);
  const database = effectiveDatabase(profile, input.database);
  const statements: QueryPreviewStatement[] = planned.statements.map(statement => {
    const commandType = statementCommandType(statement.sql);
    const readOnly = isProfileReadOnlySql(profile, statement.sql);
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
  if (containsWrite) await assertDesignerSnapshotCurrent(app, profile, input);
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
  }, app.apiConfig.masterKey);
  return { database, readOnly: profile.readOnly, containsWrite, previewToken, expiresAt, statements };
}

async function startQuery(app: FastifyInstance, userId: string, input: QueryStartRequest): Promise<{ queryId: string; statementCount: number }> {
  const profile = app.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  if (!input.sql.trim()) throw new Error('SQL is required.');
  const planned = planStatements(input, profile.dbType);
  const containsWrite = planned.statements.some(statement => !isProfileReadOnlySql(profile, statement.sql));
  if (profile.readOnly && containsWrite) throw new Error('This connection is read-only. Enable write mode for DDL or DML.');
  const database = effectiveDatabase(profile, input.database);
  if (!profile.readOnly && containsWrite) {
    const claims = typeof input.writePreviewToken === 'string' ? verifyPreviewClaims(input.writePreviewToken, app.apiConfig.masterKey) : undefined;
    if (input.writeConfirmed !== true || !claims) throw new Error('Write confirmation required before executing DML or DDL.');
    if (claims.userId !== userId || claims.connectionId !== input.connectionId || claims.database !== database || claims.mode !== planned.mode || claims.cursorOffset !== input.cursorOffset || claims.statementsDigest !== plannedDigest(planned.mode, planned.statements) || claims.designerFingerprint !== input.designer?.baseFingerprint || claims.designerTargetDigest !== (input.designer ? designerTargetDigest(input.designer.target) : undefined)) {
      throw new Error('Write preview is stale. Preview the exact SQL again before execution.');
    }
    await assertDesignerSnapshotCurrent(app, profile, input);
  }

  const queryId = randomUUID();
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
  };
  app.queryJobs.set(queryId, job);
  void (async () => {
    const startedAt = Date.now();
    emit(job, { type: 'started', queryId, startedAt, mode: job.mode, statementCount: job.statements.length });
    let completedStatements = 0;
    try {
      for (const statement of job.statements) {
        job.activeStatementIndex = statement.index;
        if (job.cancelRequested) {
          emit(job, { type: 'cancelled', queryId, statementIndex: statement.index, statementCount: job.statements.length, totalRows: 0, scope: 'batch' });
          emit(job, { type: 'batch-complete', queryId, statementCount: job.statements.length, status: 'cancelled', completedStatements, message: 'Query batch cancelled.' });
          recordAudit(app, userId, {
            connectionId: input.connectionId,
            database,
            statementIndex: statement.index,
            statementCount: job.statements.length,
            commandType: statementCommandType(statement.sql),
            sql: statement.sql,
            status: 'cancelled',
            durationMs: 0,
            confirmed: input.writeConfirmed === true,
          });
          break;
        }

        emit(job, { type: 'statement-started', queryId, statementIndex: statement.index, statementCount: job.statements.length, statementSql: statement.sql });
        const sessionId = app.querySessions.create(queryId, userId, input.connectionId, [], statement.index, job.statements.length);
        job.sessionIds.set(statement.index, sessionId);
        emit(job, { type: 'session', queryId, statementIndex: statement.index, statementCount: job.statements.length, sessionId, totalRows: 0 });
        let totalRows = 0;
        const statementStartedAt = Date.now();
        const commandType = statementCommandType(statement.sql);

        try {
          const result = await executeNetezzaQuery(profile, statement.sql, {
            masterKey: app.apiConfig.masterKey,
            maxRows: input.maxRows ?? DEFAULT_ROW_LIMIT,
            timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
            readOnly: profile.readOnly,
            database,
          }, {
            onColumns: columns => {
              app.querySessions.setColumns(userId, sessionId, columns);
              emit(job, { type: 'columns', queryId, statementIndex: statement.index, statementCount: job.statements.length, columns });
            },
            onRows: rows => {
              totalRows = app.querySessions.appendRows(userId, sessionId, rows);
              emit(job, { type: 'progress', queryId, statementIndex: statement.index, statementCount: job.statements.length, totalRows });
            },
            onCommand: command => { job.cancel = () => command.cancel(); },
          });
          if (job.cancelRequested) throw new Error('Query cancelled.');
          totalRows = result.totalRows;
          const message = statementMessage(commandType, result);
          totalRows = app.querySessions.complete(userId, sessionId, { rowsAffected: result.rowsAffected, limitReached: result.limitReached, message });
          emit(job, { type: 'complete', queryId, statementIndex: statement.index, statementCount: job.statements.length, totalRows, limitReached: result.limitReached, rowsAffected: result.rowsAffected, message, commandType });
          app.store.addHistory(userId, input.connectionId, database, statement.sql, 'success', Date.now() - startedAt, result.rowsAffected ?? totalRows);
          recordAudit(app, userId, {
            connectionId: input.connectionId,
            database,
            statementIndex: statement.index,
            statementCount: job.statements.length,
            commandType,
            sql: statement.sql,
            status: 'success',
            rowsAffected: result.rowsAffected ?? totalRows,
            durationMs: Date.now() - statementStartedAt,
            confirmed: input.writeConfirmed === true,
          });
          if (isSchemaMutation(commandType)) {
            invalidateSchemaCache(input.connectionId);
            invalidateSqlMetadataCache(input.connectionId);
            for (const session of app.lspSessions) session.invalidateConnection(input.connectionId);
          }
          completedStatements += 1;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Query failed.';
          const cancelled = job.cancelRequested || /cancel/i.test(message);
          app.querySessions.complete(userId, sessionId, { message: cancelled ? 'Query cancelled.' : message });
          if (cancelled) {
            emit(job, { type: 'cancelled', queryId, statementIndex: statement.index, statementCount: job.statements.length, totalRows, scope: job.mode === 'script' ? 'batch' : 'statement' });
            emit(job, { type: 'batch-complete', queryId, statementCount: job.statements.length, status: 'cancelled', completedStatements, message: 'Query batch cancelled.' });
            app.store.addHistory(userId, input.connectionId, database, statement.sql, 'cancelled', Date.now() - startedAt, totalRows);
            recordAudit(app, userId, {
              connectionId: input.connectionId,
              database,
              statementIndex: statement.index,
              statementCount: job.statements.length,
              commandType,
              sql: statement.sql,
              status: 'cancelled',
              rowsAffected: totalRows,
              durationMs: Date.now() - statementStartedAt,
              confirmed: input.writeConfirmed === true,
            });
          } else {
            emit(job, { type: 'error', queryId, statementIndex: statement.index, statementCount: job.statements.length, message });
            emit(job, { type: 'batch-complete', queryId, statementCount: job.statements.length, status: 'error', completedStatements, message: `Statement ${statement.index + 1} failed; subsequent statements were not executed.` });
            app.store.addHistory(userId, input.connectionId, database, statement.sql, 'error', Date.now() - startedAt, totalRows);
            recordAudit(app, userId, {
              connectionId: input.connectionId,
              database,
              statementIndex: statement.index,
              statementCount: job.statements.length,
              commandType,
              sql: statement.sql,
              status: 'error',
              rowsAffected: totalRows,
              durationMs: Date.now() - statementStartedAt,
              confirmed: input.writeConfirmed === true,
            });
          }
          break;
        } finally {
          job.cancel = undefined;
        }
      }
      if (completedStatements === job.statements.length) {
        emit(job, { type: 'batch-complete', queryId, statementCount: job.statements.length, status: 'complete', completedStatements });
      }
    } finally {
      job.done = true;
      job.cancel = undefined;
      job.activeStatementIndex = undefined;
      // Keep the event log for the same window as disk-backed result sessions,
      // so a reconnect can replay the terminal event instead of leaving the tab running forever.
      setTimeout(() => app.queryJobs.delete(queryId), QUERY_JOB_TTL_MS).unref();
    }
  })();
  return { queryId, statementCount: job.statements.length };
}

export async function buildServer(apiConfig: ApiConfig): Promise<FastifyInstance> {
  const app = fastify({ logger: true });
  app.setErrorHandler((error, request, reply) => {
    const hasValidation = typeof error === 'object'
      && error !== null
      && 'validation' in error
      && Boolean((error as { validation?: unknown }).validation);
    if (error instanceof RequestValidationError || hasValidation) {
      void reply.code(400).send({
        code: error instanceof RequestValidationError ? error.code : 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request.',
      });
      return;
    }
    const statusCode = clientErrorStatusCode(error);
    if (statusCode !== undefined) {
      void reply.code(statusCode).send({
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request.',
      });
      return;
    }
    request.log.error(error);
    void reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  });
  const localDbRoot = apiConfig.localDbRoot ?? path.join(apiConfig.dataDir, 'local-databases');
  const store = new AppStore(apiConfig.dataDir, localDbRoot);
  app.decorate('store', store);
  app.decorate('apiConfig', apiConfig);
  app.decorate('queryJobs', new Map<string, QueryJob>());
  app.decorate('querySessions', new QuerySessionManager(apiConfig.dataDir));
  app.decorate('lspSessions', new Set<LspSession>());
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  await app.register(cookie);
  await app.register(websocket);

  if (apiConfig.adminUsername && apiConfig.adminPassword && store.countUsers() === 0) store.createUser(apiConfig.adminUsername, apiConfig.adminPassword, 'admin');

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.post('/api/auth/login', { preHandler: loginRateLimit }, async (request, reply) => {
    const body = bodyObject(request.body) as LoginBody;
    const username = requiredString(body.username, 'username');
    const password = requiredString(body.password, 'password');
    const row = store.findUserByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    const token = randomBytes(32).toString('base64url');
    store.createSession(row.id, token, Date.now() + 7 * 24 * 60 * 60 * 1000);
    setSessionCookie(reply, token);
    return { user: { id: row.id, username: row.username, role: row.role } };
  });
  app.post('/api/auth/logout', async (request, reply) => { const token = request.cookies[SESSION_COOKIE]; if (token) store.deleteSession(token); reply.clearCookie(SESSION_COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/auth/me', { preHandler: authenticate }, async request => ({ user: request.user }));
  app.get('/api/admin/users', { preHandler: [authenticate, requireAdmin] }, async () => store.listUsers());
  app.post('/api/admin/users', { preHandler: [authenticate, requireAdmin, validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as AdminUserCreateRequest;
      const username = requiredString(input.username, 'username');
      const password = requiredString(input.password, 'password');
      if (password.length < 8) throw new Error('password must contain at least 8 characters.');
      const role = input.role === 'admin' ? 'admin' : 'user';
      const created = store.createUser(username, password, role);
      return reply.code(201).send(store.listUsers().find(user => user.id === created.id));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'INVALID_USER', message: error instanceof Error ? error.message : 'Invalid user.' });
    }
  });
  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', { preHandler: [authenticate, requireAdmin, validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as AdminUserUpdateRequest;
      if (input.password !== undefined && input.password.length < 8) throw new Error('password must contain at least 8 characters.');
      const updated = store.updateUser(request.params.id, input);
      if (!updated) return reply.code(404).send({ code: 'NOT_FOUND', message: 'User not found.' });
      return updated;
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'INVALID_USER', message: error instanceof Error ? error.message : 'Invalid user update.' });
    }
  });
  app.get('/api/admin/backup', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-web-backup-'));
    const backupPath = path.join(tempDir, 'justybase.sqlite');
    try {
      store.backupTo(backupPath);
      const data = await readFile(backupPath);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="justybase-backup-${new Date().toISOString().slice(0, 10)}.sqlite"`);
      return reply.send(data);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  app.post('/api/admin/restore', { bodyLimit: MAX_ADMIN_RESTORE_BODY_BYTES, preHandler: [authenticate, requireAdmin, validateCsrf] }, async (request, reply) => {
    let tempDir: string | undefined;
    try {
      const input = request.body as AdminRestoreRequest;
      if (input.restoreConfirmed !== true) throw new Error('Restore confirmation is required.');
      if (typeof input.fileName !== 'string' || input.fileName.trim().length === 0) throw new Error('fileName is required.');
      if ([...app.queryJobs.values()].some(job => !job.done)) throw new Error('Wait for running queries to finish before restoring a backup.');
      const content = decodeBase64Upload(input.contentBase64, 'contentBase64', MAX_ADMIN_BACKUP_BYTES);
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'justybase-web-restore-'));
      const uploadPath = path.join(tempDir, 'restore.sqlite');
      await writeFile(uploadPath, content, { mode: 0o600 });

      const safetyDir = path.join(apiConfig.dataDir, 'backups');
      await mkdir(safetyDir, { recursive: true });
      const safetyPath = path.join(safetyDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      store.backupTo(safetyPath);
      await closeEmbeddedDatabases();
      const restored = store.restoreFrom(uploadPath);
      app.querySessions.clearAll();
      app.queryJobs.clear();
      invalidateSchemaCache();
      invalidateSqlMetadataCache();
      for (const session of app.lspSessions) session.invalidateAll();
      rateLimitBuckets.clear();
      return reply.code(200).send({
        message: `Backup restored. A safety copy was saved as ${path.basename(safetyPath)}. Sign in again if this session is no longer valid.`,
        ...restored,
      });
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'RESTORE_REJECTED', message: error instanceof Error ? error.message : 'Backup restore failed.' });
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.get('/api/connections', { preHandler: authenticate }, async request => store.listConnections(request.user!.id));
  app.post('/api/connections', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const dbType = connectionKind(body.dbType);
      const local = dbType !== 'netezza';
      const input: ConnectionProfileInput = { name: requiredString(body.name, 'name'), host: local ? optionalLocalString(body.host, 'local') : requiredString(body.host, 'host'), port: typeof body.port === 'number' ? body.port : local ? 0 : undefined, database: requiredString(body.database, 'database'), user: local ? optionalLocalString(body.user, 'local') : requiredString(body.user, 'user'), password: local ? optionalLocalString(body.password, '') : requiredString(body.password, 'password'), dbType, readOnly: body.readOnly !== false };
      return reply.code(201).send(store.createConnection(request.user!.id, input, encryptSecret(input.password, apiConfig.masterKey)));
    } catch (error: unknown) { return reply.code(400).send({ code: 'INVALID_CONNECTION', message: error instanceof Error ? error.message : 'Invalid connection.' }); }
  });
  app.put<{ Params: { id: string } }>('/api/connections/:id', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try {
      const body = bodyObject(request.body);
      const dbType = connectionKind(body.dbType);
      const local = dbType !== 'netezza';
      const input: ConnectionProfileUpdate = {
        name: requiredString(body.name, 'name'),
        host: local ? optionalLocalString(body.host, 'local') : requiredString(body.host, 'host'),
        port: typeof body.port === 'number' ? body.port : local ? 0 : undefined,
        database: requiredString(body.database, 'database'),
        user: local ? optionalLocalString(body.user, 'local') : requiredString(body.user, 'user'),
        password: typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined,
        dbType,
        readOnly: body.readOnly !== false,
      };
      const updated = store.updateConnection(request.user!.id, request.params.id, input, input.password ? encryptSecret(input.password, apiConfig.masterKey) : undefined);
      if (!updated) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      await closeDuckDbDatabase(request.params.id);
      closeSqliteDatabase(request.params.id);
      invalidateSchemaCache(request.params.id);
      invalidateSqlMetadataCache(request.params.id);
      for (const session of app.lspSessions) session.invalidateConnection(request.params.id);
      return updated;
    } catch (error: unknown) { return reply.code(400).send({ code: 'INVALID_CONNECTION', message: error instanceof Error ? error.message : 'Invalid connection.' }); }
  });
  app.delete<{ Params: { id: string } }>('/api/connections/:id', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    if (!store.deleteConnection(request.user!.id, request.params.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    await closeDuckDbDatabase(request.params.id);
    closeSqliteDatabase(request.params.id);
    invalidateSchemaCache(request.params.id);
    invalidateSqlMetadataCache(request.params.id);
    for (const session of app.lspSessions) session.invalidateConnection(request.params.id);
    return { ok: true };
  });
  app.post('/api/connections/test', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    let testProfile: StoredConnection | undefined;
    let testDbType: StoredConnection['dbType'] | undefined;
    try {
      const body = bodyObject(request.body);
      const dbType = connectionKind(body.dbType);
      testDbType = dbType;
      const local = dbType !== 'netezza';
      const password = local ? optionalLocalString(body.password, '') : requiredString(body.password, 'password');
      const encrypted = encryptSecret(password, apiConfig.masterKey);
      const profile: StoredConnection = {
        id: `test-${randomUUID()}`,
        name: requiredString(body.name, 'name'),
        host: local ? optionalLocalString(body.host, 'local') : requiredString(body.host, 'host'),
        port: typeof body.port === 'number' ? body.port : local ? 0 : 5480,
        database: requiredString(body.database, 'database'),
        user: local ? optionalLocalString(body.user, 'local') : requiredString(body.user, 'user'),
        dbType,
        passwordCiphertext: encrypted.ciphertext,
        passwordIv: encrypted.iv,
        passwordAuthTag: encrypted.authTag,
        readOnly: true,
        userId: request.user!.id,
        localDbRoot: apiConfig.localDbRoot ?? path.join(apiConfig.dataDir, 'local-databases'),
      };
      testProfile = profile;
      await executeNetezzaQuery(profile, 'SELECT 1', { masterKey: apiConfig.masterKey, maxRows: 1, timeoutSeconds: 30, readOnly: true }, { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined });
      return { ok: true };
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'CONNECTION_FAILED', message: error instanceof Error ? error.message : 'Connection failed.' });
    } finally {
      if (testDbType === 'duckdb' && testProfile) await closeDuckDbDatabase(testProfile.id);
      if (testDbType === 'sqlite' && testProfile) closeSqliteDatabase(testProfile.id);
    }
  });
  app.post<{ Params: { id: string } }>('/api/connections/:id/test', { preHandler: authenticate }, async (request, reply) => {
    const profile = store.getConnection(request.user!.id, request.params.id);
    if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
    try { await executeNetezzaQuery(profile, 'SELECT 1', { masterKey: apiConfig.masterKey, maxRows: 1, timeoutSeconds: 30, readOnly: true }, { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined }); return { ok: true }; } catch (error: unknown) { return reply.code(400).send({ code: 'CONNECTION_FAILED', message: error instanceof Error ? error.message : 'Connection failed.' }); }
  });

  app.get('/api/metadata/databases', { preHandler: authenticate }, async (request, reply) => { const id = String((request.query as { connectionId?: string }).connectionId ?? ''); const profile = store.getConnection(request.user!.id, id); if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' }); return listDatabases(profile, apiConfig.masterKey); });
  app.get('/api/metadata/schemas', { preHandler: authenticate }, async (request, reply) => { const query = request.query as { connectionId?: string; database?: string }; const profile = store.getConnection(request.user!.id, String(query.connectionId ?? '')); if (!profile || !query.database) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection or database not found.' }); return listSchemas(profile, query.database, apiConfig.masterKey); });
  app.get('/api/metadata/objects', { preHandler: authenticate }, async (request, reply) => { const query = request.query as { connectionId?: string; database?: string; schema?: string }; const profile = store.getConnection(request.user!.id, String(query.connectionId ?? '')); if (!profile || !query.database) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection or database not found.' }); return listObjects(profile, query.database, query.schema, apiConfig.masterKey); });
  app.get('/api/metadata/columns', { preHandler: authenticate }, async (request, reply) => { const query = request.query as { connectionId?: string; database?: string; schema?: string; table?: string }; const profile = store.getConnection(request.user!.id, String(query.connectionId ?? '')); if (!profile || !query.database || !query.schema || !query.table) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Table scope not found.' }); return listColumns(profile, query.database, query.schema, query.table, apiConfig.masterKey); });
  app.get('/api/designer/capabilities', { preHandler: authenticate }, async (request, reply) => {
    try {
      const input = parseDesignerCapabilitiesRequest(request.query);
      const profile = store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return getDesignerCapabilitiesResponse(profile, input);
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'DESIGNER_CAPABILITIES_FAILED', message: error instanceof Error ? error.message : 'Designer capabilities failed.' });
    }
  });
  app.get('/api/designer/snapshot', { preHandler: authenticate }, async (request, reply) => {
    try {
      const input = parseDesignerCapabilitiesRequest(request.query);
      const profile = store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      return await getDesignerSnapshotResponse(profile, input, apiConfig.masterKey);
    } catch (error: unknown) {
      const statusCode = error instanceof Error && 'code' in error && error.code === 'DESIGNER_SNAPSHOT_UNAVAILABLE' ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof DesignerSnapshotUnavailableError ? error.code : 'DESIGNER_SNAPSHOT_FAILED',
        message: error instanceof Error ? error.message : 'Designer snapshot failed.',
      });
    }
  });

  app.get('/api/history', { preHandler: authenticate }, async request => store.listHistory(request.user!.id));
  app.get('/api/audit', { preHandler: authenticate }, async request => {
    const limit = Number((request.query as { limit?: string }).limit ?? 200);
    return store.listAudit(request.user!.id, Number.isFinite(limit) ? limit : 200);
  });
  app.get('/api/preferences/editor', { preHandler: authenticate }, async request => store.getEditorPreferences(request.user!.id));
  app.patch('/api/preferences/editor', { preHandler: [authenticate, validateCsrf] }, async request => store.updateEditorPreferences(request.user!.id, request.body as import('@justybase/contracts').EditorPreferencesPatch));
  app.get('/api/schema/tree', { preHandler: authenticate }, async (request, reply) => {
    const query = request.query as { connectionId?: string; parentId?: string };
    if (!query.connectionId) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'connectionId is required.' });
    try { return await getSchemaTree(store, apiConfig, request.user!.id, query.connectionId, query.parentId); }
    catch (error: unknown) { return reply.code(400).send({ code: 'SCHEMA_TREE_FAILED', message: error instanceof Error ? error.message : 'Schema tree failed.' }); }
  });
  app.post('/api/schema/search', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await searchSchema(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SchemaSearchRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'SCHEMA_SEARCH_FAILED', message: error instanceof Error ? error.message : 'Schema search failed.' }); }
  });
  app.post('/api/lsp/completion', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await provideSqlCompletion(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SqlCompletionRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_COMPLETION_FAILED', message: error instanceof Error ? error.message : 'Completion failed.' }); }
  });
  app.post('/api/lsp/diagnostics', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await provideSqlDiagnostics(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SqlDiagnosticsRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_DIAGNOSTICS_FAILED', message: error instanceof Error ? error.message : 'Diagnostics failed.' }); }
  });
  app.post('/api/lsp/format', { preHandler: [authenticate, validateCsrf] }, async (request, reply) => {
    try { return await formatSqlDocument(store, apiConfig, request.user!.id, request.body as import('@justybase/contracts').SqlFormatRequest); }
    catch (error: unknown) { return reply.code(400).send({ code: 'LSP_FORMAT_FAILED', message: error instanceof Error ? error.message : 'Formatting failed.' }); }
  });
  app.get('/api/lsp/snippets', { preHandler: authenticate }, async () => ({ snippets: loadNetezzaSnippets() }));
  app.post<{ Params: { id: string } }>('/api/query/:id/page', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    const input = parseQueryPageRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = job?.sessionIds.get(statementIndex) ?? app.querySessions.querySessionId(request.user!.id, request.params.id, statementIndex);
    if (!sessionId || (job && job.userId !== request.user!.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.page(request.user!.id, sessionId, input); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result expired.' }); }
  });
  app.post<{ Params: { id: string } }>('/api/query/:id/aggregate', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    const input = parseQueryAggregateRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = job?.sessionIds.get(statementIndex) ?? app.querySessions.querySessionId(request.user!.id, request.params.id, statementIndex);
    if (!sessionId || (job && job.userId !== request.user!.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.aggregate(request.user!.id, sessionId, input); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result expired.' }); }
  });
  app.post<{ Params: { id: string } }>('/api/query/:id/group', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    const input = parseQueryGroupRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = job?.sessionIds.get(statementIndex) ?? app.querySessions.querySessionId(request.user!.id, request.params.id, statementIndex);
    if (!sessionId || (job && job.userId !== request.user!.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try { return app.querySessions.group(request.user!.id, sessionId, input); }
    catch (error: unknown) { return reply.code(410).send({ code: 'RESULT_EXPIRED', message: error instanceof Error ? error.message : 'Query result grouping failed.' }); }
  });
  app.post<{ Params: { id: string } }>('/api/query/:id/export', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    const input = parseQueryExportRequest(request.body);
    const statementIndex = Number.isInteger(input.statementIndex) && (input.statementIndex ?? 0) >= 0 ? input.statementIndex ?? 0 : 0;
    const sessionId = job?.sessionIds.get(statementIndex) ?? app.querySessions.querySessionId(request.user!.id, request.params.id, statementIndex);
    if (!sessionId || (job && job.userId !== request.user!.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query result session not found.' });
    try {
      const exported = createQueryExportStream(app.querySessions, request.user!.id, sessionId, input);
      const fileName = (typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim().replace(/[^A-Za-z0-9._-]/g, '_') : `justybase-query-${request.params.id}`).replace(/\.+$/, '') || `justybase-query-${request.params.id}`;
      reply.header('Content-Type', exported.contentType);
      reply.header('Content-Disposition', `attachment; filename="${fileName}.${exported.extension}"`);
      return reply.send(exported.stream);
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : 'Query export failed.' });
    }
  });
  app.post('/api/query/preview', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      return reply.code(200).send(await previewQuery(app, request.user!.id, parseQueryStartRequest(request.body)));
    } catch (error: unknown) {
      const statusCode = error instanceof StaleDesignerSnapshotError ? 409 : error instanceof DesignerSnapshotUnavailableError ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof RequestValidationError ? error.code : error instanceof StaleDesignerSnapshotError ? error.code : error instanceof DesignerSnapshotUnavailableError ? error.code : 'QUERY_PREVIEW_REJECTED',
        message: error instanceof Error ? error.message : 'Query preview rejected.',
      });
    }
  });
  app.post('/api/query/edit/preview', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as QueryEditPreviewRequest;
      const profile = app.store.getConnection(request.user!.id, input.connectionId);
      if (!profile) throw new Error('Connection profile not found.');
      const database = effectiveDatabase(profile, input.database);
      const sql = buildUpdateSql({ ...input, database }, profile.dbType);
      return reply.code(200).send(operationPreview(app, request.user!.id, {
        connectionId: input.connectionId,
        database,
        sql,
        rowCount: 1,
        warnings: ['The selected row will be updated. Verify the key columns and new values before execution.'],
      }));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EDIT_PREVIEW_REJECTED', message: error instanceof Error ? error.message : 'Edit preview rejected.' });
    }
  });
  app.post('/api/query/edit', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as QueryEditRequest;
      const profile = store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      const database = effectiveDatabase(profile, input.database);
      const sql = buildUpdateSql({ ...input, database }, profile.dbType);
      verifyWriteOperation(app, request.user!.id, profile, {
        connectionId: input.connectionId,
        database,
        sql,
        writeConfirmed: input.writeConfirmed,
        writePreviewToken: input.writePreviewToken,
      });
      return reply.code(200).send(await executeConfirmedWrite(app, request.user!.id, profile, {
        connectionId: input.connectionId,
        database,
        sql,
        confirmed: input.writeConfirmed,
      }));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'EDIT_REJECTED', message: error instanceof Error ? error.message : 'Edit rejected.' });
    }
  });
  app.post('/api/query/import/preview', { bodyLimit: MAX_IMPORT_BODY_BYTES, preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as QueryImportPreviewRequest;
      const profile = app.store.getConnection(request.user!.id, input.connectionId);
      if (!profile) throw new Error('Connection profile not found.');
      const database = effectiveDatabase(profile, input.database);
      const sql = buildInsertSql({ ...input, database }, profile.dbType);
      return reply.code(200).send(operationPreview(app, request.user!.id, {
        connectionId: input.connectionId,
        database,
        sql,
        rowCount: input.rows.length,
        warnings: [`${input.rows.length.toLocaleString()} row(s) will be inserted. Verify the target table and column mapping before execution.`],
      }));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'IMPORT_PREVIEW_REJECTED', message: error instanceof Error ? error.message : 'Import preview rejected.' });
    }
  });
  app.post('/api/query/import', { bodyLimit: MAX_IMPORT_BODY_BYTES, preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const input = request.body as QueryImportRequest;
      const profile = store.getConnection(request.user!.id, input.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      const database = effectiveDatabase(profile, input.database);
      const sql = buildInsertSql({ ...input, database }, profile.dbType);
      verifyWriteOperation(app, request.user!.id, profile, {
        connectionId: input.connectionId,
        database,
        sql,
        writeConfirmed: input.writeConfirmed,
        writePreviewToken: input.writePreviewToken,
      });
      return reply.code(200).send(await executeConfirmedWrite(app, request.user!.id, profile, {
        connectionId: input.connectionId,
        database,
        sql,
        confirmed: input.writeConfirmed,
      }));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'IMPORT_REJECTED', message: error instanceof Error ? error.message : 'Import rejected.' });
    }
  });
  app.post('/api/query/import-file/preview', { bodyLimit: MAX_IMPORT_BODY_BYTES, preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const fileInput = request.body as QueryFileImportPreviewRequest;
      const profile = app.store.getConnection(request.user!.id, fileInput.connectionId);
      if (!profile) throw new Error('Connection profile not found.');
      const targetColumns = fileInput.hasHeader === false
        ? (await listColumns(profile, effectiveDatabase(profile, fileInput.database), fileInput.schema, fileInput.table, apiConfig.masterKey)).map(column => column.name)
        : undefined;
      const input = await materializeFileImport(fileInput, targetColumns);
      const database = effectiveDatabase(profile, input.database);
      const sql = buildInsertSql({ ...input, database }, profile.dbType);
      return reply.code(200).send(operationPreview(app, request.user!.id, {
        connectionId: input.connectionId,
        database,
        sql,
        rowCount: input.rows.length,
        warnings: [`${input.rows.length.toLocaleString()} row(s) from ${fileInput.fileName.trim()} will be inserted. Verify the target table and column mapping before execution.`],
      }));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'FILE_IMPORT_PREVIEW_REJECTED', message: error instanceof Error ? error.message : 'File import preview rejected.' });
    }
  });
  app.post('/api/query/import-file', { bodyLimit: MAX_IMPORT_BODY_BYTES, preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const fileInput = request.body as QueryFileImportRequest;
      const profile = store.getConnection(request.user!.id, fileInput.connectionId);
      if (!profile) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Connection profile not found.' });
      const targetColumns = fileInput.hasHeader === false
        ? (await listColumns(profile, effectiveDatabase(profile, fileInput.database), fileInput.schema, fileInput.table, apiConfig.masterKey)).map(column => column.name)
        : undefined;
      const input = await materializeFileImport(fileInput, targetColumns);
      const database = effectiveDatabase(profile, input.database);
      const sql = buildInsertSql({ ...input, database }, profile.dbType);
      verifyWriteOperation(app, request.user!.id, profile, {
        connectionId: input.connectionId,
        database,
        sql,
        writeConfirmed: fileInput.writeConfirmed,
        writePreviewToken: fileInput.writePreviewToken,
      });
      return reply.code(200).send(await executeConfirmedWrite(app, request.user!.id, profile, {
        connectionId: input.connectionId,
        database,
        sql,
        confirmed: fileInput.writeConfirmed,
      }));
    } catch (error: unknown) {
      return reply.code(400).send({ code: 'FILE_IMPORT_REJECTED', message: error instanceof Error ? error.message : 'File import rejected.' });
    }
  });
  app.post('/api/query', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    try {
      const started = await startQuery(app, request.user!.id, parseQueryStartRequest(request.body));
      return reply.code(202).send(started);
    } catch (error: unknown) {
      const statusCode = error instanceof StaleDesignerSnapshotError ? 409 : error instanceof DesignerSnapshotUnavailableError ? 501 : 400;
      return reply.code(statusCode).send({
        code: error instanceof RequestValidationError ? error.code : error instanceof StaleDesignerSnapshotError ? error.code : error instanceof DesignerSnapshotUnavailableError ? error.code : 'QUERY_REJECTED',
        message: error instanceof Error ? error.message : 'Query rejected.',
      });
    }
  });
  app.post<{ Params: { id: string } }>('/api/query/:id/cancel', { preHandler: [authenticate, queryRateLimit, validateCsrf] }, async (request, reply) => {
    const job = app.queryJobs.get(request.params.id);
    if (!job || job.userId !== request.user!.id) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Query not found.' });
    if (!job.done) {
      job.cancelRequested = true;
      if (job.cancel) await job.cancel();
    }
    return { ok: true };
  });
  app.get('/api/ws', { websocket: true, preValidation: authenticate }, (socket, request) => {
    socket.on('message', (raw: Buffer) => {
      let message: { type?: string; queryId?: string; afterSequence?: number };
      try { message = JSON.parse(raw.toString()) as { type?: string; queryId?: string; afterSequence?: number }; }
      catch { socket.close(1003, 'Malformed JSON payload.'); return; }
      if (message.type !== 'subscribe' || !message.queryId) return;
      const job = app.queryJobs.get(message.queryId);
      if (!job || job.userId !== request.user!.id) { socket.close(4404, 'Query result stream not found.'); return; }
      job.subscribers.add(socket);
      const afterSequence = Number.isFinite(message.afterSequence) ? message.afterSequence ?? 0 : 0;
      for (const event of job.events) if ((event.sequence ?? 0) > afterSequence && socket.readyState === 1) socket.send(JSON.stringify(event));
      socket.once('close', () => job.subscribers.delete(socket));
    });
  });
  app.get('/api/lsp', { websocket: true, preValidation: authenticate }, (socket, request) => {
    let session: LspSession;
    session = attachLspSocket(socket, store, apiConfig, request.user!.id, closed => app.lspSessions.delete(closed));
    app.lspSessions.add(session);
  });

  const webRoot = path.resolve(apiConfig.webDistDir);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.' }) : reply.sendFile('index.html'));
  }
  const cleanupTimer = setInterval(() => app.querySessions.cleanup(), 60_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => { clearInterval(cleanupTimer); app.querySessions.closeAll(); await closeEmbeddedDatabases(); store.close(); });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    store: AppStore;
    apiConfig: ApiConfig;
    queryJobs: Map<string, QueryJob>;
    querySessions: QuerySessionManager;
    lspSessions: Set<LspSession>;
  }
}
