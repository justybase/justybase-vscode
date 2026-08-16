import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from './api';
import type { ResultState } from './queryState';

function display(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ExplainPanel({ queryId, statementIndex, result }: { queryId: string; statementIndex: number; result: ResultState }): ReactElement {
  const [rows, setRows] = useState<unknown[][]>(result.rows);
  const [columns, setColumns] = useState(result.columns);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const terminal = result.status.startsWith('complete') || result.status === 'error' || result.status === 'cancelled';
    if (!queryId || !result.sessionId || !terminal) return;
    setLoading(true);
    setError('');
    void api.queryPage(queryId, { statementIndex, offset: 0, limit: 1000 }).then(response => {
      setRows(response.rows);
      setColumns(response.columns.map(column => column.name));
    }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load explain plan.')).finally(() => setLoading(false));
  }, [queryId, result.sessionId, result.status, statementIndex]);

  return <section className="explain-panel">
    <div className="explain-toolbar"><strong>Explain plan</strong><span>{loading ? 'Loading…' : `${rows.length.toLocaleString()} plan row(s)`}</span>{error && <span className="grid-error">{error}</span>}</div>
    {columns.length > 0 && <div className="explain-table-wrap"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{columns.map((_column, columnIndex) => <td key={columnIndex}>{display(row[columnIndex])}</td>)}</tr>)}</tbody></table></div>}
    {columns.length === 0 && !loading && rows.length > 0 && <pre className="explain-text">{rows.map(row => row.map(display).join('  ')).join('\n')}</pre>}
    {columns.length === 0 && !loading && rows.length === 0 && <div className="explain-empty" aria-live="polite"><strong>No plan output returned</strong><span>{result.message || 'The database returned no explain rows for this statement.'}</span><small>Try running Explain again after selecting a single statement.</small></div>}
  </section>;
}
