import type { DataGridCellMetadata } from './resultGridFormatting';

/** Public column metadata shared by the grid and its clipboard formatter. */
export interface DataGridColumn extends DataGridCellMetadata {
  readonly name: string;
}

export interface DataGridSelection {
  readonly anchorRow: number;
  readonly anchorColumn: number;
  readonly focusRow: number;
  readonly focusColumn: number;
}

export interface DataGridCopyPayload {
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly selection?: DataGridSelection;
  /** Whether the receiving clipboard adapter should include column headers. */
  readonly includeHeaders?: boolean;
}
