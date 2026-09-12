import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, UIEvent } from 'react';
import type { UiResultViewState } from '@justybase/ui-core';
import {
  formatDataGridCellValue,
  inferDataGridColumnMetadata,
  isDataGridNumericColumn,
  isDataGridTemporalColumn,
  matchesDataGridFilterValue,
} from './resultGridFormatting';
import type { DataGridCellMetadata } from './resultGridFormatting';
import { formatDataGridClipboard } from './dataGridClipboard';
import type { DataGridClipboardFormat } from './dataGridClipboard';
import type { DataGridColumn, DataGridCopyPayload, DataGridSelection } from './dataGridTypes';

export { formatDataGridCellValue } from './resultGridFormatting';
export type { DataGridColumn, DataGridCopyPayload, DataGridSelection } from './dataGridTypes';

export type DataGridViewState = Pick<UiResultViewState, 'globalFilter' | 'columnFilters' | 'sorting' | 'grouping'> &
  Partial<Pick<UiResultViewState, 'columnVisibility' | 'columnOrder' | 'pinnedColumns' | 'columnWidths'>>;

export interface GridScrollPosition {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly top: number;
  readonly left: number;
  readonly anchorRow?: number;
}

export interface DataGridCellContext {
  /** Index into the supplied raw rows, not the filtered or sorted display list. */
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface DataGridProps {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  /** Provides value metadata when a column's cells have heterogeneous source types. */
  readonly getCellMetadata?: (value: unknown, rowIndex: number, columnIndex: number, column: DataGridColumn) => DataGridCellMetadata;
  readonly totalRowCount?: number;
  readonly scroll?: GridScrollPosition;
  readonly onScroll?: (position: GridScrollPosition) => void;
  /** Requests the next adapter-owned page when the rendered rows near the end. */
  readonly onLoadMore?: () => void;
  /** Index into the supplied raw rows, even when displayed rows are filtered, sorted, or grouped. */
  readonly onRowSelect?: (rowIndex: number) => void;
  /** Opens the host-owned guarded row editor for the context-menu row. */
  readonly onEditRow?: (context: DataGridCellContext) => void;
  readonly selectedRowIndex?: number;
  readonly view?: DataGridViewState;
  readonly onViewChange?: (patch: Partial<UiResultViewState>) => void;
  /** Server-backed grids keep filtering/sorting in the adapter but share the same renderer. */
  readonly clientProcessing?: boolean;
  readonly onSelectionChange?: (selection: DataGridSelection | undefined) => void;
  readonly onContextMenu?: (context: DataGridCellContext) => void;
  readonly onCopySelection?: (payload: DataGridCopyPayload, format?: DataGridClipboardFormat) => void;
  /** Opens the host-specific large-value viewer for a context-menu cell. */
  readonly onViewCell?: (context: DataGridCellContext) => void;
  /** Opens the host-specific full-row detail view for a context-menu row. */
  readonly onViewRow?: (context: DataGridCellContext) => void;
  /** Opens the host-specific result formatting surface. */
  readonly onOpenResultFormatting?: () => void;
  /** Enables the shared copy/filter/sort/row-detail context menu. */
  readonly showContextMenu?: boolean;
  /** Shows the shared column visibility/order/pinning menu. */
  readonly showColumnMenu?: boolean;
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
const MAX_EMPTY_PAGE_REQUESTS = 3;
const ROW_HEIGHT = 30;
const DEFAULT_VIEWPORT_HEIGHT = 480;
const VIRTUAL_OVERSCAN_ROWS = 8;

export interface DataGridVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

/**
 * Calculates the rendered row window without touching the DOM. Keeping this
 * calculation pure makes the large-result behaviour testable in Node and
 * keeps the React renderer responsible only for applying the window.
 */
export function calculateDataGridVirtualWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  overscanRows = VIRTUAL_OVERSCAN_ROWS,
): DataGridVirtualWindow {
  const count = Math.max(0, Math.trunc(rowCount));
  if (count === 0) return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewportHeight = Math.max(ROW_HEIGHT, Number.isFinite(viewportHeight) ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT);
  const safeOverscan = Math.max(0, Math.trunc(overscanRows));
  const firstVisible = Math.min(count - 1, Math.floor(safeScrollTop / ROW_HEIGHT));
  const visibleRows = Math.max(1, Math.ceil(safeViewportHeight / ROW_HEIGHT));
  const startIndex = Math.max(0, firstVisible - safeOverscan);
  const endIndex = Math.min(count, firstVisible + visibleRows + safeOverscan);
  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * ROW_HEIGHT,
    paddingBottom: Math.max(0, count - endIndex) * ROW_HEIGHT,
  };
}

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

function cellText(value: unknown, metadata: DataGridCellMetadata = {}): string {
  return formatDataGridCellValue(value, metadata.type, metadata);
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

function typeBadge(column: DataGridColumn): string {
  if (column.inferredDateInteger) return 'DT';
  if (column.inferredNumericKind === 'integer') return 'INT';
  if (column.inferredNumericKind === 'decimal') return 'NUM';
  if (!column.type) return '?';
  const value = column.type.toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT/.test(value)) return 'INT';
  if (/DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(value)) return 'NUM';
  if (/VARCHAR|CHAR|TEXT|CLOB|STRING/.test(value)) return 'TXT';
  if (/DATE|TIME|TIMESTAMP/.test(value)) return 'DT';
  if (/BOOL/.test(value)) return 'BOOL';
  return value.slice(0, 4);
}

function typeBadgeClass(column: DataGridColumn): string {
  if (column.inferredDateInteger) return 'temporal';
  if (column.inferredNumericKind !== undefined) return 'numeric';
  if (!column.type) return 'text';
  const value = column.type.toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(value)) return 'numeric';
  if (/DATE|TIME|TIMESTAMP/.test(value)) return 'temporal';
  if (/BOOL/.test(value)) return 'boolean';
  return 'text';
}

function parseTemporalSortValue(value: unknown, metadata: DataGridCellMetadata = {}): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  if (metadata.inferredDateInteger) {
    const rawInteger = Number(String(value));
    return Number.isFinite(rawInteger) ? rawInteger : undefined;
  }
  const raw = cellText(value, metadata);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function valueClass(value: unknown, column: DataGridCellMetadata): string {
  if (value === null || value === undefined) return 'null';
  if (isDataGridNumericColumn(column)) return 'numeric';
  if (isDataGridTemporalColumn(column)) return 'temporal';
  if (column.type !== undefined && /BOOL/u.test(column.type.toUpperCase())) {
    return formatDataGridCellValue(value, column.type, column) === '✓ true' ? 'boolean-true' : 'boolean-false';
  }
  return '';
}

function columnKey(column: DataGridColumn, index: number): string {
  // Persist a semantic key instead of the position. Keep accepting the
  // historical numeric key below so existing saved views still resolve.
  const name = column.name.trim();
  return name.length > 0 ? name : `column-${index}`;
}

function columnMatchesKey(column: DataGridColumn, index: number, key: string): boolean {
  return key === columnKey(column, index) || key === column.name || key === String(index);
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

/** Returns raw column indexes in the order and visibility of a grid view. */
export function resolveDataGridColumnIndexes(
  columns: readonly DataGridColumn[],
  view: DataGridViewState = normaliseView(undefined),
): readonly number[] {
  return orderColumns(columns, normaliseView(view));
}

export function resolveDataGridColumns(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
): readonly DataGridColumn[] {
  return columns.map((column, columnIndex) => ({
    ...column,
    ...inferDataGridColumnMetadata(column, rows.slice(0, 100).map(row => row[columnIndex])),
  }));
}

function compareValues(left: unknown, right: unknown, leftColumn: DataGridCellMetadata, rightColumn = leftColumn): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1;
  if (right === null || right === undefined) return 1;
  if (isDataGridTemporalColumn(leftColumn) || isDataGridTemporalColumn(rightColumn)) {
    const leftTime = parseTemporalSortValue(left, leftColumn);
    const rightTime = parseTemporalSortValue(right, rightColumn);
    if (leftTime !== undefined || rightTime !== undefined) {
      if (leftTime === undefined) return -1;
      if (rightTime === undefined) return 1;
      return leftTime - rightTime;
    }
  }
  if (isDataGridNumericColumn(leftColumn) || isDataGridNumericColumn(rightColumn)) {
    const leftDecimal = parseComparableDecimal(left);
    const rightDecimal = parseComparableDecimal(right);
    if (leftDecimal && rightDecimal) return compareComparableDecimals(leftDecimal, rightDecimal);
  }
  return cellText(left, leftColumn).localeCompare(cellText(right, rightColumn), undefined, { numeric: true, sensitivity: 'base' });
}

type CellMetadataResolver = (
  value: unknown,
  rowIndex: number,
  columnIndex: number,
  column: DataGridColumn,
) => DataGridCellMetadata;

function matchesRow(
  columns: readonly DataGridColumn[],
  values: readonly unknown[],
  view: DataGridViewState,
  sourceIndex: number,
  getCellMetadata?: CellMetadataResolver,
): boolean {
  const globalFilter = view.globalFilter.trim();
  if (globalFilter && !values.some((value, columnIndex) => {
    const column = columns[columnIndex];
    const metadata = column === undefined ? undefined : getCellMetadata?.(value, sourceIndex, columnIndex, column) ?? column;
    return matchesDataGridFilterValue(value, globalFilter, metadata);
  })) return false;
  return columns.every((column, columnIndex) => {
    const filter = filterValue(view, column, columnIndex).trim();
    const metadata = getCellMetadata?.(values[columnIndex], sourceIndex, columnIndex, column) ?? column;
    return !filter || matchesDataGridFilterValue(values[columnIndex], filter, metadata);
  });
}

function processIndexedRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
  clientProcessing: boolean,
  getCellMetadata?: CellMetadataResolver,
): readonly IndexedRow[] {
  const indexed = rows.flatMap((values, sourceIndex) => {
    if (clientProcessing && !matchesRow(columns, values, view, sourceIndex, getCellMetadata)) return [];
    return [{ values, sourceIndex }];
  });
  if (!clientProcessing) return indexed;
  const sorting = view.sorting
    .map(item => ({ ...item, columnIndex: resolveColumnIndex(columns, item.column) }))
    .filter(item => item.columnIndex >= 0);
  indexed.sort((left, right) => {
    for (const item of sorting) {
      const column = columns[item.columnIndex]!;
      const leftColumn = getCellMetadata?.(left.values[item.columnIndex], left.sourceIndex, item.columnIndex, column) ?? column;
      const rightColumn = getCellMetadata?.(right.values[item.columnIndex], right.sourceIndex, item.columnIndex, column) ?? column;
      const comparison = compareValues(left.values[item.columnIndex], right.values[item.columnIndex], leftColumn, rightColumn);
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
  const resolvedColumns = resolveDataGridColumns(columns, rows);
  return processIndexedRows(resolvedColumns, rows, view, true).map(item => item.values);
}

/** Returns source-row indexes after applying the same filtering and sorting as the grid. */
export function processDataGridRowIndices(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
): readonly number[] {
  const resolvedColumns = resolveDataGridColumns(columns, rows);
  return processIndexedRows(resolvedColumns, rows, view, true).map(item => item.sourceIndex);
}

function indexedRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
  clientProcessing: boolean,
  getCellMetadata?: CellMetadataResolver,
): readonly IndexedRow[] {
  return processIndexedRows(columns, rows, view, clientProcessing, getCellMetadata);
}

function groupRows(columns: readonly DataGridColumn[], rows: readonly IndexedRow[], grouping: readonly string[], getCellMetadata?: CellMetadataResolver): readonly RenderedRow[] {
  if (grouping.length === 0) return rows.map((row, displayIndex) => ({ ...row, kind: 'data', displayIndex }));
  const groups = new Map<string, IndexedRow[]>();
  for (const row of rows) {
    const values = grouping.map(key => {
      const index = resolveColumnIndex(columns, key);
      const column = index >= 0 ? columns[index] : undefined;
      const value = index >= 0 ? row.values[index] : undefined;
      const metadata = column === undefined ? undefined : getCellMetadata?.(value, row.sourceIndex, index, column) ?? column;
      return formatDataGridCellValue(value, metadata?.type, metadata);
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
  getCellMetadata,
  totalRowCount = rows.length,
  scroll,
  onScroll,
  onLoadMore,
  onRowSelect,
  onEditRow,
  selectedRowIndex,
  view,
  onViewChange,
  clientProcessing = true,
  onSelectionChange,
  onContextMenu,
  onCopySelection,
  onViewCell,
  onViewRow,
  onOpenResultFormatting,
  showContextMenu = true,
  showColumnMenu = true,
}: DataGridProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const [internalView, setInternalView] = useState<DataGridViewState>(() => normaliseView(undefined));
  const activeView = normaliseView(view ?? internalView);
  const resolvedColumnsCacheRef = useRef<{
    readonly resultSetId: string;
    readonly signature: string;
    readonly columns: readonly DataGridColumn[];
    readonly ready: boolean;
  } | undefined>(undefined);
  const columnMetadataSignature = useMemo(
    () => columns.map(column => [column.name, column.type ?? '', column.scale ?? '', column.inferredNumericKind ?? '', column.inferredDateInteger ? 'date' : ''].join('\u0000')).join('\u0001'),
    [columns],
  );
  const resolvedColumns = useMemo(() => {
    const cache = resolvedColumnsCacheRef.current;
    const stableResultSetId = resultSetId ?? '';
    if (cache
      && cache.resultSetId === stableResultSetId
      && cache.signature === columnMetadataSignature
      && (cache.ready || rows.length === 0)) {
      return cache.columns;
    }
    const nextColumns = resolveDataGridColumns(columns, rows);
    const ready = rows.length > 0 || columns.every(column =>
      column.type !== undefined
      || column.inferredNumericKind !== undefined
      || column.inferredDateInteger !== undefined,
    );
    resolvedColumnsCacheRef.current = {
      resultSetId: stableResultSetId,
      signature: columnMetadataSignature,
      columns: nextColumns,
      ready,
    };
    return nextColumns;
  }, [columnMetadataSignature, columns, resultSetId, rows]);
  const [selection, setSelection] = useState<DataGridSelection | undefined>(undefined);
  const selectionRef = useRef<DataGridSelection | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<DataGridCellContext | undefined>(undefined);
  const contextMenuElementRef = useRef<HTMLDivElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ left: 8, top: 8 });
  const dragSelectingRef = useRef(false);
  const draggedColumnRef = useRef<number | undefined>(undefined);
  const resizeRef = useRef<{ columnId: string; startX: number; startWidth: number } | undefined>(undefined);
  const activeViewRef = useRef<DataGridViewState>(activeView);
  const updateViewRef = useRef<(patch: Partial<UiResultViewState>) => void>(() => undefined);
  const selectionScopeRef = useRef<string | undefined>(undefined);
  const selectionChangeRef = useRef(onSelectionChange);
  const emptyPageRequestRef = useRef<{ readonly key: string; readonly count: number } | undefined>(undefined);
  const virtualScrollFrameRef = useRef<number | undefined>(undefined);
  const virtualViewportSyncRef = useRef<(() => void) | undefined>(undefined);
  const virtualViewportRef = useRef({ scrollTop: 0, height: DEFAULT_VIEWPORT_HEIGHT });
  const [virtualViewport, setVirtualViewport] = useState(virtualViewportRef.current);
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

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (): void => setContextMenu(undefined);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu) return;
    const element = contextMenuElementRef.current;
    if (!element) return;
    const margin = 8;
    const bounds = element.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - bounds.height - margin);
    const left = Math.min(Math.max(margin, contextMenu.clientX), maxLeft);
    const top = Math.min(Math.max(margin, contextMenu.clientY), maxTop);
    setContextMenuPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
  }, [contextMenu]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const flushViewport = (): void => {
      virtualScrollFrameRef.current = undefined;
      const next = virtualViewportRef.current;
      setVirtualViewport(previous => previous.scrollTop === next.scrollTop && previous.height === next.height ? previous : next);
    };
    const scheduleViewport = (): void => {
      virtualViewportRef.current = {
        scrollTop: Math.max(0, element.scrollTop),
        height: Math.max(0, element.clientHeight) || DEFAULT_VIEWPORT_HEIGHT,
      };
      if (virtualScrollFrameRef.current !== undefined) return;
      if (typeof requestAnimationFrame === 'function') {
        virtualScrollFrameRef.current = requestAnimationFrame(flushViewport);
      } else {
        flushViewport();
      }
    };

    virtualViewportSyncRef.current = scheduleViewport;
    scheduleViewport();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleViewport);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (virtualScrollFrameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(virtualScrollFrameRef.current);
      }
      virtualScrollFrameRef.current = undefined;
      virtualViewportSyncRef.current = undefined;
    };
  }, [columns.length, resultSetId, rows.length]);

  const visibleColumnIndexes = useMemo(() => orderColumns(resolvedColumns, activeView), [resolvedColumns, activeView]);
  const processedRows = useMemo(() => indexedRows(resolvedColumns, rows, activeView, clientProcessing, getCellMetadata), [resolvedColumns, rows, activeView, clientProcessing, getCellMetadata]);
  const renderedRows = useMemo(() => groupRows(resolvedColumns, processedRows, activeView.grouping, getCellMetadata), [resolvedColumns, processedRows, activeView.grouping, getCellMetadata]);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const visibleRenderedRows = useMemo(
    () => renderedRows.filter(row => row.kind === 'group' || row.groupId === undefined || !collapsedGroups.has(row.groupId)),
    [collapsedGroups, renderedRows],
  );
  const virtualWindow = useMemo(
    () => calculateDataGridVirtualWindow(visibleRenderedRows.length, virtualViewport.scrollTop, virtualViewport.height),
    [visibleRenderedRows.length, virtualViewport.height, virtualViewport.scrollTop],
  );
  const virtualRenderedRows = useMemo(
    () => visibleRenderedRows.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [visibleRenderedRows, virtualWindow.endIndex, virtualWindow.startIndex],
  );
  const range = selectedRange(selection);
  const columnRange = selectedColumnPositionRange(selection, visibleColumnIndexes);
  const hasMoreRows = onLoadMore !== undefined && rows.length < totalRowCount;
  const emptyPageRequestKey = useMemo(() => JSON.stringify({
    resultSetId,
    totalRowCount,
    globalFilter: activeView.globalFilter,
    columnFilters: activeView.columnFilters,
  }), [activeView.columnFilters, activeView.globalFilter, resultSetId, totalRowCount]);
  const selectionScope = useMemo(() => JSON.stringify({
    sourceId,
    resultSetId,
    clientProcessing,
    columns: resolvedColumns.map(column => [column.name, column.type, column.scale, column.inferredNumericKind, column.inferredDateInteger]),
    view: {
      globalFilter: activeView.globalFilter,
      columnFilters: activeView.columnFilters,
      sorting: activeView.sorting,
      grouping: activeView.grouping,
      columnVisibility: activeView.columnVisibility,
      columnOrder: activeView.columnOrder,
      pinnedColumns: activeView.pinnedColumns,
    },
  }), [activeView.columnFilters, activeView.columnOrder, activeView.columnVisibility, activeView.grouping, activeView.pinnedColumns, activeView.globalFilter, activeView.sorting, clientProcessing, columns, resolvedColumns, resultSetId, sourceId]);

  useEffect(() => {
    const previousScope = selectionScopeRef.current;
    selectionScopeRef.current = selectionScope;
    if (previousScope === undefined || previousScope === selectionScope) return;
    dragSelectingRef.current = false;
    selectionRef.current = undefined;
    setSelection(undefined);
    setCollapsedGroups(new Set());
    setContextMenu(undefined);
    selectionChangeRef.current?.(undefined);
  }, [selectionScope]);

  useEffect(() => {
    if (!hasMoreRows || processedRows.length > 0) {
      emptyPageRequestRef.current = undefined;
      return;
    }
    const previous = emptyPageRequestRef.current;
    if (previous?.key === emptyPageRequestKey && previous.count >= MAX_EMPTY_PAGE_REQUESTS) return;
    emptyPageRequestRef.current = {
      key: emptyPageRequestKey,
      count: previous?.key === emptyPageRequestKey ? previous.count + 1 : 1,
    };
    onLoadMore?.();
  }, [emptyPageRequestKey, hasMoreRows, onLoadMore, processedRows.length]);

  useEffect(() => {
    const restore = (): void => {
      const element = scroller.current;
      if (!element || !scroll || scroll.resultSetId !== resultSetId || (scroll.sourceId !== undefined && scroll.sourceId !== sourceId)) return;
      element.scrollTop = Math.max(0, scroll.top);
      element.scrollLeft = Math.max(0, scroll.left);
      virtualViewportSyncRef.current?.();
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
    virtualViewportRef.current = {
      scrollTop: Math.max(0, element.scrollTop),
      height: Math.max(0, element.clientHeight) || DEFAULT_VIEWPORT_HEIGHT,
    };
    if (virtualScrollFrameRef.current === undefined) {
      const flush = (): void => {
        virtualScrollFrameRef.current = undefined;
        const next = virtualViewportRef.current;
        setVirtualViewport(previous => previous.scrollTop === next.scrollTop && previous.height === next.height ? previous : next);
      };
      if (typeof requestAnimationFrame === 'function') virtualScrollFrameRef.current = requestAnimationFrame(flush);
      else flush();
    }
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
    const id = columnKey(resolvedColumns[columnIndex]!, columnIndex);
    const current = activeView.sorting.find(item => columnMatchesKey(resolvedColumns[columnIndex]!, columnIndex, item.column));
    const nextSorting = current === undefined
      ? [{ column: id, descending: false }]
      : current.descending
        ? activeView.sorting.filter(item => !columnMatchesKey(resolvedColumns[columnIndex]!, columnIndex, item.column))
        : activeView.sorting.map(item => columnMatchesKey(resolvedColumns[columnIndex]!, columnIndex, item.column) ? { ...item, descending: true } : item);
    updateView({ sorting: nextSorting });
  }

  function filterColumn(columnIndex: number, value: string): void {
    const id = columnKey(resolvedColumns[columnIndex]!, columnIndex);
    const nextFilters = { ...activeView.columnFilters };
    if (value) nextFilters[id] = value;
    else delete nextFilters[id];
    updateView({ columnFilters: nextFilters });
  }

  function togglePin(columnIndex: number): void {
    const id = columnKey(resolvedColumns[columnIndex]!, columnIndex);
    const pinned = [...(activeView.pinnedColumns ?? [])];
    const index = pinned.findIndex(key => columnMatchesKey(resolvedColumns[columnIndex]!, columnIndex, key));
    if (index >= 0) pinned.splice(index, 1);
    else pinned.push(id);
    updateView({ pinnedColumns: pinned });
  }

  function toggleColumnVisibility(columnIndex: number, visible: boolean): void {
    const column = resolvedColumns[columnIndex];
    if (!column) return;
    const id = columnKey(column, columnIndex);
    const visibility = { ...(activeView.columnVisibility ?? {}) };
    if (visible) delete visibility[id];
    else visibility[id] = false;
    updateView({ columnVisibility: visibility });
  }

  function reorderColumn(columnIndex: number, targetIndex: number): void {
    const current = [...(activeView.columnOrder ?? resolvedColumns.map((_column, index) => columnKey(resolvedColumns[index]!, index)))];
    const sourceId = columnKey(resolvedColumns[columnIndex]!, columnIndex);
    const targetId = columnKey(resolvedColumns[targetIndex]!, targetIndex);
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
    const payload: DataGridCopyPayload = { columns: columnIndexes.map(index => resolvedColumns[index]!), rows: selectedRows.map(row => columnIndexes.map(index => row[index])), selection, includeHeaders: true };
    if (onCopySelection) {
      onCopySelection(payload);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    const text = formatDataGridClipboard(payload, 'text');
    void navigator.clipboard.writeText(text);
  }

  function copyContextPayload(payload: DataGridCopyPayload, format: DataGridClipboardFormat = 'text'): void {
    if (onCopySelection) {
      if (format === 'text') onCopySelection(payload);
      else onCopySelection(payload, format);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    const text = formatDataGridClipboard(payload, format);
    void navigator.clipboard.writeText(text);
  }

  function copyContextValue(context: DataGridCellContext, row: readonly unknown[]): void {
    const column = resolvedColumns[context.columnIndex];
    if (!column) return;
    copyContextPayload({ columns: [column], rows: [[row[context.columnIndex]]], includeHeaders: false });
    setContextMenu(undefined);
  }

  function copyContextRow(row: readonly unknown[]): void {
    const columnIndexes = visibleColumnIndexes;
    copyContextPayload({ columns: columnIndexes.map(index => resolvedColumns[index]!), rows: [columnIndexes.map(index => row[index])], includeHeaders: false });
    setContextMenu(undefined);
  }

  function copyContextRowAs(format: Exclude<DataGridClipboardFormat, 'html' | 'tsv'> | 'tsv'): void {
    const row = contextMenu ? rows[contextMenu.rowIndex] : undefined;
    if (!row) return;
    const columnIndexes = visibleColumnIndexes;
    copyContextPayload({ columns: columnIndexes.map(index => resolvedColumns[index]!), rows: [columnIndexes.map(index => row[index])], includeHeaders: format === 'markdown' }, format);
    setContextMenu(undefined);
  }

  function filterContextValue(context: DataGridCellContext, row: readonly unknown[]): void {
    filterColumn(context.columnIndex, row[context.columnIndex] === null || row[context.columnIndex] === undefined ? '' : String(row[context.columnIndex]));
    setContextMenu(undefined);
  }

  function clearContextFilter(columnIndex: number): void {
    filterColumn(columnIndex, '');
    setContextMenu(undefined);
  }

  function sortContextValue(columnIndex: number, descending: boolean): void {
    const column = resolvedColumns[columnIndex];
    if (!column) return;
    updateView({ sorting: [{ column: columnKey(column, columnIndex), descending }] });
    setContextMenu(undefined);
  }

  function selectContextRow(context: DataGridCellContext): void {
    onRowSelect?.(context.rowIndex);
    onViewRow?.(context);
    setContextMenu(undefined);
  }

  function toggleContextGrouping(columnIndex: number): void {
    const column = resolvedColumns[columnIndex];
    if (!column) return;
    const id = columnKey(column, columnIndex);
    const grouping = activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key))
      ? activeView.grouping.filter(key => !columnMatchesKey(column, columnIndex, key))
      : [...activeView.grouping, id];
    updateView({ grouping });
    setContextMenu(undefined);
  }

  function hideContextColumn(columnIndex: number): void {
    toggleColumnVisibility(columnIndex, false);
    setContextMenu(undefined);
  }

  function viewContextCell(context: DataGridCellContext): void {
    onViewCell?.(context);
    setContextMenu(undefined);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') {
      event.preventDefault();
      copySelection();
    }
  }

  if (resolvedColumns.length === 0 || (rows.length === 0 && !hasMoreRows)) return <div className="ui-grid-empty" role="status">No rows to display.</div>;

  // Keep the legacy result-grid hook as a compatibility selector while the
  // shared class remains the styling/API identity for every host.
  const contextRow = contextMenu ? rows[contextMenu.rowIndex] : undefined;
  const contextColumn = contextMenu ? resolvedColumns[contextMenu.columnIndex] : undefined;

  return <div className="ui-result-grid result-grid">
    {showColumnMenu && <details className="ui-data-grid-column-menu">
      <summary>Columns</summary>
      <div className="ui-data-grid-column-menu-panel" role="menu" aria-label="Column settings">
        {resolvedColumns.map((column, columnIndex) => {
          const id = columnKey(column, columnIndex);
          const visible = visibleColumnIndexes.includes(columnIndex);
          const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
          return <div className="ui-data-grid-column-menu-item" key={id}>
            <label><input type="checkbox" checked={visible} onChange={event => toggleColumnVisibility(columnIndex, event.target.checked)} />{column.name}</label>
            <button type="button" aria-label={pinned ? `Unpin ${column.name} in column menu` : `Pin ${column.name} in column menu`} onClick={() => togglePin(columnIndex)}>{pinned ? 'Unpin' : 'Pin'}</button>
          </div>;
        })}
      </div>
    </details>}
    <div ref={scroller} className="ui-data-grid-scroll" onScroll={handleScroll} onKeyDown={handleKeyDown} tabIndex={0} aria-label={`Data grid with ${totalRowCount} rows`}>
      {processedRows.length === 0 ? <div className="ui-grid-empty" role="status">No matching rows.{hasMoreRows && <button type="button" onClick={onLoadMore}>Load more rows</button>}</div> : <table className="ui-data-grid">
        <thead><tr>
          <th scope="col" className="ui-data-grid-row-number">#</th>
          {visibleColumnIndexes.map(columnIndex => {
            const column = resolvedColumns[columnIndex]!;
            const id = columnKey(column, columnIndex);
            const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
            const left = pinned ? ROW_NUMBER_WIDTH + visibleColumnIndexes.slice(0, visibleColumnIndexes.indexOf(columnIndex)).filter(index => activeView.pinnedColumns?.some(key => columnMatchesKey(resolvedColumns[index]!, index, key))).reduce((sum, index) => sum + (activeView.columnWidths?.[columnKey(resolvedColumns[index]!, index)] ?? DEFAULT_COLUMN_WIDTH), 0) : undefined;
            const sort = activeView.sorting.find(item => columnMatchesKey(column, columnIndex, item.column));
            const width = activeView.columnWidths?.[id] ?? DEFAULT_COLUMN_WIDTH;
            return <th scope="col" key={id} className={pinned ? 'ui-data-grid-pinned' : undefined} style={{ width, minWidth: width, ...(left === undefined ? {} : { left }) }} onDragOver={event => event.preventDefault()} onDrop={() => { const source = draggedColumnRef.current; if (source !== undefined) reorderColumn(source, columnIndex); draggedColumnRef.current = undefined; }}>
              <div className="ui-data-grid-header-content">
                <button type="button" className="ui-data-grid-drag-handle" draggable aria-label={`Reorder ${column.name}`} onDragStart={() => { draggedColumnRef.current = columnIndex; }} onDragEnd={() => { draggedColumnRef.current = undefined; }}>⠿</button>
                <button type="button" className="ui-data-grid-header-label" onClick={() => sortColumn(columnIndex)} title={`Sort by ${column.name}`}><span>{column.name}</span><span className="ui-data-grid-sort" aria-label={sort === undefined ? 'Not sorted' : sort.descending ? 'Sorted descending' : 'Sorted ascending'}>{sort?.descending ? '▼' : sort ? '▲' : '↕'}</span></button>
                <span className={`ui-data-grid-type-badge ui-data-grid-type-${typeBadgeClass(column)}`}>{typeBadge(column)}</span>
                <button type="button" className={`ui-data-grid-header-action ${pinned ? 'active' : ''}`} aria-label={pinned ? `Unpin ${column.name}` : `Pin ${column.name}`} title={pinned ? 'Unpin column' : 'Pin column'} onClick={() => togglePin(columnIndex)}>📌</button>
                <input className="ui-data-grid-column-filter" aria-label={`Filter ${column.name}`} placeholder="filter…" value={filterValue(activeView, column, columnIndex)} onChange={event => filterColumn(columnIndex, event.target.value)} />
                <button type="button" className="ui-data-grid-group-action" aria-label={activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key)) ? `Ungroup ${column.name}` : `Group by ${column.name}`} title={activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key)) ? 'Remove grouping' : 'Group by column'} onClick={() => { const grouping = activeView.grouping.filter(key => !columnMatchesKey(column, columnIndex, key)); if (grouping.length === activeView.grouping.length) grouping.push(id); updateView({ grouping }); }}>▦</button>
                <span className="ui-data-grid-resizer" role="separator" aria-label={`Resize ${column.name}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); resizeRef.current = { columnId: id, startX: event.clientX, startWidth: width }; }} />
              </div>
            </th>;
          })}
        </tr></thead>
        <tbody>
          {virtualWindow.paddingTop > 0 && <tr className="ui-data-grid-virtual-spacer" aria-hidden="true"><td colSpan={visibleColumnIndexes.length + 1} style={{ height: virtualWindow.paddingTop }} /></tr>}
          {virtualRenderedRows.map(rendered => {
          if (rendered.kind === 'group') {
            const collapsed = collapsedGroups.has(rendered.id);
            return <tr className="ui-data-grid-group-row" data-group-id={rendered.id} key={`group:${rendered.id}`}><td className="ui-data-grid-group-cell" colSpan={visibleColumnIndexes.length + 1}><button type="button" className="ui-data-grid-group-toggle" aria-label={`${collapsed ? 'Expand' : 'Collapse'} group ${rendered.label}`} onClick={() => setCollapsedGroups(previous => { const next = new Set(previous); if (collapsed) next.delete(rendered.id); else next.add(rendered.id); return next; })}><span className="ui-data-grid-group-marker">{collapsed ? '▸' : '▾'}</span></button>{rendered.label}<span className="ui-data-grid-group-count">{rendered.count.toLocaleString()} rows</span></td></tr>;
          }
          const rowSelected = selectedRowIndex === rendered.sourceIndex;
          const rowLabel = rendered.values.map((value, columnIndex) => {
            const column = resolvedColumns[columnIndex];
            const metadata = column === undefined ? undefined : getCellMetadata?.(value, rendered.sourceIndex, columnIndex, column) ?? column;
            return formatDataGridCellValue(value, metadata?.type, metadata);
          }).join(' ');
          const firstVisibleColumn = visibleColumnIndexes[0];
          return <tr key={`${resultSetId}:${rendered.sourceIndex}`} data-row-index={rendered.displayIndex} data-source-index={rendered.sourceIndex} aria-label={rowLabel} className={`${rendered.displayIndex % 2 === 0 ? 'ui-data-grid-row-even' : 'ui-data-grid-row-odd'} ${rowSelected ? 'ui-data-grid-row-selected' : ''}`} onClick={() => onRowSelect?.(rendered.sourceIndex)}>
            <th scope="row" className="ui-data-grid-row-number" onMouseDown={event => selectWholeRow(rendered.displayIndex, event)} onMouseEnter={() => firstVisibleColumn !== undefined && extendSelection(rendered.displayIndex, firstVisibleColumn)}><button type="button" aria-label={`Select row ${rendered.displayIndex + 1}`} onClick={event => { event.stopPropagation(); onRowSelect?.(rendered.sourceIndex); }}>{rendered.displayIndex + 1}</button></th>
            {visibleColumnIndexes.map(columnIndex => {
              const column = resolvedColumns[columnIndex]!;
              const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
              const left = pinned ? ROW_NUMBER_WIDTH + visibleColumnIndexes.slice(0, visibleColumnIndexes.indexOf(columnIndex)).filter(index => activeView.pinnedColumns?.some(key => columnMatchesKey(resolvedColumns[index]!, index, key))).reduce((sum, index) => sum + (activeView.columnWidths?.[columnKey(resolvedColumns[index]!, index)] ?? DEFAULT_COLUMN_WIDTH), 0) : undefined;
              const columnPosition = visibleColumnIndexes.indexOf(columnIndex);
              const selected = range !== undefined && columnRange !== undefined && rendered.displayIndex >= range.minRow && rendered.displayIndex <= range.maxRow && columnPosition >= columnRange.minColumn && columnPosition <= columnRange.maxColumn;
              const value = rendered.values[columnIndex];
              const metadata = getCellMetadata?.(value, rendered.sourceIndex, columnIndex, column) ?? column;
              const displayValue = formatDataGridCellValue(value, metadata.type, metadata);
              return <td key={`${rendered.sourceIndex}:${columnKey(column, columnIndex)}`} className={[pinned ? 'ui-data-grid-pinned' : '', selected ? 'ui-data-grid-cell-selected' : '', `ui-data-grid-value-${valueClass(value, metadata)}`, isDataGridNumericColumn(metadata) ? 'ui-data-grid-cell-numeric' : ''].filter(Boolean).join(' ')} style={left === undefined ? undefined : { left }} onMouseDown={event => selectCell(rendered.displayIndex, columnIndex, event)} onMouseEnter={() => extendSelection(rendered.displayIndex, columnIndex)} onContextMenu={event => { event.preventDefault(); const context = { rowIndex: rendered.sourceIndex, columnIndex, clientX: event.clientX, clientY: event.clientY }; onContextMenu?.(context); if (showContextMenu) setContextMenu(context); }} title={displayValue}>{displayValue}</td>;
            })}
          </tr>;
        })}
          {virtualWindow.paddingBottom > 0 && <tr className="ui-data-grid-virtual-spacer" aria-hidden="true"><td colSpan={visibleColumnIndexes.length + 1} style={{ height: virtualWindow.paddingBottom }} /></tr>}
        </tbody>
      </table>}
    </div>
    {showContextMenu && contextMenu && contextRow && contextColumn && <div ref={contextMenuElementRef} className="ui-data-grid-context-menu" role="menu" aria-label={`Actions for row ${contextMenu.rowIndex + 1}`} style={{ left: contextMenuPosition.left, top: contextMenuPosition.top }} onClick={event => event.stopPropagation()}>
      <strong>{contextColumn.name}</strong>
      <button type="button" role="menuitem" onClick={() => copyContextValue(contextMenu, contextRow)}>Copy value</button>
      <button type="button" role="menuitem" onClick={() => copyContextRow(contextRow)}>Copy row</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('tsv')}>Copy row as TSV</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('markdown')}>Copy row as Markdown</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('json')}>Copy row as JSON</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('sql')}>Copy SQL INSERT</button>
      <hr />
      <button type="button" role="menuitem" onClick={() => filterContextValue(contextMenu, contextRow)}>Filter by this value</button>
      <button type="button" role="menuitem" onClick={() => clearContextFilter(contextMenu.columnIndex)}>Clear Filter</button>
      <button type="button" role="menuitem" onClick={() => sortContextValue(contextMenu.columnIndex, false)}>Sort ascending</button>
      <button type="button" role="menuitem" onClick={() => sortContextValue(contextMenu.columnIndex, true)}>Sort descending</button>
      <button type="button" role="menuitem" onClick={() => toggleContextGrouping(contextMenu.columnIndex)}>{activeView.grouping.some(key => columnMatchesKey(contextColumn, contextMenu.columnIndex, key)) ? 'Ungroup This Column' : 'Group by This Column'}</button>
      <button type="button" role="menuitem" onClick={() => hideContextColumn(contextMenu.columnIndex)}>Hide Column</button>
      <hr />
      <button type="button" role="menuitem" onClick={() => selectContextRow(contextMenu)}>View full row</button>
      {onViewCell && <button type="button" role="menuitem" onClick={() => viewContextCell(contextMenu)}>View Cell Value</button>}
      {onOpenResultFormatting && <button type="button" role="menuitem" onClick={() => { onOpenResultFormatting(); setContextMenu(undefined); }}>Result Formatting…</button>}
      {onEditRow && <button type="button" role="menuitem" onClick={() => { onEditRow(contextMenu); setContextMenu(undefined); }}>Edit row…</button>}
    </div>}
  </div>;
}

/**
 * Canonical result-grid name for new consumers. DataGrid remains exported as a
 * compatibility name because the first shared UI slices already consume it.
 */
export function ResultGrid(props: DataGridProps): ReactNode {
  return <DataGrid {...props} />;
}
