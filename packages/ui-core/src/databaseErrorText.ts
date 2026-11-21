import type { DatabaseErrorDetails } from '@justybase/contracts';

/** Human labels for the protocol fields carried in `details.diagnostics`. */
export const DATABASE_DIAGNOSTIC_LABELS: Readonly<Record<string, string>> = {
  internalPosition: 'Internal position',
  internalQuery: 'Internal query',
  schema: 'Schema',
  table: 'Table',
  column: 'Column',
  dataType: 'Data type',
  constraint: 'Constraint',
  routine: 'Routine',
};

export interface SqlErrorLineExcerpt {
  /** One-based line number inside the submitted SQL. */
  readonly line: number;
  /** The line content, bounded for display. */
  readonly text: string;
  /** Zero-based caret column inside {@link text}. */
  readonly caret: number;
}

/**
 * Builds a psql-style line excerpt for a backend-reported one-based character
 * `position`. Returns `undefined` when the position is missing or nonsensical,
 * so callers can keep rendering the plain error message.
 */
export function buildSqlErrorLineExcerpt(sql: string, position: number): SqlErrorLineExcerpt | undefined {
  if (!Number.isFinite(position) || position < 1) return undefined;
  const offset = Math.min(Math.trunc(position) - 1, sql.length);
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1;
  let lineEnd = sql.indexOf('\n', offset);
  if (lineEnd < 0) lineEnd = sql.length;
  if (lineEnd > lineStart && sql[lineEnd - 1] === '\r') lineEnd -= 1;
  const line = sql.slice(0, lineStart).split('\n').length;
  const raw = sql.slice(lineStart, lineEnd);
  const rawCaret = Math.max(0, offset - lineStart);
  const maxLength = 160;
  if (raw.length <= maxLength) {
    return { line, text: raw, caret: rawCaret };
  }
  const start = Math.max(0, Math.min(rawCaret - 40, raw.length - maxLength));
  const leading = start > 0 ? '…' : '';
  const trailing = start + maxLength < raw.length ? '…' : '';
  return {
    line,
    text: `${leading}${raw.slice(start, start + maxLength)}${trailing}`,
    caret: rawCaret - start + leading.length,
  };
}

/**
 * Composes the backend diagnostics into the error text sent to the assistant.
 * The result panel renders the same fields separately; this keeps the
 * "Fix with Copilot" prompt complete without changing the visible message.
 */
export function formatDatabaseErrorForPrompt(
  message: string | undefined,
  details?: DatabaseErrorDetails,
): string {
  const base = message?.trim() ? message : 'Query execution failed.';
  const lines: string[] = [];
  if (details?.code) lines.push(`SQLSTATE: ${details.code}`);
  if (details?.severity) lines.push(`SEVERITY: ${details.severity}`);
  if (details?.position !== undefined) lines.push(`POSITION: ${details.position}`);
  if (details?.detail) lines.push(`DETAIL: ${details.detail}`);
  if (details?.hint) lines.push(`HINT: ${details.hint}`);
  if (details?.context) lines.push(`CONTEXT: ${details.context}`);
  for (const [key, value] of Object.entries(details?.diagnostics ?? {})) {
    lines.push(`${DATABASE_DIAGNOSTIC_LABELS[key] ?? key}: ${value}`);
  }
  return lines.length > 0 ? `${base}\n${lines.join('\n')}` : base;
}
