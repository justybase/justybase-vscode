import { randomUUID } from 'node:crypto';
import type {
  DesignerSnapshotRequest,
  ExecutionEvent,
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
  QueryAuditStatus,
  QueryWriteResponse,
  WriteOperationPreviewResponse,
} from '@justybase/contracts';
import { StaleDesignerSnapshotError } from '@justybase/database-runtime';
import { getSqlStatementAtPosition, splitSqlStatements } from '@justybase/sql-core';
import { getDesignerSnapshotResponse } from './designerSnapshotService';
import {
  DEFAULT_ROW_LIMIT,
  DEFAULT_TIMEOUT_SECONDS,
  designerTargetDigest,
  effectiveDatabase,
  isSchemaMutation,
  plannedDigest,
  recordAudit,
  signPreviewClaims,
  statementCommandType,
  statementWarnings,
  verifyPreviewClaims,
  WRITE_PREVIEW_TTL_MS,
} from './queryUseCaseSupport';
import type {
  PlannedStatement,
  QueryJob,
  QueryUseCaseContext,
} from './queryUseCaseTypes';
import {
  executeEdit,
  executeFileImport,
  executeImport,
  previewEdit,
  previewFileImport,
  previewImport,
} from './queryWriteUseCases';
import type { StoredConnection } from './store';

const QUERY_JOB_TTL_MS = 60 * 60 * 1000;

export type { PlannedStatement, QueryJob, QueryUseCaseContext } from './queryUseCaseTypes';
export type { QueryUseCaseLogger } from './queryUseCaseTypes';

function emit(job: QueryJob, event: QueryEvent): void {
  const sequenced: QueryEvent = { ...event, sequence: ++job.sequence };
  job.events.push(sequenced);
  const payload = JSON.stringify(sequenced);
  for (const socket of job.subscribers) if (socket.readyState === 1) socket.send(payload);
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
