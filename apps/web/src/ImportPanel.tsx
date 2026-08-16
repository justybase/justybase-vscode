import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { QueryFileImportFormat, SchemaTreeNode } from '@justybase/contracts';
import { api } from './api';

interface ImportPanelProps {
  connectionId: string;
  target: SchemaTreeNode;
  database: string;
  onClose(): void;
  onCompleted(): void;
}

function fileFormat(fileName: string): QueryFileImportFormat | undefined {
  const extension = fileName.toLowerCase().split('.').pop();
  return extension === 'csv' ? 'csv' : extension === 'xlsx' ? 'xlsx' : extension === 'xlsb' ? 'xlsb' : undefined;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      if (comma < 0) reject(new Error('Could not encode the selected file.'));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function ImportPanel({ connectionId, target, database, onClose, onCompleted }: ImportPanelProps): ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(',');
  const [sheetName, setSheetName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const table = target.objectName ?? target.label;
  const format = file ? fileFormat(file.name) : undefined;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!file || !format) {
      setError('Choose a CSV, XLSX, or XLSB file.');
      return;
    }
    if (!target.schema || !table) {
      setError('The target table is incomplete.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const contentBase64 = await readBase64(file);
      const input = {
        connectionId,
        database: database || target.database,
        schema: target.schema,
        table,
        fileName: file.name,
        contentBase64,
        format,
        hasHeader,
        ...(format === 'csv' ? { delimiter: delimiter || ',' } : {}),
        ...(format !== 'csv' && sheetName.trim() ? { sheetName: sheetName.trim() } : {}),
      } as const;
      const preview = await api.importFilePreview(input);
      const previewText = `${preview.warnings.join(' ')}\n\n${preview.sql.slice(0, 2_000)}${preview.sql.length > 2_000 ? '\n…' : ''}`;
      if (!window.confirm(`Confirm import into ${target.schema}.${table}?\n\n${previewText}`)) {
        setMessage('Import cancelled.');
        return;
      }
      const result = await api.importFile({ ...input, writeConfirmed: true, writePreviewToken: preview.previewToken });
      setMessage(result.message);
      onCompleted();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal-card import-card" onSubmit={event => void submit(event)}>
      <div className="modal-header"><div><strong>Import data</strong><small>{target.schema}.{table}</small></div><button type="button" className="secondary small" onClick={onClose}>Close</button></div>
      <label>File<input type="file" accept=".csv,.xlsx,.xlsb" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      <label className="checkbox"><input type="checkbox" checked={hasHeader} onChange={event => setHasHeader(event.target.checked)} />First row contains column names</label>
      {format === 'csv' && <label>CSV delimiter<input value={delimiter} maxLength={1} onChange={event => setDelimiter(event.target.value.slice(-1))} /></label>}
      {format !== undefined && format !== 'csv' && <label>Worksheet (optional)<input value={sheetName} onChange={event => setSheetName(event.target.value)} placeholder="First worksheet" /></label>}
      {error && <div className="error">{error}</div>}
      {message && <div className="success-message">{message}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button disabled={busy || !file}>{busy ? 'Importing…' : 'Preview and import'}</button></div>
    </form>
  </div>;
}
