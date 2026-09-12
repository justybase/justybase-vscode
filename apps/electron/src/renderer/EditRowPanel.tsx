import { useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { MetadataColumn, QueryEditPreviewRequest, QueryEditRequest, SchemaTreeNode } from '@justybase/contracts';
import type { ElectronWorkspaceApi } from './api';

interface EditRowPanelProps {
  readonly api: ElectronWorkspaceApi;
  readonly connectionId: string;
  readonly database: string;
  readonly target: SchemaTreeNode;
  readonly columns: readonly MetadataColumn[];
  readonly values: readonly unknown[];
  onClose(): void;
  onCompleted(message: string): void;
}

function inputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
  }
  return String(value);
}

export function valueFromInput(value: string, original: unknown, type?: string): unknown {
  if (value.trim().toUpperCase() === 'NULL') return null;
  if (original === null || original === undefined) return value;
  const normalizedType = (type ?? '').toUpperCase();
  if (/INT|DECIMAL|NUMERIC|NUMBER/u.test(normalizedType)) return value.trim();
  if (/REAL|FLOAT|DOUBLE/u.test(normalizedType) || (typeof original === 'number' && !type)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof original === 'boolean' || /BOOL/u.test(normalizedType)) return /^(true|t|1)$/iu.test(value.trim());
  if (typeof original === 'object') {
    try { return JSON.parse(value) as unknown; } catch { return value; }
  }
  return value;
}

export function EditRowPanel({ api, connectionId, database, target, columns, values, onClose, onCompleted }: EditRowPanelProps): ReactElement {
  const [formValues, setFormValues] = useState<Record<string, string>>(() => Object.fromEntries(columns.map((column, index) => [column.name, inputValue(values[index])] )));
  const [keyColumns, setKeyColumns] = useState<ReadonlySet<string>>(() => new Set(columns.filter(column => column.isPk).map(column => column.name)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const table = target.objectName ?? target.label;
  const changedColumns = useMemo(() => columns.filter(column => !keyColumns.has(column.name)), [columns, keyColumns]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!target.schema || !table || !database) {
      setError('The target table is incomplete.');
      return;
    }
    if (keyColumns.size === 0) {
      setError('Select at least one key column.');
      return;
    }
    if (changedColumns.length === 0) {
      setError('Select at least one editable column.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const key = Object.fromEntries(columns.filter(column => keyColumns.has(column.name)).map(column => {
        const originalIndex = columns.indexOf(column);
        return [column.name, valueFromInput(formValues[column.name] ?? '', values[originalIndex], column.type)];
      }));
      const changes = Object.fromEntries(changedColumns.map(column => {
        const originalIndex = columns.indexOf(column);
        return [column.name, valueFromInput(formValues[column.name] ?? '', values[originalIndex], column.type)];
      }));
      const input: QueryEditPreviewRequest = { connectionId, database, schema: target.schema, table, key, changes };
      const preview = await api.editPreview(input);
      if (!window.confirm(`Confirm update of the selected row?\n\n${preview.warnings.join(' ')}\n\n${preview.sql}`)) {
        setMessage('Update cancelled.');
        return;
      }
      const result = await api.edit({ ...input, writeConfirmed: true, writePreviewToken: preview.previewToken } satisfies QueryEditRequest);
      setMessage(result.message);
      onCompleted(result.message);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="electron-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="electron-modal-card electron-edit-row-card" onSubmit={event => void submit(event)} role="dialog" aria-modal="true" aria-labelledby="electron-edit-row-title">
      <div className="electron-modal-header"><div><strong id="electron-edit-row-title">Edit row</strong><small>{target.schema}.{table}</small></div><button type="button" className="electron-secondary" onClick={onClose}>Close</button></div>
      <p className="electron-modal-hint">Choose key columns used in the WHERE clause. Key columns remain unchanged; all other columns are written back.</p>
      <div className="electron-edit-row-grid"><div className="electron-edit-row-header"><span>Key</span><span>Column</span><span>Value</span></div>{columns.map((column, index) => <label className="electron-edit-row-line" key={`${column.name}-${index}`}><input type="checkbox" checked={keyColumns.has(column.name)} onChange={event => setKeyColumns(previous => { const next = new Set(previous); if (event.target.checked) next.add(column.name); else next.delete(column.name); return next; })} /><strong>{column.name}</strong><input aria-label={`Value ${column.name}`} value={formValues[column.name] ?? ''} onChange={event => setFormValues(previous => ({ ...previous, [column.name]: event.target.value }))} /></label>)}</div>
      {error && <div className="electron-modal-error" role="alert">{error}</div>}
      {message && <div className="electron-modal-success" role="status">{message}</div>}
      <div className="electron-modal-actions"><button type="button" className="electron-secondary" onClick={onClose}>Cancel</button><button disabled={busy}>{busy ? 'Updating…' : 'Preview and update'}</button></div>
    </form>
  </div>;
}
