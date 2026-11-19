import type { DataGridCellMetadata } from './resultGridFormatting';

/** Public column metadata shared by the grid and its clipboard formatter. */
export interface DataGridColumn extends DataGridCellMetadata {
  readonly name: string;
}

export interface DataGridSelectionRange {
  readonly minRow: number;
  readonly maxRow: number;
  readonly minColumn: number;
  readonly maxColumn: number;
}

export interface DataGridSelection {
  readonly anchorRow: number;
  readonly anchorColumn: number;
  readonly focusRow: number;
  readonly focusColumn: number;
  /**
   * Discontiguous rectangles added with Ctrl/Cmd+click. The primary
   * anchor/focus rectangle remains the keyboard and shift-extend target.
   */
  readonly additionalRanges?: readonly DataGridSelectionRange[];
}

export interface DataGridCopyPayload {
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly selection?: DataGridSelection;
  /** Whether the receiving clipboard adapter should include column headers. */
  readonly includeHeaders?: boolean;
}
