import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  QueryAuditStatus,
  QueryExecutionMode,
  QueryStartRequest,
} from '@justybase/contracts';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { QueryUseCaseContext, PlannedStatement } from './queryUseCaseTypes';
import type { StoredConnection } from './store';

export const DEFAULT_ROW_LIMIT = 200_000;
export const DEFAULT_TIMEOUT_SECONDS = 1_800;
export const WRITE_PREVIEW_TTL_MS = 5 * 60 * 1000;

export interface WritePreviewClaims {
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

export function effectiveDatabase(
  runtimes: ApiDatabaseRuntimeRegistry,
  profile: StoredConnection,
  requested: string | undefined,
): string {
  const value = requested?.trim() || (profile.dbType === 'sqlite' ? 'main' : profile.database.trim());
  return runtimes.normalizeDatabase(profile, value);
}

export function statementCommandType(sql: string): string {
  return /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() ?? 'SQL';
}

export function isSchemaMutation(commandType: string): boolean {
  return /^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|RENAME|GRANT|REVOKE|GROOM|ATTACH|DETACH)$/i.test(commandType);
}

export function plannedDigest(mode: QueryExecutionMode, statements: PlannedStatement[]): string {
  return createHash('sha256').update(JSON.stringify({ mode, statements: statements.map(statement => ({ index: statement.index, startOffset: statement.startOffset, endOffset: statement.endOffset, sql: statement.sql })) })).digest('hex');
}

export function designerTargetDigest(target: NonNullable<QueryStartRequest['designer']>['target']): string {
  const normalized = {
    connectionId: target.connectionId,
    database: target.database,
    schema: target.schema,
    objectName: target.objectName,
    objectType: target.objectType,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function signPreviewClaims(claims: WritePreviewClaims, masterKey: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', masterKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyPreviewClaims(token: string, masterKey: string): WritePreviewClaims | undefined {
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

export function statementWarnings(commandType: string, readOnly: boolean): string[] {
  if (readOnly) return [];
  if (/^(DROP|TRUNCATE)$/i.test(commandType)) return ['Destructive operation: objects or rows may be removed.'];
  if (/^(DELETE|UPDATE|MERGE)$/i.test(commandType)) return ['Data-changing operation: verify the target and filter before execution.'];
  if (/^(CREATE|ALTER|COMMENT|RENAME|GRANT|REVOKE|GROOM)$/i.test(commandType)) return ['Schema, permissions, or storage metadata may change.'];
  if (/^(INSERT|CALL|EXEC|EXECUTE|COPY|GENERATE)$/i.test(commandType)) return ['The statement may write data or invoke a procedure with side effects.'];
  return ['This statement is not classified as read-only and requires confirmation.'];
}

export function recordAudit(
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
