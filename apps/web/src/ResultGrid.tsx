import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef, ColumnFiltersState, ColumnPinningState, RowSelectionState, SortingState, VisibilityState } from '@tanstack/react-table';
import type { QueryAggregateFunction, QueryAggregateResponse, QueryColumnFilterSpec, QueryExportFormat, QueryGroupResponse, QuerySortSpec } from '@justybase/contracts';
import type { UiResultViewState } from '@justybase/ui-core';
import { CellValueViewer, DataGrid, createDataGridClipboardPayload, formatDataGridCellValue, formatDataGridClipboard, inferDataGridColumnMetadata, isDataGridNumericColumn, isDataGridTemporalColumn, processDataGridRows } from '@justybase/ui-react';
import type { DataGridCellContext, DataGridCellMetadata, DataGridClipboardFormat, DataGridCopyPayload, GridScrollPosition } from '@justybase/ui-react';
import { aggregateResultRows, filterResultRows, type ResultColumn, type ResultColumnFilter } from '@justybase/result-core';
import { useApiClient } from './api';
import { readLegacyWorkspaceValue, useWorkspaceStorage, type WorkspaceStorage } from './workspacePersistence';
import { type ResultState } from './queryState';

interface GridRow { values: readonly unknown[]; }

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
  scrollTop?: number;
  scrollLeft?: number;
  scrollAnchorRow?: number;
}

interface PersistedGridStateEnvelope {
  version: 2;
  resultSetId: string;
  state: SavedGridState;
}

interface PivotResult {
  columns: string[];
  columnTypes: Array<string | undefined>;
  columnScales: Array<number | undefined>;
  rows: unknown[][];
}

type ResultGridColumnMetadata = DataGridCellMetadata & { readonly name: string };

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

/**
 * Type-aware formatting and display utilities for cell values.
 * Inspired by the extension's result panel but simplified for the web.
 */
function isNumericType(type?: string, scale?: number): boolean {
  return isDataGridNumericColumn({ type, scale });
}

function formatCellValue(value: unknown, metadata: DataGridCellMetadata = {}): { text: string; isNull: boolean; colorClass: string; } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true, colorClass: '' };
  const text = formatDataGridCellValue(value, metadata.type, metadata);
  const t = (metadata.type ?? '').toUpperCase();
  if (/BOOL/.test(t)) {
    return { text, isNull: false, colorClass: text.startsWith('✓') ? 'val-bool-t' : 'val-bool-f' };
  }
  if (isDataGridNumericColumn(metadata)) return { text, isNull: false, colorClass: 'val-num' };
  if (isDataGridTemporalColumn(metadata)) return { text, isNull: false, colorClass: 'val-date' };
  return { text, isNull: false, colorClass: '' };
}

function analysisGridColumns(columns: readonly { readonly name: string; readonly type?: string; readonly scale?: number }[]): ResultGridColumnMetadata[] {
  return columns.map(column => ({
    name: column.name,
    ...(column.type === undefined ? {} : { type: column.type }),
    ...(column.scale === undefined ? {} : { scale: column.scale }),
  }));
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
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollAnchorRow, setScrollAnchorRow] = useState<number | undefined>(undefined);
  const [gridGrouping, setGridGrouping] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exportFormat, setExportFormat] = useState<QueryExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => result.columns.map((_, i) => String(i)));
  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [cellViewer, setCellViewer] = useState<{ readonly column: ResultGridColumnMetadata; readonly value: unknown; readonly rowNumber: number } | undefined>(undefined);
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
  const gridRows = result.sessionId ? rows : result.rows;
  const gridColumnSignature = useMemo(
    () => result.columns.map((name, index) => [name, result.columnTypes[index] ?? '', result.columnScales[index] ?? ''].join('\u0000')).join('\u0001'),
    [result.columns, result.columnScales, result.columnTypes],
  );
  const gridColumnsCacheRef = useRef<{ readonly resultSetId: string; readonly signature: string; readonly columns: ResultGridColumnMetadata[]; readonly ready: boolean } | undefined>(undefined);
  const gridColumns = useMemo<ResultGridColumnMetadata[]>(() => {
    const cache = gridColumnsCacheRef.current;
    if (cache?.resultSetId === resultSetId && cache.signature === gridColumnSignature && cache.ready) return cache.columns;
    if (cache?.resultSetId === resultSetId && cache.signature === gridColumnSignature && gridRows.length === 0) return cache.columns;
    const nextColumns = result.columns.map((name, index) => {
      const column: ResultGridColumnMetadata = {
        name,
        ...(result.columnTypes[index] === undefined ? {} : { type: result.columnTypes[index] }),
        ...(result.columnScales[index] === undefined ? {} : { scale: result.columnScales[index] }),
      };
      return { ...column, ...inferDataGridColumnMetadata(column, gridRows.slice(0, 100).map(row => row[index])) };
    });
    const ready = gridRows.length > 0 || nextColumns.every(column => column.type !== undefined || column.inferredNumericKind !== undefined || column.inferredDateInteger !== undefined);
    gridColumnsCacheRef.current = { resultSetId, signature: gridColumnSignature, columns: nextColumns, ready };
    return nextColumns;
  }, [gridColumnSignature, gridRows, result.columns, result.columnScales, result.columnTypes, resultSetId]);
  const localFilterColumns = useMemo<ResultColumn[]>(() => gridColumns.map(({ name, type, scale }) => ({ name, type, scale })), [gridColumns]);
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
    setDetailRowIndex(null);
    setCellViewer(undefined);
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
    setScrollTop(Number.isFinite(saved?.scrollTop) ? Math.max(0, saved?.scrollTop ?? 0) : 0);
    setScrollLeft(Number.isFinite(saved?.scrollLeft) ? Math.max(0, saved?.scrollLeft ?? 0) : 0);
    setScrollAnchorRow(Number.isInteger(saved?.scrollAnchorRow) && (saved?.scrollAnchorRow ?? 0) >= 0 ? saved?.scrollAnchorRow : undefined);
    setColumnOrder(mergedOrder);
    setGridHydratedKey(gridKey);
  }, [gridKey, legacyKey, resultSetId, result.sessionId, result.columns, storage]);

  useEffect(() => {
    if (gridHydratedKey !== gridKey) return;
    try {
      const state: SavedGridState = { pageSize, sorting, columnFilters, globalFilter, columnVisibility, columnPinning, columnOrder, columnWidths, grouping: gridGrouping, scrollTop, scrollLeft, scrollAnchorRow };
      const envelope: PersistedGridStateEnvelope = { version: 2, resultSetId, state };
      storage.set(gridKey, JSON.stringify(envelope));
    } catch {
      // A full localStorage should not make the result grid unusable.
    }
  }, [gridKey, gridHydratedKey, resultSetId, pageSize, sorting, columnFilters, globalFilter, columnVisibility, columnPinning, columnOrder, columnWidths, gridGrouping, scrollTop, scrollLeft, scrollAnchorRow, storage]);

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
          .map((name, index) => ({ name, type: result.columnTypes[index], scale: result.columnScales[index] }))
          .flatMap((column, columnIndex) => functions.map(fn => ({
            columnIndex,
            function: fn,
            dataType: column.type,
            scale: column.scale,
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
        ...result.columns.map((_column, index) => ({ index, function: 'sum' as const })).filter(item => isNumericType(result.columnTypes[item.index], result.columnScales[item.index])).map(item => ({ function: item.function, columnIndex: item.index })),
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
      const valueType = result.columnTypes[indices[2]];
      const valueScale = result.columnScales[indices[2]];
      setPivot({
        columns: [result.columns[indices[0]] ?? 'Row', ...pivotValues],
        columnTypes: [result.columnTypes[indices[0]], ...pivotValues.map(() => valueType)],
        columnScales: [result.columnScales[indices[0]], ...pivotValues.map(() => valueScale)],
        rows: rowValues.map(rowValue => [rowValue, ...pivotValues.map(pivotValue => rowMap.get(rowValue)?.get(pivotValue) ?? null)]),
      });
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
    const metadata = gridColumns[index] ?? {};
    const dataType = metadata.type;
    return {
      id: String(index),
      accessorFn: row => row.values[index],
      header: name,
      meta: { dataType, scale: metadata.scale },
      size: isNumericType(dataType, metadata.scale) ? 130 : 150,
      enableSorting: true,
      enableColumnFilter: true,
      enableResizing: true,
      cell: info => {
        const value = info.getValue();
        const formatted = formatCellValue(value, metadata);
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
  }), [result.columns, gridColumns]);
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
  const selectedDisplayIndex = selectedRows[0] ? Number(selectedRows[0].id) : undefined;
  const selectedRawIndex = selectedDisplayIndex === undefined
    ? undefined
    : result.sessionId
      ? selectedDisplayIndex
      : (() => {
        const rawIndex = result.rows.findIndex(row => row === displayRows[selectedDisplayIndex]);
        return rawIndex >= 0 ? rawIndex : undefined;
      })();
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

  const aggregateGrid = useMemo(() => {
    if (!aggregates) return undefined;
    const columns = analysisGridColumns([
      { name: 'Column' },
      { name: 'Count', type: 'BIGINT' },
      { name: 'Sum' },
      { name: 'Average' },
      { name: 'Min' },
      { name: 'Max' },
    ]).map(column => ({ ...column, undefinedPlaceholder: '—' }));
    const rows = aggregates.values.map(value => {
      const sourceName = result.columns[value.columnIndex] ?? `Column ${value.columnIndex + 1}`;
      return [
        sourceName,
        value.count,
        value.sum,
        value.avg,
        value.min,
        value.max,
      ];
    });
    return {
      columns,
      rows,
      getCellMetadata: (_value: unknown, rowIndex: number, columnIndex: number, column: ResultGridColumnMetadata): DataGridCellMetadata => {
        if (columnIndex < 2 || rowIndex >= aggregates.values.length) return column;
        const sourceColumnIndex = aggregates.values[rowIndex]?.columnIndex;
        if (sourceColumnIndex === undefined) return column;
        const sourceColumn = gridColumns[sourceColumnIndex];
        if (sourceColumn === undefined) return column;
        const { inferredDateInteger: _inferredDateInteger, ...sourceWithoutInferredDate } = sourceColumn;
        return {
          ...sourceWithoutInferredDate,
          ...(columnIndex === 3 ? { type: 'DECIMAL', scale: Math.max(1, sourceColumn.scale ?? 4), inferredNumericKind: 'decimal' as const } : {}),
          undefinedPlaceholder: column.undefinedPlaceholder,
        };
      },
    };
  }, [aggregates, result.columns, gridColumns]);

  const groupedGrid = useMemo(() => {
    if (!grouped && !pivot) return undefined;
    if (pivot) {
      return {
        columns: analysisGridColumns(pivot.columns.map((name, index) => ({ name, type: pivot.columnTypes[index], scale: pivot.columnScales[index] }))),
        rows: pivot.rows,
      };
    }
    return { columns: analysisGridColumns(grouped?.columns ?? []), rows: grouped?.rows ?? [] };
  }, [grouped, pivot]);

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
    if (patch.scrollTop !== undefined) setScrollTop(Math.max(0, patch.scrollTop));
    if (patch.scrollLeft !== undefined) setScrollLeft(Math.max(0, patch.scrollLeft));
    if (patch.anchorRow !== undefined) setScrollAnchorRow(Math.max(0, patch.anchorRow));
  }

  function handleGridScroll(position: GridScrollPosition): void {
    updateSharedGridView({ scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow });
  }

  async function copyGridPayload(payload: DataGridCopyPayload, format: DataGridClipboardFormat = 'text'): Promise<void> {
    const options = { includeHeaders: payload.includeHeaders ?? true };
    const formatted = createDataGridClipboardPayload(payload, options);
    const plainText = formatDataGridClipboard(payload, format, options);
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setError('Clipboard access is unavailable');
      return;
    }
    try {
      if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([formatted.html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        })]);
      } else if (typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(plainText);
      } else {
        setError('Clipboard access is unavailable');
        return;
      }
      setNotice('Copied.');
    } catch {
      try {
        await navigator.clipboard.writeText(plainText);
        setNotice('Copied.');
      } catch {
        setError('Failed to copy to clipboard');
      }
    }
  }

  function copyGridSelection(payload: DataGridCopyPayload, format?: DataGridClipboardFormat): void {
    void copyGridPayload(payload, format);
  }

  function openCellValue(context: DataGridCellContext): void {
    const column = gridColumns[context.columnIndex];
    const row = gridRows[context.rowIndex];
    if (!column || !row) return;
    setCellViewer({
      column,
      value: row[context.columnIndex],
      rowNumber: (result.sessionId ? pageIndex * pageSize : 0) + context.rowIndex + 1,
    });
  }

  function copyCellValue(): void {
    const item = cellViewer;
    if (!item) return;
    void copyGridPayload({ columns: [item.column], rows: [[item.value]], includeHeaders: false });
  }

  function copySelection(): void {
    const selected = selectedRows.length > 0 ? selectedRows : table.getRowModel().rows;
    void copyGridPayload({ columns: gridColumns, rows: selected.map(row => row.original.values) });
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
      <div className="grid-tool-group grid-copy-actions"><button className="secondary small copy-btn" aria-label="Copy selected result rows" onClick={copySelection}>Copy</button></div>
      <div className="grid-tool-group grid-analysis-actions"><button className="secondary small" disabled={aggregatesLoading} onClick={() => { const next = !showAggregates; setShowAggregates(next); if (!next) setAggregates(null); }}>{aggregatesLoading ? 'Calculating…' : showAggregates ? 'Hide aggregates' : 'Aggregates'}</button><button className="secondary small" disabled={grouping} onClick={() => void groupResults()}>{grouping ? 'Grouping…' : 'Group'}</button><button className="secondary small" disabled={grouping} onClick={() => void pivotResults()}>Pivot</button></div>
      <div className="grid-tool-group grid-export-actions"><label className="grid-export-label">Export<select className="grid-export-format" value={exportFormat} onChange={event => setExportFormat(event.target.value as QueryExportFormat)} aria-label="Export format"><option value="csv">CSV</option><option value="csv.gz">CSV gzip</option><option value="csv.zst">CSV zstd</option><option value="json">JSON</option><option value="xml">XML</option><option value="sql">SQL INSERT</option><option value="markdown">Markdown</option><option value="xlsx">XLSX</option><option value="xlsb">XLSB (preferred, faster)</option></select></label><button className="secondary small" disabled={exporting} onClick={() => void exportResult()}>{exporting ? 'Exporting…' : 'Download'}</button></div>
      {loading && <span className="running">Loading…</span>}{notice && <span className="grid-notice" role="status">{notice}</span>}{error && <span className="grid-error" role="alert">{error}</span>}
    </div>
    {showAggregates && aggregates && aggregateGrid && <div className="grid-aggregates"><div className="grid-aggregates-title">Aggregates for {aggregates.filteredRowCount.toLocaleString()} {hasGridFilter ? 'filtered rows' : 'rows'}</div><div className="grid-aggregates-scroll"><DataGrid resultSetId={`${resultSetId}:aggregates`} columns={aggregateGrid.columns} rows={aggregateGrid.rows} totalRowCount={aggregateGrid.rows.length} view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }} onViewChange={() => undefined} clientProcessing={false} getCellMetadata={aggregateGrid.getCellMetadata} /></div></div>}
    {(grouped || pivot) && groupedGrid && <div className="grid-aggregates grid-grouped"><div className="grid-aggregates-title">{pivot ? 'Pivot view' : `Grouped view · ${grouped?.totalGroups.toLocaleString() ?? 0} groups`}<button type="button" className="secondary small" onClick={() => { setGrouped(null); setPivot(null); }}>Close</button></div><div className="grid-aggregates-scroll"><DataGrid resultSetId={`${resultSetId}:${pivot ? 'pivot' : 'grouped'}`} columns={groupedGrid.columns} rows={groupedGrid.rows} totalRowCount={groupedGrid.rows.length} view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }} onViewChange={() => undefined} clientProcessing={false} /></div></div>}
    <DataGrid resultSetId={resultSetId} columns={gridColumns} rows={gridRows} totalRowCount={effectiveTotalRows} view={sharedGridView} clientProcessing={!result.sessionId} showContextMenu onViewChange={updateSharedGridView} selectedRowIndex={selectedRawIndex} scroll={{ resultSetId, top: scrollTop, left: scrollLeft, anchorRow: scrollAnchorRow }} onScroll={handleGridScroll} onCopySelection={copyGridSelection} onSelectionChange={selection => setRowSelection(selection ? { [String(selection.focusRow)]: true } : {})} onRowSelect={rowIndex => { const displayIndex = result.sessionId ? rowIndex : displayRows.findIndex(row => row === result.rows[rowIndex]); if (displayIndex >= 0) setRowSelection({ [String(displayIndex)]: true }); }} onViewRow={context => setDetailRowIndex(context.rowIndex)} onViewCell={openCellValue} onEditRow={onEditRow ? context => { const row = gridRows[context.rowIndex]; if (row) onEditRow([...row]); } : undefined} />
    {cellViewer && <CellValueViewer column={cellViewer.column} value={cellViewer.value} rowNumber={cellViewer.rowNumber} onClose={() => setCellViewer(undefined)} onCopy={copyCellValue} />}
    {detailRowIndex !== null && gridRows[detailRowIndex] && <aside className="grid-row-details"><div className="grid-row-details-header"><strong>Row details</strong><button type="button" className="secondary small" onClick={() => setDetailRowIndex(null)}>Close</button></div><dl>{gridRows[detailRowIndex].map((value, index) => <div key={index}><dt>{result.columns[index] ?? `Column ${index + 1}`}</dt><dd>{formatCellValue(value, gridColumns[index]).text}</dd></div>)}</dl></aside>}
    <div className="grid-pagination"><span>{effectiveTotalRows.toLocaleString()} rows · page {pageIndex + 1} / {totalPages}</span><label>Page size<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPageIndex(0); }}><option value="100">100</option><option value="200">200</option><option value="500">500</option><option value="1000">1000</option></select></label><button className="secondary small" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex(value => value - 1)}>Previous</button><button className="secondary small" disabled={pageIndex + 1 >= totalPages || loading} onClick={() => setPageIndex(value => value + 1)}>Next</button></div>
  </section>;
}
