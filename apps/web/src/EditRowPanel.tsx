import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { SchemaTreeNode } from '@justybase/contracts';
import { api } from './api';

interface EditRowPanelProps {
  connectionId: string;
  database: string;
  target: SchemaTreeNode;
  columns: string[];
  columnTypes: Array<string | undefined>;
  values: unknown[];
  onClose(): void;
  onCompleted(message: string): void;
}

function inputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function valueFromInput(value: string, original: unknown, type?: string): unknown {
  if (value.trim().toUpperCase() === 'NULL') return null;
  if (original === null || original === undefined) return value;
  const normalizedType = (type ?? '').toUpperCase();
  if (/INT|DECIMAL|NUMERIC|NUMBER/.test(normalizedType)) {
    // Keep integral and decimal text exact. sqlWriteLiteral quotes strings,
    // which lets the database cast the exact decimal/integer text to the
    // target column without passing through JavaScript's Number range.
    return value.trim();
  }
  if (/REAL|FLOAT|DOUBLE/.test(normalizedType) || (typeof original === 'number' && !type)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof original === 'boolean' || /BOOL/.test((type ?? '').toUpperCase())) return /^(true|t|1)$/i.test(value.trim());
  if (typeof original === 'object') {
    try { return JSON.parse(value) as unknown; } catch { return value; }
  }
  return value;
}

export function EditRowPanel({ connectionId, database, target, columns, columnTypes, values, onClose, onCompleted }: EditRowPanelProps): ReactElement {
  const [formValues, setFormValues] = useState<Record<string, string>>(() => Object.fromEntries(columns.map((column, index) => [column, inputValue(values[index])] )));
  const [keyColumns, setKeyColumns] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const table = target.objectName ?? target.label;
  const changedColumns = useMemo(() => columns.filter(column => !keyColumns.has(column)), [columns, keyColumns]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!target.schema || !table) { setError('The target table is incomplete.'); return; }
    if (keyColumns.size === 0) { setError('Select at least one key column.'); return; }
    if (changedColumns.length === 0) { setError('Select at least one editable column.'); return; }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const key = Object.fromEntries(columns.filter(column => keyColumns.has(column)).map(column => [column, valueFromInput(formValues[column] ?? '', values[columns.indexOf(column)], columnTypes[columns.indexOf(column)])]));
      const changes = Object.fromEntries(changedColumns.map(column => [column, valueFromInput(formValues[column] ?? '', values[columns.indexOf(column)], columnTypes[columns.indexOf(column)])]));
      const input = { connectionId, database: database || target.database, schema: target.schema, table, key, changes } as const;
      const preview = await api.editPreview(input);
      if (!window.confirm(`Confirm update of the selected row?\n\n${preview.warnings.join(' ')}\n\n${preview.sql}`)) {
        setMessage('Update cancelled.');
        return;
      }
      const result = await api.edit({ ...input, writeConfirmed: true, writePreviewToken: preview.previewToken });
      setMessage(result.message);
      onCompleted(result.message);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal-card edit-row-card" onSubmit={event => void submit(event)}>
      <div className="modal-header"><div><strong>Edit row</strong><small>{target.schema}.{table}</small></div><button type="button" className="secondary small" onClick={onClose}>Close</button></div>
      <p className="muted">Choose key columns used in the WHERE clause. Key columns remain unchanged; all other columns are written back.</p>
      <div className="edit-row-grid"><div className="edit-row-grid-header"><span>Key</span><span>Column</span><span>Value</span></div>{columns.map((column, index) => <label className="edit-row-line" key={`${column}-${index}`}><input type="checkbox" checked={keyColumns.has(column)} onChange={event => setKeyColumns(previous => { const next = new Set(previous); if (event.target.checked) next.add(column); else next.delete(column); return next; })} /><strong>{column}</strong><input value={formValues[column] ?? ''} onChange={event => setFormValues(previous => ({ ...previous, [column]: event.target.value }))} /></label>)}</div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success-message">{message}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button disabled={busy}>{busy ? 'Updating…' : 'Preview and update'}</button></div>
    </form>
  </div>;
}
