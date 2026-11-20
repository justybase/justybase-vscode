import type { ConnectionDetails } from '../../types';
import { createConnectedNetezzaConnectionFromDetails } from '../mcpConnectionFactory';
import { classifySqlStatement, type SqlAccessKind } from './sqlAccess';

/**
 * Single-statement execution shared by the Copilot tools and the MCP server.
 *
 * Every call opens its own connection and executes exactly one statement. There
 * is no cross-call transaction: DML is autocommitted by the server. The caller
 * is responsible for the access policy (`toolPolicy` + `sqlAccess`).
 */

export interface ExecuteStatementOptions {
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Database override for the connection. */
  readonly database?: string;
}

export interface ExecuteStatementResult {
  readonly kind: SqlAccessKind;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly affectedRows: number;
  readonly truncated: boolean;
  readonly notices: readonly string[];
}

export const DEFAULT_MAX_ROWS = 500;
export const MAX_MAX_ROWS = 5000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;

export function clampMaxRows(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ROWS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_MAX_ROWS);
}

export function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_TIMEOUT_MS);
}

export async function executeStatement(
  details: ConnectionDetails,
  sql: string,
  options: ExecuteStatementOptions = {},
): Promise<ExecuteStatementResult> {
  if (options.signal?.aborted) {
    throw new Error('The statement was cancelled before it started.');
  }

  const classification = classifySqlStatement(sql);
  const maxRows = clampMaxRows(options.maxRows);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const connection = await createConnectedNetezzaConnectionFromDetails(details, options.database);

  const notices: string[] = [];
  const noticeHandler = (message: unknown): void => {
    const notification = message as { message?: unknown };
    if (typeof notification.message === 'string' && notification.message.trim().length > 0) {
      notices.push(notification.message);
    }
  };
  connection.on('notice', noticeHandler);

  try {
    const command = connection.createCommand(classification.statement);
    // The Netezza driver expects `commandTimeout` in seconds.
    command.commandTimeout = Math.max(1, Math.ceil(timeoutMs / 1000));
    const cancel = (): void => {
      void command.cancel().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });

    try {
      if (classification.kind === 'read') {
        const reader = await command.executeReader();
        try {
          const columns = Array.from({ length: reader.fieldCount }, (_value, index) => reader.getName(index));
          const rows: unknown[][] = [];
          let truncated = false;
          while (await reader.read()) {
            if (rows.length >= maxRows) {
              truncated = true;
              break;
            }
            rows.push(reader.getValues() as unknown[]);
          }
          return {
            kind: classification.kind,
            columns,
            rows,
            rowCount: rows.length,
            affectedRows: 0,
            truncated,
            notices: [...notices],
          };
        } finally {
          await reader.close();
        }
      }

      const affectedRows = await command.executeNonQuery();
      return {
        kind: classification.kind,
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows,
        truncated: false,
        notices: [...notices, ...command.notices],
      };
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  } finally {
    connection.removeListener('notice', noticeHandler);
    await connection.close();
  }
}
