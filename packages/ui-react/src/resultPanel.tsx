import type { ReactElement } from 'react';
import type {
  SqlProblem,
  UiExecutionState,
  UiResultAnalysisTable,
  UiResultSurfaceState,
  UiResultViewState,
} from '@justybase/ui-core';
import {
  AsyncStateView,
  DataGrid,
  ResultOutputTabs,
  ResultTabs,
  ResultViewToolbar,
  RowDetail,
} from './components';
import type {
  AsyncViewState,
  DataGridCellContext,
  DataGridColumn,
  DataGridColumnFilterRequest,
  DataGridCopyPayload,
  GridScrollPosition,
  ResultOutputTab,
} from './components';
import type { DataGridClipboardFormat } from './dataGridClipboard';
import { DataGridColumnFilterPanel } from './dataGridFilter';
import type { DataGridColumnFilterState } from './dataGridFilter';
import { DataGridColumnMenu } from './dataGrid';
import { SqlProblemsPanel } from './sqlProblems';
import { ResultAnalysisPanel } from './resultAnalysis';

export interface ResultPanelProps {
  readonly results: readonly UiResultSurfaceState[];
  readonly activeResult?: UiResultSurfaceState;
  readonly execution?: UiExecutionState;
  readonly onRetryStatement?: (statementIndex: number) => void;
  readonly rows: readonly (readonly unknown[])[];
  readonly resultState: AsyncViewState;
  readonly resultMessage?: string;
  readonly activeTab: ResultOutputTab;
  readonly problemCount: number;
  readonly problems: readonly SqlProblem[];
  readonly onOutputTabChange: (tab: ResultOutputTab) => void;
  readonly onProblemSelect?: (problem: SqlProblem) => void;
  readonly onResultSelect: (resultSetId: string, sourceId?: string) => void;
  readonly onViewChange: (patch: Partial<UiResultViewState>) => void;
  readonly onLoadMore?: () => void | Promise<void>;
  readonly onScroll?: (position: GridScrollPosition) => void;
  readonly selectedRowIndex?: number;
  readonly onRowSelect?: (rowIndex: number) => void;
  readonly onCopySelection?: (payload: DataGridCopyPayload, format?: DataGridClipboardFormat) => void;
  readonly onViewCell?: (context: DataGridCellContext) => void;
  readonly onViewRow?: (context: DataGridCellContext) => void;
  readonly onEditRow?: (context: DataGridCellContext) => void;
  readonly onOpenColumnFilter?: (request: DataGridColumnFilterRequest) => void | Promise<void>;
  readonly filterMenu?: DataGridColumnFilterState;
  readonly onFilterMenuChange?: (patch: Partial<DataGridColumnFilterState>) => void;
  readonly onApplyColumnFilter?: () => void;
  readonly onClearColumnFilter?: () => void;
  readonly onCloseColumnFilter?: () => void;
  readonly onRefresh?: () => void;
  readonly onCopy?: () => void;
  readonly onExport?: () => void;
  readonly onAggregate?: () => void;
  readonly onGroup?: () => void;
  readonly onPivot?: () => void;
  readonly activeAnalysis?: UiResultAnalysisTable['kind'];
  readonly analysisBusy?: boolean;
  readonly resultAnalysis?: UiResultAnalysisTable;
  readonly resultAnalysisLoading?: boolean;
  readonly resultAnalysisError?: string;
  readonly onCloseResultAnalysis?: () => void;
  readonly onViewAnalysisCell?: (context: DataGridCellContext) => void;
  readonly onCopyAnalysisSelection?: (payload: DataGridCopyPayload, format?: DataGridClipboardFormat) => void;
  readonly detailColumns?: readonly DataGridColumn[];
  readonly onCloseRowDetail?: () => void;
  readonly exportFormat?: string;
  readonly onExportFormatChange?: (format: string) => void;
  readonly exportFormatAriaLabel?: string;
  /** Use local filtering/sorting when the host has the complete result set. */
  readonly clientProcessing?: boolean;
  readonly showContextMenu?: boolean;
  readonly showColumnMenu?: boolean;
  readonly showGroupingPanel?: boolean;
  readonly showInlineColumnFilters?: boolean;
  readonly loadingLabel?: string;
}

/**
 * Canonical result surface shared by Web and Electron.
 *
 * Host adapters own query execution, persistence, clipboard and dialogs. This
 * component owns the result-panel DOM so the two products cannot drift in tab
 * order, toolbar geometry, filter placement or grid composition.
 */
export function ResultPanel({
  results,
  activeResult,
  execution,
  onRetryStatement,
  rows,
  resultState,
  resultMessage,
  activeTab,
  problemCount,
  problems,
  onOutputTabChange,
  onProblemSelect,
  onResultSelect,
  onViewChange,
  onLoadMore,
  onScroll,
  selectedRowIndex,
  onRowSelect,
  onCopySelection,
  onViewCell,
  onViewRow,
  onEditRow,
  onOpenColumnFilter,
  filterMenu,
  onFilterMenuChange,
  onApplyColumnFilter,
  onClearColumnFilter,
  onCloseColumnFilter,
  onRefresh,
  onCopy,
  onExport,
  onAggregate,
  onGroup,
  onPivot,
  activeAnalysis,
  analysisBusy = false,
  resultAnalysis,
  resultAnalysisLoading = false,
  resultAnalysisError,
  onCloseResultAnalysis,
  onViewAnalysisCell,
  onCopyAnalysisSelection,
  detailColumns,
  onCloseRowDetail,
  exportFormat,
  onExportFormatChange,
  exportFormatAriaLabel = 'Result export format',
  clientProcessing = false,
  showContextMenu = true,
  showColumnMenu = true,
  showGroupingPanel = true,
  showInlineColumnFilters = false,
  loadingLabel = 'Streaming result data…',
}: ResultPanelProps): ReactElement {
  const detailRow = selectedRowIndex === undefined ? undefined : rows[selectedRowIndex];
  const detailColumnSet = detailColumns ?? activeResult?.columns ?? [];
  const statementEntries = execution ? Object.values(execution.statements).sort((left, right) => left.statementIndex - right.statementIndex) : [];
  const showExecutionSummary = execution !== undefined && (execution.mode === 'script' || execution.statementCount > 1 || execution.status === 'error' || execution.status === 'cancelled');

  return <section className="ui-result-panel" aria-label="Query results">
    <ResultOutputTabs activeTab={activeTab} problemCount={problemCount} onChange={onOutputTabChange} />
    {activeTab === 'problems' ? <div className="ui-result-output-content"><SqlProblemsPanel problems={problems} onSelect={onProblemSelect} /></div> : <>
      <div className="ui-result-heading"><strong>Result sets</strong><ResultTabs results={results} activeResultSetId={activeResult?.resultSetId} activeSourceId={activeResult?.sourceId} execution={execution} onSelect={onResultSelect} /></div>
      {showExecutionSummary && execution && <section className="ui-batch-summary" aria-label="Batch execution"><div className="ui-batch-summary-heading"><strong>{execution.mode === 'script' || execution.statementCount > 1 ? 'Batch execution' : 'Execution'}</strong><span>{execution.completedStatements} / {execution.statementCount} statements complete</span><span data-execution-status={execution.status}>Status: {execution.status}</span></div>{execution.message && <p>{execution.message}</p>}{statementEntries.length > 0 && <ol>{statementEntries.map(statement => <li key={statement.statementIndex} data-statement-status={statement.status}><span>Statement {statement.statementIndex + 1} · {statement.status}</span>{statement.status === 'error' && onRetryStatement && <button type="button" onClick={() => onRetryStatement(statement.statementIndex)}>Retry statement {statement.statementIndex + 1}</button>}</li>)}</ol>}</section>}
      {activeResult && <div className="ui-result-controls"><ResultViewToolbar columns={activeResult.columns} view={activeResult.view} onChange={onViewChange} onAggregate={onAggregate} onGroup={onGroup} onPivot={onPivot} activeAnalysis={activeAnalysis} analysisBusy={analysisBusy} onRefresh={onRefresh} onCopy={onCopy} onExport={onExport} columnMenu={showColumnMenu ? <DataGridColumnMenu columns={activeResult.columns} view={activeResult.view} onViewChange={onViewChange} /> : undefined} />
        {exportFormat !== undefined && onExportFormatChange && <label className="ui-export-format">Format<select aria-label={exportFormatAriaLabel} value={exportFormat} onChange={event => onExportFormatChange(event.target.value)}><option value="csv">CSV</option><option value="csv.gz">CSV gzip</option><option value="csv.zst">CSV zstd</option><option value="json">JSON</option><option value="xml">XML</option><option value="sql">SQL INSERT</option><option value="markdown">Markdown</option><option value="xlsx">XLSX</option><option value="xlsb">XLSB</option></select></label>}
      </div>}
      {activeResult && (resultAnalysis || resultAnalysisLoading || resultAnalysisError) && <ResultAnalysisPanel sourceId={activeResult.sourceId} resultSetId={activeResult.resultSetId} table={resultAnalysis} loading={resultAnalysisLoading} error={resultAnalysisError} onClose={onCloseResultAnalysis ?? (() => undefined)} onCopySelection={onCopyAnalysisSelection ?? onCopySelection} onViewCell={onViewAnalysisCell ?? onViewCell} />}
      <AsyncStateView state={resultState} message={resultMessage} emptyLabel="No rows to display." loadingLabel={loadingLabel}>
        <DataGrid sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'empty'} columns={activeResult?.columns ?? []} rows={rows} totalRowCount={activeResult?.totalRowCount} view={activeResult?.view} onViewChange={onViewChange} clientProcessing={clientProcessing} showContextMenu={showContextMenu} showColumnMenu={false} showGroupingPanel={showGroupingPanel} showInlineColumnFilters={showInlineColumnFilters} onOpenColumnFilter={onOpenColumnFilter} selectedRowIndex={selectedRowIndex} scroll={activeResult ? { sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow, ...(activeResult.view.scrollRowHeight === undefined ? {} : { rowHeight: activeResult.view.scrollRowHeight }) } : undefined} onScroll={onScroll} onLoadMore={onLoadMore} onCopySelection={onCopySelection} onViewCell={onViewCell} onViewRow={onViewRow} onEditRow={onEditRow} onRowSelect={onRowSelect} />
      </AsyncStateView>
      {filterMenu && onFilterMenuChange && onApplyColumnFilter && onClearColumnFilter && onCloseColumnFilter && <DataGridColumnFilterPanel state={filterMenu} onChange={onFilterMenuChange} onApply={onApplyColumnFilter} onClear={onClearColumnFilter} onClose={onCloseColumnFilter} />}
      {detailRow !== undefined && activeResult && onCloseRowDetail && <RowDetail columns={detailColumnSet} row={detailRow} onClose={onCloseRowDetail} />}
    </>}
  </section>;
}
