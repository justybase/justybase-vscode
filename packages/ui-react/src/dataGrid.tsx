import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, UIEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Range, Virtualizer } from '@tanstack/react-virtual';
import type { UiResultAggregationFunction, UiResultColumnAggregation, UiResultColumnFilterDefinition, UiResultViewState } from '@justybase/ui-core';
import { editValuesEqual, gridSelectionColumnRange, gridSelectionRangeColumnRange, normalizeGridSelection, parseTypedEditValue, resolveGridCellEditKind, toEditableCellText } from '@justybase/ui-core';
import type { GridCellEditKind } from '@justybase/ui-core';
import { AGGREGATION_FUNCTION_LABELS, AGGREGATION_LABELS, calculateDataGridAggregations } from './dataGridAggregation';
import type { DataGridAggregationCell } from './dataGridAggregation';
import {
  formatDataGridCellValue,
  formatDataGridCellValueForSql,
  formatDataGridIdentifierForSql,
  inferDataGridColumnMetadata,
  isDataGridBinaryType,
  isDataGridNumericColumn,
  isDataGridTemporalColumn,
  matchesDataGridFilterValue,
} from './resultGridFormatting';
import type { DataGridCellMetadata, DataGridFormattingOptions } from './resultGridFormatting';
import type { DataGridClipboardFormat } from './dataGridClipboard';
import type { DataGridColumn, DataGridCopyPayload, DataGridSelection, DataGridSelectionRange } from './dataGridTypes';
import { DataGridRow } from './dataGridRow';
import type { DataGridCellMetadataResolver, DataGridColumnLayout } from './dataGridRow';
import {
  DATA_GRID_COLUMN_HEADER_HEIGHT,
  DATA_GRID_COLUMN_WINDOW_THRESHOLD,
  DATA_GRID_COMPACT_COLUMN_HEADER_HEIGHT,
  DATA_GRID_DEFAULT_VIEWPORT_HEIGHT,
  DATA_GRID_DEFAULT_VIEWPORT_WIDTH,
  DATA_GRID_ROW_HEIGHT,
  DATA_GRID_ROW_NUMBER_WIDTH,
  DATA_GRID_VIRTUAL_OVERSCAN_ROWS,
  calculateDataGridColumnWindow,
  calculateDataGridVirtualWindow,
  resolveDataGridNavigationTarget,
  resolveDataGridScrollTop,
} from './dataGridVirtualization';
import { MenuIcon } from './menuIcons';

export { formatDataGridCellValue } from './resultGridFormatting';
export type { DataGridColumn, DataGridCopyPayload, DataGridSelection, DataGridSelectionRange } from './dataGridTypes';
export { calculateDataGridColumnWindow, calculateDataGridVirtualWindow, resolveDataGridNavigationTarget, resolveDataGridScrollTop } from './dataGridVirtualization';
export type { DataGridColumnWindow, DataGridNavigationRequest, DataGridNavigationTarget, DataGridVirtualWindow } from './dataGridVirtualization';

export type DataGridViewState = Pick<UiResultViewState, 'globalFilter' | 'columnFilters' | 'columnFilterDefinitions' | 'sorting' | 'grouping'> &
  Partial<Pick<UiResultViewState, 'columnVisibility' | 'columnOrder' | 'pinnedColumns' | 'columnWidths' | 'columnAggregations'>>;

export interface GridScrollPosition {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly top: number;
  readonly left: number;
  readonly anchorRow?: number;
  /** Row height used by the virtualizer when this position was measured. */
  readonly rowHeight?: number;
}

export interface DataGridCellContext {
  /** Index into the supplied raw rows, not the filtered or sorted display list. */
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly clientX: number;
  readonly clientY: number;
}

/** A validated inline edit applied to one raw result cell. */
export interface DataGridCellEdit {
  /** Index into the supplied raw rows, not the filtered or sorted display list. */
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export interface DataGridColumnFilterRequest {
  readonly columnIndex: number;
  readonly column: DataGridColumn;
  readonly anchor: DOMRect;
}

/** Catalog actions mirrored from the legacy column context menu. */
export type DataGridColumnAction =
  | 'copyName'
  | 'copyQualifiedName'
  | 'addToSelect'
  | 'commentOnColumn'
  | 'findReferences'
  | 'toggleFavorite';

interface CellEditorLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface ActiveCellEditor {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly columnName: string;
  readonly columnType?: string;
  readonly oldValue: unknown;
  readonly kind: GridCellEditKind;
  readonly initialText: string;
  readonly initialNull: boolean;
  readonly layout: CellEditorLayout;
}

interface DataGridInlineEditorProps extends ActiveCellEditor {
  readonly onCommit: (value: unknown) => void;
  readonly onCancel: () => void;
}

/**
 * One-cell editor rendered inside the scroll container, so it moves with the
 * virtual row instead of floating over unrelated content. Validation and value
 * parsing come from `@justybase/ui-core`, matching the legacy DOM grid.
 */
function DataGridInlineEditor({
  columnName,
  columnType,
  oldValue,
  kind,
  initialText,
  initialNull,
  layout,
  onCommit,
  onCancel,
}: DataGridInlineEditorProps): ReactNode {
  const [text, setText] = useState(initialText);
  const [nullValue, setNullValue] = useState(initialNull);
  const [error, setError] = useState<string | undefined>();
  const finishedRef = useRef(false);

  const finish = (value: unknown): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (editValuesEqual(oldValue, value)) onCancel();
    else onCommit(value);
  };

  const commit = (): void => {
    if (finishedRef.current) return;
    const parsed = parseTypedEditValue(
      text,
      columnType,
      kind === 'boolean' ? text === 'NULL' : nullValue,
    );
    if (!parsed.valid) {
      setError(parsed.message);
      return;
    }
    finish(parsed.value);
  };

  const cancel = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCancel();
  };

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== 'Enter') return;
    if (kind === 'textarea' && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    commit();
  };

  const editorProps = {
    className: 'ui-data-grid-cell-editor-input',
    'aria-label': `Edit ${columnName}`,
    autoFocus: true,
    disabled: kind !== 'boolean' && nullValue,
    onKeyDown: handleKeyDown,
    onBlur: commit,
  };
  const editor = kind === 'boolean'
    ? <select
      {...editorProps}
      value={text}
      onChange={event => { setText(event.target.value); setError(undefined); }}
    >
      <option value="NULL">NULL</option>
      <option value="true">TRUE</option>
      <option value="false">FALSE</option>
    </select>
    : kind === 'textarea'
      ? <textarea
        {...editorProps}
        rows={3}
        value={text}
        onChange={event => { setText(event.target.value); setError(undefined); }}
      />
      : <input
        {...editorProps}
        type={kind === 'date' ? 'date' : 'text'}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        value={text}
        onFocus={event => event.currentTarget.select()}
        onChange={event => { setText(event.target.value); setError(undefined); }}
      />;

  return <div
    className={`ui-data-grid-cell-editor ui-data-grid-cell-editor-${kind}`}
    style={{ left: layout.left, top: layout.top, width: layout.width, minHeight: layout.height }}
    onMouseDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
  >
    {kind !== 'boolean' && <button
      type="button"
      className="ui-data-grid-cell-editor-null"
      aria-pressed={nullValue}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { setNullValue(value => !value); setError(undefined); }}
    >{nullValue ? 'Use value' : 'Set NULL'}</button>}
    {editor}
    {error !== undefined && <span className="ui-data-grid-cell-editor-error" role="alert">{error}</span>}
  </div>;
}

interface ScrollRestorationState {
  readonly scope: string;
  readonly top: number;
  readonly left: number;
}

interface PendingScrollRestoration {
  readonly scope: string;
  readonly top: number;
  readonly left: number;
}

export interface DataGridHandle {
  /** Scrolls the grid horizontally to the requested raw column index. */
  scrollToColumn(columnIndex: number): void;
}

export interface DataGridProps {
  readonly sourceId?: string;
  readonly resultSetId: string;
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  /** Provides value metadata when a column's cells have heterogeneous source types. */
  readonly getCellMetadata?: (value: unknown, rowIndex: number, columnIndex: number, column: DataGridColumn) => DataGridCellMetadata;
  /** Host formatting preferences (grouping, decimal scale and separators) per column. */
  readonly getColumnFormatting?: (column: DataGridColumn, columnIndex: number) => DataGridFormattingOptions | undefined;
  readonly totalRowCount?: number;
  readonly scroll?: GridScrollPosition;
  readonly onScroll?: (position: GridScrollPosition) => void;
  /** Requests the next adapter-owned page when the rendered rows near the end. */
  readonly onLoadMore?: () => void | Promise<void>;
  /** Index into the supplied raw rows, even when displayed rows are filtered, sorted, or grouped. */
  readonly onRowSelect?: (rowIndex: number) => void;
  /** Opens the host-owned guarded row editor for the context-menu row. */
  readonly onEditRow?: (context: DataGridCellContext) => void;
  /** Enables double-click inline editing of typed cells. */
  readonly editMode?: boolean;
  /** Receives a validated edit after the inline editor commits. */
  readonly onCellEdit?: (edit: DataGridCellEdit) => void;
  /**
   * Receives a SQL-ready cell representation on a non-editing cell
   * double-click, and the SQL-ready column name when a column header is
   * double-clicked.
   */
  readonly onInsertCellContent?: (payload: { readonly text: string; readonly dataType?: string; readonly sqlText: string }) => void;
  readonly selectedRowIndex?: number;
  readonly view?: DataGridViewState;
  readonly onViewChange?: (patch: Partial<UiResultViewState>) => void;
  /** Server-backed grids keep filtering/sorting in the adapter but share the same renderer. */
  readonly clientProcessing?: boolean;
  /**
   * Exact group counts supplied by the host (keyed by the JSON string of the
   * formatted value path). Used for disk-backed results where the webview only
   * holds a window of rows; local counts are used for keys that are absent.
   */
  readonly groupCounts?: ReadonlyMap<string, number>;
  /** Groups known to the host but not present in the loaded row window. */
  readonly extraGroups?: readonly DataGridExtraGroup[];
  /** True when the host could not enumerate every group (counts are lower bounds). */
  readonly groupCountsPartial?: boolean;
  readonly onSelectionChange?: (selection: DataGridSelection | undefined) => void;
  readonly onContextMenu?: (context: DataGridCellContext) => void;
  readonly onCopySelection?: (payload: DataGridCopyPayload, format?: DataGridClipboardFormat) => void;
  /** Exports the current selection (or context row) through the host-owned download. */
  readonly onExportSelection?: (payload: DataGridCopyPayload, format: 'csv' | 'json') => void;
  /** Optional host-owned writer used when no rich copy callback is supplied. */
  readonly clipboardWriter?: (payload: DataGridCopyPayload, format?: DataGridClipboardFormat) => void | Promise<void>;
  /** Opens the host-specific large-value viewer for a context-menu cell. */
  readonly onViewCell?: (context: DataGridCellContext) => void;
  /** Opens the host-specific full-row detail view for a context-menu row. */
  readonly onViewRow?: (context: DataGridCellContext) => void;
  /** Marks a row for deletion in edit mode (or restores it). */
  readonly onDeleteRow?: (rowIndex: number) => void;
  /** Returns true when the raw row is staged for deletion. */
  readonly isRowDeleted?: (rowIndex: number) => boolean;
  /** Opens the host-specific result formatting surface. */
  readonly onOpenResultFormatting?: () => void;
  /** Enables the shared copy/filter/sort/row-detail context menu. */
  readonly showContextMenu?: boolean;
  /** Shows the shared column visibility/order/pinning menu. */
  readonly showColumnMenu?: boolean;
  /** Allows analysis grids to reuse the renderer without exposing a second grouping surface. */
  readonly showGroupingPanel?: boolean;
  /** Opens the host-owned Excel-like filter surface for a column. */
  readonly onOpenColumnFilter?: (request: DataGridColumnFilterRequest) => void;
  /** Runs a catalog-aware column action from the context menu. */
  readonly onColumnAction?: (context: DataGridCellContext, action: DataGridColumnAction) => void;
  /** Enables catalog actions that need a single bound table (edit source). */
  readonly catalogBound?: boolean;
  /** Switches to the column profile surface for the context column. */
  readonly onProfileColumn?: (context: DataGridCellContext) => void;
  /** Keeps the legacy inline text field for hosts without a filter surface. */
  readonly showInlineColumnFilters?: boolean;
  /** Marks the grid as loading without unmounting virtualized rows. */
  readonly busy?: boolean;
}

export interface DataGridColumnMenuProps {
  readonly columns: readonly DataGridColumn[];
  readonly view?: DataGridViewState;
  readonly onViewChange: (patch: Partial<UiResultViewState>) => void;
}

export interface DataGridExtraGroup {
  /** Formatted value at each grouping level, top-down. */
  readonly path: readonly string[];
  readonly count: number;
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
  /** The host supplied only a partial group enumeration; show the count as a lower bound. */
  readonly partial?: boolean;
  /** The group has rows in the result but none in the loaded window. */
  readonly unloaded?: boolean;
  readonly ancestorIds: readonly string[];
  readonly level: number;
  /**
   * 1-based ordinal of the group's first result row. The band keeps the
   * row-number gutter visible, so this number ties the band to the data it
   * contains instead of leaving the gutter empty.
   */
  readonly rowNumber: number;
}

interface RenderedDataRow extends IndexedRow {
  readonly kind: 'data';
  readonly displayIndex: number;
  readonly groupId?: string;
  readonly ancestorIds: readonly string[];
}

type RenderedRow = RenderedGroup | RenderedDataRow;

const ROW_NUMBER_WIDTH = DATA_GRID_ROW_NUMBER_WIDTH;
const DEFAULT_COLUMN_WIDTH = 144;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 520;
const MAX_EMPTY_PAGE_REQUESTS = 3;
const ROW_HEIGHT = DATA_GRID_ROW_HEIGHT;
// The shared grid header contains the column label and inline filter rows.
// Virtual row math must start below this sticky header, otherwise the first
// rendered row after a programmatic scroll can be covered by the header.
const COLUMN_HEADER_HEIGHT = DATA_GRID_COLUMN_HEADER_HEIGHT;
const COMPACT_COLUMN_HEADER_HEIGHT = DATA_GRID_COMPACT_COLUMN_HEADER_HEIGHT;
const DEFAULT_VIEWPORT_HEIGHT = DATA_GRID_DEFAULT_VIEWPORT_HEIGHT;
const VIRTUAL_OVERSCAN_ROWS = DATA_GRID_VIRTUAL_OVERSCAN_ROWS;
const EMPTY_SELECTION_RANGES: readonly DataGridSelectionRange[] = Object.freeze([]);
const COLUMN_WINDOW_THRESHOLD = DATA_GRID_COLUMN_WINDOW_THRESHOLD;
// Wait long enough to tell a double-click from two separate sort clicks, but
// keep a single click feeling responsive.
const HEADER_SINGLE_CLICK_DELAY_MS = 250;

/**
 * The shared grid contract is a fixed body-row height. Data, group and
 * row-detail rows share it, so the virtualizer never measures elements and
 * stored scroll anchors stay exact.
 */
function estimateRowHeight(): number {
  return ROW_HEIGHT;
}

function DataGridFilterIcon(): ReactNode {
  return <MenuIcon name="filter" />;
}

/**
 * Serialises the grid-relevant view fields into a stable key. Normalising
 * first keeps host-owned scroll coordinates out of the signature while still
 * covering every future field added to the shared grid view.
 */
function viewSignature(view: DataGridViewState): string {
  return JSON.stringify(normaliseView(view));
}

/**
 * Moves one grouping key to an insertion point in the grouping order. The
 * insertion point is measured before removing the source item, which keeps
 * drag-and-drop predictable in both directions.
 */
export function reorderDataGridGrouping(
  grouping: readonly string[],
  sourceIndex: number,
  insertionIndex: number,
): readonly string[] {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= grouping.length) return grouping;
  if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > grouping.length) return grouping;
  const next = [...grouping];
  const moved = next.splice(sourceIndex, 1)[0];
  if (moved === undefined) return grouping;
  const targetIndex = insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex;
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, moved);
  return next;
}

function normaliseView(view: DataGridViewState | undefined): DataGridViewState {
  return {
    globalFilter: view?.globalFilter ?? '',
    columnFilters: view?.columnFilters ?? {},
    columnFilterDefinitions: view?.columnFilterDefinitions,
    sorting: view?.sorting ?? [],
    grouping: view?.grouping ?? [],
    columnVisibility: view?.columnVisibility,
    columnOrder: view?.columnOrder,
    pinnedColumns: view?.pinnedColumns,
    columnWidths: view?.columnWidths,
    columnAggregations: view?.columnAggregations,
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
  // Numeric keys were used by the first web grid implementation. Keep them
  // readable here so an old persisted view cannot make a column reappear when
  // the renderer switches to semantic column ids.
  return visibility[columnKey(column, index)] !== false
    && visibility[column.name] !== false
    && visibility[String(index)] !== false;
}

function columnWidthFor(
  column: DataGridColumn,
  index: number,
  view: DataGridViewState,
  measuredWidths: Readonly<Record<string, number>> = {},
  headerActionCount = 4,
): number {
  const widths = view.columnWidths;
  // Prefer the semantic id written by the shared grid, then accept both
  // historical name and positional keys from saved web/desktop views.
  const configuredWidth = widths?.[columnKey(column, index)]
    ?? widths?.[column.name]
    ?? widths?.[String(index)]
    ?? DEFAULT_COLUMN_WIDTH;
  const measuredWidth = measuredWidths[columnKey(column, index)];
  // The DOM measurement is the real header minimum: once it exists, using the
  // heuristic too would leave an empty strip after the last header action.
  if (measuredWidth !== undefined) return Math.max(configuredWidth, measuredWidth);
  const estimatedTextWidth = Math.max(40, column.name.length * 7.25);
  const estimatedTypeWidth = typeBadge(column).length * 6 + 8;
  const estimatedHeaderWidth = Math.ceil(14 + estimatedTextWidth + 12 + estimatedTypeWidth + headerActionCount * 20 + (headerActionCount + 1) * 3);
  return Math.max(configuredWidth, estimatedHeaderWidth);
}

function measuredHeaderMinimumWidth(column: DataGridColumn, cell: HTMLTableCellElement, inlineFilter: boolean): number {
  const content = cell.querySelector<HTMLElement>('.ui-data-grid-header-content');
  const labelText = content?.querySelector<HTMLElement>('.ui-data-grid-header-label > span:first-child');
  const sort = content?.querySelector<HTMLElement>('.ui-data-grid-sort');
  const type = content?.querySelector<HTMLElement>('.ui-data-grid-type-badge');
  const actions = content
    ? [...content.querySelectorAll<HTMLElement>('.ui-data-grid-drag-handle, .ui-data-grid-header-action, .ui-data-grid-column-action, .ui-data-grid-group-action, .ui-data-grid-filter-action, .ui-data-grid-aggregation-action')]
    : [];
  const textWidth = Math.max(
    labelText?.scrollWidth ?? 0,
    labelText?.getBoundingClientRect().width ?? 0,
    40,
  );
  const sortWidth = Math.max(sort?.scrollWidth ?? 0, sort?.getBoundingClientRect().width ?? 0, 12);
  const typeWidth = Math.max(type?.scrollWidth ?? 0, type?.getBoundingClientRect().width ?? 0, typeBadge(column).length * 6 + 8);
  const actionWidth = actions.reduce((total, action) => total + Math.max(action.getBoundingClientRect().width, action.scrollWidth, 17), 0);
  // Six grid items (drag, label, type, filter/summary, pin, grouping) with 2px gaps.
  const gapWidth = 10;
  const filterMinimum = inlineFilter ? 96 : 0;
  // The th contributes 10px horizontal padding and 2px borders; the resizer is
  // absolute and must not reserve another action slot.
  const required = Math.ceil(12 + textWidth + sortWidth + typeWidth + actionWidth + gapWidth);
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, filterMinimum, required));
}

function orderAllColumns(columns: readonly DataGridColumn[], view: DataGridViewState): readonly number[] {
  const defaultOrder = columns.map((_column, index) => index);
  const requested = view.columnOrder ?? [];
  const ordered: number[] = [];
  const orderedSet = new Set<number>();
  // Resolve every persisted key once instead of scanning the column list for
  // each requested or default entry (O(n²) on wide result sets).
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]!;
    for (const key of [columnKey(column, index), column.name, String(index)]) {
      if (!indexByKey.has(key)) indexByKey.set(key, index);
    }
  }
  for (const key of requested) {
    const index = indexByKey.get(key);
    if (index !== undefined && !orderedSet.has(index)) {
      ordered.push(index);
      orderedSet.add(index);
    }
  }
  for (const index of defaultOrder) {
    if (orderedSet.has(index)) continue;
    ordered.push(index);
    orderedSet.add(index);
  }
  const pinned = ordered.filter(index => view.pinnedColumns?.some(key => columnMatchesKey(columns[index]!, index, key)) ?? false);
  const pinnedSet = new Set(pinned);
  return [...pinned, ...ordered.filter(index => !pinnedSet.has(index))];
}

function orderColumns(columns: readonly DataGridColumn[], view: DataGridViewState): readonly number[] {
  return orderAllColumns(columns, view).filter(index => visibilityFor(columns[index]!, index, view));
}

/** Returns every column index in display order, including hidden columns. */
export function resolveDataGridColumnOrder(
  columns: readonly DataGridColumn[],
  view: DataGridViewState = normaliseView(undefined),
): readonly number[] {
  return orderAllColumns(columns, normaliseView(view));
}

function canonicalColumnKeys(columns: readonly DataGridColumn[], view: DataGridViewState): string[] {
  const keys = columns.map((column, index) => columnKey(column, index));
  const order: string[] = [];
  for (const key of view.columnOrder ?? keys) {
    const index = resolveColumnIndex(columns, key);
    if (index >= 0 && !order.includes(keys[index]!)) order.push(keys[index]!);
  }
  for (const key of keys) {
    if (!order.includes(key)) order.push(key);
  }
  return order;
}

/** Moves a column relative to another one and returns the persisted key order. */
export function moveDataGridColumnOrder(
  columns: readonly DataGridColumn[],
  view: DataGridViewState | undefined,
  sourceIndex: number,
  targetIndex: number,
  after: boolean,
): string[] | undefined {
  const source = columns[sourceIndex];
  const target = columns[targetIndex];
  if (!source || !target || sourceIndex === targetIndex) return undefined;
  const sourceKey = columnKey(source, sourceIndex);
  const targetKey = columnKey(target, targetIndex);
  const order = canonicalColumnKeys(columns, normaliseView(view)).filter(key => key !== sourceKey);
  const targetPosition = order.indexOf(targetKey);
  if (targetPosition < 0) return undefined;
  order.splice(targetPosition + (after ? 1 : 0), 0, sourceKey);
  return order;
}

function filterValue(view: DataGridViewState, column: DataGridColumn, index: number): string {
  const filters = view.columnFilters;
  return filters[columnKey(column, index)] ?? filters[column.name] ?? '';
}

function filterDefinition(view: DataGridViewState, column: DataGridColumn, index: number): UiResultColumnFilterDefinition | undefined {
  const definitions = view.columnFilterDefinitions;
  if (!definitions) return undefined;
  return definitions[columnKey(column, index)] ?? definitions[column.name] ?? definitions[String(index)];
}

function columnAggregations(view: DataGridViewState, column: DataGridColumn, index: number): readonly UiResultColumnAggregation[] {
  const definitions = view.columnAggregations;
  if (!definitions) return [];
  return definitions[columnKey(column, index)] ?? definitions[column.name] ?? definitions[String(index)] ?? [];
}

function filterValueKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
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

/** Compact visibility/pinning control used by both the standalone grid and result toolbar. */
export function DataGridColumnMenu({ columns, view, onViewChange }: DataGridColumnMenuProps): ReactNode {
  const activeView = normaliseView(view);
  const visibleColumnIndexes = resolveDataGridColumnIndexes(columns, activeView);
  const [draggedColumn, setDraggedColumn] = useState<number | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<{ readonly columnIndex: number; readonly after: boolean } | undefined>(undefined);
  const [search, setSearch] = useState('');
  const filteredColumns = columns
    .map((column, columnIndex) => ({ column, columnIndex }))
    .filter(({ column }) => column.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  function setAllVisibility(visible: boolean): void {
    const visibility = { ...(activeView.columnVisibility ?? {}) };
    columns.forEach((column, columnIndex) => {
      const id = columnKey(column, columnIndex);
      if (visible) delete visibility[id];
      else visibility[id] = false;
    });
    onViewChange({ columnVisibility: visibility });
  }

  function toggleColumnVisibility(columnIndex: number, visible: boolean): void {
    const column = columns[columnIndex];
    if (!column) return;
    const id = columnKey(column, columnIndex);
    const visibility = { ...(activeView.columnVisibility ?? {}) };
    if (visible) delete visibility[id];
    else visibility[id] = false;
    onViewChange({ columnVisibility: visibility });
  }

  function togglePin(columnIndex: number): void {
    const column = columns[columnIndex];
    if (!column) return;
    const id = columnKey(column, columnIndex);
    const pinned = [...(activeView.pinnedColumns ?? [])];
    const index = pinned.findIndex(key => columnMatchesKey(column, columnIndex, key));
    if (index >= 0) pinned.splice(index, 1);
    else pinned.push(id);
    onViewChange({ pinnedColumns: pinned });
  }

  function moveColumn(sourceIndex: number, targetIndex: number, after: boolean): void {
    const order = moveDataGridColumnOrder(columns, activeView, sourceIndex, targetIndex, after);
    if (!order) return;
    onViewChange({ columnOrder: order });
  }

  return <details className="ui-data-grid-column-menu">
    <summary><span className="ui-data-grid-column-menu-title">Columns</span><span className="ui-data-grid-column-menu-count">{visibleColumnIndexes.length}/{columns.length}</span></summary>
    <div className="ui-data-grid-column-menu-panel" role="menu" aria-label="Column settings">
      <div className="ui-data-grid-column-menu-heading"><strong>Visible columns</strong><span>{visibleColumnIndexes.length} of {columns.length}</span></div>
      <div className="ui-data-grid-column-menu-tools">
        <input aria-label="Filter columns" placeholder="Filter columns…" value={search} onChange={event => setSearch(event.target.value)} />
        <button type="button" onClick={() => setAllVisibility(true)}>Show all</button>
        <button type="button" onClick={() => setAllVisibility(false)}>Hide all</button>
      </div>
      {filteredColumns.map(({ column, columnIndex }) => {
        const id = columnKey(column, columnIndex);
        const visible = visibleColumnIndexes.includes(columnIndex);
        const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
        const dragging = draggedColumn === columnIndex;
        const dropBefore = dropTarget?.columnIndex === columnIndex && !dropTarget.after;
        const dropAfter = dropTarget?.columnIndex === columnIndex && dropTarget.after;
        return <div
          className={[
            'ui-data-grid-column-menu-item',
            dragging ? 'ui-data-grid-column-menu-item-dragging' : '',
            dropBefore ? 'ui-data-grid-column-menu-item-drop-before' : '',
            dropAfter ? 'ui-data-grid-column-menu-item-drop-after' : '',
          ].filter(Boolean).join(' ')}
          key={`${columnIndex}:${id}`}
          onDragOver={event => {
            if (draggedColumn === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            const rect = event.currentTarget.getBoundingClientRect();
            setDropTarget({ columnIndex, after: event.clientY > rect.top + rect.height / 2 });
          }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
            const raw = event.dataTransfer.getData('application/x-justybase-column-menu');
            const source = raw === '' ? draggedColumn : Number(raw);
            if (source !== undefined && Number.isInteger(source)) {
              moveColumn(source, columnIndex, dropTarget?.columnIndex === columnIndex ? dropTarget.after : false);
            }
            setDraggedColumn(undefined);
            setDropTarget(undefined);
          }}
        >
          <button
            type="button"
            className="ui-data-grid-column-menu-drag"
            draggable
            aria-label={`Reorder ${column.name} in column list`}
            title="Drag to reorder column"
            onDragStart={event => {
              setDraggedColumn(columnIndex);
              setDropTarget(undefined);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-justybase-column-menu', String(columnIndex));
              event.dataTransfer.setData('text/plain', String(columnIndex));
            }}
            onDragEnd={() => {
              setDraggedColumn(undefined);
              setDropTarget(undefined);
            }}
          ><MenuIcon name="rows" /></button>
          <label title={column.name}><input type="checkbox" checked={visible} onChange={event => toggleColumnVisibility(columnIndex, event.target.checked)} /><span className="ui-data-grid-column-menu-name">{column.name}</span></label>
          <button type="button" className={`ui-data-grid-column-menu-pin${pinned ? ' active' : ''}`} aria-label={pinned ? `Unpin ${column.name} in column menu` : `Pin ${column.name} in column menu`} title={pinned ? 'Unpin column' : 'Pin column'} onClick={() => togglePin(columnIndex)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m14.4 3.2 6.4 6.4-2.2 2.2-1.8-1.8-4.2 4.2 1.8 1.8-2.2 2.2-6.4-6.4L8 9.6 6.2 7.8l2.2-2.2L10.2 7l4.2-4.2Z" /><path d="m11.8 13.8-7.2 7.2M4.6 21H3v-1.6" /></svg></button>
        </div>;
      })}
    </div>
  </details>;
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

type CellMetadataResolver = DataGridCellMetadataResolver;

function matchesFilterCondition(
  value: unknown,
  metadata: DataGridCellMetadata,
  condition: Pick<UiResultColumnFilterDefinition, 'operator' | 'value' | 'value2' | 'values'>,
): boolean {
  switch (condition.operator) {
    case 'isNull': return value === null || value === undefined;
    case 'isNotNull': return value !== null && value !== undefined;
    case 'isEmpty': return value === null || value === undefined || cellText(value, metadata) === '';
    case 'isNotEmpty': return value !== null && value !== undefined && cellText(value, metadata) !== '';
    case 'in': return condition.values?.some(candidate => filterValueKey(candidate) === filterValueKey(value)) ?? false;
    default: break;
  }
  const left = cellText(value, metadata).toLocaleLowerCase();
  const right = condition.value.toLocaleLowerCase();
  switch (condition.operator) {
    case 'contains': return left.includes(right);
    case 'notContains': return value === null || value === undefined || !left.includes(right);
    case 'equals': return left === right;
    case 'notEquals': return value === null || value === undefined || left !== right;
    case 'startsWith': return left.startsWith(right);
    case 'endsWith': return left.endsWith(right);
    case 'like': return left === right;
    case 'greaterThan': return compareValues(value, condition.value, metadata) > 0;
    case 'greaterThanOrEqual': return compareValues(value, condition.value, metadata) >= 0;
    case 'lessThan': return compareValues(value, condition.value, metadata) < 0;
    case 'lessThanOrEqual': return compareValues(value, condition.value, metadata) <= 0;
    case 'between': return compareValues(value, condition.value, metadata) >= 0
      && compareValues(value, condition.value2 ?? '', metadata) <= 0;
    default: return true;
  }
}

function matchesFilterDefinition(
  value: unknown,
  metadata: DataGridCellMetadata,
  definition: UiResultColumnFilterDefinition,
): boolean {
  const conditions = definition.conditions;
  if (conditions === undefined || conditions.length === 0) return matchesFilterCondition(value, metadata, definition);
  const matches = conditions.map(condition => matchesFilterCondition(value, metadata, condition));
  return definition.logic === 'or' ? matches.some(Boolean) : matches.every(Boolean);
}

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
    const definition = filterDefinition(view, column, columnIndex);
    if (definition) return matchesFilterDefinition(values[columnIndex], metadata, definition);
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

/** Shared filtering/sorting semantics used by the Web/VS Code shells and tests. */
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

function primarySelectionRange(selection: DataGridSelection): DataGridSelectionRange {
  return {
    minRow: Math.min(selection.anchorRow, selection.focusRow),
    maxRow: Math.max(selection.anchorRow, selection.focusRow),
    minColumn: Math.min(selection.anchorColumn, selection.focusColumn),
    maxColumn: Math.max(selection.anchorColumn, selection.focusColumn),
  };
}

/** The active rectangle followed by every discontiguous Ctrl/Cmd rectangle. */
function selectionRanges(selection: DataGridSelection | undefined): readonly DataGridSelectionRange[] {
  if (!selection) return [];
  return [primarySelectionRange(selection), ...(selection.additionalRanges ?? [])];
}

function rangeContainsCell(range: DataGridSelectionRange, row: number, column: number): boolean {
  return row >= range.minRow && row <= range.maxRow && column >= range.minColumn && column <= range.maxColumn;
}

/** Splits a rectangle around one cell so the remaining cells stay selectable. */
function splitSelectionRange(range: DataGridSelectionRange, row: number, column: number): readonly DataGridSelectionRange[] {
  const pieces: DataGridSelectionRange[] = [];
  if (row > range.minRow) pieces.push({ ...range, maxRow: row - 1 });
  if (row < range.maxRow) pieces.push({ ...range, minRow: row + 1 });
  if (column > range.minColumn) {
    pieces.push({ minRow: row, maxRow: row, minColumn: range.minColumn, maxColumn: column - 1 });
  }
  if (column < range.maxColumn) {
    pieces.push({ minRow: row, maxRow: row, minColumn: column + 1, maxColumn: range.maxColumn });
  }
  return pieces;
}

function selectionFromRanges(ranges: readonly DataGridSelectionRange[]): DataGridSelection | undefined {
  if (ranges.length === 0) return undefined;
  const [primary, ...additional] = ranges;
  return {
    anchorRow: primary!.minRow,
    anchorColumn: primary!.minColumn,
    focusRow: primary!.maxRow,
    focusColumn: primary!.maxColumn,
    ...(additional.length === 0 ? {} : { additionalRanges: additional }),
  };
}

/** Excel-style Ctrl/Cmd+click: add a cell, or remove it from the current ranges. */
function toggleSelectionCell(
  selection: DataGridSelection | undefined,
  row: number,
  column: number,
): DataGridSelection | undefined {
  const ranges = selectionRanges(selection);
  const containing = ranges.findIndex(range => rangeContainsCell(range, row, column));
  if (containing < 0) {
    return selectionFromRanges([
      { minRow: row, maxRow: row, minColumn: column, maxColumn: column },
      ...ranges,
    ]);
  }
  const remaining = ranges.flatMap((range, index) =>
    index === containing ? splitSelectionRange(range, row, column) : [range]);
  return selectionFromRanges(remaining);
}

function overallSelectionBounds(selection: DataGridSelection | undefined): DataGridSelectionRange | undefined {
  const ranges = selectionRanges(selection);
  if (ranges.length === 0) return undefined;
  return ranges.reduce((bounds, range) => ({
    minRow: Math.min(bounds.minRow, range.minRow),
    maxRow: Math.max(bounds.maxRow, range.maxRow),
    minColumn: Math.min(bounds.minColumn, range.minColumn),
    maxColumn: Math.max(bounds.maxColumn, range.maxColumn),
  }));
}

/** Display-position bounding box across the active and discontiguous ranges. */
function overallSelectionColumnRange(
  selection: DataGridSelection,
  visibleColumnIndexes: readonly number[],
): { readonly minColumn: number; readonly maxColumn: number } | undefined {
  const primary = gridSelectionColumnRange(selection, visibleColumnIndexes);
  let minColumn = primary?.minColumn;
  let maxColumn = primary?.maxColumn;
  for (const range of selection.additionalRanges ?? []) {
    const columns = gridSelectionRangeColumnRange(range, visibleColumnIndexes);
    if (columns === undefined) continue;
    minColumn = minColumn === undefined ? columns.minColumn : Math.min(minColumn, columns.minColumn);
    maxColumn = maxColumn === undefined ? columns.maxColumn : Math.max(maxColumn, columns.maxColumn);
  }
  return minColumn === undefined || maxColumn === undefined ? undefined : { minColumn, maxColumn };
}

/** Mirrors the DataGrid group id so host-supplied groups map to rendered bands. */
function groupIdForPath(values: readonly string[]): string {
  const ancestors: string[] = [];
  let id = '';
  for (const value of values) {
    const valueKey = JSON.stringify(value);
    id = JSON.stringify([...ancestors, valueKey]);
    ancestors.push(id);
  }
  return id;
}

function groupRows(
  columns: readonly DataGridColumn[],
  rows: readonly IndexedRow[],
  grouping: readonly string[],
  getCellMetadata?: CellMetadataResolver,
  groupCounts?: ReadonlyMap<string, number>,
  extraGroups?: readonly DataGridExtraGroup[],
  groupCountsPartial = false,
): readonly RenderedRow[] {
  if (grouping.length === 0) return rows.map((row, displayIndex) => ({ ...row, kind: 'data', displayIndex, ancestorIds: [] }));
  const rendered: RenderedRow[] = [];
  let displayIndex = 0;

  const appendLevel = (
    level: number,
    levelRows: readonly IndexedRow[],
    ancestorIds: readonly string[],
    ancestorValues: readonly string[],
  ): void => {
    const groupingKey = grouping[level];
    if (groupingKey === undefined) {
      levelRows.forEach(row => {
        rendered.push({ ...row, kind: 'data', displayIndex, groupId: ancestorIds[ancestorIds.length - 1], ancestorIds });
        displayIndex += 1;
      });
      return;
    }
    const columnIndex = resolveColumnIndex(columns, groupingKey);
    const column = columnIndex >= 0 ? columns[columnIndex] : undefined;
    const groups = new Map<string, { readonly value: string; readonly rows: IndexedRow[] }>();
    for (const row of levelRows) {
      const value = columnIndex >= 0 ? row.values[columnIndex] : undefined;
      const metadata = column === undefined ? undefined : getCellMetadata?.(value, row.sourceIndex, columnIndex, column) ?? column;
      const formattedValue = formatDataGridCellValue(value, metadata?.type, metadata);
      const key = JSON.stringify(formattedValue);
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { value: formattedValue, rows: [row] });
    }
    const emittedPaths = new Set<string>();
    for (const [valueKey, group] of groups) {
      const id = JSON.stringify([...ancestorIds, valueKey]);
      const path = [...ancestorValues, group.value];
      const pathKey = JSON.stringify(path);
      emittedPaths.add(pathKey);
      const authoritativeCount = groupCounts?.get(pathKey);
      const label = `${column?.name ?? groupingKey}: ${group.value}`;
      // Depth-first emission means the first data row of this group is the
      // next one emitted, so its 1-based ordinal is the current count + 1.
      rendered.push({
        kind: 'group',
        id,
        label,
        count: authoritativeCount ?? group.rows.length,
        partial: authoritativeCount === undefined && groupCountsPartial,
        ancestorIds,
        level,
        rowNumber: displayIndex + 1,
      });
      appendLevel(level + 1, group.rows, [...ancestorIds, id], path);
    }
    for (const extra of extraGroups ?? []) {
      if (extra.path.length !== level + 1) continue;
      if (JSON.stringify(extra.path.slice(0, level)) !== JSON.stringify(ancestorValues)) continue;
      const pathKey = JSON.stringify(extra.path);
      if (emittedPaths.has(pathKey)) continue;
      emittedPaths.add(pathKey);
      const parentIds: string[] = [];
      for (const value of extra.path.slice(0, level)) {
        parentIds.push(JSON.stringify([...parentIds, JSON.stringify(value)]));
      }
      const id = groupIdForPath(extra.path);
      rendered.push({
        kind: 'group',
        id,
        label: `${column?.name ?? groupingKey}: ${extra.path[level]}`,
        count: extra.count,
        ancestorIds: parentIds,
        level,
        rowNumber: displayIndex + 1,
        partial: groupCountsPartial,
        unloaded: true,
      });
    }
  };

  appendLevel(0, rows, [], []);
  return rendered;
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid({
  sourceId,
  resultSetId,
  columns,
  rows,
  getCellMetadata,
  getColumnFormatting,
  totalRowCount = rows.length,
  scroll,
  onScroll,
  onLoadMore,
  onRowSelect,
  onEditRow,
  editMode = false,
  onCellEdit,
  onInsertCellContent,
  selectedRowIndex,
  view,
  onViewChange,
  clientProcessing = true,
  groupCounts,
  extraGroups,
  groupCountsPartial = false,
  onSelectionChange,
  onContextMenu,
  onCopySelection,
  onExportSelection,
  clipboardWriter,
  onViewCell,
  onViewRow,
  onDeleteRow,
  isRowDeleted,
  onOpenResultFormatting,
  showContextMenu = true,
  showColumnMenu = true,
  showGroupingPanel = true,
  onOpenColumnFilter,
  showInlineColumnFilters = true,
  onColumnAction,
  catalogBound = false,
  onProfileColumn,
  busy = false,
}: DataGridProps, ref): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const [highlightedColumn, setHighlightedColumn] = useState<number | undefined>(undefined);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const headerSortTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const sortColumnRef = useRef<(columnIndex: number, extend?: boolean) => void>(() => undefined);
  const [internalView, setInternalView] = useState<DataGridViewState>(() => normaliseView(undefined));
  const [activeCellEditor, setActiveCellEditor] = useState<ActiveCellEditor | undefined>(undefined);
  const [aggregationMenu, setAggregationMenu] = useState<{ readonly columnIndex: number; readonly left: number; readonly top: number } | undefined>(undefined);
  // Result surfaces also persist scroll coordinates in their view object. Do
  // not rebuild the processing view for every scroll event; doing so would
  // re-filter/re-sort all loaded rows while the browser is trying to paint.
  // A serialised signature keeps every future view field covered without a
  // hand-maintained dependency list.
  const activeViewKey = viewSignature(view ?? internalView);
  const activeView = useMemo(() => normaliseView(view ?? internalView), [activeViewKey]);
  useEffect(() => {
    // A filter/sort/group change moves cells under the editor; committing into
    // a stale coordinate would edit the wrong row. Discard and re-open.
    setActiveCellEditor(undefined);
  }, [activeViewKey, resultSetId, rows]);
  useEffect(() => {
    if (!editMode) setActiveCellEditor(undefined);
  }, [editMode]);
  useEffect(() => () => {
    if (highlightTimerRef.current !== undefined) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
    for (const timer of headerSortTimersRef.current.values()) clearTimeout(timer);
    headerSortTimersRef.current.clear();
  }, []);
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
  const rowSelectionRangeCacheRef = useRef(new Map<string, readonly DataGridSelectionRange[]>());
  const selectionPointerRef = useRef<{ readonly clientX: number; readonly clientY: number } | undefined>(undefined);
  const selectionAutoScrollFrameRef = useRef<number | undefined>(undefined);
  const columnHeaderRefs = useRef(new Map<string, HTMLTableCellElement>());
  const [measuredColumnWidths, setMeasuredColumnWidths] = useState<Readonly<Record<string, number>>>({});
  const [contextMenu, setContextMenu] = useState<DataGridCellContext | undefined>(undefined);
  const contextMenuElementRef = useRef<HTMLDivElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState({ left: 8, top: 8 });
  const dragSelectingRef = useRef(false);
  const draggedColumnRef = useRef<number | undefined>(undefined);
  const headerDragRevealTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [draggedHeaderColumn, setDraggedHeaderColumn] = useState<number | undefined>(undefined);
  const [columnDropTarget, setColumnDropTarget] = useState<{ readonly columnIndex: number; readonly after: boolean } | undefined>(undefined);
  const draggedGroupingRef = useRef<number | undefined>(undefined);
  const [groupingDropIndex, setGroupingDropIndex] = useState<number | undefined>(undefined);
  const resizeRef = useRef<{ columnId: string; startX: number; startWidth: number } | undefined>(undefined);
  const activeViewRef = useRef<DataGridViewState>(activeView);
  const updateViewRef = useRef<(patch: Partial<UiResultViewState>) => void>(() => undefined);
  const selectionScopeRef = useRef<string | undefined>(undefined);
  const selectionChangeRef = useRef(onSelectionChange);
  const onLoadMoreRef = useRef(onLoadMore);
  const onRowSelectRef = useRef(onRowSelect);
  const onContextMenuRef = useRef(onContextMenu);
  const visibleColumnIndexesRef = useRef<readonly number[]>([]);
  const columnLayoutRef = useRef<readonly DataGridColumnLayout[]>([]);
  const columnHeaderHeightRef = useRef(COLUMN_HEADER_HEIGHT);
  const loadMoreInFlightRef = useRef(false);
  const emptyPageRequestRef = useRef<{ readonly key: string; readonly count: number } | undefined>(undefined);
  const columnViewportFrameRef = useRef<number | undefined>(undefined);
  const columnViewportSyncRef = useRef<(() => void) | undefined>(undefined);
  const columnViewportRef = useRef({ left: 0, width: DATA_GRID_DEFAULT_VIEWPORT_WIDTH });
  const [rowWindowVersion, setRowWindowVersion] = useState(0);
  const bumpRowWindow = useCallback((): void => setRowWindowVersion(version => version + 1), []);
  const selectionMetricsRef = useRef({ rowCount: 0, headerHeight: COLUMN_HEADER_HEIGHT });
  const scrollReportFrameRef = useRef<number | undefined>(undefined);
  const scrollReportRef = useRef<{ readonly position: GridScrollPosition; readonly callback: (position: GridScrollPosition) => void } | undefined>(undefined);
  const scrollRestorationRef = useRef<ScrollRestorationState | undefined>(undefined);
  const nativeScrollRef = useRef<ScrollRestorationState | undefined>(undefined);
  const pendingScrollRestorationRef = useRef<PendingScrollRestoration | undefined>(undefined);
  const [columnViewport, setColumnViewport] = useState(columnViewportRef.current);
  activeViewRef.current = activeView;
  selectionChangeRef.current = onSelectionChange;
  onLoadMoreRef.current = onLoadMore;
  onRowSelectRef.current = onRowSelect;
  onContextMenuRef.current = onContextMenu;

  /**
   * Adapter for TanStack Virtual that keeps the sticky column header out of
   * the measured viewport and falls back to the shared default size when the
   * webview reports 0×0 during mount or in a test environment.
   */
  const rangeExtractor = useCallback((range: Range): number[] => {
    const element = scroller.current;
    const window = calculateDataGridVirtualWindow(
      range.count,
      Math.max(0, element?.scrollTop ?? 0),
      element?.clientHeight || DEFAULT_VIEWPORT_HEIGHT,
      VIRTUAL_OVERSCAN_ROWS,
      columnHeaderHeightRef.current,
    );
    const indexes: number[] = [];
    for (let index = window.startIndex; index < window.endIndex; index += 1) indexes.push(index);
    return indexes;
    // The version is part of the extractor identity: a programmatic scroll write
    // has not updated the virtualizer's own offset yet, so changing the identity
    // forces TanStack to re-run this policy against the element's new position.
  }, [rowWindowVersion]);

  const observeGridRect = useCallback((instance: Virtualizer<HTMLDivElement, HTMLTableRowElement>, callback: (rect: { width: number; height: number }) => void) => {
    const element = instance.scrollElement;
    if (!element) return undefined;
    const emit = (): void => {
      callback({
        width: Math.max(0, element.clientWidth) || DATA_GRID_DEFAULT_VIEWPORT_WIDTH,
        height: Math.max(0, element.clientHeight) || DEFAULT_VIEWPORT_HEIGHT,
      });
    };
    emit();
    element.addEventListener('scroll', emit);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(emit);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', emit);
      observer?.disconnect();
    };
  }, []);

  const setSelectionValue = useCallback((next: DataGridSelection | undefined): void => {
    selectionRef.current = next;
    setSelection(next);
    selectionChangeRef.current?.(next);
  }, []);

  useEffect(() => () => {
    if (scrollReportFrameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(scrollReportFrameRef.current);
    }
    if (selectionAutoScrollFrameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(selectionAutoScrollFrameRef.current);
    }
    scrollReportFrameRef.current = undefined;
    scrollReportRef.current = undefined;
    selectionAutoScrollFrameRef.current = undefined;
    selectionPointerRef.current = undefined;
    scrollRestorationRef.current = undefined;
    nativeScrollRef.current = undefined;
    pendingScrollRestorationRef.current = undefined;
    if (headerDragRevealTimerRef.current !== undefined) {
      clearTimeout(headerDragRevealTimerRef.current);
      headerDragRevealTimerRef.current = undefined;
    }
  }, []);

  const updateView = (patch: Partial<UiResultViewState>): void => {
    if (view === undefined) setInternalView(previous => normaliseView({ ...previous, ...patch }));
    onViewChange?.(patch);
  };
  updateViewRef.current = updateView;

  useEffect(() => {
    if (!aggregationMenu) return undefined;
    const close = (event: globalThis.MouseEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.ui-data-grid-aggregation-menu, .ui-data-grid-aggregation-action')) return;
      setAggregationMenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAggregationMenu(undefined);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [aggregationMenu]);

  const updateColumnAggregations = (
    columnIndex: number,
    change: (current: readonly UiResultColumnAggregation[]) => readonly UiResultColumnAggregation[],
  ): void => {
    const column = resolvedColumns[columnIndex];
    if (!column) return;
    const key = columnKey(column, columnIndex);
    const definitions = { ...(activeView.columnAggregations ?? {}) };
    const next = change(columnAggregations(activeView, column, columnIndex));
    if (next.length === 0) delete definitions[key];
    else definitions[key] = next;
    updateView({ columnAggregations: definitions });
  };

  const toggleColumnAggregation = (columnIndex: number, fn: UiResultAggregationFunction): void => {
    updateColumnAggregations(columnIndex, current => current.some(entry => entry.fn === fn)
      ? current.filter(entry => entry.fn !== fn)
      : [...current, { fn }]);
  };

  const setColumnAggregationPosition = (columnIndex: number, position: 'top' | 'bottom'): void => {
    updateColumnAggregations(columnIndex, current => current.map(entry => ({ ...entry, position })));
  };

  const clearColumnAggregations = (columnIndex: number): void => {
    updateColumnAggregations(columnIndex, () => []);
  };

  /** Double-click on the resizer fits the header and a small data sample. */
  const autoFitColumn = (columnIndex: number): void => {
    const column = resolvedColumns[columnIndex];
    if (!column) return;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    const font = scroller.current === null
      ? '12px sans-serif'
      : getComputedStyle(scroller.current).font || '12px sans-serif';
    context.font = font;
    const formatting = getColumnFormatting?.(column, columnIndex);
    let width = context.measureText(column.name).width + typeBadge(column).length * 7 + 128;
    for (const row of rows.slice(0, 250)) {
      const text = formatDataGridCellValue(row[columnIndex], column.type, column, formatting);
      width = Math.max(width, context.measureText(text).width + 22);
    }
    const nextWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(600, Math.ceil(width)));
    updateView({
      columnWidths: {
        ...(activeViewRef.current.columnWidths ?? {}),
        [columnKey(column, columnIndex)]: nextWidth,
      },
    });
  };

  useEffect(() => {
    const handleMouseUp = (): void => {
      dragSelectingRef.current = false;
      selectionPointerRef.current = undefined;
      if (selectionAutoScrollFrameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      }
      selectionAutoScrollFrameRef.current = undefined;
      resizeRef.current = undefined;
    };
    const handleMouseMove = (event: MouseEvent): void => {
      const resize = resizeRef.current;
      if (resize) {
        const nextWidth = Math.max(MIN_COLUMN_WIDTH, resize.startWidth + event.clientX - resize.startX);
        const widths = { ...(activeViewRef.current.columnWidths ?? {}), [resize.columnId]: nextWidth };
        updateViewRef.current({ columnWidths: widths });
        return;
      }
      if (dragSelectingRef.current) updateSelectionFromPointer(event.clientX, event.clientY);
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

    const flushColumns = (): void => {
      columnViewportFrameRef.current = undefined;
      const next = columnViewportRef.current;
      setColumnViewport(previous => previous.left === next.left && previous.width === next.width ? previous : next);
    };
    const scheduleColumns = (): void => {
      columnViewportRef.current = {
        left: Math.max(0, element.scrollLeft),
        width: Math.max(0, element.clientWidth) || DATA_GRID_DEFAULT_VIEWPORT_WIDTH,
      };
      if (columnViewportFrameRef.current !== undefined) return;
      if (typeof requestAnimationFrame === 'function') {
        columnViewportFrameRef.current = requestAnimationFrame(flushColumns);
      } else {
        flushColumns();
      }
    };

    columnViewportSyncRef.current = scheduleColumns;
    scheduleColumns();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleColumns);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (columnViewportFrameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(columnViewportFrameRef.current);
      }
      columnViewportFrameRef.current = undefined;
      columnViewportSyncRef.current = undefined;
    };
  }, [columns.length, resultSetId, rows.length]);

  const visibleColumnIndexes = useMemo(() => {
    const ordered = orderColumns(resolvedColumns, activeView);
    const pinned = ordered.filter(columnIndex => activeView.pinnedColumns?.some(key => columnMatchesKey(resolvedColumns[columnIndex]!, columnIndex, key)) ?? false);
    if (pinned.length === 0) return ordered;
    // Excel keeps pinned columns against the row-number gutter. Moving them
    // to the front guarantees their sticky offsets never collide.
    return [...pinned, ...ordered.filter(columnIndex => !pinned.includes(columnIndex))];
  }, [resolvedColumns, activeView]);
  const processedRows = useMemo(() => indexedRows(resolvedColumns, rows, activeView, clientProcessing, getCellMetadata), [resolvedColumns, rows, activeView, clientProcessing, getCellMetadata]);
  // Grouping is a renderer concern for every host. Server-backed adapters may
  // page/filter the input rows, but a group must still be a tree row in this
  // grid rather than a second aggregate table below it.
  const groupedRows = useMemo(
    () => activeView.grouping.length > 0
      ? groupRows(resolvedColumns, processedRows, activeView.grouping, getCellMetadata, groupCounts, extraGroups, groupCountsPartial)
      : undefined,
    [activeView.grouping, getCellMetadata, processedRows, resolvedColumns, groupCounts, extraGroups, groupCountsPartial],
  );
  /*
   * Groups render collapsed by default so adding a grouping column shows the
   * tree shape immediately instead of pushing thousands of leaf rows into
   * view. Expansion is ephemeral: a different grouping starts collapsed again.
   */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const groupingSignature = activeView.grouping.join('\u0000');
  useEffect(() => {
    setExpandedGroups(previous => previous.size === 0 ? previous : new Set());
  }, [groupingSignature]);
  const visibleRowCount = groupedRows === undefined ? processedRows.length : groupedRows.length;
  const visibleGroupedRows = useMemo(
    () => groupedRows?.filter(row => !row.ancestorIds.some(groupId => !expandedGroups.has(groupId))),
    [expandedGroups, groupedRows],
  );
  const columnAggregationRows = useMemo(() => {
    const definitions = activeView.columnAggregations;
    if (!definitions || visibleColumnIndexes.length === 0) return { top: [], bottom: [] } as const;
    const definitionsFor = (columnIndex: number): readonly UiResultColumnAggregation[] => {
      const column = resolvedColumns[columnIndex];
      if (!column) return [];
      return definitions[columnKey(column, columnIndex)] ?? definitions[column.name] ?? definitions[String(columnIndex)] ?? [];
    };
    let maxTop = 0;
    let maxBottom = 0;
    for (const columnIndex of visibleColumnIndexes) {
      const entries = definitionsFor(columnIndex);
      const topCount = entries.filter(entry => entry.position === 'top').length;
      maxTop = Math.max(maxTop, topCount);
      maxBottom = Math.max(maxBottom, entries.length - topCount);
    }
    if (maxTop === 0 && maxBottom === 0) return { top: [], bottom: [] } as const;
    const allValues = processedRows.map(row => row.values);
    const buildRows = (position: 'top' | 'bottom', count: number) => {
      const rows: Array<readonly (DataGridAggregationCell | undefined)[]> = [];
      for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
        rows.push(visibleColumnIndexes.map(columnIndex => {
          const column = resolvedColumns[columnIndex];
          if (!column) return undefined;
          const entry = definitionsFor(columnIndex).filter(item => (item.position ?? 'bottom') === position)[rowIndex];
          if (!entry) return undefined;
          return calculateDataGridAggregations(column, columnIndex, allValues, [entry])[0];
        }));
      }
      return rows;
    };
    return { top: buildRows('top', maxTop), bottom: buildRows('bottom', maxBottom) };
  }, [activeView.columnAggregations, processedRows, resolvedColumns, visibleColumnIndexes]);
  const columnHeaderHeight = onOpenColumnFilter && !showInlineColumnFilters ? COMPACT_COLUMN_HEADER_HEIGHT : COLUMN_HEADER_HEIGHT;
  columnHeaderHeightRef.current = columnHeaderHeight;
  visibleColumnIndexesRef.current = visibleColumnIndexes;
  // Drag handle, filter/aggregate, pin and grouping are always rendered.
  const headerActionCount = 4;
  // One pass computes the sticky offset of every column. The previous
  // renderer repeated this O(columns) walk inside every header and body cell,
  // which became quadratic for wide result sets.
  const columnGeometry = useMemo(() => {
    const entries: DataGridColumnLayout[] = [];
    let pinnedLeft = ROW_NUMBER_WIDTH;
    let offset = ROW_NUMBER_WIDTH;
    let pinnedCount = 0;
    let onlyPinned = true;
    for (let position = 0; position < visibleColumnIndexes.length; position += 1) {
      const columnIndex = visibleColumnIndexes[position]!;
      const column = resolvedColumns[columnIndex]!;
      const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
      const width = columnWidthFor(column, columnIndex, activeView, measuredColumnWidths, headerActionCount);
      entries.push({
        columnIndex,
        position,
        key: columnKey(column, columnIndex),
        pinned,
        left: pinned ? pinnedLeft : undefined,
        offset,
        width,
      });
      offset += width;
      if (pinned && onlyPinned) {
        pinnedLeft += width;
        pinnedCount += 1;
      } else {
        onlyPinned = false;
      }
    }
    return { entries, pinnedCount };
  }, [activeView, headerActionCount, measuredColumnWidths, resolvedColumns, visibleColumnIndexes]);
  const columnLayout = columnGeometry.entries;
  columnLayoutRef.current = columnLayout;
  const columnWindow = useMemo(
    () => calculateDataGridColumnWindow(
      columnLayout.map(entry => entry.width),
      columnViewport.left,
      columnViewport.width,
      columnGeometry.pinnedCount,
      ROW_NUMBER_WIDTH,
      undefined,
      COLUMN_WINDOW_THRESHOLD,
    ),
    [columnGeometry.pinnedCount, columnLayout, columnViewport.left, columnViewport.width],
  );
  const mountedColumns = useMemo(
    () => columnWindow.windowed
      ? [...columnLayout.slice(0, columnGeometry.pinnedCount), ...columnLayout.slice(columnWindow.startIndex, columnWindow.endIndex)]
      : columnLayout,
    // Use window primitives, not the fresh columnWindow object, so a
    // horizontal scroll inside the mounted window keeps row props stable.
    [columnGeometry.pinnedCount, columnLayout, columnWindow.endIndex, columnWindow.startIndex, columnWindow.windowed],
  );
  const leftColumnSpacer = columnWindow.windowed ? columnWindow.paddingLeft : 0;
  const rightColumnSpacer = columnWindow.windowed ? columnWindow.paddingRight : 0;
  const mountedCellCount = 2 + mountedColumns.length + (leftColumnSpacer > 0 ? 1 : 0) + (rightColumnSpacer > 0 ? 1 : 0);
  const mountedColumnSignature = mountedColumns.map(entry => `${entry.columnIndex}:${entry.key}`).join(',');
  selectionMetricsRef.current = {
    rowCount: visibleGroupedRows?.length ?? visibleRowCount,
    headerHeight: columnHeaderHeight,
  };
  // TanStack Virtual owns scroll observation, the mounted range and the total
  // spacer extent. The extractor only adapts the sticky-header-aware range
  // policy that the shared grid has always exposed to its hosts.
  const displayRowCount = visibleGroupedRows === undefined ? processedRows.length : visibleGroupedRows.length;
  const getScrollElement = useCallback((): HTMLDivElement | null => scroller.current, []);
  // Fixed-height rows: no measureElement ref is attached, so every item start
  // is index * ROW_HEIGHT and total size is count * ROW_HEIGHT.
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: displayRowCount,
    getScrollElement,
    estimateSize: estimateRowHeight,
    overscan: VIRTUAL_OVERSCAN_ROWS,
    initialRect: { width: DATA_GRID_DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT },
    rangeExtractor,
    observeElementRect: observeGridRect,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();
  const virtualTopSpacer = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const virtualBottomSpacer = virtualItems.length > 0
    ? Math.max(0, virtualTotalSize - virtualItems[virtualItems.length - 1]!.end)
    : 0;
  const visibleColumnSignature = visibleColumnIndexes.join(',');
  const visibleColumnIndexSet = useMemo(() => new Set(visibleColumnIndexes), [visibleColumnIndexes]);
  const hasColumnFilterSurface = onOpenColumnFilter !== undefined;
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    for (const [index, column] of resolvedColumns.entries()) {
      if (!visibleColumnIndexSet.has(index)) continue;
      const id = columnKey(column, index);
      const cell = columnHeaderRefs.current.get(`${id}:${index}`);
      if (!cell) continue;
      next[id] = measuredHeaderMinimumWidth(column, cell, showInlineColumnFilters || !hasColumnFilterSurface);
    }
    setMeasuredColumnWidths(previous => {
      let changed = false;
      const merged = { ...previous };
      for (const [key, width] of Object.entries(next)) {
        if (merged[key] !== width) {
          merged[key] = width;
          changed = true;
        }
      }
      // Keep measurements for columns that scrolled out of the mounted window.
      // Dropping them would shrink the virtual table extent and make the
      // horizontal scrollbar jump while a wide result is being explored.
      return changed ? merged : previous;
    });
  }, [columnMetadataSignature, hasColumnFilterSurface, mountedColumnSignature, resolvedColumns, showInlineColumnFilters, visibleColumnIndexSet, visibleColumnSignature]);
  const range = normalizeGridSelection(selection);
  const columnRange = gridSelectionColumnRange(selection, visibleColumnIndexes);
  // Project every selected rectangle to display positions once; rows only do
  // a handful of primitive comparisons per cell. The primary rectangle uses
  // the anchor/focus projection so reordered columns copy as the user sees
  // them, not as their raw indexes happen to fall.
  const displaySelectionRanges = useMemo<readonly DataGridSelectionRange[]>(() => {
    if (!selection) return [];
    const primary = primarySelectionRange(selection);
    const primaryColumns = gridSelectionColumnRange(selection, visibleColumnIndexes);
    const projected: DataGridSelectionRange[] = primaryColumns === undefined ? [] : [{
      ...primary,
      minColumn: primaryColumns.minColumn,
      maxColumn: primaryColumns.maxColumn,
    }];
    for (const range of selection.additionalRanges ?? []) {
      const columns = gridSelectionRangeColumnRange(range, visibleColumnIndexes);
      if (columns === undefined) continue;
      projected.push({ ...range, minColumn: columns.minColumn, maxColumn: columns.maxColumn });
    }
    return projected;
  }, [selection, visibleColumnIndexes]);
  // The current cell is stored in raw column indexes; the renderer compares
  // display positions, so project it once next to the selection rectangles.
  const displayFocusColumn = useMemo(() => {
    if (selection === undefined) return undefined;
    const position = visibleColumnIndexes.indexOf(selection.focusColumn);
    return position >= 0 ? position : undefined;
  }, [selection, visibleColumnIndexes]);
  // Keep one stable array per distinct per-row selection shape so a pointer
  // drag re-renders only rows whose selected columns actually changed.
  const selectionRangesForRow = (displayIndex: number): readonly DataGridSelectionRange[] => {
    const matching = displaySelectionRanges.filter(range =>
      displayIndex >= range.minRow && displayIndex <= range.maxRow);
    if (matching.length === 0) return EMPTY_SELECTION_RANGES;
    const key = matching
      .map(range => `${range.minRow}:${range.maxRow}:${range.minColumn}:${range.maxColumn}`)
      .join(',');
    const cache = rowSelectionRangeCacheRef.current;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    cache.set(key, matching);
    return matching;
  };
  const selectableRowCount = visibleGroupedRows?.length ?? visibleRowCount;
  const allSelected = selectableRowCount > 0
    && range !== undefined
    && range.minRow === 0
    && range.maxRow >= selectableRowCount - 1
    && columnRange !== undefined
    && columnRange.minColumn === 0
    && columnRange.maxColumn >= visibleColumnIndexes.length - 1;
  const hasMoreRows = onLoadMore !== undefined && rows.length < totalRowCount;
  const requestMoreRows = useCallback((): void => {
    const loader = onLoadMoreRef.current;
    if (!hasMoreRows || !loader || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    try {
      const operation = loader();
      if (operation === undefined) {
        // Synchronous adapters have completed their request by contract.
        loadMoreInFlightRef.current = false;
        return;
      }
      void operation.then(
        () => { loadMoreInFlightRef.current = false; },
        () => { loadMoreInFlightRef.current = false; },
      );
    } catch (error: unknown) {
      loadMoreInFlightRef.current = false;
      throw error;
    }
  }, [hasMoreRows]);
  useEffect(() => {
    loadMoreInFlightRef.current = false;
  }, [resultSetId]);
  const emptyPageRequestKey = useMemo(() => JSON.stringify({
    resultSetId,
    totalRowCount,
    globalFilter: activeView.globalFilter,
    columnFilters: activeView.columnFilters,
    columnFilterDefinitions: activeView.columnFilterDefinitions,
  }), [activeView.columnFilterDefinitions, activeView.columnFilters, activeView.globalFilter, resultSetId, totalRowCount]);
  const selectionScope = useMemo(() => JSON.stringify({
    sourceId,
    resultSetId,
    clientProcessing,
    columns: resolvedColumns.map(column => [column.name, column.type, column.scale, column.inferredNumericKind, column.inferredDateInteger]),
    view: {
      globalFilter: activeView.globalFilter,
      columnFilters: activeView.columnFilters,
      columnFilterDefinitions: activeView.columnFilterDefinitions,
      sorting: activeView.sorting,
      grouping: activeView.grouping,
      columnVisibility: activeView.columnVisibility,
      columnOrder: activeView.columnOrder,
      pinnedColumns: activeView.pinnedColumns,
    },
  }), [activeView.columnFilterDefinitions, activeView.columnFilters, activeView.columnOrder, activeView.columnVisibility, activeView.grouping, activeView.pinnedColumns, activeView.globalFilter, activeView.sorting, clientProcessing, columns, resolvedColumns, resultSetId, sourceId]);

  useEffect(() => {
    const previousScope = selectionScopeRef.current;
    selectionScopeRef.current = selectionScope;
    if (previousScope === undefined || previousScope === selectionScope) return;
    dragSelectingRef.current = false;
    selectionRef.current = undefined;
    setSelection(undefined);
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
    requestMoreRows();
  }, [emptyPageRequestKey, hasMoreRows, processedRows.length, requestMoreRows]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (!scroll || scroll.resultSetId !== resultSetId || (scroll.sourceId !== undefined && scroll.sourceId !== sourceId)) {
      scrollRestorationRef.current = undefined;
      nativeScrollRef.current = undefined;
      pendingScrollRestorationRef.current = undefined;
      return;
    }
    const scope = `${sourceId ?? ''}\u0000${resultSetId}`;
    const nextTop = resolveDataGridScrollTop(scroll.top, scroll.anchorRow, scroll.rowHeight);
    const nextLeft = Math.max(0, Number.isFinite(scroll.left) ? scroll.left : 0);
    const previous = scrollRestorationRef.current;
    const pending = pendingScrollRestorationRef.current;
    const positionChanged = previous?.scope !== scope || previous.top !== nextTop || previous.left !== nextLeft;
    const nativeScroll = nativeScrollRef.current;
    const nativeScrollAhead = nativeScroll?.scope === scope
      && (nativeScroll.top !== nextTop || nativeScroll.left !== nextLeft);
    if ((dragSelectingRef.current || nativeScrollAhead) && positionChanged) {
      // A drag or a controlled native scroll owns the viewport until mouseup
      // or until the host confirms the same position through props. Restoring
      // the previous prop during that window makes the grid visibly oscillate.
      const currentPosition = { scope, top: element.scrollTop, left: element.scrollLeft };
      scrollRestorationRef.current = currentPosition;
      if (nativeScrollAhead) nativeScrollRef.current = currentPosition;
      pendingScrollRestorationRef.current = undefined;
      return;
    }
    if (nativeScroll?.scope === scope && nativeScroll.top === nextTop && nativeScroll.left === nextLeft) {
      nativeScrollRef.current = undefined;
    } else if (nativeScroll !== undefined && nativeScroll.scope !== scope) {
      nativeScrollRef.current = undefined;
    }
    // Appending a page changes the virtual spacer height, but it must not be
    // treated as a new controlled scroll position. Only a new result, an
    // explicit host position change, or an outstanding zero-size restoration
    // is allowed to write scrollTop/scrollLeft back to the DOM.
    const shouldRestore = positionChanged || pending?.scope === scope;
    const target: PendingScrollRestoration = { scope, top: nextTop, left: nextLeft };
    const restore = (position: PendingScrollRestoration = target): void => {
      const current = scroller.current;
      if (!current || position.scope !== scope) return;
      if (current.scrollTop !== position.top) current.scrollTop = position.top;
      if (current.scrollLeft !== position.left) current.scrollLeft = position.left;
      columnViewportSyncRef.current?.();
      bumpRowWindow();
    };
    if (shouldRestore) restore();
    const needsLayoutRetry = shouldRestore && element.clientHeight <= 0 && typeof ResizeObserver !== 'undefined';
    pendingScrollRestorationRef.current = needsLayoutRetry ? target : undefined;
    scrollRestorationRef.current = target;
    let frame: number | undefined;
    if (shouldRestore && typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const currentRestoration = scrollRestorationRef.current;
        if (currentRestoration !== undefined
          && (currentRestoration.scope !== target.scope
            || currentRestoration.top !== target.top
            || currentRestoration.left !== target.left)) {
          // A native scroll or drag advanced the viewport after this frame was
          // scheduled. Restoring the stale target now would reintroduce the
          // oscillation the pending guard exists to prevent.
          return;
        }
        restore();
      });
    }
    const observer = pendingScrollRestorationRef.current && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (element.clientHeight <= 0) return;
        const pendingTarget = pendingScrollRestorationRef.current;
        if (!pendingTarget || pendingTarget.scope !== scope) return;
        restore(pendingTarget);
        pendingScrollRestorationRef.current = undefined;
      })
      : undefined;
    observer?.observe(element);
    return () => {
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [resultSetId, sourceId, scroll?.sourceId, scroll?.resultSetId, scroll?.top, scroll?.left, scroll?.anchorRow, scroll?.rowHeight, rows.length, columns.length, totalRowCount]);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    const position: GridScrollPosition = { ...(sourceId === undefined ? {} : { sourceId }), resultSetId, top: element.scrollTop, left: element.scrollLeft, anchorRow: Math.floor(Math.max(0, element.scrollTop) / ROW_HEIGHT), rowHeight: ROW_HEIGHT };
    // Record the browser-owned position before notifying a controlled host.
    // This prevents the restoration effect from briefly writing the previous
    // prop value back while a drag is advancing through frames, or while a
    // controlled host still reports the stale position for one frame after a
    // programmatic scroll. The native pending position owns the viewport until
    // the host confirms it through props.
    if (dragSelectingRef.current || onScroll) {
      const nativePosition = {
        scope: `${sourceId ?? ''}\u0000${resultSetId}`,
        top: position.top,
        left: position.left,
      };
      scrollRestorationRef.current = nativePosition;
      if (onScroll) nativeScrollRef.current = nativePosition;
      pendingScrollRestorationRef.current = undefined;
    }
    // Row virtualization is notified by its own scroll subscription. Only the
    // horizontal column window needs an explicit (rAF-throttled) update.
    columnViewportSyncRef.current?.();
    if (onScroll) {
      scrollReportRef.current = {
        position,
        callback: onScroll,
      };
      if (scrollReportFrameRef.current === undefined) {
        const flushScrollReport = (): void => {
          scrollReportFrameRef.current = undefined;
          const pending = scrollReportRef.current;
          scrollReportRef.current = undefined;
          pending?.callback(pending.position);
        };
        if (typeof requestAnimationFrame === 'function') scrollReportFrameRef.current = requestAnimationFrame(flushScrollReport);
        else flushScrollReport();
      }
    }
    const distanceFromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromEnd <= 160) requestMoreRows();
  }

  function scheduleSelectionAutoScroll(): void {
    if (selectionAutoScrollFrameRef.current !== undefined || typeof requestAnimationFrame !== 'function') return;
    selectionAutoScrollFrameRef.current = requestAnimationFrame(() => {
      selectionAutoScrollFrameRef.current = undefined;
      const pointer = selectionPointerRef.current;
      if (!dragSelectingRef.current || !pointer) return;
      updateSelectionFromPointer(pointer.clientX, pointer.clientY);
    });
  }

  function updateSelectionFromPointer(clientX: number, clientY: number): void {
    if (!dragSelectingRef.current || !selectionRef.current) return;
    const element = scroller.current;
    if (!element) return;
    selectionPointerRef.current = { clientX, clientY };
    const bounds = element.getBoundingClientRect();
    const edge = 28;
    const verticalDirection = clientY < bounds.top + edge ? -1 : clientY > bounds.bottom - edge ? 1 : 0;
    const horizontalDirection = clientX < bounds.left + edge ? -1 : clientX > bounds.right - edge ? 1 : 0;
    const previousScrollTop = element.scrollTop;
    const previousScrollLeft = element.scrollLeft;
    if (verticalDirection !== 0) {
      const distance = verticalDirection < 0
        ? Math.max(0, bounds.top + edge - clientY)
        : Math.max(0, clientY - (bounds.bottom - edge));
      const speed = Math.min(48, Math.max(10, 8 + Math.ceil(distance / 4)));
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const nextScrollTop = Math.max(0, Math.min(maximum, previousScrollTop + verticalDirection * speed));
      if (nextScrollTop !== previousScrollTop) {
        element.scrollTop = nextScrollTop;
      }
    }
    if (horizontalDirection !== 0) {
      const distance = horizontalDirection < 0
        ? Math.max(0, bounds.left + edge - clientX)
        : Math.max(0, clientX - (bounds.right - edge));
      const speed = Math.min(48, Math.max(10, 8 + Math.ceil(distance / 4)));
      const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
      const nextScrollLeft = Math.max(0, Math.min(maximum, previousScrollLeft + horizontalDirection * speed));
      if (nextScrollLeft !== previousScrollLeft) element.scrollLeft = nextScrollLeft;
    }
    if (element.scrollTop !== previousScrollTop) {
      bumpRowWindow();
    }
    if (element.scrollLeft !== previousScrollLeft) {
      columnViewportSyncRef.current?.();
    }

    const pointedElement = typeof document === 'undefined' || typeof document.elementFromPoint !== 'function'
      ? undefined
      : document.elementFromPoint(clientX, clientY);
    const edgeElement = horizontalDirection === 0 || typeof document === 'undefined' || typeof document.elementFromPoint !== 'function'
      ? undefined
      : document.elementFromPoint(
        Math.min(bounds.right - 1, Math.max(bounds.left + 1, horizontalDirection < 0 ? bounds.left + edge + 1 : bounds.right - edge - 1)),
        Math.min(bounds.bottom - 1, Math.max(bounds.top + selectionMetricsRef.current.headerHeight + 1, clientY)),
      );
    const pointedRow = pointedElement?.closest<HTMLElement>('tr[data-row-index]') ?? edgeElement?.closest<HTMLElement>('tr[data-row-index]');
    const pointedRowIndex = pointedRow ? Number(pointedRow.dataset.rowIndex) : undefined;
    const pointedCell = pointedElement?.closest<HTMLElement>('td[data-column-index]') ?? edgeElement?.closest<HTMLElement>('td[data-column-index]');
    const pointedColumnIndex = pointedCell ? Number(pointedCell.dataset.columnIndex) : undefined;
    const rowCount = selectionMetricsRef.current.rowCount;
    let focusRow = Number.isInteger(pointedRowIndex) && (pointedRowIndex ?? -1) >= 0 ? pointedRowIndex! : selectionRef.current.focusRow;
    if (verticalDirection !== 0 && rowCount > 0) {
      const viewportHeight = Math.max(ROW_HEIGHT, element.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
      const visibleRows = Math.max(1, Math.ceil((viewportHeight - selectionMetricsRef.current.headerHeight) / ROW_HEIGHT));
      // Rows under the sticky header are partially covered, so the first
      // fully visible row is the first one whose top edge has scrolled past
      // the header; partial rows must not become the drag target.
      const firstVisibleRow = Math.min(rowCount - 1, Math.ceil(Math.max(0, element.scrollTop) / ROW_HEIGHT));
      const lastVisibleRow = Math.min(rowCount - 1, firstVisibleRow + visibleRows - 1);
      focusRow = verticalDirection < 0 ? firstVisibleRow : lastVisibleRow;
    }
    const focusColumn = Number.isInteger(pointedColumnIndex) && (pointedColumnIndex ?? -1) >= 0
      ? pointedColumnIndex!
      : selectionRef.current.focusColumn;
    if (focusRow !== selectionRef.current.focusRow || focusColumn !== selectionRef.current.focusColumn) {
      setSelectionValue({ ...selectionRef.current, focusRow, focusColumn });
    }
    if ((verticalDirection !== 0 || horizontalDirection !== 0)
      && (element.scrollTop !== previousScrollTop || element.scrollLeft !== previousScrollLeft)) {
      scheduleSelectionAutoScroll();
    }
  }

  const handleCellMouseDown = useCallback((rowIndex: number, columnIndex: number, event: ReactMouseEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    scroller.current?.focus({ preventScroll: true });
    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd+click toggles one cell without starting a drag. The clicked
      // cell becomes the active rectangle so keyboard navigation follows it.
      dragSelectingRef.current = false;
      setSelectionValue(toggleSelectionCell(selectionRef.current, rowIndex, columnIndex));
      return;
    }
    const previous = selectionRef.current;
    const next = event.shiftKey && previous
      ? { anchorRow: previous.anchorRow, anchorColumn: previous.anchorColumn, focusRow: rowIndex, focusColumn: columnIndex }
      : { anchorRow: rowIndex, anchorColumn: columnIndex, focusRow: rowIndex, focusColumn: columnIndex };
    dragSelectingRef.current = true;
    setSelectionValue(next);
  }, [setSelectionValue]);

  const handleCellMouseEnter = useCallback((rowIndex: number, columnIndex: number): void => {
    const current = selectionRef.current;
    if (!dragSelectingRef.current || !current) return;
    // Dragging extends the active rectangle; discontiguous Ctrl+click cells
    // are intentionally dropped, matching the legacy grid's range drag.
    setSelectionValue({
      anchorRow: current.anchorRow,
      anchorColumn: current.anchorColumn,
      focusRow: rowIndex,
      focusColumn: columnIndex,
    });
  }, [setSelectionValue]);

  const handleRowNumberMouseDown = useCallback((rowIndex: number, event: ReactMouseEvent<HTMLElement>): void => {
    const columns = visibleColumnIndexesRef.current;
    const firstColumn = columns[0];
    const lastColumn = columns[columns.length - 1];
    if (event.button !== 0 || firstColumn === undefined || lastColumn === undefined) return;
    event.preventDefault();
    scroller.current?.focus({ preventScroll: true });
    const previous = selectionRef.current;
    const next = event.shiftKey && previous
      ? { anchorRow: previous.anchorRow, anchorColumn: firstColumn, focusRow: rowIndex, focusColumn: lastColumn }
      : { anchorRow: rowIndex, anchorColumn: firstColumn, focusRow: rowIndex, focusColumn: lastColumn };
    dragSelectingRef.current = true;
    setSelectionValue(next);
  }, [setSelectionValue]);

  const handleRowNumberEnter = useCallback((rowIndex: number): void => {
    const firstColumn = visibleColumnIndexesRef.current[0];
    if (firstColumn === undefined || !dragSelectingRef.current || !selectionRef.current) return;
    setSelectionValue({ ...selectionRef.current, focusRow: rowIndex, focusColumn: firstColumn });
  }, [setSelectionValue]);

  const handleRowClick = useCallback((sourceIndex: number): void => {
    scroller.current?.focus({ preventScroll: true });
    onRowSelectRef.current?.(sourceIndex);
  }, []);

  const handleCellContextMenu = useCallback((sourceIndex: number, columnIndex: number, event: ReactMouseEvent<HTMLElement>): void => {
    event.preventDefault();
    const context = { rowIndex: sourceIndex, columnIndex, clientX: event.clientX, clientY: event.clientY };
    onContextMenuRef.current?.(context);
    if (showContextMenu) setContextMenu(context);
  }, [showContextMenu]);

  const handleCellDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!editMode && onInsertCellContent === undefined) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, button, a, [contenteditable="true"]') !== null) return;
    const cell = target.closest('td');
    const rowElement = target.closest('tr');
    if (!(cell instanceof HTMLTableCellElement) || !(rowElement instanceof HTMLTableRowElement)) return;
    if (cell.classList.contains('ui-data-grid-column-spacer')) return;
    const columnIndex = Number.parseInt(cell.dataset.columnIndex ?? '', 10);
    const rowIndex = Number.parseInt(rowElement.dataset.sourceIndex ?? '', 10);
    if (!Number.isInteger(columnIndex) || !Number.isInteger(rowIndex)) return;
    const column = resolvedColumns[columnIndex];
    const row = rows[rowIndex];
    if (column === undefined || row === undefined) return;
    const metadata = getCellMetadata?.(row[columnIndex], rowIndex, columnIndex, column);
    const columnType = metadata?.type ?? column.type;
    const value = row[columnIndex];

    if (editMode && onCellEdit !== undefined) {
      const scrollerElement = scroller.current;
      if (scrollerElement === null || isDataGridBinaryType(columnType)) return;
      const cellRect = cell.getBoundingClientRect();
      const scrollerRect = scrollerElement.getBoundingClientRect();
      event.preventDefault();
      setContextMenu(undefined);
      setActiveCellEditor({
        rowIndex,
        columnIndex,
        columnName: column.name,
        columnType,
        oldValue: value,
        kind: resolveGridCellEditKind(columnType, value),
        initialText: toEditableCellText(value, columnType),
        initialNull: value === null || value === undefined,
        layout: {
          left: cellRect.left - scrollerRect.left + scrollerElement.scrollLeft,
          top: cellRect.top - scrollerRect.top + scrollerElement.scrollTop,
          width: Math.max(cellRect.width, 160),
          height: cellRect.height,
        },
      });
      return;
    }

    if (onInsertCellContent === undefined) return;
    const sqlText = formatDataGridCellValueForSql(value, { ...column, ...metadata, type: columnType });
    if (!sqlText) return;
    onInsertCellContent({
      text: value === null || value === undefined ? 'NULL' : String(value),
      ...(columnType === undefined ? {} : { dataType: columnType }),
      sqlText,
    });
  };

  /** Scrolls horizontally to a column. Returns true when the offset changed. */
  function scrollColumnIntoView(element: HTMLDivElement, layout: readonly DataGridColumnLayout[], columnIndex: number): boolean {
    const entry = layout.find(item => item.columnIndex === columnIndex);
    if (entry === undefined || entry.pinned) return false;
    const pinnedWidth = layout.reduce((sum, item) => item.pinned ? sum + item.width : sum, 0);
    const visibleLeft = element.scrollLeft + ROW_NUMBER_WIDTH + pinnedWidth;
    const visibleRight = element.scrollLeft + element.clientWidth;
    let nextLeft = element.scrollLeft;
    if (entry.offset < visibleLeft) nextLeft = Math.max(0, entry.offset - ROW_NUMBER_WIDTH - pinnedWidth);
    else if (entry.offset + entry.width > visibleRight) nextLeft = entry.offset + entry.width - element.clientWidth;
    if (nextLeft === element.scrollLeft) return false;
    element.scrollLeft = nextLeft;
    return true;
  }

  /**
   * Keeps a keyboard target below the sticky header and outside pinned columns.
   *
   * The sticky `<thead>` is part of the scroll content, so body row `N` starts
   * at `headerHeight + N * ROW_HEIGHT` in content coordinates while the header
   * covers the first `headerHeight` pixels of the viewport. Comparing virtual
   * row offsets without that header term hid the focused row by exactly one
   * header height at the bottom edge and scrolled one row too early at the top.
   */
  function scrollCellIntoView(rowIndex: number, columnIndex: number): void {
    const element = scroller.current;
    const layout = columnLayoutRef.current;
    if (!element || layout.length === 0) return;
    const header = columnHeaderHeightRef.current;
    const rowTop = header + rowIndex * ROW_HEIGHT;
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    let nextTop = element.scrollTop;
    if (rowTop < nextTop + header) nextTop = rowTop - header;
    else if (rowTop + ROW_HEIGHT > nextTop + element.clientHeight) nextTop = rowTop + ROW_HEIGHT - element.clientHeight;
    nextTop = Math.max(0, Math.min(maxTop, nextTop));
    const topChanged = nextTop !== element.scrollTop;
    const leftChanged = scrollColumnIntoView(element, layout, columnIndex);
    if (topChanged) element.scrollTop = nextTop;
    if (leftChanged) columnViewportSyncRef.current?.();
    if (topChanged) bumpRowWindow();
  }

  function highlightColumn(columnIndex: number): void {
    setHighlightedColumn(columnIndex);
    if (highlightTimerRef.current !== undefined) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedColumn(undefined);
      highlightTimerRef.current = undefined;
    }, 1800);
  }

  /** Public handle used by the toolbar's find-column control. */
  function scrollToColumn(columnIndex: number): void {
    const element = scroller.current;
    const layout = columnLayoutRef.current;
    if (!element || layout.length === 0) return;
    if (!layout.some(item => item.columnIndex === columnIndex)) return;
    if (scrollColumnIntoView(element, layout, columnIndex)) {
      // Adopt the native position before the host confirms it, so a pending
      // restoration frame cannot write the previous controlled offset back.
      const position = {
        scope: `${sourceId ?? ''}\u0000${resultSetId}`,
        top: element.scrollTop,
        left: element.scrollLeft,
      };
      scrollRestorationRef.current = position;
      if (onScroll) nativeScrollRef.current = position;
      pendingScrollRestorationRef.current = undefined;
      columnViewportSyncRef.current?.();
    }
    highlightColumn(columnIndex);
  }

  useImperativeHandle(ref, () => ({ scrollToColumn }));

  function sortColumn(columnIndex: number, extend = false): void {
    const column = resolvedColumns[columnIndex]!;
    const id = columnKey(column, columnIndex);
    const current = activeView.sorting.find(item => columnMatchesKey(column, columnIndex, item.column));
    if (!extend) {
      const nextSorting = current === undefined
        ? [{ column: id, descending: false }]
        : current.descending
          ? activeView.sorting.filter(item => !columnMatchesKey(column, columnIndex, item.column))
          : activeView.sorting.map(item => columnMatchesKey(column, columnIndex, item.column) ? { ...item, descending: true } : item);
      updateView({ sorting: nextSorting });
      return;
    }
    // Shift+Click adds another sort column, or cycles its direction without
    // discarding the other priority entries.
    const nextSorting = current === undefined
      ? [...activeView.sorting, { column: id, descending: false }]
      : current.descending
        ? activeView.sorting.filter(item => !columnMatchesKey(column, columnIndex, item.column))
        : activeView.sorting.map(item => columnMatchesKey(column, columnIndex, item.column) ? { ...item, descending: true } : item);
    updateView({ sorting: nextSorting });
  }
  sortColumnRef.current = sortColumn;

  function cancelHeaderSort(columnIndex: number): void {
    const timer = headerSortTimersRef.current.get(columnIndex);
    if (timer === undefined) return;
    clearTimeout(timer);
    headerSortTimersRef.current.delete(columnIndex);
  }

  /**
   * A header label is both a sort control and (when the host can insert into
   * an editor) the column-name insertion control. Pointer clicks are delayed so
   * the second click of a double-click can cancel the sort; keyboard activation
   * (`detail === 0`) still sorts immediately.
   */
  function handleHeaderLabelClick(event: ReactMouseEvent<HTMLButtonElement>, columnIndex: number): void {
    if (event.detail > 1) {
      cancelHeaderSort(columnIndex);
      return;
    }
    const extend = event.shiftKey;
    if (onInsertCellContent === undefined || event.detail === 0) {
      cancelHeaderSort(columnIndex);
      sortColumn(columnIndex, extend);
      return;
    }
    cancelHeaderSort(columnIndex);
    headerSortTimersRef.current.set(columnIndex, setTimeout(() => {
      headerSortTimersRef.current.delete(columnIndex);
      sortColumnRef.current(columnIndex, extend);
    }, HEADER_SINGLE_CLICK_DELAY_MS));
  }

  function handleHeaderLabelDoubleClick(event: ReactMouseEvent<HTMLButtonElement>, columnIndex: number): void {
    if (onInsertCellContent === undefined) return;
    cancelHeaderSort(columnIndex);
    const column = resolvedColumns[columnIndex];
    if (column === undefined) return;
    const sqlText = formatDataGridIdentifierForSql(column.name);
    if (!sqlText) return;
    event.preventDefault();
    event.stopPropagation();
    onInsertCellContent({
      text: column.name,
      sqlText,
    });
  }

  function filterColumn(columnIndex: number, value: string): void {
    const id = columnKey(resolvedColumns[columnIndex]!, columnIndex);
    const nextFilters = { ...activeView.columnFilters };
    if (value) nextFilters[id] = value;
    else delete nextFilters[id];
    const nextDefinitions = { ...(activeView.columnFilterDefinitions ?? {}) };
    delete nextDefinitions[id];
    updateView({
      columnFilters: nextFilters,
      ...(activeView.columnFilterDefinitions === undefined ? {} : { columnFilterDefinitions: nextDefinitions }),
    });
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

  function reorderColumn(columnIndex: number, targetIndex: number, after = false): void {
    const current = [...(activeView.columnOrder ?? resolvedColumns.map((_column, index) => columnKey(resolvedColumns[index]!, index)))];
    const sourceId = columnKey(resolvedColumns[columnIndex]!, columnIndex);
    const targetId = columnKey(resolvedColumns[targetIndex]!, targetIndex);
    const sourcePosition = current.indexOf(sourceId);
    const targetPosition = current.indexOf(targetId);
    if (sourcePosition < 0 || targetPosition < 0 || sourcePosition === targetPosition) return;
    current.splice(sourcePosition, 1);
    const insertion = sourcePosition < targetPosition ? targetPosition - 1 : targetPosition;
    current.splice(insertion + (after ? 1 : 0), 0, sourceId);
    updateView({ columnOrder: current });
  }

  function selectionPayload(): DataGridCopyPayload {
    // Legacy copies the bounding rectangle of a Ctrl+click selection, not just
    // the toggled cells, so copy/export stay identical between renderers.
    const selected = overallSelectionBounds(selection);
    const minRow = selected?.minRow ?? 0;
    const maxRow = selected?.maxRow ?? Math.max(0, processedRows.length - 1);
    const selectedRangeColumns = selection === undefined
      ? undefined
      : overallSelectionColumnRange(selection, visibleColumnIndexes);
    const selectedColumns = visibleColumnIndexes.filter((_columnIndex, position) =>
      selectedRangeColumns === undefined
      || (position >= selectedRangeColumns.minColumn && position <= selectedRangeColumns.maxColumn));
    const columnIndexes = selectedColumns.length > 0 ? selectedColumns : visibleColumnIndexes;
    const selectedRows = processedRows.slice(minRow, maxRow + 1).map(row => row.values);
    return { columns: columnIndexes.map(index => resolvedColumns[index]!), rows: selectedRows.map(row => columnIndexes.map(index => row[index])), selection, includeHeaders: true };
  }

  function copySelection(): void {
    const payload = selectionPayload();
    if (onCopySelection) {
      onCopySelection(payload);
      return;
    }
    void clipboardWriter?.(payload, 'text');
  }

  /**
   * Right-click does not create a cell range, so a context-menu export with
   * no active range falls back to the right-clicked row instead of silently
   * exporting every loaded row.
   */
  function contextRowPayload(): DataGridCopyPayload | undefined {
    const context = contextMenu;
    const row = context ? rows[context.rowIndex] : undefined;
    if (!context || !row) return undefined;
    const columnIndexes = visibleColumnIndexes;
    return { columns: columnIndexes.map(index => resolvedColumns[index]!), rows: [columnIndexes.map(index => row[index])], includeHeaders: true };
  }

  function exportSelection(format: 'csv' | 'json'): void {
    if (!onExportSelection) return;
    onExportSelection(overallSelectionBounds(selection) === undefined ? contextRowPayload() ?? selectionPayload() : selectionPayload(), format);
    setContextMenu(undefined);
  }

  function copyContextPayload(payload: DataGridCopyPayload, format: DataGridClipboardFormat = 'text'): void {
    if (onCopySelection) {
      // Pass the format explicitly: a host-level configured copy format must
      // not turn "Copy value" into a Markdown table.
      onCopySelection(payload, format);
      return;
    }
    void clipboardWriter?.(payload, format);
  }

  function copyContextValue(context: DataGridCellContext, row: readonly unknown[]): void {
    const column = resolvedColumns[context.columnIndex];
    if (!column) return;
    copyContextPayload({ columns: [column], rows: [[row[context.columnIndex]]], includeHeaders: false }, 'text');
    setContextMenu(undefined);
  }

  function copyContextRow(row: readonly unknown[]): void {
    const columnIndexes = visibleColumnIndexes;
    copyContextPayload({ columns: columnIndexes.map(index => resolvedColumns[index]!), rows: [columnIndexes.map(index => row[index])], includeHeaders: false }, 'tsv');
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

  function addDraggedGrouping(columnIndex: number): void {
    const column = resolvedColumns[columnIndex];
    if (!column) return;
    if (activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key))) return;
    updateView({ grouping: [...activeView.grouping, columnKey(column, columnIndex)] });
  }

  function groupingInsertionIndex(event: ReactDragEvent<HTMLElement>, targetIndex: number): number {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX > bounds.left + bounds.width / 2 ? targetIndex + 1 : targetIndex;
  }

  /**
   * Reveals the grouping panel only after the drag has actually started.
   * Inserting the panel synchronously from dragstart changes layout inside the
   * drag-start task, which makes Chromium cancel the drag; the panel then
   * disappears before the user can drop onto it.
   */
  function startHeaderColumnDrag(event: ReactDragEvent<HTMLElement>, columnIndex: number): void {
    draggedColumnRef.current = columnIndex;
    setColumnDropTarget(undefined);
    event.dataTransfer?.setData('application/x-justybase-column-index', String(columnIndex));
    event.dataTransfer?.setData('text/plain', String(columnIndex));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    if (headerDragRevealTimerRef.current !== undefined) {
      clearTimeout(headerDragRevealTimerRef.current);
    }
    headerDragRevealTimerRef.current = setTimeout(() => {
      headerDragRevealTimerRef.current = undefined;
      setDraggedHeaderColumn(columnIndex);
    }, 0);
  }

  function endHeaderColumnDrag(): void {
    if (headerDragRevealTimerRef.current !== undefined) {
      clearTimeout(headerDragRevealTimerRef.current);
      headerDragRevealTimerRef.current = undefined;
    }
    draggedColumnRef.current = undefined;
    setDraggedHeaderColumn(undefined);
    setColumnDropTarget(undefined);
  }

  function handleGroupingDragStart(event: ReactDragEvent<HTMLButtonElement>, groupingIndex: number): void {
    draggedGroupingRef.current = groupingIndex;
    setGroupingDropIndex(groupingIndex);
    event.dataTransfer?.setData('application/x-justybase-grouping-index', String(groupingIndex));
    event.dataTransfer?.setData('text/plain', activeView.grouping[groupingIndex] ?? '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function handleGroupingDragEnd(): void {
    draggedGroupingRef.current = undefined;
    setGroupingDropIndex(undefined);
  }

  function handleGroupingDrop(event: ReactDragEvent<HTMLElement>, targetIndex: number): void {
    event.preventDefault();
    event.stopPropagation();
    const dataIndex = event.dataTransfer?.getData('application/x-justybase-grouping-index');
    const parsedIndex = dataIndex === undefined || dataIndex === '' ? undefined : Number(dataIndex);
    const sourceIndex = draggedGroupingRef.current ?? (Number.isInteger(parsedIndex) ? parsedIndex : undefined);
    if (sourceIndex !== undefined) {
      const insertionIndex = groupingInsertionIndex(event, targetIndex);
      const nextGrouping = reorderDataGridGrouping(activeView.grouping, sourceIndex, insertionIndex);
      if (nextGrouping.length === activeView.grouping.length && nextGrouping.some((key, index) => key !== activeView.grouping[index])) {
        updateView({ grouping: nextGrouping });
      }
    } else if (draggedColumnRef.current !== undefined) {
      addDraggedGrouping(draggedColumnRef.current);
    }
    handleGroupingDragEnd();
    draggedColumnRef.current = undefined;
  }

  function removeGrouping(key: string): void {
    const columnIndex = resolveColumnIndex(resolvedColumns, key);
    const column = columnIndex >= 0 ? resolvedColumns[columnIndex] : undefined;
    updateView({ grouping: activeView.grouping.filter(item => column === undefined || !columnMatchesKey(column, columnIndex, item)) });
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
    const target = event.target;
    // Inline filter inputs and other form controls keep their native keys.
    if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable="true"]') !== null) return;
    const key = event.key;
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey && key.toLocaleLowerCase() === 'c') {
      event.preventDefault();
      copySelection();
      return;
    }
    if (commandKey && key.toLocaleLowerCase() === 'a') {
      const columns = visibleColumnIndexesRef.current;
      const rowCount = selectionMetricsRef.current.rowCount;
      if (columns.length === 0 || rowCount === 0) return;
      event.preventDefault();
      setSelectionValue({ anchorRow: 0, anchorColumn: columns[0]!, focusRow: rowCount - 1, focusColumn: columns[columns.length - 1]! });
      return;
    }
    if (key === 'Escape') {
      if (selectionRef.current === undefined) return;
      event.preventDefault();
      setSelectionValue(undefined);
      return;
    }
    if (key === 'Enter') {
      const current = selectionRef.current;
      if (current === undefined) return;
      if (visibleGroupedRows !== undefined) {
        const row = visibleGroupedRows[current.focusRow];
        if (row === undefined || row.kind !== 'data') return;
        event.preventDefault();
        onRowSelectRef.current?.(row.sourceIndex);
        return;
      }
      const row = processedRows[current.focusRow];
      if (row === undefined) return;
      event.preventDefault();
      onRowSelectRef.current?.(row.sourceIndex);
      return;
    }
    const columns = visibleColumnIndexesRef.current;
    const rowCount = selectionMetricsRef.current.rowCount;
    if (columns.length === 0 || rowCount === 0) return;
    const current = selectionRef.current;
    const currentPosition = current === undefined ? -1 : columns.indexOf(current.focusColumn);
    const fallbackRow = Math.min(rowCount - 1, Math.max(0, Math.floor((scroller.current?.scrollTop ?? 0) / ROW_HEIGHT)));
    const pageRows = Math.max(1, Math.floor(Math.max(ROW_HEIGHT, (scroller.current?.clientHeight || DEFAULT_VIEWPORT_HEIGHT) - columnHeaderHeightRef.current) / ROW_HEIGHT) - 1);
    const navigation = resolveDataGridNavigationTarget({
      key,
      row: current?.focusRow ?? fallbackRow,
      column: currentPosition >= 0 ? currentPosition : 0,
      rowCount,
      columnCount: columns.length,
      pageRows,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    if (navigation === undefined) return;
    event.preventDefault();
    const focusColumn = columns[Math.min(columns.length - 1, Math.max(0, navigation.column))]!;
    const anchorRow = navigation.extend && current !== undefined ? current.anchorRow : navigation.row;
    const anchorColumn = navigation.extend && current !== undefined ? current.anchorColumn : focusColumn;
    dragSelectingRef.current = false;
    setSelectionValue({ anchorRow, anchorColumn, focusRow: navigation.row, focusColumn });
    scrollCellIntoView(navigation.row, focusColumn);
    if (commandKey && (key === 'ArrowDown' || key === 'PageDown' || key === 'ArrowUp' || key === 'PageUp')) {
      const element = scroller.current;
      if (element) element.scrollTop = key === 'ArrowDown' || key === 'PageDown' ? element.scrollHeight : 0;
    } else if (commandKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const element = scroller.current;
      if (element) element.scrollLeft = key === 'ArrowRight' ? element.scrollWidth : 0;
    }
  }

  if (resolvedColumns.length === 0 || (rows.length === 0 && !hasMoreRows)) return <div className="ui-grid-empty" role="status">No rows to display.</div>;

  // Keep the legacy result-grid hook as a compatibility selector while the
  // shared class remains the styling/API identity for every host.
  const contextRow = contextMenu ? rows[contextMenu.rowIndex] : undefined;
  const contextColumn = contextMenu ? resolvedColumns[contextMenu.columnIndex] : undefined;

  const renderAggregationRow = (
    cells: readonly (DataGridAggregationCell | undefined)[],
    position: 'top' | 'bottom',
    rowIndex: number,
  ): ReactNode => {
    const cellsByColumn = new Map<number, DataGridAggregationCell | undefined>();
    visibleColumnIndexes.forEach((columnIndex, index) => cellsByColumn.set(columnIndex, cells[index]));
    return <tr className={`ui-data-grid-aggregation-row ui-data-grid-aggregation-row-${position}`} key={`aggregation:${position}:${rowIndex}`} data-aggregation-row={position}>
      <td className="ui-data-grid-row-number ui-data-grid-aggregation-rownum" aria-hidden="true" />
      {leftColumnSpacer > 0 && <td aria-hidden="true" className="ui-data-grid-column-spacer" style={{ width: leftColumnSpacer, minWidth: leftColumnSpacer }} />}
      {mountedColumns.map(entry => {
        const cell = cellsByColumn.get(entry.columnIndex);
        return <td
          key={`${entry.position}:${entry.key}:${rowIndex}`}
          className={entry.pinned ? 'ui-data-grid-pinned' : undefined}
          style={{ width: entry.width, minWidth: entry.width, ...(entry.left === undefined ? {} : { left: entry.left }) }}
        >
          {cell && <><span className="ui-data-grid-aggregation-label">{cell.label}</span><span className="ui-data-grid-aggregation-value">{cell.value}</span></>}
        </td>;
      })}
      {rightColumnSpacer > 0 && <td aria-hidden="true" className="ui-data-grid-column-spacer" style={{ width: rightColumnSpacer, minWidth: rightColumnSpacer }} />}
      <td aria-hidden="true" className="ui-data-grid-column-spacer ui-data-grid-fill-spacer" />
    </tr>;
  };

  return <div className={`ui-result-grid result-grid${onOpenColumnFilter && !showInlineColumnFilters ? ' ui-data-grid-compact' : ''}`} aria-busy={busy || undefined}>
    {showColumnMenu && <DataGridColumnMenu columns={resolvedColumns} view={activeView} onViewChange={updateView} />}
    {(showGroupingPanel || draggedHeaderColumn !== undefined) && <div
      className={`ui-data-grid-group-panel${activeView.grouping.length > 0 ? ' ui-data-grid-group-panel-active' : ''}${draggedHeaderColumn !== undefined ? ' ui-data-grid-group-panel-dragging' : ''}`}
      role="group"
      aria-label="Grouping panel"
      onDragOver={event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={event => {
        event.preventDefault();
        const source = draggedColumnRef.current;
        if (source !== undefined) addDraggedGrouping(source);
        endHeaderColumnDrag();
        draggedGroupingRef.current = undefined;
        setGroupingDropIndex(undefined);
      }}
    >
      <span className="ui-data-grid-group-panel-label">Group by</span>
      {activeView.grouping.map((key, groupingIndex) => {
        const columnIndex = resolveColumnIndex(resolvedColumns, key);
        const column = columnIndex >= 0 ? resolvedColumns[columnIndex] : undefined;
        const label = column?.name ?? key;
        const dropBefore = groupingDropIndex === groupingIndex;
        const dropAfter = groupingDropIndex === groupingIndex + 1;
        return <div
          className={`ui-data-grid-group-chip${dropBefore ? ' ui-data-grid-group-chip-drop-before' : ''}${dropAfter ? ' ui-data-grid-group-chip-drop-after' : ''}`}
          key={key}
          role="listitem"
          title={`${label} · grouping priority ${groupingIndex + 1}`}
          onDragOver={event => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setGroupingDropIndex(groupingInsertionIndex(event, groupingIndex));
          }}
          onDrop={event => handleGroupingDrop(event, groupingIndex)}
        >
          <button type="button" className="ui-data-grid-group-drag-handle" draggable aria-label={`Reorder grouping ${label}`} title={`Drag to change grouping priority for ${label}`} onDragStart={event => handleGroupingDragStart(event, groupingIndex)} onDragEnd={handleGroupingDragEnd}>⠿</button>
          <span>{label}</span>
          <button type="button" aria-label={`Remove grouping ${label}`} onClick={() => removeGrouping(key)}>×</button>
        </div>;
      })}
      <span className="ui-data-grid-group-panel-placeholder">{activeView.grouping.length > 0 ? 'Drag another column here' : (draggedHeaderColumn !== undefined ? 'Drop the column here to group' : 'Drag columns here to group')}</span>
    </div>}
    <div ref={scroller} className="ui-data-grid-scroll" onScroll={handleScroll} onDoubleClick={handleCellDoubleClick} onKeyDown={handleKeyDown} tabIndex={0} aria-label={`Data grid with ${totalRowCount} rows`}>
      {processedRows.length === 0 ? <div className="ui-grid-empty" role="status">No matching rows.{hasMoreRows && <button type="button" onClick={requestMoreRows}>Load more rows</button>}</div> : <table className="ui-data-grid" aria-rowcount={displayRowCount + 1} aria-colcount={visibleColumnIndexes.length + 1}>
        <thead><tr>
          <th scope="col" className="ui-data-grid-row-number ui-data-grid-select-all">
            <input
              type="checkbox"
              aria-label={allSelected ? 'Clear selection' : 'Select all rows'}
              title={allSelected ? 'Clear selection' : 'Select all rows'}
              checked={allSelected}
              ref={element => { if (element) element.indeterminate = selection !== undefined && !allSelected; }}
              onChange={() => {
                if (allSelected) {
                  setSelectionValue(undefined);
                  return;
                }
                if (visibleColumnIndexes.length === 0 || selectableRowCount === 0) return;
                setSelectionValue({
                  anchorRow: 0,
                  anchorColumn: visibleColumnIndexes[0]!,
                  focusRow: selectableRowCount - 1,
                  focusColumn: visibleColumnIndexes[visibleColumnIndexes.length - 1]!,
                });
              }}
            />
          </th>
          {leftColumnSpacer > 0 && <th aria-hidden="true" className="ui-data-grid-column-spacer" style={{ width: leftColumnSpacer, minWidth: leftColumnSpacer }} />}
          {mountedColumns.map(entry => {
            const columnIndex = entry.columnIndex;
            const column = resolvedColumns[columnIndex]!;
            const id = entry.key;
            const sort = activeView.sorting.find(item => columnMatchesKey(column, columnIndex, item.column));
            const filterActive = filterValue(activeView, column, columnIndex) !== '' || filterDefinition(activeView, column, columnIndex) !== undefined;
            return <th scope="col" key={`${entry.position}:${id}`} ref={element => { const refKey = `${id}:${columnIndex}`; if (element) columnHeaderRefs.current.set(refKey, element); else columnHeaderRefs.current.delete(refKey); }} className={[entry.pinned ? 'ui-data-grid-pinned' : '', columnDropTarget?.columnIndex === columnIndex ? (columnDropTarget.after ? 'ui-data-grid-column-drop-after' : 'ui-data-grid-column-drop-before') : ''].filter(Boolean).join(' ') || undefined} style={{ width: entry.width, minWidth: entry.width, ...(entry.left === undefined ? {} : { left: entry.left }) }} onDragOver={event => { if (draggedHeaderColumn === undefined) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; const rect = event.currentTarget.getBoundingClientRect(); setColumnDropTarget({ columnIndex, after: event.clientX > rect.left + rect.width / 2 }); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); const source = draggedColumnRef.current; if (source !== undefined) reorderColumn(source, columnIndex, columnDropTarget?.columnIndex === columnIndex ? columnDropTarget.after : false); endHeaderColumnDrag(); }}>
              <div className={highlightedColumn === columnIndex ? 'ui-data-grid-header-content ui-data-grid-column-highlight' : 'ui-data-grid-header-content'}>
                <button type="button" className="ui-data-grid-drag-handle" draggable aria-label={`Reorder ${column.name}`} title="Drag to reorder or to grouping panel" onDragStart={event => startHeaderColumnDrag(event, columnIndex)} onDragEnd={endHeaderColumnDrag}><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="currentColor"><circle cx="5" cy="4" r="1.1" /><circle cx="11" cy="4" r="1.1" /><circle cx="5" cy="8" r="1.1" /><circle cx="11" cy="8" r="1.1" /><circle cx="5" cy="12" r="1.1" /><circle cx="11" cy="12" r="1.1" /></svg></button>
                <button type="button" className="ui-data-grid-header-label" draggable onDragStart={event => startHeaderColumnDrag(event, columnIndex)} onDragEnd={endHeaderColumnDrag} onClick={event => handleHeaderLabelClick(event, columnIndex)} onDoubleClick={event => handleHeaderLabelDoubleClick(event, columnIndex)} title={`Sort by ${column.name}.${onInsertCellContent === undefined ? '' : ' Double-click to insert the column name into the SQL editor.'} Shift+Click to add another sort column. Drag to grouping panel.`}><span>{column.name}</span><span className="ui-data-grid-sort" aria-label={sort === undefined ? 'Not sorted' : `${sort.descending ? 'Sorted descending' : 'Sorted ascending'}${activeView.sorting.length > 1 ? `, priority ${activeView.sorting.findIndex(item => columnMatchesKey(column, columnIndex, item.column)) + 1}` : ''}`}>{sort?.descending ? '▼' : sort ? '▲' : '↕'}{sort !== undefined && activeView.sorting.length > 1 ? ` ${activeView.sorting.findIndex(item => columnMatchesKey(column, columnIndex, item.column)) + 1}` : ''}</span></button>
                <span className={`ui-data-grid-type-badge ui-data-grid-type-${typeBadgeClass(column)}`}>{typeBadge(column)}</span>
                {onOpenColumnFilter
                  ? <button type="button" className={`ui-data-grid-filter-action ${filterActive || columnAggregations(activeView, column, columnIndex).length > 0 ? 'active' : ''}`} aria-label={`Open filter for ${column.name}`} title={`Filter and summarize ${column.name}`} onClick={event => { event.stopPropagation(); onOpenColumnFilter({ columnIndex, column, anchor: event.currentTarget.getBoundingClientRect() }); }}><DataGridFilterIcon /></button>
                  : <button type="button" className={`ui-data-grid-aggregation-action ${columnAggregations(activeView, column, columnIndex).length > 0 ? 'active' : ''}`} aria-label={`Aggregate ${column.name}`} title="Aggregate column" onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setAggregationMenu({ columnIndex, left: Math.max(8, Math.min(rect.left, window.innerWidth - 292)), top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 430)) }); }}><MenuIcon name="bar-chart" /></button>}
                <button type="button" className={`ui-data-grid-header-action ${entry.pinned ? 'active' : ''}`} aria-label={entry.pinned ? `Unpin ${column.name}` : `Pin ${column.name}`} title={entry.pinned ? 'Unpin column' : 'Pin column'} onClick={() => togglePin(columnIndex)}><MenuIcon name="pin" /></button>
                {(!onOpenColumnFilter || showInlineColumnFilters) && <input className="ui-data-grid-column-filter" aria-label={`Filter ${column.name}`} placeholder="filter…" value={filterValue(activeView, column, columnIndex)} onChange={event => filterColumn(columnIndex, event.target.value)} />}
                <button type="button" className="ui-data-grid-group-action" aria-label={activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key)) ? `Ungroup ${column.name}` : `Group by ${column.name}`} title={activeView.grouping.some(key => columnMatchesKey(column, columnIndex, key)) ? 'Remove grouping' : 'Group by column'} onClick={() => { const grouping = activeView.grouping.filter(key => !columnMatchesKey(column, columnIndex, key)); if (grouping.length === activeView.grouping.length) grouping.push(id); updateView({ grouping }); }}><MenuIcon name="layers" /></button>
                <span className="ui-data-grid-resizer" role="separator" aria-label={`Resize ${column.name}`} title="Drag to resize; double-click to fit" onMouseDown={event => { event.preventDefault(); event.stopPropagation(); resizeRef.current = { columnId: id, startX: event.clientX, startWidth: entry.width }; }} onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); autoFitColumn(columnIndex); }} />
              </div>
            </th>;
          })}
          {rightColumnSpacer > 0 && <th aria-hidden="true" className="ui-data-grid-column-spacer" style={{ width: rightColumnSpacer, minWidth: rightColumnSpacer }} />}
          <th aria-hidden="true" className="ui-data-grid-column-spacer ui-data-grid-fill-spacer" />
        </tr>
        {columnAggregationRows.top.map((cells, rowIndex) => renderAggregationRow(cells, 'top', rowIndex))}
        </thead>
        <tbody>
          {virtualTopSpacer > 0 && <tr className="ui-data-grid-virtual-spacer" aria-hidden="true"><td colSpan={mountedCellCount}><div className="ui-data-grid-virtual-spacer-inner" style={{ height: virtualTopSpacer }} /></td></tr>}
          {virtualItems.map(item => {
            const flatRow = processedRows[item.index];
            const rendered: RenderedRow | undefined = visibleGroupedRows === undefined
              ? flatRow === undefined ? undefined : { ...flatRow, kind: 'data' as const, displayIndex: item.index, ancestorIds: [] }
              : visibleGroupedRows[item.index];
            if (rendered === undefined) return null;
            if (rendered.kind === 'group') {
              const expanded = expandedGroups.has(rendered.id);
              // The whole band label is the toggle. A separate chevron button
              // would leave the visible name inert, which reads as a bug when
              // the band highlights on hover.
              return <tr className="ui-data-grid-group-row" data-group-id={rendered.id} data-group-level={rendered.level} aria-level={rendered.level + 1} key={`group:${rendered.id}`}>
                <th scope="row" className="ui-data-grid-row-number ui-data-grid-group-row-number" aria-label={`Group starting at row ${rendered.rowNumber}`}><span aria-hidden="true">{rendered.rowNumber}</span></th>
                <td className="ui-data-grid-group-cell" colSpan={mountedCellCount - 1}>
                  <div className="ui-data-grid-group-content">
                    <span className="ui-data-grid-group-tree-indent" aria-hidden="true">{Array.from({ length: rendered.level }, (_value, level) => <span key={level} />)}</span>
                    <button
                      type="button"
                      className="ui-data-grid-group-toggle"
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} group ${rendered.label}`}
                      aria-expanded={expanded}
                      title={rendered.unloaded ? 'Rows for this group are not in the loaded window' : undefined}
                      onClick={() => setExpandedGroups(previous => {
                        const next = new Set(previous);
                        if (expanded) next.delete(rendered.id); else next.add(rendered.id);
                        return next;
                      })}
                    >
                      <span className="ui-data-grid-group-marker" aria-hidden="true" />
                      <span className="ui-data-grid-group-label">{rendered.label}</span>
                      <span className="ui-data-grid-group-count">{rendered.partial ? '~' : ''}{rendered.count.toLocaleString()} rows</span>
                    </button>
                  </div>
                </td>
              </tr>;
            }
            return <DataGridRow
              key={`${resultSetId}:${rendered.sourceIndex}`}
              resultSetId={resultSetId}
              displayIndex={rendered.displayIndex}
              sourceIndex={rendered.sourceIndex}
              values={rendered.values}
              columns={mountedColumns}
              resolvedColumns={resolvedColumns}
              getCellMetadata={getCellMetadata}
              getColumnFormatting={getColumnFormatting}
              deleted={isRowDeleted?.(rendered.sourceIndex) === true}
              hostSelected={selectedRowIndex === rendered.sourceIndex}
              selectionRanges={selectionRangesForRow(rendered.displayIndex)}
              focusRow={selection?.focusRow}
              focusColumn={displayFocusColumn}
              leftSpacer={leftColumnSpacer}
              rightSpacer={rightColumnSpacer}
              onRowClick={handleRowClick}
              onRowNumberClick={handleRowClick}
              onRowNumberMouseDown={handleRowNumberMouseDown}
              onRowNumberEnter={handleRowNumberEnter}
              onCellMouseDown={handleCellMouseDown}
              onCellMouseEnter={handleCellMouseEnter}
              onCellContextMenu={handleCellContextMenu}
            />;
          })}
          {virtualBottomSpacer > 0 && <tr className="ui-data-grid-virtual-spacer" aria-hidden="true"><td colSpan={mountedCellCount}><div className="ui-data-grid-virtual-spacer-inner" style={{ height: virtualBottomSpacer }} /></td></tr>}
        </tbody>
        {columnAggregationRows.bottom.length > 0 && <tfoot>{columnAggregationRows.bottom.map((cells, rowIndex) => renderAggregationRow(cells, 'bottom', rowIndex))}</tfoot>}
      </table>}
      {activeCellEditor && <DataGridInlineEditor
        {...activeCellEditor}
        onCommit={value => {
          onCellEdit?.({
            rowIndex: activeCellEditor.rowIndex,
            columnIndex: activeCellEditor.columnIndex,
            oldValue: activeCellEditor.oldValue,
            newValue: value,
          });
          setActiveCellEditor(undefined);
        }}
        onCancel={() => setActiveCellEditor(undefined)}
      />}
    </div>
    {aggregationMenu && (() => {
      const column = resolvedColumns[aggregationMenu.columnIndex];
      if (!column) return null;
      const current = columnAggregations(activeView, column, aggregationMenu.columnIndex);
      const position = current[0]?.position ?? 'bottom';
      return <div className="ui-data-grid-aggregation-menu" role="menu" aria-label={`Aggregations for ${column.name}`} style={{ left: aggregationMenu.left, top: aggregationMenu.top }} onMouseDown={event => event.stopPropagation()}>
        <strong className="ui-data-grid-aggregation-menu-title">Aggregate {column.name}</strong>
        <small className="ui-data-grid-aggregation-menu-hint">Calculated from the filtered loaded rows.</small>
        <div className="ui-data-grid-aggregation-options">
          {(Object.keys(AGGREGATION_FUNCTION_LABELS) as UiResultAggregationFunction[]).map(fn => <label key={fn}>
            <input type="checkbox" checked={current.some(entry => entry.fn === fn)} onChange={() => toggleColumnAggregation(aggregationMenu.columnIndex, fn)} />
            <span className="ui-data-grid-aggregation-symbol" aria-hidden="true">{AGGREGATION_LABELS[fn]}</span>
            <span>{AGGREGATION_FUNCTION_LABELS[fn]}</span>
          </label>)}
        </div>
        <div className="ui-data-grid-aggregation-position">
          <span>Position</span>
          <button type="button" aria-pressed={position === 'bottom'} onClick={() => setColumnAggregationPosition(aggregationMenu.columnIndex, 'bottom')}>Bottom</button>
          <button type="button" aria-pressed={position === 'top'} onClick={() => setColumnAggregationPosition(aggregationMenu.columnIndex, 'top')}>Top</button>
        </div>
        <div className="ui-data-grid-aggregation-actions">
          <button type="button" disabled={current.length === 0} onClick={() => clearColumnAggregations(aggregationMenu.columnIndex)}>Clear</button>
          <button type="button" onClick={() => setAggregationMenu(undefined)}>Done</button>
        </div>
      </div>;
    })()}
    {showContextMenu && contextMenu && contextRow && contextColumn && <div ref={contextMenuElementRef} className="ui-data-grid-context-menu" role="menu" aria-label={`Actions for row ${contextMenu.rowIndex + 1}`} style={{ left: contextMenuPosition.left, top: contextMenuPosition.top }} onClick={event => event.stopPropagation()}>
      <strong>{contextColumn.name}</strong>
      <button type="button" role="menuitem" onClick={() => copyContextValue(contextMenu, contextRow)}><MenuIcon name="copy" />Copy value</button>
      {onColumnAction && <button type="button" role="menuitem" onClick={() => { onColumnAction(contextMenu, 'copyName'); setContextMenu(undefined); }}><MenuIcon name="copy" />Copy Name</button>}
      {onColumnAction && catalogBound && <button type="button" role="menuitem" onClick={() => { onColumnAction(contextMenu, 'copyQualifiedName'); setContextMenu(undefined); }}><MenuIcon name="clipboard-copy" />Copy Qualified Name</button>}
      {onColumnAction && <button type="button" role="menuitem" onClick={() => { onColumnAction(contextMenu, 'addToSelect'); setContextMenu(undefined); }}><MenuIcon name="plus" />Add to SELECT</button>}
      {onOpenColumnFilter && <button type="button" role="menuitem" onClick={() => { const anchor = contextMenuElementRef.current?.getBoundingClientRect() ?? new DOMRect(contextMenu.clientX, contextMenu.clientY, 0, 0); onOpenColumnFilter({ columnIndex: contextMenu.columnIndex, column: contextColumn, anchor }); setContextMenu(undefined); }}><MenuIcon name="check-square" />Select Distinct</button>}
      {onProfileColumn && <button type="button" role="menuitem" onClick={() => { onProfileColumn(contextMenu); setContextMenu(undefined); }}><MenuIcon name="bar-chart" />Profile Column</button>}
      {onColumnAction && catalogBound && <button type="button" role="menuitem" onClick={() => { onColumnAction(contextMenu, 'commentOnColumn'); setContextMenu(undefined); }}><MenuIcon name="message-square" />Comment on Column…</button>}
      {onColumnAction && catalogBound && <button type="button" role="menuitem" onClick={() => { onColumnAction(contextMenu, 'findReferences'); setContextMenu(undefined); }}><MenuIcon name="git-branch" />Find References</button>}
      {onColumnAction && catalogBound && <button type="button" role="menuitem" onClick={() => { onColumnAction(contextMenu, 'toggleFavorite'); setContextMenu(undefined); }}><MenuIcon name="star" />Add to favorites</button>}
      <button type="button" role="menuitem" onClick={() => copyContextRow(contextRow)}><MenuIcon name="rows" />Copy row</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('tsv')}><MenuIcon name="file-spreadsheet" />Copy row as TSV</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('markdown')}><MenuIcon name="file-text" />Copy row as Markdown</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('json')}><MenuIcon name="braces" />Copy row as JSON</button>
      <button type="button" role="menuitem" onClick={() => copyContextRowAs('sql')}><MenuIcon name="database" />Copy SQL INSERT</button>
      {onExportSelection && <button type="button" role="menuitem" onClick={() => exportSelection('csv')}><MenuIcon name="download" />Export selection as CSV</button>}
      {onExportSelection && <button type="button" role="menuitem" onClick={() => exportSelection('json')}><MenuIcon name="download" />Export selection as JSON</button>}
      <hr />
      <button type="button" role="menuitem" onClick={() => filterContextValue(contextMenu, contextRow)}><MenuIcon name="filter" />Filter by this value</button>
      <button type="button" role="menuitem" onClick={() => clearContextFilter(contextMenu.columnIndex)}><MenuIcon name="filter-x" />Clear Filter</button>
      <button type="button" role="menuitem" onClick={() => sortContextValue(contextMenu.columnIndex, false)}><MenuIcon name="arrow-up" />Sort ascending</button>
      <button type="button" role="menuitem" onClick={() => sortContextValue(contextMenu.columnIndex, true)}><MenuIcon name="arrow-down" />Sort descending</button>
      <button type="button" role="menuitem" onClick={() => toggleContextGrouping(contextMenu.columnIndex)}><MenuIcon name="layers" />{activeView.grouping.some(key => columnMatchesKey(contextColumn, contextMenu.columnIndex, key)) ? 'Ungroup This Column' : 'Group by This Column'}</button>
      <button type="button" role="menuitem" onClick={() => hideContextColumn(contextMenu.columnIndex)}><MenuIcon name="eye-off" />Hide Column</button>
      <hr />
      {onDeleteRow && <button type="button" role="menuitem" onClick={() => { onDeleteRow(contextMenu.rowIndex); setContextMenu(undefined); }}><MenuIcon name="trash" />{isRowDeleted?.(contextMenu.rowIndex) ? 'Restore row' : 'Delete row'}</button>}
      <button type="button" role="menuitem" onClick={() => selectContextRow(contextMenu)}><MenuIcon name="panel-right" />View full row</button>
      {onViewCell && <button type="button" role="menuitem" onClick={() => viewContextCell(contextMenu)}><MenuIcon name="eye" />View Cell Value</button>}
      {onOpenResultFormatting && <button type="button" role="menuitem" onClick={() => { onOpenResultFormatting(); setContextMenu(undefined); }}><MenuIcon name="wrench" />Result Formatting…</button>}
      {onEditRow && <button type="button" role="menuitem" onClick={() => { onEditRow(contextMenu); setContextMenu(undefined); }}><MenuIcon name="pencil" />Edit row…</button>}
    </div>}
  </div>;
});

/**
 * Canonical result-grid name for new consumers. DataGrid remains exported as a
 * compatibility name because the first shared UI slices already consume it.
 */
export function ResultGrid(props: DataGridProps): ReactNode {
  return <DataGrid {...props} />;
}
