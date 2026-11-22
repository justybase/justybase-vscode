import { useMemo, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import type { DataGridColumn } from './dataGridTypes';
import { MenuIcon } from './menuIcons';
import {
  isDataGridBinaryType,
  isDataGridNumericColumn,
  isDataGridTemporalColumn,
} from './resultGridFormatting';

const COLUMN_DRAG_TYPE = 'application/x-justybase-column-index';

export interface ResultColumnSidebarProps {
  readonly columns: readonly DataGridColumn[];
  /**
   * Column indexes in the order currently used by the grid (pinned first).
   * Hidden columns stay in the list; they are only marked as hidden.
   */
  readonly order?: readonly number[];
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
  /** Moves a column before or after the drop target. */
  readonly onMoveColumn?: (sourceIndex: number, targetIndex: number, after: boolean) => void;
  /** Lets the host focus the sidebar search from a shortcut or menu item. */
  readonly searchInputRef?: Ref<HTMLInputElement>;
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
 * affordances (visibility, type badge, name click-to-scroll, drag-to-group)
 * and adds drag reordering so this panel is the single place for column
 * management.
 */
export function ResultColumnSidebar({
  columns,
  order,
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
  onMoveColumn,
  searchInputRef,
}: ResultColumnSidebarProps): ReactNode {
  const [search, setSearch] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<number | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<{ readonly columnIndex: number; readonly after: boolean } | undefined>(undefined);
  const query = search.trim().toLocaleLowerCase();
  const ordered = useMemo(() => {
    const entries: { readonly column: DataGridColumn; readonly columnIndex: number }[] = [];
    const seen = new Set<number>();
    for (const columnIndex of order ?? []) {
      const column = columns[columnIndex];
      if (!column || seen.has(columnIndex)) continue;
      seen.add(columnIndex);
      entries.push({ column, columnIndex });
    }
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      if (seen.has(columnIndex)) continue;
      entries.push({ column: columns[columnIndex]!, columnIndex });
    }
    return entries;
  }, [columns, order]);
  const filtered = useMemo(
    () => ordered.filter(({ column }) => query.length === 0 || column.name.toLocaleLowerCase().includes(query)),
    [ordered, query],
  );
  const canReorder = onMoveColumn !== undefined;
  const canDrag = canReorder || onGroupColumn !== undefined;
  const acceptDrop = (event: React.DragEvent<HTMLElement>, columnIndex: number): void => {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer?.getData(COLUMN_DRAG_TYPE) ?? event.dataTransfer?.getData('text/plain') ?? '';
    const parsed = raw === '' ? undefined : Number.parseInt(raw, 10);
    const source = draggedColumn ?? (Number.isInteger(parsed) ? parsed : undefined);
    const after = dropTarget?.columnIndex === columnIndex ? dropTarget.after : false;
    if (onMoveColumn && source !== undefined && source !== columnIndex) onMoveColumn(source, columnIndex, after);
    setDraggedColumn(undefined);
    setDropTarget(undefined);
  };
  const dropColumn = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    if (!onGroupColumn) return;
    const raw = event.dataTransfer?.getData(COLUMN_DRAG_TYPE) ?? event.dataTransfer?.getData('text/plain') ?? '';
    const index = Number.parseInt(raw, 10);
    const column = Number.isInteger(index) ? columns[index] : undefined;
    if (column) onGroupColumn(column, index);
  };
  return <aside className="ui-column-sidebar" aria-label="Result columns">
    <header className="ui-column-sidebar-header">
      <strong>Columns</strong>
      <span>{columns.length}</span>
      {onClose && <button type="button" aria-label="Close column sidebar" title="Close sidebar" onClick={onClose}>×</button>}
    </header>
    <div className="ui-column-sidebar-tools">
      <input
        ref={searchInputRef}
        aria-label="Find column"
        placeholder="Find column…"
        value={search}
        onChange={event => setSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            const first = filtered[0];
            if (!first) return;
            event.preventDefault();
            onSelectColumn?.(first.column, first.columnIndex);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setSearch('');
          }
        }}
      />
      <button type="button" onClick={onShowAll}>All</button>
      <button type="button" onClick={onHideAll}>None</button>
    </div>
    {(onGroupColumn || grouping.length > 0) && <div className="ui-column-sidebar-group">
      <div className="ui-column-sidebar-group-title">Group by</div>
      <div
        className={`ui-column-sidebar-drop${dragOver ? ' is-drag-over' : ''}`}
        onDragOver={event => {
          if (!onGroupColumn) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          setDragOver(true);
        }}
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
        const dragging = draggedColumn === columnIndex;
        const dropBefore = dropTarget?.columnIndex === columnIndex && !dropTarget.after;
        const dropAfter = dropTarget?.columnIndex === columnIndex && dropTarget.after;
        return <li
          key={`${column.name}:${columnIndex}`}
          data-sidebar-column-index={columnIndex}
          className={[
            visible ? '' : 'is-hidden',
            dragging ? 'is-drag-source' : '',
            dropBefore ? 'is-drop-before' : '',
            dropAfter ? 'is-drop-after' : '',
          ].filter(Boolean).join(' ') || undefined}
          draggable={canDrag}
          onDragStart={event => {
            if (!canDrag) return;
            setDraggedColumn(columnIndex);
            setDropTarget(undefined);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = 'copyMove';
              event.dataTransfer.setData(COLUMN_DRAG_TYPE, String(columnIndex));
              event.dataTransfer.setData('text/plain', String(columnIndex));
            }
          }}
          onDragEnd={() => {
            setDraggedColumn(undefined);
            setDropTarget(undefined);
            setDragOver(false);
          }}
          onDragOver={event => {
            if (!canReorder || draggedColumn === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const rect = event.currentTarget.getBoundingClientRect();
            setDropTarget({ columnIndex, after: event.clientY > rect.top + rect.height / 2 });
          }}
          onDrop={event => {
            if (!canReorder) return;
            acceptDrop(event, columnIndex);
          }}
        >
          <span className="ui-column-sidebar-drag" title={canReorder ? 'Drag to reorder column' : undefined} aria-hidden="true"><MenuIcon name="rows" /></span>
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
