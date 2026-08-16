import type { QueryEvent } from '@justybase/contracts';

export interface ResultState {
  columns: string[];
  columnTypes: Array<string | undefined>;
  rows: unknown[][];
  status: string;
  message?: string;
  totalRows: number;
  sessionId?: string;
  statementIndex?: number;
  statementCount?: number;
  statementSql?: string;
  rowsAffected?: number;
  limitReached?: boolean;
  cancelScope?: 'statement' | 'batch';
  batchStatus?: 'complete' | 'error' | 'cancelled';
  lastSequence?: number;
}

export const emptyResult: ResultState = { columns: [], columnTypes: [], rows: [], status: 'idle', totalRows: 0 };

export function applyQueryEvent(previous: ResultState, event: QueryEvent): ResultState {
  if (event.sequence !== undefined && previous.lastSequence !== undefined && event.sequence <= previous.lastSequence) return previous;
  const sequence = event.sequence ?? previous.lastSequence;
  if (event.type === 'started') return { ...previous, status: 'running', statementCount: event.statementCount, lastSequence: sequence };
  if (event.type === 'statement-started') {
    return {
      ...emptyResult,
      status: 'running',
      statementIndex: event.statementIndex,
      statementCount: event.statementCount,
      statementSql: event.statementSql,
      lastSequence: sequence,
    };
  }
  if (event.type === 'columns') return { ...previous, columns: event.columns.map(column => column.name), columnTypes: event.columns.map(column => column.type), statementIndex: event.statementIndex, statementCount: event.statementCount, lastSequence: sequence };
  if (event.type === 'session') return { ...previous, sessionId: event.sessionId, totalRows: event.totalRows, statementIndex: event.statementIndex, statementCount: event.statementCount, lastSequence: sequence };
  if (event.type === 'progress') return { ...previous, totalRows: event.totalRows, lastSequence: sequence };
  if (event.type === 'rows') return { ...previous, rows: [...previous.rows, ...event.rows], totalRows: event.totalRows, lastSequence: sequence };
  if (event.type === 'complete') return { ...previous, status: event.limitReached ? 'complete · row limit reached' : 'complete', totalRows: event.totalRows, rowsAffected: event.rowsAffected, message: event.message, limitReached: event.limitReached, statementIndex: event.statementIndex, statementCount: event.statementCount, lastSequence: sequence };
  if (event.type === 'cancelled') return { ...previous, status: 'cancelled', totalRows: event.totalRows, message: event.scope === 'statement' ? 'Statement cancelled.' : 'Query batch cancelled.', cancelScope: event.scope, statementIndex: event.statementIndex, statementCount: event.statementCount, lastSequence: sequence };
  if (event.type === 'error') return { ...previous, status: 'error', message: event.message, statementIndex: event.statementIndex, statementCount: event.statementCount, lastSequence: sequence };
  return { ...previous, batchStatus: event.status, message: event.message ?? previous.message, lastSequence: sequence };
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
