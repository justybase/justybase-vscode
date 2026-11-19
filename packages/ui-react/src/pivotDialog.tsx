import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { DataGridColumn } from './dataGridTypes';
import { isDataGridNumericColumn } from './resultGridFormatting';

export type PivotAggregation = 'sum' | 'count' | 'avg' | 'min' | 'max';

export interface PivotConfiguration {
  readonly rowColumnIndex: number;
  readonly pivotColumnIndex: number;
  readonly valueColumnIndex: number;
  readonly aggregation: PivotAggregation;
}

export interface PivotDialogProps {
  readonly columns: readonly DataGridColumn[];
  readonly defaults?: Partial<PivotConfiguration>;
  readonly onSubmit: (configuration: PivotConfiguration) => void;
  readonly onClose: () => void;
}

const AGGREGATION_LABELS: Record<PivotAggregation, string> = {
  sum: 'Sum',
  count: 'Count',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
};

function firstDifferentIndex(index: number, columns: readonly DataGridColumn[], excluded: number): number {
  for (let candidate = 0; candidate < columns.length; candidate += 1) {
    if (candidate !== index && candidate !== excluded) return candidate;
  }
  return excluded === 0 ? Math.max(0, columns.length - 1) : 0;
}

/**
 * Compact pivot builder. The legacy Explore pivot always asked for a row
 * dimension, a column dimension and a value; doing that silently from one
 * toolbar click produced matrices nobody could explain. The dialog makes the
 * three inputs and the aggregation explicit before the request runs.
 */
export function PivotDialog({ columns, defaults, onSubmit, onClose }: PivotDialogProps): ReactNode {
  const numericIndexes = columns
    .map((column, index) => ({ column, index }))
    .filter(item => isDataGridNumericColumn(item.column))
    .map(item => item.index);
  const valueCandidates = numericIndexes.length > 0 ? numericIndexes : columns.map((_column, index) => index);
  const initialRow = defaults?.rowColumnIndex ?? 0;
  const initialPivot = defaults?.pivotColumnIndex ?? firstDifferentIndex(initialRow, columns, -1);
  const initialValue = defaults?.valueColumnIndex ?? valueCandidates[0] ?? 0;
  const [rowColumnIndex, setRowColumnIndex] = useState(initialRow);
  const [pivotColumnIndex, setPivotColumnIndex] = useState(initialPivot);
  const [valueColumnIndex, setValueColumnIndex] = useState(initialValue);
  const [aggregation, setAggregation] = useState<PivotAggregation>(
    defaults?.aggregation ?? (numericIndexes.length > 0 ? 'sum' : 'count'),
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const selectRow = (index: number): void => {
    setRowColumnIndex(index);
    if (pivotColumnIndex === index) {
      setPivotColumnIndex(firstDifferentIndex(index, columns, -1));
    }
  };
  const selectPivot = (index: number): void => {
    setPivotColumnIndex(index);
    if (rowColumnIndex === index) {
      setRowColumnIndex(firstDifferentIndex(index, columns, -1));
    }
  };
  const canSubmit = columns.length >= 2
    && rowColumnIndex !== pivotColumnIndex
    && valueColumnIndex >= 0
    && valueColumnIndex < columns.length;

  return <div className="ui-pivot-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form
      className="ui-pivot-dialog"
      role="dialog"
      aria-label="Create pivot"
      onMouseDown={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit({ rowColumnIndex, pivotColumnIndex, valueColumnIndex, aggregation });
      }}
    >
      <header className="ui-pivot-dialog-header">
        <h2>Create pivot</h2>
        <button type="button" className="ui-pivot-dialog-close" aria-label="Close pivot dialog" onClick={onClose}>×</button>
      </header>
      <p className="ui-pivot-dialog-hint">
        Rows become the first column, the pivot column becomes the header row, and the value is aggregated in each cell.
      </p>
      <div className="ui-pivot-dialog-fields">
        <label>
          <span>Rows</span>
          <select aria-label="Pivot rows" value={rowColumnIndex} onChange={event => selectRow(Number(event.target.value))}>
            {columns.map((column, index) => <option key={`row:${column.name}:${index}`} value={index}>{column.name}</option>)}
          </select>
        </label>
        <label>
          <span>Columns</span>
          <select aria-label="Pivot columns" value={pivotColumnIndex} onChange={event => selectPivot(Number(event.target.value))}>
            {columns.map((column, index) => <option key={`pivot:${column.name}:${index}`} value={index}>{column.name}</option>)}
          </select>
        </label>
        <label>
          <span>Values</span>
          <select aria-label="Pivot values" value={valueColumnIndex} onChange={event => setValueColumnIndex(Number(event.target.value))}>
            {valueCandidates.map(index => <option key={`value:${columns[index]?.name}:${index}`} value={index}>{columns[index]?.name ?? `Column ${index + 1}`}</option>)}
          </select>
        </label>
        <label>
          <span>Aggregation</span>
          <select aria-label="Pivot aggregation" value={aggregation} onChange={event => setAggregation(event.target.value as PivotAggregation)}>
            {(Object.keys(AGGREGATION_LABELS) as PivotAggregation[]).map(value => <option key={value} value={value}>{AGGREGATION_LABELS[value]}</option>)}
          </select>
        </label>
      </div>
      <footer className="ui-pivot-dialog-footer">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={!canSubmit}>Create pivot</button>
      </footer>
    </form>
  </div>;
}
