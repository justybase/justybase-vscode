import { randomUUID } from 'node:crypto';
import type {
  QueryAuditStatus,
  QueryEditPreviewRequest,
  QueryEditRequest,
  QueryFileImportPreviewRequest,
  QueryFileImportRequest,
  QueryImportPreviewRequest,
  QueryImportRequest,
  QueryWriteResponse,
  WriteOperationPreviewResponse,
} from '@justybase/contracts';
import {
  DEFAULT_ROW_LIMIT,
  DEFAULT_TIMEOUT_SECONDS,
  effectiveDatabase,
  isSchemaMutation,
  plannedDigest,
  recordAudit,
  signPreviewClaims,
  statementCommandType,
  verifyPreviewClaims,
  WRITE_PREVIEW_TTL_MS,
} from './queryUseCaseSupport';
import type { QueryUseCaseContext } from './queryUseCaseTypes';
import {
  buildInsertSql,
  buildUpdateSql,
  materializeFileImport,
} from './queryWriteSupport';
import type { AppStore } from './store';

function operationPreview(
  context: QueryUseCaseContext,
  userId: string,
  input: { connectionId: string; database?: string; sql: string; rowCount: number; warnings: string[] },
): WriteOperationPreviewResponse {
  const profile = context.store.getConnection(userId, input.connectionId);
  if (!profile) throw new Error('Connection profile not found.');
  if (profile.readOnly) throw new Error('This connection is read-only. Enable write mode for data changes.');
  const database = effectiveDatabase(context.databaseRuntimes, profile, input.database);
  const expiresAt = Date.now() + WRITE_PREVIEW_TTL_MS;
  const statement = { index: 0, startOffset: 0, endOffset: input.sql.length, sql: input.sql };
  const previewToken = signPreviewClaims({ userId, connectionId: input.connectionId, database, mode: 'single', statementsDigest: plannedDigest('single', [statement]), expiresAt }, context.config.masterKey);
  return { sql: input.sql, previewToken, expiresAt, warnings: input.warnings, rowCount: input.rowCount };
}

function verifyWriteOperation(
  context: QueryUseCaseContext,
  userId: string,
  profile: ReturnType<AppStore['getConnection']>,
  input: { connectionId: string; database: string; sql: string; writeConfirmed: boolean; writePreviewToken: string },
): void {
  if (!profile) throw new Error('Connection profile not found.');
  if (profile.readOnly) throw new Error('This connection is read-only. Enable write mode for data changes.');
  const claims = verifyPreviewClaims(input.writePreviewToken, context.config.masterKey);
  if (!input.writeConfirmed || !claims) throw new Error('Write confirmation required before executing the operation.');
  const statement = { index: 0, startOffset: 0, endOffset: input.sql.length, sql: input.sql };
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

export async function previewEdit(
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

export async function executeEdit(context: QueryUseCaseContext, userId: string, input: QueryEditRequest): Promise<QueryWriteResponse> {
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

export async function previewImport(
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

export async function executeImport(context: QueryUseCaseContext, userId: string, input: QueryImportRequest): Promise<QueryWriteResponse> {
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

export async function previewFileImport(
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

export async function executeFileImport(context: QueryUseCaseContext, userId: string, input: QueryFileImportRequest): Promise<QueryWriteResponse> {
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

export type { QueryAuditStatus };
