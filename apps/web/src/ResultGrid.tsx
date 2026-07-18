import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef, ColumnFiltersState, ColumnPinningState, RowSelectionState, SortingState, VisibilityState } from '@tanstack/react-table';
import type { QueryColumnFilterSpec, QueryExportFormat, QuerySortSpec } from '@justybase/contracts';
import { api } from './api';
import { type ResultState } from './queryState';

interface GridRow { values: unknown[]; }

/**
 * Type-aware formatting and display utilities for cell values.
 * Inspired by the extension's result panel but simplified for the web.
 */
function typeBadge(type?: string): string {
  if (!type) return '?';
  const t = type.toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT/.test(t)) return 'INT';
  if (/DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(t)) return 'NUM';
  if (/VARCHAR|CHAR|TEXT|CLOB|STRING/.test(t)) return 'TXT';
  if (/DATE|TIME|TIMESTAMP/.test(t)) return 'DT';
  if (/BOOL/.test(t)) return 'BOOL';
  return t.slice(0, 4);
}

function typeBadgeClass(type?: string): string {
  if (!type) return 'tt';
  const t = type.toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(t)) return 'tn';
  if (/DATE|TIME|TIMESTAMP/.test(t)) return 'td';
  if (/BOOL/.test(t)) return 'tb2';
  return 'tt';
}

function isNumericType(type?: string): boolean {
  if (!type) return false;
  return /INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(type.toUpperCase());
}

function formatCellValue(value: unknown, type?: string): { text: string; isNull: boolean; colorClass: string; } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true, colorClass: '' };
  const t = (type ?? '').toUpperCase();
  if (/INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/.test(t)) {
    // Keep string/BigInt values verbatim. Converting Netezza DECIMAL/NUMERIC
    // values through Number can silently lose precision.
    return { text: String(value), isNull: false, colorClass: 'val-num' };
  }
  if (/DATE|TIME|TIMESTAMP/.test(t)) {
    return { text: String(value), isNull: false, colorClass: 'val-date' };
  }
  if (/BOOL/.test(t)) {
    const boolValue = value === true || value === 1 || value === 't' || value === 'TRUE' || value === 'true';
    return { text: boolValue ? 'TRUE' : 'FALSE', isNull: false, colorClass: boolValue ? 'val-bool-t' : 'val-bool-f' };
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return { text, isNull: false, colorClass: '' };
}

function cellAlignment(type?: string): string {
  return isNumericType(type) ? 'cell-align-right' : '';
}

export function ResultGrid({ queryId, result }: { queryId: string; result: ResultState }): ReactElement {
  const [rows, setRows] = useState<unknown[][]>(result.rows);
  const [totalRows, setTotalRows] = useState(result.totalRows);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(200);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: [], right: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportFormat, setExportFormat] = useState<QueryExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const [columnOrder, setColumnOrder] = useState<string[]>(() => result.columns.map((_, i) => String(i)));
  const [draggedColId, setDraggedColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    setRows(result.rows);
    setTotalRows(result.totalRows);
    setPageIndex(0);
    setRowSelection({});
    setColumnOrder(result.columns.map((_, i) => String(i)));
  }, [result.sessionId]);

  useEffect(() => {
    if (!queryId || !result.sessionId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    const requestSorting: QuerySortSpec[] = sorting.map(item => ({ columnIndex: Number(item.id), desc: item.desc }));
    const requestFilters: QueryColumnFilterSpec[] = columnFilters.flatMap(item => typeof item.value === 'string' && item.value.trim() ? [{ columnIndex: Number(item.id), value: item.value }] : []);
    void api.queryPage(queryId, { offset: pageIndex * pageSize, limit: pageSize, sorting: requestSorting, columnFilters: requestFilters, globalFilter }).then(response => {
      if (generation !== requestGeneration.current) return;
      setRows(response.rows);
      setTotalRows(response.totalRows);
    }).catch(reason => { if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Could not load result page.'); }).finally(() => { if (generation === requestGeneration.current) setLoading(false); });
  }, [queryId, result.sessionId, result.status, pageIndex, pageSize, sorting, columnFilters, globalFilter]);

  const columns = useMemo<ColumnDef<GridRow>[]>(() => result.columns.map((name, index) => {
    const dataType = result.columnTypes[index];
    return {
      id: String(index),
      accessorFn: row => row.values[index],
      header: name,
      meta: { dataType },
      size: isNumericType(dataType) ? 130 : 150,
      enableSorting: true,
      enableColumnFilter: true,
      enableResizing: true,
      cell: info => {
        const value = info.getValue();
        const formatted = formatCellValue(value, dataType);
        return (
          <span
            className={`cell-value ${formatted.colorClass} ${formatted.isNull ? 'null-value' : ''}`}
            title={formatted.text}
          >
            {formatted.text}
          </span>
        );
      },
    };
  }), [result.columns, result.columnTypes]);
  const data = useMemo(() => rows.map(values => ({ values })), [rows]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection, columnVisibility, columnPinning, columnOrder },
    onSortingChange: updater => { setSorting(updater); setPageIndex(0); },
    onColumnFiltersChange: updater => { setColumnFilters(updater); setPageIndex(0); },
    onGlobalFilterChange: updater => { setGlobalFilter(updater); setPageIndex(0); },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnPinningChange: setColumnPinning,
    onColumnOrderChange: setColumnOrder,
    manualSorting: true,
    manualFiltering: true,
    enableRowSelection: true,
    enableColumnPinning: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel(),
  });
  const selectedRows = table.getSelectedRowModel().rows;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  function copySelection(): void {
    const selected = selectedRows.length > 0 ? selectedRows : table.getRowModel().rows;
    const headerRow = result.columns.map(col => col).join('\t');
    const dataRows = selected.map(row =>
      row.original.values.map((value, i) => formatCellValue(value, result.columnTypes[i]).text).join('\t')
    );
    const text = [headerRow, ...dataRows].join('\n');
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) {
      setError('Clipboard access is unavailable');
      return;
    }
    void writeText.call(navigator.clipboard, text).then(() => {
      // Show brief inline feedback
      const btn = document.querySelector('.copy-btn');
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }
    }).catch(() => setError('Failed to copy to clipboard'));
  }

  async function exportResult(): Promise<void> {
    setExporting(true);
    setError('');
    try {
      const sortingRequest: QuerySortSpec[] = sorting.map(item => ({ columnIndex: Number(item.id), desc: item.desc }));
      const filtersRequest: QueryColumnFilterSpec[] = columnFilters.flatMap(item => typeof item.value === 'string' && item.value.trim() ? [{ columnIndex: Number(item.id), value: item.value }] : []);
      const downloaded = await api.exportQuery(queryId, { format: exportFormat, sorting: sortingRequest, columnFilters: filtersRequest, globalFilter });
      const url = URL.createObjectURL(downloaded.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloaded.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Could not export query result.');
    } finally {
      setExporting(false);
    }
  }

  return <section className="advanced-grid"><div className="grid-toolbar"><input className="grid-global-filter" placeholder="Filter results…" value={globalFilter} onChange={event => setGlobalFilter(event.target.value)} /><details className="grid-columns"><summary>Columns</summary><div className="grid-columns-menu">{table.getAllLeafColumns().map(column => <label key={column.id}><input type="checkbox" checked={column.getIsVisible()} onChange={event => column.toggleVisibility(event.target.checked)} /><span>{String(column.columnDef.header)}</span><button type="button" title="Pin/unpin" onClick={() => column.pin(column.getIsPinned() ? false : 'left')}>📌</button></label>)}</div></details>        <button className="secondary small copy-btn" onClick={copySelection}>Copy</button><select className="grid-export-format" value={exportFormat} onChange={event => setExportFormat(event.target.value as QueryExportFormat)} aria-label="Export format"><option value="csv">CSV</option><option value="csv.gz">CSV gzip</option><option value="csv.zst">CSV zstd</option><option value="json">JSON</option><option value="xml">XML</option><option value="sql">SQL INSERT</option><option value="markdown">Markdown</option>          <option value="xlsx">XLSX</option>
          <option value="xlsb">XLSB (preferred, faster)</option></select><button className="secondary small" disabled={exporting} onClick={() => void exportResult()}>{exporting ? 'Exporting…' : 'Export'}</button>{loading && <span className="running">Loading…</span>}{error && <span className="grid-error">{error}</span>}</div><div className="result-grid"><table className="tanstack-result-table"><thead>{table.getHeaderGroups().map(headerGroup => <tr key={headerGroup.id}>{headerGroup.headers.map(header =>      <th
        key={header.id}
        className={[
          header.column.getIsPinned() ? 'pinned-column' : '',
          header.column.getIsResizing() ? 'is-resizing' : '',
          draggedColId === header.column.id ? 'dragging' : '',
          dragOverColId === header.column.id && draggedColId !== header.column.id && draggedColId !== null ? 'drag-over' : '',
        ].filter(Boolean).join(' ')}
        style={{
          ...(header.column.getIsPinned() ? { left: `${header.column.getStart('left')}px` } : {}),
          width: header.getSize(),
          minWidth: header.getSize(),
        }}
      >{
        header.isPlaceholder ? null : <div className="grid-header-content">
        <button
          type="button"
          draggable
          onDragStart={() => setDraggedColId(header.column.id)}
          onDragOver={e => { e.preventDefault(); setDragOverColId(header.column.id); }}
          onDragEnd={() => { setDraggedColId(null); setDragOverColId(null); }}
          onDrop={e => {
            e.preventDefault();
            if (!draggedColId || draggedColId === header.column.id) return;
            setColumnOrder(prev => {
              const reordered = [...prev];
              const oldIdx = reordered.indexOf(draggedColId);
              const newIdx = reordered.indexOf(header.column.id);
              if (oldIdx === -1 || newIdx === -1) return prev;
              reordered.splice(oldIdx, 1);
              // After removing at oldIdx, indices shift left. Adjust when oldIdx < newIdx.
              const insertAt = oldIdx < newIdx ? newIdx - 1 : newIdx;
              reordered.splice(insertAt, 0, draggedColId);
              return reordered;
            });
            setDraggedColId(null);
            setDragOverColId(null);
          }}
          onClick={header.column.getToggleSortingHandler()}
          title={`Sort by ${String(header.column.columnDef.header)}`}
        >
          <span className="header-label">{flexRender(header.column.columnDef.header, header.getContext())}</span>
          <span className="sort-arrows">
            <span className={`sort-arrow sort-asc ${header.column.getIsSorted() === 'asc' ? 'active' : ''}`}>▲</span>
            <span className={`sort-arrow sort-desc ${header.column.getIsSorted() === 'desc' ? 'active' : ''}`}>▼</span>
          </span>
        </button>
        <span className={`tb ${typeBadgeClass((header.column.columnDef.meta as { dataType?: string } | undefined)?.dataType)}`}>{typeBadge((header.column.columnDef.meta as { dataType?: string } | undefined)?.dataType)}</span>
        <input placeholder="filter…" value={String(header.column.getFilterValue() ?? '')} onChange={event => header.column.setFilterValue(event.target.value)} />
        <div className="col-resizer" onMouseDown={header.getResizeHandler()} onTouchStart={header.getResizeHandler()} />
      </div>}</th>)}</tr>)}</thead>    <tbody>{table.getRowModel().rows.map((row, rowIndex) => (
      <tr key={row.id} className={rowIndex % 2 === 0 ? 'row-even' : 'row-odd'}>
        {row.getVisibleCells().map(cell => {
          const colType = result.columnTypes[Number(cell.column.id)];
          return (
            <td
              key={cell.id}
              className={[
                cell.column.getIsPinned() ? 'pinned-column' : '',
                cellAlignment(colType),
              ].filter(Boolean).join(' ')}
              style={cell.column.getIsPinned() ? { left: `${cell.column.getStart('left')}px` } : undefined}
            >{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
          );
        })}
      </tr>
    ))}</tbody></table></div><div className="grid-pagination"><span>{totalRows.toLocaleString()} rows · page {pageIndex + 1} / {totalPages}</span><label>Page size<select value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPageIndex(0); }}><option value="100">100</option><option value="200">200</option><option value="500">500</option><option value="1000">1000</option></select></label><button className="secondary small" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex(value => value - 1)}>Previous</button><button className="secondary small" disabled={pageIndex + 1 >= totalPages || loading} onClick={() => setPageIndex(value => value + 1)}>Next</button></div></section>;
}
