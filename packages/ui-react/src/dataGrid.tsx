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

function valueClass(value: unknown, type?: string): string {
  if (value === null || value === undefined) return 'null';
  if (isNumericType(type)) return 'numeric';
  if (type !== undefined && /DATE|TIME|TIMESTAMP/.test(type.toUpperCase())) return 'temporal';
  if (type !== undefined && /BOOL/.test(type.toUpperCase())) {
    const truthy = value === true || value === 1 || value === 't' || value === 'TRUE' || value === 'true';
    return truthy ? 'boolean-true' : 'boolean-false';
  }
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
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (isNumericType(type)) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  }
  return cellText(left).localeCompare(cellText(right), undefined, { numeric: true, sensitivity: 'base' });
}

/** Shared filtering/sorting semantics used by the Electron shell and tests. */
export function processDataGridRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
): readonly (readonly unknown[])[] {
  const globalFilter = view.globalFilter.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => {
    if (globalFilter && !row.some(value => cellText(value).toLocaleLowerCase().includes(globalFilter))) return false;
    return columns.every((column, columnIndex) => {
      const filter = filterValue(view, column, columnIndex).trim().toLocaleLowerCase();
      return !filter || cellText(row[columnIndex]).toLocaleLowerCase().includes(filter);
    });
  });
  const indexed = filtered.map((values, sourceIndex) => ({ values, sourceIndex }));
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
  return indexed.map(item => item.values);
}

function indexedRows(
  columns: readonly DataGridColumn[],
  rows: readonly (readonly unknown[])[],
  view: DataGridViewState,
  clientProcessing: boolean,
): readonly IndexedRow[] {
  if (!clientProcessing) return rows.map((values, sourceIndex) => ({ values, sourceIndex }));
  const globalFilter = view.globalFilter.trim().toLocaleLowerCase();
  const filtered = rows.flatMap((values, sourceIndex) => {
    if (globalFilter && !values.some(value => cellText(value).toLocaleLowerCase().includes(globalFilter))) return [];
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const filter = filterValue(view, columns[columnIndex]!, columnIndex).trim().toLocaleLowerCase();
      if (filter && !cellText(values[columnIndex]).toLocaleLowerCase().includes(filter)) return [];
    }
    return [{ values, sourceIndex }];
  });
  const sorting = view.sorting
    .map(item => ({ ...item, columnIndex: resolveColumnIndex(columns, item.column) }))
    .filter(item => item.columnIndex >= 0);
  return filtered.sort((left, right) => {
    for (const item of sorting) {
      const comparison = compareValues(left.values[item.columnIndex], right.values[item.columnIndex], columns[item.columnIndex]?.type);
      if (comparison !== 0) return item.descending ? -comparison : comparison;
    }
    return left.sourceIndex - right.sourceIndex;
  });
}

function groupRows(columns: readonly DataGridColumn[], rows: readonly IndexedRow[], grouping: readonly string[]): readonly RenderedRow[] {
  if (grouping.length === 0) return rows.map((row, displayIndex) => ({ ...row, kind: 'data', displayIndex }));
  const groups = new Map<string, IndexedRow[]>();
  for (const row of rows) {
    const values = grouping.map(key => {
      const index = resolveColumnIndex(columns, key);
      return cellText(index >= 0 ? row.values[index] : undefined);
    });
    const id = values.join('\u001f');
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  const rendered: RenderedRow[] = [];
  let displayIndex = 0;
  for (const [id, group] of groups) {
    const label = id.split('\u001f').join(' · ');
    rendered.push({ kind: 'group', id, label, count: group.length });
    for (const row of group) rendered.push({ ...row, kind: 'data', displayIndex });
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
  activeViewRef.current = activeView;

  const updateView = (patch: Partial<UiResultViewState>): void => {
    if (view === undefined) setInternalView(previous => normaliseView({ ...previous, ...patch }));
    onViewChange?.(patch);
  };
  updateViewRef.current = updateView;

  useEffect(() => {
    const handleMouseUp = (): void => { dragSelectingRef.current = false; };
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
    if (onLoadMore && processedRows.length < totalRowCount && distanceFromEnd <= 160) onLoadMore();
  }

  function setSelectionValue(next: DataGridSelection | undefined): void {
    selectionRef.current = next;
    setSelection(next);
    onSelectionChange?.(next);
  }

  function selectCell(rowIndex: number, columnIndex: number, event: ReactMouseEvent<HTMLElement>): void {
    if (event.button !== 0) return;
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
    if (event.button !== 0 || columns.length === 0) return;
    const previous = selectionRef.current;
    const next = event.shiftKey && previous
      ? { anchorRow: previous.anchorRow, anchorColumn: 0, focusRow: rowIndex, focusColumn: columns.length - 1 }
      : { anchorRow: rowIndex, anchorColumn: 0, focusRow: rowIndex, focusColumn: columns.length - 1 };
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
    const selectedColumns = visibleColumnIndexes.filter(columnIndex => selected === undefined || (columnIndex >= selected.minColumn && columnIndex <= selected.maxColumn));
    const columnIndexes = selectedColumns.length > 0 ? selectedColumns : visibleColumnIndexes;
    const selectedRows = processedRows.slice(minRow, maxRow + 1).map(row => row.values);
    const payload: DataGridCopyPayload = { columns: columnIndexes.map(index => columns[index]!), rows: selectedRows.map(row => columnIndexes.map(index => row[index])), selection };
    if (onCopySelection) {
      onCopySelection(payload);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    const text = [payload.columns.map(column => column.name).join('\t'), ...payload.rows.map(row => row.map(cellText).join('\t'))].join('\n');
    void navigator.clipboard.writeText(text);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') {
      event.preventDefault();
      copySelection();
    }
  }

  if (columns.length === 0 || rows.length === 0) return <div className="ui-grid-empty" role="status">No rows to display.</div>;
  if (processedRows.length === 0) return <div className="ui-grid-empty" role="status">No matching rows.</div>;

  return <div className="ui-result-grid">
    <div ref={scroller} className="ui-data-grid-scroll" onScroll={handleScroll} onKeyDown={handleKeyDown} tabIndex={0} aria-label={`Data grid with ${totalRowCount} rows`}>
      <table className="ui-data-grid">
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
          if (rendered.kind === 'group') return <tr className="ui-data-grid-group-row" key={`group:${rendered.id}`}><td className="ui-data-grid-group-cell" colSpan={visibleColumnIndexes.length + 1}><span className="ui-data-grid-group-marker">▾</span>{rendered.label}<span className="ui-data-grid-group-count">{rendered.count.toLocaleString()} rows</span></td></tr>;
          const rowSelected = selectedRowIndex === rendered.displayIndex;
          return <tr key={`${resultSetId}:${rendered.sourceIndex}`} aria-label={rendered.values.map(cellText).join(' ')} className={`${rendered.displayIndex % 2 === 0 ? 'ui-data-grid-row-even' : 'ui-data-grid-row-odd'} ${rowSelected ? 'ui-data-grid-row-selected' : ''}`} onClick={() => onRowSelect?.(rendered.displayIndex)}>
            <th scope="row" className="ui-data-grid-row-number" onMouseDown={event => selectWholeRow(rendered.displayIndex, event)} onMouseEnter={() => extendSelection(rendered.displayIndex, 0)}><button type="button" aria-label={`Select row ${rendered.displayIndex + 1}`} onClick={event => { event.stopPropagation(); onRowSelect?.(rendered.displayIndex); }}>{rendered.displayIndex + 1}</button></th>
            {visibleColumnIndexes.map(columnIndex => {
              const column = columns[columnIndex]!;
              const pinned = activeView.pinnedColumns?.some(key => columnMatchesKey(column, columnIndex, key)) ?? false;
              const left = pinned ? ROW_NUMBER_WIDTH + visibleColumnIndexes.slice(0, visibleColumnIndexes.indexOf(columnIndex)).filter(index => activeView.pinnedColumns?.some(key => columnMatchesKey(columns[index]!, index, key))).reduce((sum, index) => sum + (activeView.columnWidths?.[columnKey(columns[index]!, index)] ?? DEFAULT_COLUMN_WIDTH), 0) : undefined;
              const selected = range !== undefined && rendered.displayIndex >= range.minRow && rendered.displayIndex <= range.maxRow && columnIndex >= range.minColumn && columnIndex <= range.maxColumn;
              const value = rendered.values[columnIndex];
              return <td key={`${rendered.sourceIndex}:${columnKey(column, columnIndex)}`} className={[pinned ? 'ui-data-grid-pinned' : '', selected ? 'ui-data-grid-cell-selected' : '', `ui-data-grid-value-${valueClass(value, column.type)}`, isNumericType(column.type) ? 'ui-data-grid-cell-numeric' : ''].filter(Boolean).join(' ')} style={left === undefined ? undefined : { left }} onMouseDown={event => selectCell(rendered.displayIndex, columnIndex, event)} onMouseEnter={() => extendSelection(rendered.displayIndex, columnIndex)} onContextMenu={event => { event.preventDefault(); onContextMenu?.({ rowIndex: rendered.displayIndex, columnIndex, clientX: event.clientX, clientY: event.clientY }); }} title={cellText(value)}>{cellText(value)}</td>;
            })}
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}
