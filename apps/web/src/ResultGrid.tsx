import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef, ColumnFiltersState, ColumnPinningState, RowSelectionState, SortingState, VisibilityState } from '@tanstack/react-table';
import type { QueryAggregateFunction, QueryAggregateResponse, QueryColumnFilterSpec, QueryExportFormat, QueryGroupResponse, QuerySortSpec } from '@justybase/contracts';
import type { UiResultViewState } from '@justybase/ui-core';
import { DataGrid, formatDataGridCellValue, processDataGridRows } from '@justybase/ui-react';
import { aggregateResultRows, filterResultRows, type ResultColumn, type ResultColumnFilter } from '@justybase/result-core';
import { useApiClient } from './api';
import { readLegacyWorkspaceValue, useWorkspaceStorage, type WorkspaceStorage } from './workspacePersistence';
import { type ResultState } from './queryState';

interface GridRow { values: readonly unknown[]; }

interface GridContextMenuState {
  x: number;
  y: number;
  rowIndex: number;
  columnIndex: number;
}

interface SavedGridState {
  pageSize?: number;
  sorting?: SortingState;
  columnFilters?: ColumnFiltersState;
  globalFilter?: string;
  columnVisibility?: VisibilityState;
  columnPinning?: ColumnPinningState;
  columnOrder?: string[];
  columnWidths?: Record<string, number>;
  grouping?: string[];
}

interface PersistedGridStateEnvelope {
  version: 2;
  resultSetId: string;
  state: SavedGridState;
}

interface PivotResult {
  columns: string[];
  rows: unknown[][];
}

function gridStateKey(resultSetId: string): string {
  return `grid_v2_${resultSetId}`;
}

function legacyGridStateKey(queryId: string, statementIndex: number): string {
  return `grid_${queryId}_${statementIndex}`;
}

function parseGridState(value: string | null, expectedResultSetId: string): SavedGridState | undefined {
  try {
    if (!value) return undefined;
    const parsed = JSON.parse(value) as PersistedGridStateEnvelope;
    if (parsed && typeof parsed === 'object' && parsed.version === 2 && parsed.resultSetId === expectedResultSetId && parsed.state && typeof parsed.state === 'object') return parsed.state;
    return undefined;
  } catch {
    return undefined;
  }
}

function readGridState(storage: WorkspaceStorage, key: string, expectedResultSetId: string): SavedGridState | undefined {
  return parseGridState(storage.get(key), expectedResultSetId);
}

function parseLegacyGridState(value: string | null): SavedGridState | undefined {
  try {
    if (!value) return undefined;
    const parsed = JSON.parse(value) as SavedGridState;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readLegacyGridState(storage: WorkspaceStorage, key: string): SavedGridState | undefined {
  return parseLegacyGridState(storage.get(key));
}

function serialiseValue(value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function uniqueJsonNames(columns: string[]): string[] {
  const used = new Set<string>();
  return columns.map((column, index) => {
    const base = column || `column_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) { candidate = `${base}_${suffix}`; suffix += 1; }
    used.add(candidate);
    return candidate;
  });
}

function rowAsJson(columns: string[], values: readonly unknown[]): string {
  const record: Record<string, unknown> = {};
  uniqueJsonNames(columns).forEach((column, index) => { record[column] = serialiseValue(values[index]); });
  return JSON.stringify(record, null, 2);
}

function rowAsMarkdown(columns: string[], values: readonly unknown[], types: Array<string | undefined>): string {
  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = `| ${values.map((value, index) => formatCellValue(value, types[index]).text.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [header, separator, body].join('\n');
}

function rowAsInsert(columns: string[], values: readonly unknown[]): string {
  const names = columns.map((column, index) => `"${(column || `column_${index + 1}`).replace(/"/g, '""')}"`).join(', ');
  return `INSERT INTO <table> (${names}) VALUES (${values.map(sqlLiteral).join(', ')});`;
}

/**
 * Type-aware formatting and display utilities for cell values.
 * Inspired by the extension's result panel but simplified for the web.
 */
function isNumericType(type?: string): boolean {
  if (!type) return false;
  return /INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(type.toUpperCase());
}

function formatCellValue(value: unknown, type?: string): { text: string; isNull: boolean; colorClass: string; } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true, colorClass: '' };
  const t = (type ?? '').toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(t)) {
    // Keep string/BigInt values verbatim. Converting Netezza DECIMAL/NUMERIC
    // values through Number can silently lose precision.
    return { text: String(value), isNull: false, colorClass: 'val-num' };
  }
  if (/DATE|TIME|TIMESTAMP/.test(t)) {
    return { text: String(value), isNull: false, colorClass: 'val-date' };
  }
  if (/BOOL/.test(t)) {
    const text = formatDataGridCellValue(value, type);
    return { text, isNull: false, colorClass: text === 'TRUE' ? 'val-bool-t' : 'val-bool-f' };
  }
  const text = formatDataGridCellValue(value, type);
  return { text, isNull: false, colorClass: '' };
}

export function ResultGrid({ queryId, statementIndex = 0, result, onEditRow }: { queryId: string; statementIndex?: number; result: ResultState; onEditRow?(values: unknown[]): void }): ReactElement {
  const api = useApiClient();
  const storage = useWorkspaceStorage();
  const [rows, setRows] = useState<unknown[][]>(result.rows);
  const [totalRows, setTotalRows] = useState(result.totalRows);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(200);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: [], right: [] });
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [gridGrouping, setGridGrouping] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportFormat, setExportFormat] = useState<QueryExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => result.columns.map((_, i) => String(i)));
  const [contextMenu, setContextMenu] = useState<GridContextMenuState | null>(null);
  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [showAggregates, setShowAggregates] = useState(false);
  const [aggregates, setAggregates] = useState<QueryAggregateResponse | null>(null);
  const [aggregatesLoading, setAggregatesLoading] = useState(false);
  const [gridHydratedKey, setGridHydratedKey] = useState<string | null>(null);
  const [grouped, setGrouped] = useState<QueryGroupResponse | null>(null);
  const [pivot, setPivot] = useState<PivotResult | null>(null);
  const [grouping, setGrouping] = useState(false);
  const requestGeneration = useRef(0);
  const resultSetId = result.resultSetId ?? `${queryId}::statement-${statementIndex}`;
  const gridKey = gridStateKey(resultSetId);
  const legacyKey = legacyGridStateKey(queryId, statementIndex);

  const requestFilters = useMemo<QueryColumnFilterSpec[]>(() => columnFilters.flatMap(item => typeof item.value === 'string' && item.value.trim() ? [{ columnIndex: Number(item.id), value: item.value }] : []), [columnFilters]);
  const requestSorting = useMemo<QuerySortSpec[]>(() => sorting.map(item => ({ columnIndex: Number(item.id), desc: item.desc })), [sorting]);
  const hasGridFilter = globalFilter.trim().length > 0 || requestFilters.length > 0;
  const localFilterColumns = useMemo<ResultColumn[]>(() => result.columns.map((name, index) => ({ name, type: result.columnTypes[index] })), [result.columns, result.columnTypes]);
  const localFilters = useMemo<ResultColumnFilter[]>(() => requestFilters.map(filter => ({
    columnIndex: filter.columnIndex,
    value: { _isConditionFilter: true, logic: 'and', conditions: [{ type: 'contains', value: filter.value }] },
  })), [requestFilters]);

  useEffect(() => {
    setRows(result.rows);
    setTotalRows(result.totalRows);
    setPageIndex(0);
    setRowSelection({});
    setError('');
    setAggregates(null);
    setContextMenu(null);
    setDetailRowIndex(null);
    setShowAggregates(false);
    setGridHydratedKey(null);
    const saved = readGridState(storage, gridKey, resultSetId)
      ?? readLegacyGridState(storage, legacyKey)
      ?? parseGridState(readLegacyWorkspaceValue(`jwb_grid_v2_${resultSetId}`), resultSetId)
      ?? parseLegacyGridState(readLegacyWorkspaceValue(`jwb_grid_${queryId}_${statementIndex}`));
    const defaultOrder = result.columns.map((_, i) => String(i));
    const savedOrder = saved?.columnOrder?.filter(column => defaultOrder.includes(column)) ?? [];
    const mergedOrder = [...savedOrder, ...defaultOrder.filter(column => !savedOrder.includes(column))];
    setPageSize(saved?.pageSize && saved.pageSize >= 1 && saved.pageSize <= 1000 ? saved.pageSize : 200);
    setSorting(Array.isArray(saved?.sorting) ? saved.sorting : []);
    setColumnFilters(Array.isArray(saved?.columnFilters) ? saved.columnFilters : []);
    setGlobalFilter(typeof saved?.globalFilter === 'string' ? saved.globalFilter : '');
    setColumnVisibility(saved?.columnVisibility ?? {});
    setColumnPinning(saved?.columnPinning ?? { left: [], right: [] });
    setColumnWidths(saved?.columnWidths ?? {});
    setGridGrouping(saved?.grouping ?? []);
    setColumnOrder(mergedOrder);
    setGridHydratedKey(gridKey);
  }, [gridKey, legacyKey, resultSetId, result.sessionId, result.columns, storage]);

  useEffect(() => {
    if (gridHydratedKey !== gridKey) return;
    try {
      const state: SavedGridState = { pageSize, sorting, columnFilters, globalFilter, columnVisibility, columnPinning, columnOrder, columnWidths, grouping: gridGrouping };
      const envelope: PersistedGridStateEnvelope = { version: 2, resultSetId, state };
      storage.set(gridKey, JSON.stringify(envelope));
    } catch {
      // A full localStorage should not make the result grid unusable.
    }
  }, [gridKey, gridHydratedKey, resultSetId, pageSize, sorting, columnFilters, globalFilter, columnVisibility, columnPinning, columnOrder, columnWidths, gridGrouping, storage]);

  useEffect(() => {
    if (!queryId || !result.sessionId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    void api.queryPage(queryId, { statementIndex, offset: pageIndex * pageSize, limit: pageSize, sorting: requestSorting, columnFilters: requestFilters, globalFilter }).then(response => {
      if (generation !== requestGeneration.current) return;
      setRows(response.rows);
      setTotalRows(response.totalRows);
    }).catch(reason => { if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Could not load result page.'); }).finally(() => { if (generation === requestGeneration.current) setLoading(false); });
  }, [queryId, statementIndex, result.sessionId, result.status, pageIndex, pageSize, requestSorting, requestFilters, globalFilter]);

  async function loadAggregates(): Promise<void> {
    if (!queryId) return;
    setAggregatesLoading(true);
    try {
      if (!result.sessionId) {
        const filteredRows = filterResultRows(result.rows, localFilterColumns, { globalFilter, columnFilters: localFilters });
        const functions: QueryAggregateFunction[] = ['count', 'sum', 'avg', 'min', 'max'];
        const calculated = aggregateResultRows(filteredRows, result.columns
          .map((name, index) => ({ name, type: result.columnTypes[index] }))
          .flatMap((column, columnIndex) => functions.map(fn => ({
            columnIndex,
            function: fn,
            dataType: column.type,
          }))));
        const values = result.columns.map((_name, columnIndex) => {
          const entries = calculated.filter(item => item.columnIndex === columnIndex);
          const valueFor = (fn: QueryAggregateFunction) => entries.find(item => item.function === fn)?.value;
          return {
            columnIndex,
            count: Number(valueFor('count') ?? 0),
            sum: valueFor('sum'),
            avg: valueFor('avg'),
            min: valueFor('min'),
            max: valueFor('max'),
          };
        });
        setAggregates({ statementIndex, filteredRowCount: filteredRows.length, values });
      } else {
        const response = await api.aggregate(queryId, { statementIndex, globalFilter, columnFilters: requestFilters, functions: ['count', 'sum', 'avg', 'min', 'max'] as QueryAggregateFunction[] });
        setAggregates(response);
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not calculate aggregates.');
    } finally {
      setAggregatesLoading(false);
    }
  }

  function columnIndexes(value: string): number[] {
    return [...new Set(value.split(',').map(part => Number(part.trim()) - 1).filter(index => Number.isInteger(index) && index >= 0 && index < result.columns.length))];
  }

  async function groupResults(): Promise<void> {
    const selected = window.prompt(`Group by column number(s), 1-${result.columns.length}:`, '1');
    if (!selected) return;
    const groupByColumnIndices = columnIndexes(selected);
    if (groupByColumnIndices.length === 0) { setError('No valid grouping columns were selected.'); return; }
    setGrouping(true);
    setError('');
    try {
      const aggregates = [
        { function: 'count' as const },
        ...result.columns.map((_column, index) => ({ index, function: 'sum' as const })).filter(item => isNumericType(result.columnTypes[item.index])).map(item => ({ function: item.function, columnIndex: item.index })),
      ];
      setGrouped(await api.group(queryId, { statementIndex, groupByColumnIndices, aggregates, globalFilter, columnFilters: requestFilters, groupLimit: 2_000 }));
      setPivot(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not group results.');
    } finally {
      setGrouping(false);
    }
  }

  async function pivotResults(): Promise<void> {
    const selected = window.prompt('Pivot columns: row column, pivot column, numeric value column (1-based):', '1,2,3');
    if (!selected) return;
    const indices = columnIndexes(selected);
    if (indices.length !== 3) { setError('Pivot requires exactly three column numbers.'); return; }
    setGrouping(true);
    setError('');
    try {
      const response = await api.group(queryId, { statementIndex, groupByColumnIndices: indices.slice(0, 2), aggregates: [{ function: 'sum', columnIndex: indices[2] }], globalFilter, columnFilters: requestFilters, groupLimit: 2_000 });
      const pivotValues = [...new Set(response.rows.map(row => String(row[1] ?? 'NULL')))];
      const rowValues = [...new Set(response.rows.map(row => String(row[0] ?? 'NULL')))];
      const rowMap = new Map<string, Map<string, unknown>>();
      response.rows.forEach(row => {
        const rowKey = String(row[0] ?? 'NULL');
        const values = rowMap.get(rowKey) ?? new Map<string, unknown>();
        values.set(String(row[1] ?? 'NULL'), row[2]);
        rowMap.set(rowKey, values);
      });
      setPivot({ columns: [result.columns[indices[0]] ?? 'Row', ...pivotValues], rows: rowValues.map(rowValue => [rowValue, ...pivotValues.map(pivotValue => rowMap.get(rowValue)?.get(pivotValue) ?? null)]) });
      setGrouped(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not pivot results.');
    } finally {
      setGrouping(false);
    }
  }

  useEffect(() => {
    if (showAggregates) void loadAggregates();
  }, [showAggregates, globalFilter, requestFilters, result.sessionId]);

  const columns = useMemo<ColumnDef<GridRow>[]>(() => result.columns.map((name, index) => {
    const dataType = result.columnTypes[index];
    return {
      id: String(index),
      accessorFn: row => row.values[index],
      header: name,
      meta: { dataType },
      size: isNumericType(dataType) ? 130 : 150,
      enableSorting: true,
      enableColumnFilter: true,
      enableResizing: true,
      cell: info => {
        const value = info.getValue();
        const formatted = formatCellValue(value, dataType);
        return (
          <span
            className={`cell-value ${formatted.colorClass} ${formatted.isNull ? 'null-value' : ''}`}
            title={formatted.text}
          >
            {formatted.text}
          </span>
        );
      },
    };
  }), [result.columns, result.columnTypes]);
  const displayRows = useMemo(() => result.sessionId
    ? rows
    : processDataGridRows(localFilterColumns, result.rows, {
      globalFilter,
      columnFilters: Object.fromEntries(columnFilters.map(item => [item.id, typeof item.value === 'string' ? item.value : ''])),
      sorting: sorting.map(item => ({ column: item.id, descending: item.desc })),
      grouping: [],
    }), [result.sessionId, result.rows, rows, localFilterColumns, globalFilter, columnFilters, sorting]);
  const data = useMemo(() => displayRows.map(values => ({ values })), [displayRows]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection, columnVisibility, columnPinning, columnOrder },
    onSortingChange: updater => { setSorting(updater); setPageIndex(0); },
    onColumnFiltersChange: updater => { setColumnFilters(updater); setPageIndex(0); },
    onGlobalFilterChange: updater => { setGlobalFilter(updater); setPageIndex(0); },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnPinningChange: setColumnPinning,
    onColumnOrderChange: setColumnOrder,
    manualSorting: true,
    manualFiltering: true,
    enableRowSelection: true,
    enableColumnPinning: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  });
  const selectedRows = table.getSelectedRowModel().rows;
  const effectiveTotalRows = result.sessionId ? totalRows : data.length;
  const totalPages = Math.max(1, Math.ceil(effectiveTotalRows / pageSize));
  const sharedGridView = useMemo(() => ({
    globalFilter,
    columnFilters: Object.fromEntries(columnFilters.map(item => [item.id, typeof item.value === 'string' ? item.value : ''])),
    sorting: sorting.map(item => ({ column: item.id, descending: item.desc })),
    grouping: gridGrouping,
    columnVisibility,
    columnOrder,
    pinnedColumns: columnPinning.left ?? [],
    columnWidths,
  }), [globalFilter, columnFilters, sorting, gridGrouping, columnVisibility, columnOrder, columnPinning.left, columnWidths]);

  function updateSharedGridView(patch: Partial<UiResultViewState>): void {
    if (patch.globalFilter !== undefined) { setGlobalFilter(patch.globalFilter); setPageIndex(0); }
    if (patch.columnFilters !== undefined) {
      setColumnFilters(Object.entries(patch.columnFilters).filter(([, value]) => value.length > 0).map(([id, value]) => ({ id, value })));
      setPageIndex(0);
    }
    if (patch.sorting !== undefined) {
      setSorting(patch.sorting.map(item => ({ id: item.column, desc: item.descending })));
      setPageIndex(0);
    }
    if (patch.columnVisibility !== undefined) setColumnVisibility({ ...patch.columnVisibility });
    if (patch.columnOrder !== undefined) setColumnOrder([...patch.columnOrder]);
    if (patch.pinnedColumns !== undefined) setColumnPinning({ left: [...patch.pinnedColumns], right: [] });
    if (patch.columnWidths !== undefined) setColumnWidths({ ...patch.columnWidths });
    if (patch.grouping !== undefined) setGridGrouping([...patch.grouping]);
  }

  useEffect(() => {
    const closeMenu = (): void => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setContextMenu(null); };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('click', closeMenu); document.removeEventListener('keydown', handleKeyDown); };
  }, []);

  function copyText(text: string): void {
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) {
      setError('Clipboard access is unavailable');
      return;
    }
    void writeText.call(navigator.clipboard, text).catch(() => setError('Failed to copy to clipboard'));
  }

  function contextRow(): GridRow | undefined {
    const values = contextMenu ? displayRows[contextMenu.rowIndex] : undefined;
    return values === undefined ? undefined : { values: [...values] };
  }

  function copyContext(format: 'value' | 'tsv' | 'json' | 'markdown' | 'sql'): void {
    if (!contextMenu) return;
    const row = contextRow();
    if (!row) return;
    const value = row.values[contextMenu.columnIndex];
    const text = format === 'value' ? formatCellValue(value, result.columnTypes[contextMenu.columnIndex]).text
      : format === 'tsv' ? [result.columns.join('\t'), row.values.map((item, index) => formatCellValue(item, result.columnTypes[index]).text).join('\t')].join('\n')
        : format === 'json' ? rowAsJson(result.columns, row.values)
          : format === 'markdown' ? rowAsMarkdown(result.columns, row.values, result.columnTypes)
            : rowAsInsert(result.columns, row.values);
    copyText(text);
    setContextMenu(null);
  }

  function filterByContextValue(): void {
    if (!contextMenu) return;
    const row = contextRow();
    if (!row) return;
    const id = String(contextMenu.columnIndex);
    const value = row.values[contextMenu.columnIndex];
    setColumnFilters([...columnFilters.filter(item => item.id !== id), { id, value: value === null || value === undefined ? '' : String(value) }]);
    setPageIndex(0);
    setContextMenu(null);
  }

  function sortByContextValue(desc: boolean): void {
    if (!contextMenu) return;
    setSorting([{ id: String(contextMenu.columnIndex), desc }]);
    setPageIndex(0);
    setContextMenu(null);
  }

  function copySelection(): void {
    const selected = selectedRows.length > 0 ? selectedRows : table.getRowModel().rows;
    const headerRow = result.columns.map(col => col).join('\t');
    const dataRows = selected.map(row =>
      row.original.values.map((value, i) => formatCellValue(value, result.columnTypes[i]).text).join('\t')
    );
    const text = [headerRow, ...dataRows].join('\n');
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) {
      setError('Clipboard access is unavailable');
      return;
    }
    void writeText.call(navigator.clipboard, text).then(() => {
      // Show brief inline feedback
      const btn = document.querySelector('.copy-btn');
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }
    }).catch(() => setError('Failed to copy to clipboard'));
  }

  async function exportResult(): Promise<void> {
    setExporting(true);
    setError('');
    try {
      const downloaded = await api.exportQuery(queryId, { statementIndex, format: exportFormat, sorting: requestSorting, columnFilters: requestFilters, globalFilter });
      const url = URL.createObjectURL(downloaded.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloaded.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not export query result.');
    } finally {
      setExporting(false);
    }
  }

  return <section className="advanced-grid">
    <div className="grid-toolbar">
      <input className="grid-global-filter" aria-label="Filter all result values" placeholder="Filter results…" value={globalFilter} onChange={event => setGlobalFilter(event.target.value)} />
      <details className="grid-columns"><summary>Columns</summary><div className="grid-columns-menu">{table.getAllLeafColumns().map(column => <label key={column.id}><input type="checkbox" checked={column.getIsVisible()} onChange={event => column.toggleVisibility(event.target.checked)} /><span>{String(column.columnDef.header)}</span><button type="button" title={column.getIsPinned() ? 'Unpin column' : 'Pin column'} aria-label={column.getIsPinned() ? `Unpin ${String(column.columnDef.header)}` : `Pin ${String(column.columnDef.header)}`} onClick={() => column.pin(column.getIsPinned() ? false : 'left')}>📌</button></label>)}</div></details>
      <div className="grid-tool-group grid-copy-actions"><button className="secondary small copy-btn" aria-label="Copy selected result rows" onClick={copySelection}>Copy</button></div>
      <div className="grid-tool-group grid-analysis-actions"><button className="secondary small" disabled={aggregatesLoading} onClick={() => { const next = !showAggregates; setShowAggregates(next); if (!next) setAggregates(null); }}>{aggregatesLoading ? 'Calculating…' : showAggregates ? 'Hide aggregates' : 'Aggregates'}</button><button className="secondary small" disabled={grouping} onClick={() => void groupResults()}>{grouping ? 'Grouping…' : 'Group'}</button><button className="secondary small" disabled={grouping} onClick={() => void pivotResults()}>Pivot</button></div>
      <div className="grid-tool-group grid-export-actions"><label className="grid-export-label">Export<select className="grid-export-format" value={exportFormat} onChange={event => setExportFormat(event.target.value as QueryExportFormat)} aria-label="Export format"><option value="csv">CSV</option><option value="csv.gz">CSV gzip</option><option value="csv.zst">CSV zstd</option><option value="json">JSON</option><option value="xml">XML</option><option value="sql">SQL INSERT</option><option value="markdown">Markdown</option><option value="xlsx">XLSX</option><option value="xlsb">XLSB (preferred, faster)</option></select></label><button className="secondary small" disabled={exporting} onClick={() => void exportResult()}>{exporting ? 'Exporting…' : 'Download'}</button></div>
      {loading && <span className="running">Loading…</span>}{error && <span className="grid-error">{error}</span>}
    </div>
    {showAggregates && aggregates && <div className="grid-aggregates"><div className="grid-aggregates-title">Aggregates for {aggregates.filteredRowCount.toLocaleString()} {hasGridFilter ? 'filtered rows' : 'rows'}</div><div className="grid-aggregates-scroll"><table><thead><tr><th>Column</th><th>Count</th><th>Sum</th><th>Average</th><th>Min</th><th>Max</th></tr></thead><tbody>{aggregates.values.map(value => { const name = result.columns[value.columnIndex] ?? `Column ${value.columnIndex + 1}`; const type = result.columnTypes[value.columnIndex]; return <tr key={value.columnIndex}><td>{name}</td><td>{value.count.toLocaleString()}</td><td>{value.sum === undefined ? '—' : value.sum === null ? 'NULL' : String(value.sum)}</td><td>{value.avg === undefined ? '—' : value.avg === null ? 'NULL' : String(value.avg)}</td><td>{value.min === undefined ? '—' : formatCellValue(value.min, type).text}</td><td>{value.max === undefined ? '—' : formatCellValue(value.max, type).text}</td></tr>; })}</tbody></table></div></div>}
    {(grouped || pivot) && <div className="grid-aggregates grid-grouped"><div className="grid-aggregates-title">{pivot ? 'Pivot view' : `Grouped view · ${grouped?.totalGroups.toLocaleString() ?? 0} groups`}<button type="button" className="secondary small" onClick={() => { setGrouped(null); setPivot(null); }}>Close</button></div><div className="grid-aggregates-scroll"><table><thead><tr>{(pivot?.columns ?? grouped?.columns.map(column => column.name) ?? []).map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{(pivot?.rows ?? grouped?.rows ?? []).map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, columnIndex) => <td key={columnIndex}>{formatCellValue(value, pivot ? undefined : grouped?.columns[columnIndex]?.type).text}</td>)}</tr>)}</tbody></table></div></div>}
    <DataGrid resultSetId={resultSetId} columns={result.columns.map((name, index) => ({ name, type: result.columnTypes[index] }))} rows={result.sessionId ? rows : result.rows} totalRowCount={effectiveTotalRows} view={sharedGridView} clientProcessing={!result.sessionId} onViewChange={updateSharedGridView} selectedRowIndex={selectedRows[0] ? Number(selectedRows[0].id) : undefined} onRowSelect={rowIndex => setRowSelection({ [String(rowIndex)]: true })} onContextMenu={context => setContextMenu({ x: context.clientX, y: context.clientY, rowIndex: context.rowIndex, columnIndex: context.columnIndex })} />
    {contextMenu && <div className="grid-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={event => event.stopPropagation()}><button type="button" onClick={() => copyContext('value')}>Copy value</button><button type="button" onClick={() => copyContext('tsv')}>Copy row as TSV</button><button type="button" onClick={() => copyContext('json')}>Copy row as JSON</button><button type="button" onClick={() => copyContext('markdown')}>Copy row as Markdown</button><button type="button" onClick={() => copyContext('sql')}>Copy SQL INSERT</button><hr /><button type="button" onClick={filterByContextValue}>Filter by this value</button><button type="button" onClick={() => sortByContextValue(false)}>Sort ascending</button><button type="button" onClick={() => sortByContextValue(true)}>Sort descending</button><hr /><button type="button" onClick={() => { setDetailRowIndex(contextMenu.rowIndex); setContextMenu(null); }}>View full row</button>{onEditRow && <button type="button" onClick={() => { const row = contextRow(); if (row) onEditRow([...row.values]); setContextMenu(null); }}>Edit row…</button>}</div>}
    {detailRowIndex !== null && displayRows[detailRowIndex] && <aside className="grid-row-details"><div className="grid-row-details-header"><strong>Row details</strong><button type="button" className="secondary small" onClick={() => setDetailRowIndex(null)}>Close</button></div><dl>{displayRows[detailRowIndex].map((value, index) => <div key={index}><dt>{result.columns[index] ?? `Column ${index + 1}`}</dt><dd>{formatCellValue(value, result.columnTypes[index]).text}</dd></div>)}</dl></aside>}
    <div className="grid-pagination"><span>{effectiveTotalRows.toLocaleString()} rows · page {pageIndex + 1} / {totalPages}</span><label>Page size<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPageIndex(0); }}><option value="100">100</option><option value="200">200</option><option value="500">500</option><option value="1000">1000</option></select></label><button className="secondary small" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex(value => value - 1)}>Previous</button><button className="secondary small" disabled={pageIndex + 1 >= totalPages || loading} onClick={() => setPageIndex(value => value + 1)}>Next</button></div>
  </section>;
}
