import type { QueryEvent } from '@justybase/contracts';

export interface ResultState {
  columns: string[];
  columnTypes: Array<string | undefined>;
  rows: unknown[][];
  status: string;
  message?: string;
  totalRows: number;
  sessionId?: string;
}

export const emptyResult: ResultState = { columns: [], columnTypes: [], rows: [], status: 'idle', totalRows: 0 };

export function applyQueryEvent(previous: ResultState, event: QueryEvent): ResultState {
  if (event.type === 'started') return { ...previous, status: 'running' };
  if (event.type === 'columns') return { ...previous, columns: event.columns.map(column => column.name), columnTypes: event.columns.map(column => column.type) };
  if (event.type === 'session') return { ...previous, sessionId: event.sessionId, totalRows: event.totalRows };
  if (event.type === 'progress') return { ...previous, totalRows: event.totalRows };
  if (event.type === 'rows') return { ...previous, rows: [...previous.rows, ...event.rows], totalRows: event.totalRows };
  if (event.type === 'complete') return { ...previous, status: event.limitReached ? 'complete · row limit reached' : 'complete', totalRows: event.totalRows };
  if (event.type === 'cancelled') return { ...previous, status: 'cancelled', totalRows: event.totalRows };
  return { ...previous, status: 'error', message: event.message };
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
