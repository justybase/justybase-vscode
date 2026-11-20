import type { ExecuteStatementResult } from './executionService';
import type { ToolSurface, ToolTier } from './toolCatalog';

/** Audit events never contain SQL text or row values. */
export interface ToolAuditEvent {
  readonly tool: string;
  readonly tier: ToolTier;
  readonly surface: ToolSurface;
  readonly connectionName?: string;
  readonly statementKind?: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string;
}

export type ToolAuditSink = (event: ToolAuditEvent) => void;

const MAX_ERROR_LENGTH = 200;

export function truncateAuditError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const text = error instanceof Error ? error.message : String(error);
  const singleLine = text.replace(/\s+/gu, ' ').trim();
  return singleLine.length > MAX_ERROR_LENGTH
    ? `${singleLine.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : singleLine;
}

export function emitAudit(sink: ToolAuditSink | undefined, event: ToolAuditEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Auditing must never break a tool call.
  }
}

export function formatExecuteStatementResult(result: ExecuteStatementResult): string {
  const summary = result.kind === 'read'
    ? `Read ${result.rowCount} row(s)${result.truncated ? ' (truncated)' : ''}.`
    : `Executed ${result.kind} statement; affected rows: ${result.affectedRows}.`;
  const payload: Record<string, unknown> = result.kind === 'read'
    ? { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated }
    : { affectedRows: result.affectedRows };
  const lines = [summary, '```json', JSON.stringify(payload, jsonSafeReplacer, 2), '```'];
  if (result.notices.length > 0) {
    lines.push('Notices:', ...result.notices.map(notice => `- ${notice}`));
  }
  return lines.join('\n');
}

export function jsonSafeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  return value;
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, jsonSafeReplacer, 2);
}
