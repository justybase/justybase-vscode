/**
 * Renderer-neutral selection geometry for result grids.
 *
 * Both the shared React grid and the legacy DOM grid use the same range
 * primitives, so copy bounds, row selection and column-range projection cannot
 * drift between renderers.
 */

export interface UiGridSelection {
  readonly anchorRow: number;
  readonly anchorColumn: number;
  readonly focusRow: number;
  readonly focusColumn: number;
}

export interface UiGridSelectionBounds {
  readonly minRow: number;
  readonly maxRow: number;
  readonly minColumn: number;
  readonly maxColumn: number;
}

/** Bounding rectangle for an anchor/focus selection. */
export function normalizeGridSelection(selection: UiGridSelection | undefined): UiGridSelectionBounds | undefined {
  if (!selection) return undefined;
  return {
    minRow: Math.min(selection.anchorRow, selection.focusRow),
    maxRow: Math.max(selection.anchorRow, selection.focusRow),
    minColumn: Math.min(selection.anchorColumn, selection.focusColumn),
    maxColumn: Math.max(selection.anchorColumn, selection.focusColumn),
  };
}

/** Projects an anchor/focus selection onto display-order column positions. */
export function gridSelectionColumnRange(
  selection: UiGridSelection | undefined,
  visibleColumnIndexes: readonly number[],
): { readonly minColumn: number; readonly maxColumn: number } | undefined {
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

export function gridSelectionContains(bounds: UiGridSelectionBounds | undefined, row: number, column: number): boolean {
  return bounds !== undefined
    && row >= bounds.minRow
    && row <= bounds.maxRow
    && column >= bounds.minColumn
    && column <= bounds.maxColumn;
}

export interface ParsedGridCellId {
  readonly row: number;
  readonly column: number;
}

/** Parses the legacy `row-col` cell identity used by the DOM grid. */
export function parseGridCellId(cellId: string): ParsedGridCellId | null {
  const parts = cellId.split('-');
  if (parts.length !== 2) return null;
  const row = Number(parts[0]);
  const column = Number(parts[1]);
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) return null;
  return { row, column };
}

export function formatGridCellId(row: number, column: number): string {
  return `${row}-${column}`;
}

/** Bounding rectangle over a set of `row-col` cell ids. Returns null when empty or unparseable. */
export function getGridSelectionBounds(cells: ReadonlySet<string>): UiGridSelectionBounds | null {
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minColumn = Infinity;
  let maxColumn = -Infinity;
  let found = false;
  cells.forEach(cellId => {
    const parsed = parseGridCellId(cellId);
    if (!parsed) return;
    found = true;
    if (parsed.row < minRow) minRow = parsed.row;
    if (parsed.row > maxRow) maxRow = parsed.row;
    if (parsed.column < minColumn) minColumn = parsed.column;
    if (parsed.column > maxColumn) maxColumn = parsed.column;
  });
  if (!found) return null;
  return { minRow, maxRow, minColumn, maxColumn };
}

/** Unique row indices referenced by a set of `row-col` cell ids. */
export function getSelectedGridRowIndices(cells: ReadonlySet<string>): Set<number> {
  const rows = new Set<number>();
  cells.forEach(cellId => {
    const parsed = parseGridCellId(cellId);
    if (parsed) rows.add(parsed.row);
  });
  return rows;
}
