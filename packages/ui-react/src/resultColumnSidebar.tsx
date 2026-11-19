import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { DataGridColumn } from './dataGridTypes';
import {
  isDataGridBinaryType,
  isDataGridNumericColumn,
  isDataGridTemporalColumn,
} from './resultGridFormatting';

export interface ResultColumnSidebarProps {
  readonly columns: readonly DataGridColumn[];
  /** Column visibility keyed by name, numeric id, or persisted grid key. */
  readonly visibility?: Readonly<Record<string, boolean>>;
  readonly onToggleVisibility?: (column: DataGridColumn, columnIndex: number) => void;
  readonly onShowAll?: () => void;
  readonly onHideAll?: () => void;
  /** Scrolls/focuses the matching grid column. */
  readonly onSelectColumn?: (column: DataGridColumn, columnIndex: number) => void;
  readonly onClose?: () => void;
  /** Active grouping keys, matched by name or numeric position. */
  readonly grouping?: readonly string[];
  readonly onGroupColumn?: (column: DataGridColumn, columnIndex: number) => void;
  readonly onUngroupColumn?: (column: DataGridColumn, columnIndex: number) => void;
  readonly onClearGrouping?: () => void;
}

function typePresentation(column: DataGridColumn): { readonly className: string; readonly label: string } {
  if (isDataGridNumericColumn(column)) return { className: 'type-number', label: 'NUMB' };
  if (isDataGridTemporalColumn(column)) return { className: 'type-temporal', label: 'TEMP' };
  if (/BOOL/iu.test(column.type ?? '')) return { className: 'type-bool', label: 'BOOL' };
  if (isDataGridBinaryType(column.type)) return { className: 'type-binary', label: 'BLOB' };
  return { className: 'type-text', label: 'TEXT' };
}

function isColumnVisible(
  column: DataGridColumn,
  columnIndex: number,
  visibility: Readonly<Record<string, boolean>> | undefined,
): boolean {
  if (!visibility) return true;
  return visibility[column.name.trim()] !== false
    && visibility[column.name] !== false
    && visibility[String(columnIndex)] !== false;
}

/**
 * React counterpart of the legacy sidebar schema list. It keeps the same
 * affordances (visibility, type badge, name click-to-scroll) without owning
 * any grid state, so every host renders the same list.
 */
export function ResultColumnSidebar({
  columns,
  visibility,
  onToggleVisibility,
  onShowAll,
  onHideAll,
  onSelectColumn,
  onClose,
  grouping = [],
  onGroupColumn,
  onUngroupColumn,
  onClearGrouping,
}: ResultColumnSidebarProps): ReactNode {
  const [search, setSearch] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => columns
      .map((column, columnIndex) => ({ column, columnIndex }))
      .filter(({ column }) => query.length === 0 || column.name.toLocaleLowerCase().includes(query)),
    [columns, query],
  );
  const dropColumn = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    if (!onGroupColumn) return;
    const index = Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
    const column = columns[index];
    if (column) onGroupColumn(column, index);
  };
  return <aside className="ui-column-sidebar" aria-label="Result columns">
    <header className="ui-column-sidebar-header">
      <strong>Columns</strong>
      <span>{columns.length}</span>
      {onClose && <button type="button" aria-label="Close column sidebar" title="Close sidebar" onClick={onClose}>×</button>}
    </header>
    <div className="ui-column-sidebar-tools">
      <input aria-label="Find column" placeholder="Find column…" value={search} onChange={event => setSearch(event.target.value)} />
      <button type="button" onClick={onShowAll}>All</button>
      <button type="button" onClick={onHideAll}>None</button>
    </div>
    {(onGroupColumn || grouping.length > 0) && <div className="ui-column-sidebar-group">
      <div className="ui-column-sidebar-group-title">Group by</div>
      <div
        className={`ui-column-sidebar-drop${dragOver ? ' is-drag-over' : ''}`}
        onDragOver={event => { if (onGroupColumn) { event.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={dropColumn}
      >{onGroupColumn ? 'Drag a column here' : 'No grouping'}</div>
      {grouping.length > 0 && <div className="ui-column-sidebar-chips">
        {grouping.map(key => {
          let columnIndex = columns.findIndex(column => column.name === key || column.name.trim() === key);
          if (columnIndex < 0 && /^\d+$/u.test(key)) {
            const numeric = Number(key);
            if (numeric >= 0 && numeric < columns.length) columnIndex = numeric;
          }
          const column = columnIndex < 0 ? undefined : columns[columnIndex];
          return <button
            type="button"
            key={key}
            title={`Remove grouping ${column?.name ?? key}`}
            onClick={() => column && onUngroupColumn?.(column, columnIndex)}
          >{column?.name ?? key} ×</button>;
        })}
        {onClearGrouping && <button type="button" className="ui-column-sidebar-clear-group" onClick={onClearGrouping}>Clear</button>}
      </div>}
    </div>}
    <ul className="ui-column-sidebar-list" role="list">
      {filtered.map(({ column, columnIndex }) => {
        const visible = isColumnVisible(column, columnIndex, visibility);
        const type = typePresentation(column);
        return <li
          key={`${column.name}:${columnIndex}`}
          className={visible ? undefined : 'is-hidden'}
          draggable={onGroupColumn !== undefined}
          onDragStart={event => {
            if (!onGroupColumn) return;
            event.dataTransfer.setData('text/plain', String(columnIndex));
            event.dataTransfer.effectAllowed = 'copy';
          }}
        >
          <input
            type="checkbox"
            checked={visible}
            aria-label={`Show ${column.name}`}
            onChange={() => onToggleVisibility?.(column, columnIndex)}
          />
          <span className={`ui-column-sidebar-type ${type.className}`}>{type.label}</span>
          <button
            type="button"
            className="ui-column-sidebar-name"
            title={`Scroll to ${column.name}`}
            onClick={() => onSelectColumn?.(column, columnIndex)}
          >{column.name}</button>
        </li>;
      })}
      {filtered.length === 0 && <li className="ui-column-sidebar-empty">No matching columns.</li>}
    </ul>
  </aside>;
}
