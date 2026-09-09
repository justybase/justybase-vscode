export type PortableQueryExecutionMode = 'single' | 'script' | 'explain';

interface PortableQueryEventBase {
  queryId: string;
  sequence?: number;
  statementIndex?: number;
  statementCount?: number;
}

export type PortableQueryEvent =
  | (PortableQueryEventBase & { type: 'started'; startedAt: number; mode?: PortableQueryExecutionMode })
  | (PortableQueryEventBase & { type: 'statement-started'; statementSql?: string })
  | (PortableQueryEventBase & { type: 'columns'; columns: Array<{ name: string; type?: string }> })
  | (PortableQueryEventBase & { type: 'session'; sessionId: string; totalRows: number })
  | (PortableQueryEventBase & { type: 'progress'; totalRows: number })
  | (PortableQueryEventBase & { type: 'rows'; rows: unknown[][]; totalRows: number })
  | (PortableQueryEventBase & { type: 'complete'; totalRows: number; limitReached: boolean; rowsAffected?: number; message?: string; commandType?: string })
  | (PortableQueryEventBase & { type: 'error'; message: string })
  | (PortableQueryEventBase & { type: 'cancelled'; totalRows: number; scope?: 'statement' | 'batch' })
  | (PortableQueryEventBase & { type: 'batch-complete'; status: 'complete' | 'error' | 'cancelled'; completedStatements: number; message?: string });

export interface PortableQueryResultState {
  columns: string[];
  columnTypes: Array<string | undefined>;
  rows: unknown[][];
  status: string;
  message?: string;
  totalRows: number;
  /** Existing web/API compatibility field; equal to storageSessionId for session events. */
  sessionId?: string;
  statementIndex?: number;
  statementCount?: number;
  statementSql?: string;
  rowsAffected?: number;
  limitReached?: boolean;
  /** Stable identity of the external row-storage session, if one exists. */
  storageSessionId?: string;
  cancelScope?: 'statement' | 'batch';
  batchStatus?: 'complete' | 'error' | 'cancelled';
  lastSequence?: number;
  sourceId?: string;
  executionId?: string;
  resultSetId?: string;
}

export const emptyPortableQueryResult: PortableQueryResultState = {
  columns: [],
  columnTypes: [],
  rows: [],
  status: 'idle',
  totalRows: 0,
};

function resultSetIdFor(event: PortableQueryEvent, previous: PortableQueryResultState): string {
  const statementIndex = event.type === 'started'
    ? event.statementIndex ?? 0
    : event.statementIndex ?? previous.statementIndex ?? 0;
  return `${event.queryId}::statement-${statementIndex}`;
}

function withEventIdentity(previous: PortableQueryResultState, event: PortableQueryEvent): Pick<PortableQueryResultState, 'statementIndex' | 'statementCount' | 'executionId' | 'resultSetId'> {
  const statementIndex = event.type === 'started'
    ? event.statementIndex ?? 0
    : event.statementIndex ?? previous.statementIndex;
  return {
    statementIndex,
    statementCount: event.statementCount ?? previous.statementCount,
    executionId: event.queryId,
    resultSetId: resultSetIdFor(event, previous),
  };
}

/** Shared API/WebSocket query reducer used by the web adapter. */
export function applyPortableQueryEvent(previous: PortableQueryResultState, event: PortableQueryEvent): PortableQueryResultState {
  if (event.sequence !== undefined && previous.lastSequence !== undefined && event.sequence <= previous.lastSequence) return previous;
  const sequence = event.sequence ?? previous.lastSequence;
  const identity = withEventIdentity(previous, event);
  if (event.type === 'started') return { ...previous, ...identity, status: 'running', statementCount: event.statementCount, lastSequence: sequence };
  if (event.type === 'statement-started') {
    return {
      ...emptyPortableQueryResult,
      ...identity,
      status: 'running',
      statementSql: event.statementSql,
      lastSequence: sequence,
    };
  }
  if (event.type === 'columns') return { ...previous, ...identity, columns: event.columns.map(column => column.name), columnTypes: event.columns.map(column => column.type), lastSequence: sequence };
  if (event.type === 'session') return { ...previous, ...identity, sessionId: event.sessionId, storageSessionId: event.sessionId, totalRows: event.totalRows, lastSequence: sequence };
  if (event.type === 'progress') return { ...previous, ...identity, totalRows: event.totalRows, lastSequence: sequence };
  if (event.type === 'rows') return { ...previous, ...identity, rows: [...previous.rows, ...event.rows.map(row => row.slice())], totalRows: event.totalRows, lastSequence: sequence };
  if (event.type === 'complete') return { ...previous, ...identity, status: event.limitReached ? 'complete · row limit reached' : 'complete', totalRows: event.totalRows, rowsAffected: event.rowsAffected, message: event.message, limitReached: event.limitReached, lastSequence: sequence };
  if (event.type === 'cancelled') return { ...previous, ...identity, status: 'cancelled', totalRows: event.totalRows, message: event.scope === 'statement' ? 'Statement cancelled.' : 'Query batch cancelled.', cancelScope: event.scope, lastSequence: sequence };
  if (event.type === 'error') return { ...previous, ...identity, status: 'error', message: event.message, lastSequence: sequence };
  return { ...previous, ...identity, batchStatus: event.status, message: event.message ?? previous.message, lastSequence: sequence };
}
