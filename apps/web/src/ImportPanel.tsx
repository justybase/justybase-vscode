import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { MAX_QUERY_FILE_IMPORT_BYTES } from '@justybase/contracts';
import type { QueryFileImportFormat, QueryFileImportPreviewRequest, QueryFileImportRequest, SchemaTreeNode } from '@justybase/contracts';
import { useApiClient } from './api';

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
  const api = useApiClient();
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
    if (file.size > MAX_QUERY_FILE_IMPORT_BYTES) {
      setError('The selected file is larger than the 25 MB import limit.');
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
      const input: QueryFileImportPreviewRequest = {
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
      };
      const preview = await api.importFilePreview(input);
      const warningText = preview.warnings.length > 0 ? `\n${preview.warnings.join(' ')}` : '';
      const previewText = `${preview.sql.slice(0, 2_000)}${preview.sql.length > 2_000 ? '\n…' : ''}`;
      if (!window.confirm(`Confirm import of ${preview.rowCount.toLocaleString()} row(s) into ${target.schema}.${table}?${warningText}\n\n${previewText}`)) {
        setMessage('Import cancelled.');
        return;
      }
      const result = await api.importFile({ ...input, writeConfirmed: true, writePreviewToken: preview.previewToken } satisfies QueryFileImportRequest);
      setMessage(result.message);
      onCompleted();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal-card import-card" onSubmit={event => void submit(event)} role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="modal-header"><div><strong id="import-title">Import data</strong><small>{target.schema}.{table}</small></div><button type="button" className="secondary small" onClick={onClose}>Close</button></div>
      <label>File<input type="file" accept=".csv,.xlsx,.xlsb" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      <label className="checkbox"><input type="checkbox" checked={hasHeader} onChange={event => setHasHeader(event.target.checked)} />First row contains column names</label>
      {format === 'csv' && <label>CSV delimiter<input value={delimiter} maxLength={1} onChange={event => setDelimiter(event.target.value.slice(-1))} /></label>}
      {format !== undefined && format !== 'csv' && <label>Worksheet (optional)<input value={sheetName} onChange={event => setSheetName(event.target.value)} placeholder="First worksheet" /></label>}
      {file && <small>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB · {format?.toUpperCase() ?? 'Unsupported format'}</small>}
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="success-message" role="status">{message}</div>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button disabled={busy || !file || !format}>{busy ? 'Importing…' : 'Preview and import'}</button></div>
    </form>
  </div>;
}
