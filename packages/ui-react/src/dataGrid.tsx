import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, UIEvent } from 'react';
import type { UiResultViewState } from '@justybase/ui-core';

export interface DataGridColumn {
  readonly name: string;
  readonly type?: string;
}

export type DataGridViewState = Pick<UiResultViewState, 'globalFilter' | 'columnFilters' | 'sorting' | 'grouping'> &
  Partial<Pick<UiResultViewState, 'columnVisibility' | 'columnOrder' | 'pinnedColumns' | 'columnWidths'>>;

export interface GridScrollPosition {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly top: number;
  readonly left: number;
  readonly anchorRow?: number;
}

export interface DataGridSelection {
  readonly anchorRow: number;
  readonly anchorColumn: number;
  readonly focusRow: number;
  readonly focusColumn: number;
}

export interface DataGridCellContext {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface DataGridCopyPayload {
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly selection?: DataGridSelection;
}

export interface DataGridProps {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly totalRowCount?: number;
  readonly scroll?: GridScrollPosition;
  readonly onScroll?: (position: GridScrollPosition) => void;
  /** Requests the next adapter-owned page when the rendered rows near the end. */
  readonly onLoadMore?: () => void;
  /** Index into the supplied raw rows, even when displayed rows are filtered, sorted, or grouped. */
  readonly onRowSelect?: (rowIndex: number) => void;
  readonly selectedRowIndex?: number;
  readonly view?: DataGridViewState;
  readonly onViewChange?: (patch: Partial<UiResultViewState>) => void;
  /** Server-backed grids keep filtering/sorting in the adapter but share the same renderer. */
  readonly clientProcessing?: boolean;
  readonly onSelectionChange?: (selection: DataGridSelection | undefined) => void;
  readonly onContextMenu?: (context: DataGridCellContext) => void;
  readonly onCopySelection?: (payload: DataGridCopyPayload) => void;
}

interface IndexedRow {
  readonly values: readonly unknown[];
  readonly sourceIndex: number;
}

interface RenderedGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

interface RenderedDataRow extends IndexedRow {
  readonly kind: 'data';
  readonly displayIndex: number;
  readonly groupId?: string;
}

type RenderedRow = RenderedGroup | RenderedDataRow;

const ROW_NUMBER_WIDTH = 48;
const DEFAULT_COLUMN_WIDTH = 144;
const MIN_COLUMN_WIDTH = 72;
const ROW_HEIGHT = 30;

function normaliseView(view: DataGridViewState | undefined): DataGridViewState {
  return {
    globalFilter: view?.globalFilter ?? '',
    columnFilters: view?.columnFilters ?? {},
    sorting: view?.sorting ?? [],
    grouping: view?.grouping ?? [],
    columnVisibility: view?.columnVisibility,
    columnOrder: view?.columnOrder,
    pinnedColumns: view?.pinnedColumns,
    columnWidths: view?.columnWidths,
  };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function isBooleanType(type?: string): boolean {
  return type !== undefined && /BOOL/.test(type.toUpperCase());
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  return typeof value === 'string' && ['t', 'true', 'yes'].includes(value.trim().toLocaleLowerCase());
}

/** Formats a cell for display without changing the raw value kept by adapters. */
export function formatDataGridCellValue(value: unknown, type?: string): string {
  if (value === null || value === undefined) return 'NULL';
  if (isBooleanType(type)) return booleanValue(value) ? '✓ true' : '✗ false';
  return cellText(value);
}

interface ComparableDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parseComparableDecimal(value: unknown): ComparableDecimal | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const raw = String(value);
  const compact = raw.replace(/[\s\u00a0\u202f,]/gu, '');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(compact);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  if (match[2]!.length + fraction.length > 10_000) return undefined;
  let exponent: bigint;
  try {
    exponent = BigInt(match[4] ?? 0);
  } catch {
    return undefined;
  }
  const scaleValue = BigInt(fraction.length) - exponent;
  if (scaleValue < -1_000n || scaleValue > 1_000n) return undefined;
  let scale = Number(scaleValue);
  let coefficient = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function compareComparableDecimals(left: ComparableDecimal, right: ComparableDecimal): number {
  if (left.coefficient < 0n && right.coefficient >= 0n) return -1;
  if (left.coefficient >= 0n && right.coefficient < 0n) return 1;
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * (10n ** BigInt(scale - left.scale));
  const rightValue = right.coefficient * (10n ** BigInt(scale - right.scale));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function typeBadge(type?: string): string {
  if (!type) return '?';
  const value = type.toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT/.test(value)) return 'INT';
  if (/DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(value)) return 'NUM';
  if (/VARCHAR|CHAR|TEXT|CLOB|STRING/.test(value)) return 'TXT';
  if (/DATE|TIME|TIMESTAMP/.test(value)) return 'DT';
  if (/BOOL/.test(value)) return 'BOOL';
  return value.slice(0, 4);
}

function typeBadgeClass(type?: string): string {
  if (!type) return 'text';
  const value = type.toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(value)) return 'numeric';
  if (/DATE|TIME|TIMESTAMP/.test(value)) return 'temporal';
  if (/BOOL/.test(value)) return 'boolean';
  return 'text';
}

function isNumericType(type?: string): boolean {
  return type !== undefined && /INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(type.toUpperCase());
}

function isTemporalType(type?: string): boolean {
  return type !== undefined && /DATE|TIME|TIMESTAMP/.test(type.toUpperCase());
}

function parseTemporalSortValue(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  const raw = cellText(value);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function valueClass(value: unknown, type?: string): string {
  if (value === null || value === undefined) return 'null';
  if (isNumericType(type)) return 'numeric';
  if (type !== undefined && /DATE|TIME|TIMESTAMP/.test(type.toUpperCase())) return 'temporal';
  if (isBooleanType(type)) return booleanValue(value) ? 'boolean-true' : 'boolean-false';
  return '';
}

function columnKey(_column: DataGridColumn, index: number): string {
  // Numeric IDs are shared with the API query paging contract and remain
  // stable when result columns have duplicate display names.
  return String(index);
}

function columnMatchesKey(column: DataGridColumn, index: number, key: string): boolean {
  return key === columnKey(column, index) || key === column.name;
}

function visibilityFor(column: DataGridColumn, index: number, view: DataGridViewState): boolean {
  const visibility = view.columnVisibility;
  if (!visibility) return true;
  return visibility[columnKey(column, index)] !== false && visibility[column.name] !== false;
}

function orderColumns(columns: readonly DataGridColumn[], view: DataGridViewState): readonly number[] {
  const defaultOrder = columns.map((_column, index) => index);
  const requested = view.columnOrder ?? [];
  const ordered: number[] = [];
  for (const key of requested) {
    const index = columns.findIndex((column, columnIndex) => columnMatchesKey(column, columnIndex, key));
    if (index >= 0 && !ordered.includes(index)) ordered.push(index);
  }
  for (const index of defaultOrder) if (!ordered.includes(index)) ordered.push(index);
  const visible = ordered.filter(index => visibilityFor(columns[index]!, index, view));
  const pinned = visible.filter(index => view.pinnedColumns?.some(key => columnMatchesKey(columns[index]!, index, key)) ?? false);
  return [...pinned, ...visible.filter(index => !pinned.includes(index))];
}

function filterValue(view: DataGridViewState, column: DataGridColumn, index: number): string {
  const filters = view.columnFilters;
  return filters[columnKey(column, index)] ?? filters[column.name] ?? '';
}

function resolveColumnIndex(columns: readonly DataGridColumn[], key: string): number {
  const named = columns.findIndex(column => column.name === key);
  if (named >= 0) return named;
  if (/^[0-9]+$/u.test(key)) {
    const numeric = Number(key);
    if (numeric >= 0 && numeric < columns.length) return numeric;
  }
  return -1;
}

function compareValues(left: unknown, right: unknown, type?: string): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1;
  if (right === null || right === undefined) return 1;
  if (isTemporalType(type)) {
    const leftTime = parseTemporalSortValue(left);
    const rightTime = parseTemporalSortValue(right);
    if (leftTime !== undefined || rightTime !== undefined) {
      if (leftTime === undefined) return -1;
      if (rightTime === undefined) return 1;
      return leftTime - rightTime;
    }
  }
  if (isNumericType(type)) {
    const leftDecimal = parseComparableDecimal(left);
    const rightDecimal = parseComparableDecimal(right);
    if (leftDecimal && rightDecimal) return compareComparableDecimals(leftDecimal, rightDecimal);
  }
  return cellText(left).localeCompare(cellText(right), undefined, { numeric: true, sensitivity: 'base' });
}

function matchesRow(
  columns: readonly DataGridColumn[],
  values: readonly unknown[],
  view: DataGridViewState,
): boolean {
  const globalFilter = view.globalFilter.trim().toLocaleLowerCase();
  if (globalFilter && !values.some((value, columnIndex) => formatDataGridCellValue(value, columns[columnIndex]?.type).toLocaleLowerCase().includes(globalFilter))) return false;
  return columns.every((column, columnIndex) => {
    const filter = filterValue(view, column, columnIndex).trim().toLocaleLowerCase();
    return !filter || formatDataGridCellValue(values[columnIndex], column.type).toLocaleLowerCase().includes(filter);
  });
}

function processIndexedRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
  clientProcessing: boolean,
): readonly IndexedRow[] {
  const indexed = rows.flatMap((values, sourceIndex) => {
    if (clientProcessing && !matchesRow(columns, values, view)) return [];
    return [{ values, sourceIndex }];
  });
  if (!clientProcessing) return indexed;
  const sorting = view.sorting
    .map(item => ({ ...item, columnIndex: resolveColumnIndex(columns, item.column) }))
    .filter(item => item.columnIndex >= 0);
  indexed.sort((left, right) => {
    for (const item of sorting) {
      const comparison = compareValues(left.values[item.columnIndex], right.values[item.columnIndex], columns[item.columnIndex]?.type);
      if (comparison !== 0) return item.descending ? -comparison : comparison;
    }
    return left.sourceIndex - right.sourceIndex;
  });
  return indexed;
}

/** Shared filtering/sorting semantics used by the Electron shell and tests. */
export function processDataGridRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
): readonly (readonly unknown[])[] {
  return processIndexedRows(columns, rows, view, true).map(item => item.values);
}

function indexedRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
  clientProcessing: boolean,
): readonly IndexedRow[] {
  return processIndexedRows(columns, rows, view, clientProcessing);
}

function groupRows(columns: readonly DataGridColumn[], rows: readonly IndexedRow[], grouping: readonly string[]): readonly RenderedRow[] {
  if (grouping.length === 0) return rows.map((row, displayIndex) => ({ ...row, kind: 'data', displayIndex }));
  const groups = new Map<string, IndexedRow[]>();
  for (const row of rows) {
    const values = grouping.map(key => {
      const index = resolveColumnIndex(columns, key);
      return formatDataGridCellValue(index >= 0 ? row.values[index] : undefined, index >= 0 ? columns[index]?.type : undefined);
    });
    const id = JSON.stringify(values);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const rendered: RenderedRow[] = [];
  let displayIndex = 0;
  for (const [id, group] of groups) {
    const label = JSON.parse(id).join(' · ') as string;
    rendered.push({ kind: 'group', id, label, count: group.length });
    group.forEach((row, groupIndex) => rendered.push({ ...row, kind: 'data', displayIndex: displayIndex + groupIndex, groupId: id }));
    displayIndex += group.length;
  }
  return rendered;
}

function selectedRange(selection: DataGridSelection | undefined): { minRow: number; maxRow: number; minColumn: number; maxColumn: number } | undefined {
  if (!selection) return undefined;
  return {
    minRow: Math.min(selection.anchorRow, selection.focusRow),
    maxRow: Math.max(selection.anchorRow, selection.focusRow),
    minColumn: Math.min(selection.anchorColumn, selection.focusColumn),
    maxColumn: Math.max(selection.anchorColumn, selection.focusColumn),
  };
}

function selectedColumnPositionRange(
  selection: DataGridSelection | undefined,
  visibleColumnIndexes: readonly number[],
): { minColumn: number; maxColumn: number } | undefined {
  if (!selection) return undefined;
  const anchor = visibleColumnIndexes.indexOf(selection.anchorColumn);
  const focus = visibleColumnIndexes.indexOf(selection.focusColumn);
  const anchorPosition = anchor >= 0 ? anchor : selection.anchorColumn;
  const focusPosition = focus >= 0 ? focus : selection.focusColumn;
  return {
    minColumn: Math.min(anchorPosition, focusPosition),
    maxColumn: Math.max(anchorPosition, focusPosition),
  };
}

export function DataGrid({
  sourceId,
  resultSetId,
  columns,
  rows,
  totalRowCount = rows.length,
  scroll,
  onScroll,
  onLoadMore,
  onRowSelect,
  selectedRowIndex,
  view,
  onViewChange,
  clientProcessing = true,
  onSelectionChange,
  onContextMenu,
  onCopySelection,
}: DataGridProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const [internalView, setInternalView] = useState<DataGridViewState>(() => normaliseView(undefined));
  const activeView = normaliseView(view ?? internalView);
  const [selection, setSelection] = useState<DataGridSelection | undefined>(undefined);
  const selectionRef = useRef<DataGridSelection | undefined>(undefined);
  const dragSelectingRef = useRef(false);
  const draggedColumnRef = useRef<number | undefined>(undefined);
  const resizeRef = useRef<{ columnId: string; startX: number; startWidth: number } | undefined>(undefined);
  const activeViewRef = useRef<DataGridViewState>(activeView);
  const updateViewRef = useRef<(patch: Partial<UiResultViewState>) => void>(() => undefined);
  const selectionScopeRef = useRef<string | undefined>(undefined);
  const selectionChangeRef = useRef(onSelectionChange);
  const emptyPageRequestRef = useRef<string | undefined>(undefined);
  activeViewRef.current = activeView;
  selectionChangeRef.current = onSelectionChange;

  const updateView = (patch: Partial<UiResultViewState>): void => {
    if (view === undefined) setInternalView(previous => normaliseView({ ...previous, ...patch }));
    onViewChange?.(patch);
  };
  updateViewRef.current = updateView;

  useEffect(() => {
    const handleMouseUp = (): void => {
      dragSelectingRef.current = false;
      resizeRef.current = undefined;
    };
    const handleMouseMove = (event: MouseEvent): void => {
      const resize = resizeRef.current;
      if (!resize) return;
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, resize.startWidth + event.clientX - resize.startX);
      const widths = { ...(activeViewRef.current.columnWidths ?? {}), [resize.columnId]: nextWidth };
      updateViewRef.current({ columnWidths: widths });
    };
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
      resizeRef.current = undefined;
    };
  }, []);

  const visibleColumnIndexes = useMemo(() => orderColumns(columns, activeView), [columns, activeView]);
  const processedRows = useMemo(() => indexedRows(columns, rows, activeView, clientProcessing), [columns, rows, activeView, clientProcessing]);
  const renderedRows = useMemo(() => groupRows(columns, processedRows, activeView.grouping), [columns, processedRows, activeView.grouping]);
  const range = selectedRange(selection);
  const columnRange = selectedColumnPositionRange(selection, visibleColumnIndexes);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const hasMoreRows = onLoadMore !== undefined && rows.length < totalRowCount;
  const emptyPageRequestKey = JSON.stringify({
    rowCount: rows.length,
    totalRowCount,
    globalFilter: activeView.globalFilter,
    columnFilters: activeView.columnFilters,
  });
  const selectionScope = JSON.stringify({
    sourceId,
    resultSetId,
    clientProcessing,
    columns: columns.map(column => [column.name, column.type]),
    view: {
      globalFilter: activeView.globalFilter,
      columnFilters: activeView.columnFilters,
      sorting: activeView.sorting,
      grouping: activeView.grouping,
      columnVisibility: activeView.columnVisibility,
      columnOrder: activeView.columnOrder,
      pinnedColumns: activeView.pinnedColumns,
    },
  });

  useEffect(() => {
    const previousScope = selectionScopeRef.current;
    selectionScopeRef.current = selectionScope;
    if (previousScope === undefined || previousScope === selectionScope) return;
    dragSelectingRef.current = false;
    selectionRef.current = undefined;
    setSelection(undefined);
    setCollapsedGroups(new Set());
    selectionChangeRef.current?.(undefined);
  }, [selectionScope]);

  useEffect(() => {
    if (!hasMoreRows || processedRows.length > 0) {
      emptyPageRequestRef.current = undefined;
      return;
    }
    if (emptyPageRequestRef.current === emptyPageRequestKey) return;
    emptyPageRequestRef.current = emptyPageRequestKey;
    onLoadMore?.();
  }, [emptyPageRequestKey, hasMoreRows, onLoadMore, processedRows.length]);

  useEffect(() => {
    const restore = (): void => {
      const element = scroller.current;
      if (!element || !scroll || scroll.resultSetId !== resultSetId || (scroll.sourceId !== undefined && scroll.sourceId !== sourceId)) return;
      element.scrollTop = Math.max(0, scroll.top);
      element.scrollLeft = Math.max(0, scroll.left);
    };
    const element = scroller.current;
    if (!element) return;
    restore();
    let frame: number | undefined;
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => { frame = undefined; restore(); });
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => restore());
    observer?.observe(element);
    return () => {
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [resultSetId, sourceId, scroll?.sourceId, scroll?.resultSetId, scroll?.top, scroll?.left, scroll?.anchorRow, rows.length, columns.length, totalRowCount]);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    onScroll?.({ ...(sourceId === undefined ? {} : { sourceId }), resultSetId, top: element.scrollTop, left: element.scrollLeft, anchorRow: Math.floor(element.scrollTop / ROW_HEIGHT) });
    const distanceFromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (onLoadMore && rows.length < totalRowCount && distanceFromEnd <= 160) onLoadMore();
  }

  function setSelectionValue(next: DataGridSelection | undefined): void {
    selectionRef.current = next;
    setSelection(next);
    onSelectionChange?.(next);
  }

  function selectCell(rowIndex: number, columnIndex: number, event: ReactMouseEvent<HTMLElement>): void {
    if (event.button !== 0) return;
    scroller.current?.focus({ preventScroll: true });
    const previous = selectionRef.current;
    const next = event.shiftKey && previous
      ? { anchorRow: previous.anchorRow, anchorColumn: previous.anchorColumn, focusRow: rowIndex, focusColumn: columnIndex }
      : { anchorRow: rowIndex, anchorColumn: columnIndex, focusRow: rowIndex, focusColumn: columnIndex };
    dragSelectingRef.current = true;
    setSelectionValue(next);
  }

  function extendSelection(rowIndex: number, columnIndex: number): void {
    if (!dragSelectingRef.current || !selectionRef.current) return;
    setSelectionValue({ ...selectionRef.current, focusRow: rowIndex, focusColumn: columnIndex });
  }

  function selectWholeRow(rowIndex: number, event: ReactMouseEvent<HTMLElement>): void {
    const firstColumn = visibleColumnIndexes[0];
    const lastColumn = visibleColumnIndexes[visibleColumnIndexes.length - 1];
    if (event.button !== 0 || firstColumn === undefined || lastColumn === undefined) return;
    scroller.current?.focus({ preventScroll: true });
    const previous = selectionRef.current;
    const next = event.shiftKey && previous
      ? { anchorRow: previous.anchorRow, anchorColumn: firstColumn, focusRow: rowIndex, focusColumn: lastColumn }
      : { anchorRow: rowIndex, anchorColumn: firstColumn, focusRow: rowIndex, focusColumn: lastColumn };
    dragSelectingRef.current = true;
    setSelectionValue(next);
  }

  function sortColumn(columnIndex: number): void {
    const id = columnKey(columns[columnIndex]!, columnIndex);
    const current = activeView.sorting.find(item => columnMatchesKey(columns[columnIndex]!, columnIndex, item.column));
    const nextSorting = current === undefined
      ? [{ column: id, descending: false }]
      : current.descending
        ? activeView.sorting.filter(item => !columnMatchesKey(columns[columnIndex]!, columnIndex, item.column))
        : activeView.sorting.map(item => columnMatchesKey(columns[columnIndex]!, columnIndex, item.column) ? { ...item, descending: true } : item);
    updateView({ sorting: nextSorting });
  }

  function filterColumn(columnIndex: number, value: string): void {
    const id = columnKey(columns[columnIndex]!, columnIndex);
    const nextFilters = { ...activeView.columnFilters };
    if (value) nextFilters[id] = value;
    else delete nextFilters[id];
    updateView({ columnFilters: nextFilters });
  }

  function togglePin(columnIndex: number): void {
    const id = columnKey(columns[columnIndex]!, columnIndex);
    const pinned = [...(activeView.pinnedColumns ?? [])];
    const index = pinned.findIndex(key => columnMatchesKey(columns[columnIndex]!, columnIndex, key));
    if (index >= 0) pinned.splice(index, 1);
    else pinned.push(id);
    updateView({ pinnedColumns: pinned });
  }

  function reorderColumn(columnIndex: number, targetIndex: number): void {
    const current = [...(activeView.columnOrder ?? columns.map((_column, index) => columnKey(columns[index]!, index)))];
    const sourceId = columnKey(columns[columnIndex]!, columnIndex);
    const targetId = columnKey(columns[targetIndex]!, targetIndex);
    const sourcePosition = current.indexOf(sourceId);
    const targetPosition = current.indexOf(targetId);
    if (sourcePosition < 0 || targetPosition < 0 || sourcePosition === targetPosition) return;
    current.splice(sourcePosition, 1);
    current.splice(sourcePosition < targetPosition ? targetPosition - 1 : targetPosition, 0, sourceId);
    updateView({ columnOrder: current });
  }

  function copySelection(): void {
    const selected = range;
    const minRow = selected?.minRow ?? 0;
    const maxRow = selected?.maxRow ?? Math.max(0, processedRows.length - 1);
    const selectedColumns = visibleColumnIndexes.filter((_columnIndex, position) => columnRange === undefined || (position >= columnRange.minColumn && position <= columnRange.maxColumn));
    const columnIndexes = selectedColumns.length > 0 ? selectedColumns : visibleColumnIndexes;
    const selectedRows = processedRows.slice(minRow, maxRow + 1).map(row => row.values);
    const payload: DataGridCopyPayload = { columns: columnIndexes.map(index => columns[index]!), rows: selectedRows.map(row => columnIndexes.map(index => row[index])), selection };
    if (onCopySelection) {
      onCopySelection(payload);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    const text = [payload.columns.map(column => column.name).join('\t'), ...payload.rows.map(row => row.map((value, index) => formatDataGridCellValue(value, payload.columns[index]?.type)).join('\t'))].join('\n');
    void navigator.clipboard.writeText(text);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') {
      event.preventDefault();
      copySelection();
    }
  }

  if (columns.length === 0 || (rows.length === 0 && !hasMoreRows)) return <div className="ui-grid-empty" role="status">No rows to display.</div>;

  // Keep the legacy result-grid hook as a compatibility selector while the
  // shared class remains the styling/API identity for every host.
  return <div className="ui-result-grid result-grid">
    <div ref={scroller} className="ui-data-grid-scroll" onScroll={handleScroll} onKeyDown={handleKeyDown} tabIndex={0} aria-label={`Data grid with ${totalRowCount} rows`}>
      {processedRows.length === 0 ? <div className="ui-grid-empty" role="status">No matching rows.{hasMoreRows && <button type="button" onClick={onLoadMore}>Load more rows</button>}</div> : <table className="ui-data-grid">
        <thead><tr>
          <th scope="col" className="ui-data-grid-row-number">#</th>
          {visibleColumnIndexes.map(columnIndex => {
            const column = columns[columnIndex]!;
            const id = columnKey(column, columnIndex);
            const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
            const left = pinned ? ROW_NUMBER_WIDTH + visibleColumnIndexes.slice(0, visibleColumnIndexes.indexOf(columnIndex)).filter(index => activeView.pinnedColumns?.some(key => columnMatchesKey(columns[index]!, index, key))).reduce((sum, index) => sum + (activeView.columnWidths?.[columnKey(columns[index]!, index)] ?? DEFAULT_COLUMN_WIDTH), 0) : undefined;
            const sort = activeView.sorting.find(item => columnMatchesKey(column, columnIndex, item.column));
            const width = activeView.columnWidths?.[id] ?? DEFAULT_COLUMN_WIDTH;
            return <th scope="col" key={id} className={pinned ? 'ui-data-grid-pinned' : undefined} style={{ width, minWidth: width, ...(left === undefined ? {} : { left }) }} onDragOver={event => event.preventDefault()} onDrop={() => { const source = draggedColumnRef.current; if (source !== undefined) reorderColumn(source, columnIndex); draggedColumnRef.current = undefined; }}>
              <div className="ui-data-grid-header-content">
                <button type="button" className="ui-data-grid-drag-handle" draggable aria-label={`Reorder ${column.name}`} onDragStart={() => { draggedColumnRef.current = columnIndex; }} onDragEnd={() => { draggedColumnRef.current = undefined; }}>⠿</button>
                <button type="button" className="ui-data-grid-header-label" onClick={() => sortColumn(columnIndex)} title={`Sort by ${column.name}`}><span>{column.name}</span><span className="ui-data-grid-sort" aria-label={sort === undefined ? 'Not sorted' : sort.descending ? 'Sorted descending' : 'Sorted ascending'}>{sort?.descending ? '▼' : sort ? '▲' : '↕'}</span></button>
                <span className={`ui-data-grid-type-badge ui-data-grid-type-${typeBadgeClass(column.type)}`}>{typeBadge(column.type)}</span>
                <button type="button" className={`ui-data-grid-header-action ${pinned ? 'active' : ''}`} aria-label={pinned ? `Unpin ${column.name}` : `Pin ${column.name}`} title={pinned ? 'Unpin column' : 'Pin column'} onClick={() => togglePin(columnIndex)}>📌</button>
                <input className="ui-data-grid-column-filter" aria-label={`Filter ${column.name}`} placeholder="filter…" value={filterValue(activeView, column, columnIndex)} onChange={event => filterColumn(columnIndex, event.target.value)} />
                <button type="button" className="ui-data-grid-group-action" aria-label={activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key)) ? `Ungroup ${column.name}` : `Group by ${column.name}`} title={activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key)) ? 'Remove grouping' : 'Group by column'} onClick={() => { const grouping = activeView.grouping.filter(key => !columnMatchesKey(column, columnIndex, key)); if (grouping.length === activeView.grouping.length) grouping.push(id); updateView({ grouping }); }}>▦</button>
                <span className="ui-data-grid-resizer" role="separator" aria-label={`Resize ${column.name}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); resizeRef.current = { columnId: id, startX: event.clientX, startWidth: width }; }} />
              </div>
            </th>;
          })}
        </tr></thead>
        <tbody>{renderedRows.map(rendered => {
          if (rendered.kind === 'group') {
            const collapsed = collapsedGroups.has(rendered.id);
            return <tr className="ui-data-grid-group-row" key={`group:${rendered.id}`}><td className="ui-data-grid-group-cell" colSpan={visibleColumnIndexes.length + 1}><button type="button" className="ui-data-grid-group-toggle" aria-label={`${collapsed ? 'Expand' : 'Collapse'} group ${rendered.label}`} onClick={() => setCollapsedGroups(previous => { const next = new Set(previous); if (collapsed) next.delete(rendered.id); else next.add(rendered.id); return next; })}><span className="ui-data-grid-group-marker">{collapsed ? '▸' : '▾'}</span></button>{rendered.label}<span className="ui-data-grid-group-count">{rendered.count.toLocaleString()} rows</span></td></tr>;
          }
          if (rendered.groupId !== undefined && collapsedGroups.has(rendered.groupId)) return null;
          const rowSelected = selectedRowIndex === rendered.sourceIndex;
          const rowLabel = rendered.values.map((value, columnIndex) => formatDataGridCellValue(value, columns[columnIndex]?.type)).join(' ');
          const firstVisibleColumn = visibleColumnIndexes[0];
          return <tr key={`${resultSetId}:${rendered.sourceIndex}`} aria-label={rowLabel} className={`${rendered.displayIndex % 2 === 0 ? 'ui-data-grid-row-even' : 'ui-data-grid-row-odd'} ${rowSelected ? 'ui-data-grid-row-selected' : ''}`} onClick={() => onRowSelect?.(rendered.sourceIndex)}>
            <th scope="row" className="ui-data-grid-row-number" onMouseDown={event => selectWholeRow(rendered.displayIndex, event)} onMouseEnter={() => firstVisibleColumn !== undefined && extendSelection(rendered.displayIndex, firstVisibleColumn)}><button type="button" aria-label={`Select row ${rendered.displayIndex + 1}`} onClick={event => { event.stopPropagation(); onRowSelect?.(rendered.sourceIndex); }}>{rendered.displayIndex + 1}</button></th>
            {visibleColumnIndexes.map(columnIndex => {
              const column = columns[columnIndex]!;
              const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
              const left = pinned ? ROW_NUMBER_WIDTH + visibleColumnIndexes.slice(0, visibleColumnIndexes.indexOf(columnIndex)).filter(index => activeView.pinnedColumns?.some(key => columnMatchesKey(columns[index]!, index, key))).reduce((sum, index) => sum + (activeView.columnWidths?.[columnKey(columns[index]!, index)] ?? DEFAULT_COLUMN_WIDTH), 0) : undefined;
              const columnPosition = visibleColumnIndexes.indexOf(columnIndex);
              const selected = range !== undefined && columnRange !== undefined && rendered.displayIndex >= range.minRow && rendered.displayIndex <= range.maxRow && columnPosition >= columnRange.minColumn && columnPosition <= columnRange.maxColumn;
              const value = rendered.values[columnIndex];
              const displayValue = formatDataGridCellValue(value, column.type);
              return <td key={`${rendered.sourceIndex}:${columnKey(column, columnIndex)}`} className={[pinned ? 'ui-data-grid-pinned' : '', selected ? 'ui-data-grid-cell-selected' : '', `ui-data-grid-value-${valueClass(value, column.type)}`, isNumericType(column.type) ? 'ui-data-grid-cell-numeric' : ''].filter(Boolean).join(' ')} style={left === undefined ? undefined : { left }} onMouseDown={event => selectCell(rendered.displayIndex, columnIndex, event)} onMouseEnter={() => extendSelection(rendered.displayIndex, columnIndex)} onContextMenu={event => { event.preventDefault(); onContextMenu?.({ rowIndex: rendered.sourceIndex, columnIndex, clientX: event.clientX, clientY: event.clientY }); }} title={displayValue}>{displayValue}</td>;
            })}
          </tr>;
        })}</tbody>
      </table>}
    </div>
  </div>;
}
