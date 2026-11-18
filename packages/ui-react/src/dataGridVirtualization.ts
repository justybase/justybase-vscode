/**
 * Geometry and keyboard math for the shared result grid.
 *
 * The grid contract is a fixed body-row height (`DATA_GRID_ROW_HEIGHT`).
 * Data, group and row-detail rows share that height, so the virtualizer uses
 * estimates without DOM measurement and stored scroll anchors stay exact.
 * Do not render variable-height body rows inside the shared grid.
 *
 * Keeping these calculations pure makes the large-result behaviour testable in
 * Node and leaves the React renderer responsible only for applying a window.
 */

export const DATA_GRID_ROW_HEIGHT = 26;
export const DATA_GRID_COLUMN_HEADER_HEIGHT = 62;
export const DATA_GRID_COMPACT_COLUMN_HEADER_HEIGHT = 42;
export const DATA_GRID_DEFAULT_VIEWPORT_HEIGHT = 480;
export const DATA_GRID_DEFAULT_VIEWPORT_WIDTH = 960;
export const DATA_GRID_ROW_NUMBER_WIDTH = 48;
export const DATA_GRID_VIRTUAL_OVERSCAN_ROWS = 8;
/** Columns below this count are always rendered; wide results are windowed. */
export const DATA_GRID_COLUMN_WINDOW_THRESHOLD = 24;
export const DATA_GRID_COLUMN_OVERSCAN = 2;

/**
 * Restores a persisted position without losing the logical row anchor after
 * the compact-grid migration. New positions carry their geometry and retain
 * the exact pixel offset; older positions are reconstructed from anchorRow.
 */
export function resolveDataGridScrollTop(top: number, anchorRow?: number, rowHeight?: number): number {
  const safeTop = Math.max(0, Number.isFinite(top) ? top : 0);
  const safeAnchor = Number.isInteger(anchorRow) && (anchorRow ?? 0) > 0 ? anchorRow : undefined;
  if (safeAnchor === undefined || rowHeight === DATA_GRID_ROW_HEIGHT) return safeTop;
  return safeAnchor * DATA_GRID_ROW_HEIGHT;
}

export interface DataGridVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

export function calculateDataGridVirtualWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  overscanRows = DATA_GRID_VIRTUAL_OVERSCAN_ROWS,
  headerHeight = 0,
): DataGridVirtualWindow {
  const count = Math.max(0, Math.trunc(rowCount));
  if (count === 0) return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewportHeight = Math.max(DATA_GRID_ROW_HEIGHT, Number.isFinite(viewportHeight) ? viewportHeight : DATA_GRID_DEFAULT_VIEWPORT_HEIGHT);
  const safeOverscan = Math.max(0, Math.trunc(overscanRows));
  const safeHeaderHeight = Math.max(0, Number.isFinite(headerHeight) ? headerHeight : 0);
  // The table header is part of the scroll content but remains sticky at the
  // top of the scroller. Row zero therefore starts at `headerHeight`, while
  // row N still has a logical scroll coordinate of N * ROW_HEIGHT.
  const contentViewportHeight = Math.max(DATA_GRID_ROW_HEIGHT, safeViewportHeight - safeHeaderHeight);
  const firstVisible = Math.min(count - 1, Math.floor(safeScrollTop / DATA_GRID_ROW_HEIGHT));
  const visibleRows = Math.max(1, Math.ceil(contentViewportHeight / DATA_GRID_ROW_HEIGHT));
  const startIndex = Math.max(0, firstVisible - safeOverscan);
  const endIndex = Math.min(count, firstVisible + visibleRows + safeOverscan);
  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * DATA_GRID_ROW_HEIGHT,
    paddingBottom: Math.max(0, count - endIndex) * DATA_GRID_ROW_HEIGHT,
  };
}

export interface DataGridColumnWindow {
  /** First rendered non-pinned column index (in display order). */
  readonly startIndex: number;
  /** One past the last rendered non-pinned column index. */
  readonly endIndex: number;
  /** Width of the skipped non-pinned columns before the window. */
  readonly paddingLeft: number;
  /** Width of the skipped non-pinned columns after the window. */
  readonly paddingRight: number;
  /** False when every column is mounted and the host should not add spacers. */
  readonly windowed: boolean;
}

/**
 * Calculates the mounted column window for wide result sets.
 *
 * Pinned columns are always mounted, so the window indexes only describe the
 * scrollable tail. Spacer widths preserve the full table extent and therefore
 * the native horizontal scrollbar.
 */
export function calculateDataGridColumnWindow(
  columnWidths: readonly number[],
  scrollLeft: number,
  viewportWidth: number,
  pinnedCount: number,
  rowNumberWidth = DATA_GRID_ROW_NUMBER_WIDTH,
  overscanColumns = DATA_GRID_COLUMN_OVERSCAN,
  threshold = DATA_GRID_COLUMN_WINDOW_THRESHOLD,
): DataGridColumnWindow {
  const count = columnWidths.length;
  if (count === 0) return { startIndex: 0, endIndex: 0, paddingLeft: 0, paddingRight: 0, windowed: false };
  const pinned = Math.min(count, Math.max(0, Math.trunc(pinnedCount)));
  if (count <= Math.max(0, Math.trunc(threshold))) {
    return { startIndex: pinned, endIndex: count, paddingLeft: 0, paddingRight: 0, windowed: false };
  }
  const safeRowNumberWidth = Math.max(0, Number.isFinite(rowNumberWidth) ? rowNumberWidth : DATA_GRID_ROW_NUMBER_WIDTH);
  const safeScrollLeft = Math.max(0, Number.isFinite(scrollLeft) ? scrollLeft : 0);
  const safeViewportWidth = Math.max(1, Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : DATA_GRID_DEFAULT_VIEWPORT_WIDTH);
  const safeOverscan = Math.max(0, Math.trunc(overscanColumns));

  const prefix: number[] = new Array(count);
  let totalWidth = 0;
  for (let index = 0; index < count; index += 1) {
    prefix[index] = totalWidth;
    totalWidth += Math.max(0, columnWidths[index] ?? 0);
  }
  let pinnedWidth = 0;
  for (let index = 0; index < pinned; index += 1) pinnedWidth += Math.max(0, columnWidths[index] ?? 0);

  // Content coordinates include the sticky row-number gutter and the pinned
  // block, both of which cover scrolled content on the left.
  const viewStart = safeScrollLeft + safeRowNumberWidth + pinnedWidth;
  const viewEnd = safeScrollLeft + safeViewportWidth;

  let start = pinned;
  while (start < count && prefix[start]! + Math.max(0, columnWidths[start] ?? 0) <= viewStart) start += 1;
  let end = start;
  while (end < count && prefix[end]! < viewEnd) end += 1;

  const overscanStart = Math.max(pinned, start - safeOverscan);
  const overscanEnd = Math.min(count, Math.max(end, start) + safeOverscan);
  const windowed = overscanStart > pinned || overscanEnd < count;
  if (!windowed) return { startIndex: pinned, endIndex: count, paddingLeft: 0, paddingRight: 0, windowed: false };

  const paddingLeft = Math.max(0, prefix[overscanStart]! - pinnedWidth);
  const paddingRight = Math.max(0, totalWidth - (overscanEnd < count ? prefix[overscanEnd]! : totalWidth));
  return { startIndex: overscanStart, endIndex: overscanEnd, paddingLeft, paddingRight, windowed };
}

export interface DataGridNavigationRequest {
  readonly key: string;
  readonly row: number;
  /** Column position in display order, not the raw column index. */
  readonly column: number;
  readonly rowCount: number;
  readonly columnCount: number;
  /** Number of body rows that fit under the sticky header. */
  readonly pageRows: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface DataGridNavigationTarget {
  readonly row: number;
  /** Column position in display order. */
  readonly column: number;
  readonly extend: boolean;
}

/**
 * Maps Excel-style navigation keys to a clamped cell target.
 *
 * Returns undefined for keys that are not grid navigation so callers can leave
 * them to the webview (Tab must still move focus out of the grid).
 */
export function resolveDataGridNavigationTarget(request: DataGridNavigationRequest): DataGridNavigationTarget | undefined {
  const rowCount = Math.max(0, Math.trunc(request.rowCount));
  const columnCount = Math.max(0, Math.trunc(request.columnCount));
  if (rowCount === 0 || columnCount === 0) return undefined;
  const lastRow = rowCount - 1;
  const lastColumn = columnCount - 1;
  const row = Math.min(lastRow, Math.max(0, Math.trunc(request.row)));
  const column = Math.min(lastColumn, Math.max(0, Math.trunc(request.column)));
  const pageRows = Math.max(1, Math.trunc(request.pageRows));
  const extend = request.shiftKey === true;
  const commandKey = request.ctrlKey === true || request.metaKey === true;
  const verticalJump = commandKey ? (request.key === 'ArrowUp' || request.key === 'PageUp' ? 0 : request.key === 'ArrowDown' || request.key === 'PageDown' ? lastRow : undefined) : undefined;

  switch (request.key) {
    case 'ArrowUp':
      return { row: verticalJump ?? Math.max(0, row - 1), column, extend };
    case 'ArrowDown':
      return { row: verticalJump ?? Math.min(lastRow, row + 1), column, extend };
    case 'ArrowLeft':
      return { row, column: commandKey ? 0 : Math.max(0, column - 1), extend };
    case 'ArrowRight':
      return { row, column: commandKey ? lastColumn : Math.min(lastColumn, column + 1), extend };
    case 'PageUp':
      return { row: verticalJump ?? Math.max(0, row - pageRows), column, extend };
    case 'PageDown':
      return { row: verticalJump ?? Math.min(lastRow, row + pageRows), column, extend };
    case 'Home':
      return commandKey ? { row: 0, column: 0, extend } : { row, column: 0, extend };
    case 'End':
      return commandKey ? { row: lastRow, column: lastColumn, extend } : { row, column: lastColumn, extend };
    default:
      return undefined;
  }
}
