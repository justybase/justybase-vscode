import type { ReactNode } from 'react';
import { DataGrid } from './dataGrid';
import type { DataGridCellContext, DataGridColumn, DataGridCopyPayload, DataGridViewState } from './dataGrid';
import type { DataGridClipboardFormat } from './dataGridClipboard';
import type { DataGridCellMetadata } from './resultGridFormatting';

export type ResultAnalysisKind = 'aggregate' | 'group' | 'pivot';

/** A renderer-ready analysis table. The adapter owns how rows are produced. */
export interface ResultAnalysisTable {
  readonly kind: ResultAnalysisKind;
  readonly title: string;
  readonly summary?: string;
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly totalRowCount?: number;
  readonly getCellMetadata?: (
    value: unknown,
    rowIndex: number,
    columnIndex: number,
    column: DataGridColumn,
  ) => DataGridCellMetadata;
}

export interface ResultAnalysisPanelProps {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly table?: ResultAnalysisTable;
  readonly loading?: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onCopySelection?: (payload: DataGridCopyPayload, format?: DataGridClipboardFormat) => void;
  readonly onViewCell?: (context: DataGridCellContext) => void;
}

const emptyView: DataGridViewState = {
  globalFilter: '',
  columnFilters: {},
  sorting: [],
  grouping: [],
};

/**
 * Shared presentation for aggregate/group/pivot output. Analysis results use
 * the same DataGrid, clipboard path, and cell viewer as the primary result
 * set, so the three shells cannot silently diverge in formatting or actions.
 */
export function ResultAnalysisPanel({
  sourceId,
  resultSetId,
  table,
  loading = false,
  error,
  onClose,
  onCopySelection,
  onViewCell,
}: ResultAnalysisPanelProps): ReactNode {
  return <section className="ui-result-analysis" aria-label="Result analysis" data-analysis-kind={table?.kind ?? 'none'}>
    <header className="ui-result-analysis-header">
      <div>
        <h2>{table?.title ?? 'Result analysis'}</h2>
        {table?.summary && <small>{table.summary}</small>}
      </div>
      <button type="button" aria-label="Close result analysis" onClick={onClose}>Close</button>
    </header>
    {loading && <div className="ui-result-analysis-status" role="status" aria-live="polite">Calculating…</div>}
    {!loading && error && <div className="ui-result-analysis-status ui-result-analysis-error" role="alert">{error}</div>}
    {!loading && !error && table && <div className="ui-result-analysis-grid">
      <DataGrid
        sourceId={sourceId}
        resultSetId={`${resultSetId}:analysis:${table.kind}`}
        columns={table.columns}
        rows={table.rows}
        totalRowCount={table.totalRowCount ?? table.rows.length}
        view={emptyView}
        onViewChange={() => undefined}
        clientProcessing={false}
        showContextMenu
        showColumnMenu={false}
        getCellMetadata={table.getCellMetadata}
        onCopySelection={onCopySelection}
        onViewCell={onViewCell}
      />
    </div>}
  </section>;
}
