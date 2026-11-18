import { memo, useMemo } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { formatDataGridCellValue, isDataGridNumericColumn, isDataGridTemporalColumn } from './resultGridFormatting';
import type { DataGridCellMetadata } from './resultGridFormatting';
import type { DataGridColumn } from './dataGridTypes';

/** Mounted column geometry shared by every rendered row. */
export interface DataGridColumnLayout {
  readonly columnIndex: number;
  /** Position in display order, used by range selection. */
  readonly position: number;
  readonly key: string;
  readonly pinned: boolean;
  /** Sticky offset from the left edge, for pinned columns only. */
  readonly left?: number;
  /** Absolute table offset, used when scrolling a keyboard target into view. */
  readonly offset: number;
  readonly width: number;
}

export type DataGridCellMetadataResolver = (
  value: unknown,
  rowIndex: number,
  columnIndex: number,
  column: DataGridColumn,
) => DataGridCellMetadata;

interface PreparedCell {
  readonly key: string;
  readonly columnIndex: number;
  readonly position: number;
  readonly pinned: boolean;
  readonly left?: number;
  readonly text: string;
  /** Classes that do not depend on the current selection. */
  readonly className: string;
}

export interface DataGridRowProps {
  readonly resultSetId: string;
  readonly displayIndex: number;
  readonly sourceIndex: number;
  readonly values: readonly unknown[];
  readonly columns: readonly DataGridColumnLayout[];
  readonly resolvedColumns: readonly DataGridColumn[];
  readonly getCellMetadata?: DataGridCellMetadataResolver;
  readonly hostSelected: boolean;
  /** True only for rows inside the current selection range. */
  readonly rowInSelection: boolean;
  readonly selectionMinColumn: number;
  readonly selectionMaxColumn: number;
  /** Width of skipped columns before/after the mounted window. */
  readonly leftSpacer: number;
  readonly rightSpacer: number;
  readonly onRowClick: (sourceIndex: number) => void;
  readonly onRowNumberClick: (sourceIndex: number) => void;
  /** Starts a whole-row selection drag from the row-number gutter. */
  readonly onRowNumberMouseDown: (displayIndex: number, event: ReactMouseEvent<HTMLElement>) => void;
  /** Extends an active drag to the first mounted column. */
  readonly onRowNumberEnter: (displayIndex: number) => void;
  readonly onCellMouseDown: (displayIndex: number, columnIndex: number, event: ReactMouseEvent<HTMLElement>) => void;
  readonly onCellMouseEnter: (displayIndex: number, columnIndex: number) => void;
  readonly onCellContextMenu: (sourceIndex: number, columnIndex: number, event: ReactMouseEvent<HTMLElement>) => void;
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

function prepareRowLabel(
  values: readonly unknown[],
  resolvedColumns: readonly DataGridColumn[],
  getCellMetadata: DataGridCellMetadataResolver | undefined,
  sourceIndex: number,
): string {
  let label = '';
  for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
    const column = resolvedColumns[columnIndex];
    const value = values[columnIndex];
    const metadata = column === undefined ? undefined : getCellMetadata?.(value, sourceIndex, columnIndex, column) ?? column;
    const text = formatDataGridCellValue(value, metadata?.type, metadata);
    label = columnIndex === 0 ? text : `${label} ${text}`;
  }
  return label;
}

function prepareCells(
  values: readonly unknown[],
  columns: readonly DataGridColumnLayout[],
  resolvedColumns: readonly DataGridColumn[],
  getCellMetadata: DataGridCellMetadataResolver | undefined,
  sourceIndex: number,
): readonly PreparedCell[] {
  return columns.map(layout => {
    const column = resolvedColumns[layout.columnIndex]!;
    const value = values[layout.columnIndex];
    const metadata = getCellMetadata?.(value, sourceIndex, layout.columnIndex, column) ?? column;
    const displayValue = formatDataGridCellValue(value, metadata.type, metadata);
    return {
      key: `${layout.position}:${layout.key}`,
      columnIndex: layout.columnIndex,
      position: layout.position,
      pinned: layout.pinned,
      left: layout.left,
      text: displayValue,
      className: [
        layout.pinned ? 'ui-data-grid-pinned' : '',
        `ui-data-grid-value-${valueClass(value, metadata)}`,
        isDataGridNumericColumn(metadata) ? 'ui-data-grid-cell-numeric' : '',
      ].filter(Boolean).join(' '),
    };
  });
}

/**
 * A single mounted result row.
 *
 * Selection is passed as primitive bounds so a pointer drag re-renders only
 * the rows whose range actually changed; the cell text and row label are
 * memoised against the row values instead of being recomputed for every
 * mousemove frame.
 */
export const DataGridRow = memo(function DataGridRow({
  resultSetId,
  displayIndex,
  sourceIndex,
  values,
  columns,
  resolvedColumns,
  getCellMetadata,
  hostSelected,
  rowInSelection,
  selectionMinColumn,
  selectionMaxColumn,
  leftSpacer,
  rightSpacer,
  onRowClick,
  onRowNumberClick,
  onRowNumberMouseDown,
  onRowNumberEnter,
  onCellMouseDown,
  onCellMouseEnter,
  onCellContextMenu,
}: DataGridRowProps): ReactNode {
  const rowLabel = useMemo(
    () => prepareRowLabel(values, resolvedColumns, getCellMetadata, sourceIndex),
    [getCellMetadata, resolvedColumns, sourceIndex, values],
  );
  const cells = useMemo(
    () => prepareCells(values, columns, resolvedColumns, getCellMetadata, sourceIndex),
    [columns, getCellMetadata, resolvedColumns, sourceIndex, values],
  );
  const rowInRange = rowInSelection;

  return <tr
    data-row-index={displayIndex}
    data-source-index={sourceIndex}
    data-result-set={resultSetId}
    aria-label={rowLabel}
    aria-rowindex={displayIndex + 2}
    className={`${displayIndex % 2 === 0 ? 'ui-data-grid-row-even' : 'ui-data-grid-row-odd'} ${hostSelected ? 'ui-data-grid-row-selected' : ''}`}
    onClick={() => onRowClick(sourceIndex)}
  >
    <th scope="row" className="ui-data-grid-row-number" onMouseDown={event => onRowNumberMouseDown(displayIndex, event)} onMouseEnter={() => onRowNumberEnter(displayIndex)}>
      <button type="button" aria-label={`Select row ${displayIndex + 1}`} onClick={event => { event.stopPropagation(); onRowNumberClick(sourceIndex); }}>{displayIndex + 1}</button>
    </th>
    {leftSpacer > 0 && <td aria-hidden="true" className="ui-data-grid-column-spacer" style={{ width: leftSpacer, minWidth: leftSpacer }} />}
    {cells.map(cell => {
      const selected = rowInRange && cell.position >= selectionMinColumn && cell.position <= selectionMaxColumn;
      const className = selected ? `${cell.className} ui-data-grid-cell-selected` : cell.className;
      return <td
        key={cell.key}
        data-column-index={cell.columnIndex}
        className={className || undefined}
        style={cell.left === undefined ? undefined : { left: cell.left }}
        aria-colindex={cell.position + 2}
        onMouseDown={event => onCellMouseDown(displayIndex, cell.columnIndex, event)}
        onMouseEnter={() => onCellMouseEnter(displayIndex, cell.columnIndex)}
        onContextMenu={event => onCellContextMenu(sourceIndex, cell.columnIndex, event)}
        title={cell.text}
      >{cell.text}</td>;
    })}
    {rightSpacer > 0 && <td aria-hidden="true" className="ui-data-grid-column-spacer" style={{ width: rightSpacer, minWidth: rightSpacer }} />}
  </tr>;
});
