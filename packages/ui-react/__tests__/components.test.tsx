import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UiResultSurfaceState } from '@justybase/ui-core';
import {
  AsyncStateView,
  CapabilityGate,
  DataGrid,
  DesignerForm,
  EditorSurface,
  ExplainView,
  FocusOnMount,
  HistoryView,
  ResultTabs,
  ResultViewToolbar,
  RowDetail,
  SchemaTree,
  SqlDialectSelect,
  UiShell,
  WorkspaceTabs,
  calculateDataGridVirtualWindow,
  createDataGridClipboardPayload,
  formatDataGridCellValue,
  formatDataGridClipboard,
  processDataGridRows,
} from '../src';

const result: UiResultSurfaceState = {
  sourceId: 'source-1',
  executionId: 'execution-1',
  resultSetId: 'result-1',
  statementIndex: 0,
  status: 'complete',
  columns: [{ name: 'ID', type: 'INTEGER' }],
  totalRowCount: 2,
  loadedRowCount: 2,
  lastSequence: 3,
  cancellation: 'none',
  view: { globalFilter: '', columnFilters: {}, sorting: [], grouping: [], scrollTop: 0, scrollLeft: 0 },
};

describe('shared React presentation', () => {
  it('uses the canonical VS Code boolean cell representation', () => {
    expect(formatDataGridCellValue(true, 'BOOLEAN')).toBe('✓ true');
    expect(formatDataGridCellValue('t', 'BOOL')).toBe('✓ true');
    expect(formatDataGridCellValue(false, 'BOOLEAN')).toBe('✗ false');
    expect(formatDataGridCellValue(null, 'BOOLEAN')).toBe('NULL');
  });

  it('uses the canonical typed formatting for numbers, dates and binary values', () => {
    expect(formatDataGridCellValue(1234567, 'INTEGER')).toBe('1 234 567');
    expect(formatDataGridCellValue('1234.5', 'NUMERIC')).toBe('1 234.5000');
    expect(formatDataGridCellValue('1234.5', 'NUMERIC', { scale: 2 })).toBe('1 234.50');
    expect(formatDataGridCellValue('99.99999', 'NUMERIC(10,2)')).toBe('100.00');
    expect(formatDataGridCellValue(new Date('2024-06-15T14:30:45.000Z'), 'TIMESTAMP')).toBe('2024-06-15 14:30:45');
    expect(formatDataGridCellValue(20260315, 'INTEGER', { inferredDateInteger: true })).toBe('2026 03 15');
    expect(formatDataGridCellValue('AQIDBAUG', 'BLOB')).toBe('[BLOB · 6 B]');
    expect(formatDataGridCellValue({ nested: true }, 'JSON')).toBe('{"nested":true}');
  });

  it('keeps typed clipboard formats identical across hosts', () => {
    const payload = createDataGridClipboardPayload({
      columns: [
        { name: 'ID', type: 'INTEGER' },
        { name: 'LABEL', type: 'VARCHAR' },
        { name: 'ENABLED', type: 'BOOLEAN' },
      ],
      rows: [[1234567, "A|B\nC", true], [null, "O'Reilly", false]],
    });
    expect(payload.text).toBe('ID\tLABEL\tENABLED\n1 234 567\tA|B\nC\t✓ true\nNULL\tO\'Reilly\t✗ false');
    expect(payload.markdown).toContain('A\\|B<br>C');
    expect(payload.csv).toContain('"A|B\nC"');
    expect(payload.json).toContain('"ID": 1234567');
    expect(payload.sql).toContain("'O''Reilly'");
    expect(payload.html).toContain('x:num="1234567"');
    expect(formatDataGridClipboard({
      columns: [{ name: 'ID', type: 'INTEGER' }],
      rows: [[2]],
    }, 'csv')).toBe('ID\n2');
  });

  it('filters formatted values using compact separators and excludes NULL cells', () => {
    const columns = [{ name: 'VALUE', type: 'INTEGER' }];
    expect(processDataGridRows(columns, [[1234567], [null], [42]], {
      globalFilter: '1234567', columnFilters: {}, sorting: [], grouping: [],
    })).toEqual([[1234567]]);
    expect(processDataGridRows(columns, [[1234567], [null], [42]], {
      globalFilter: '', columnFilters: { VALUE: '1234567' }, sorting: [], grouping: [],
    })).toEqual([[1234567]]);
    expect(processDataGridRows([{ name: 'DATE', type: 'INTEGER', inferredDateInteger: true }], [[20260315], [null]], {
      globalFilter: '20260315', columnFilters: {}, sorting: [], grouping: [],
    })).toEqual([[20260315]]);
  });

  it('uses row-detail metadata when formatting values', () => {
    const onClose = jest.fn();
    render(<RowDetail columns={[{ name: 'DATE', type: 'INTEGER', inferredDateInteger: true }, { name: 'AMOUNT', type: 'NUMERIC', scale: 2 }]} row={[20260315, '1234.5']} onClose={onClose} />);
    expect(screen.getByText('2026 03 15')).toBeInTheDocument();
    expect(screen.getByText('1 234.50')).toBeInTheDocument();
  });

  it('infers the same display metadata for untyped result columns', () => {
    const { rerender } = render(<DataGrid resultSetId="inferred-grid" columns={[{ name: 'AMOUNT' }]} rows={[['1234.5'], ['2.0']]} />);
    expect(screen.getByRole('cell', { name: '1 234.5000' })).toBeInTheDocument();
    expect(screen.getByText('NUM')).toBeInTheDocument();
    rerender(<DataGrid resultSetId="inferred-grid" columns={[{ name: 'ID', type: 'INTEGER' }]} rows={[[20260315], [20260316], [20260317]]} />);
    expect(screen.getByRole('cell', { name: '2026 03 15' })).toBeInTheDocument();
  });

  it('renders every async state with accessible status semantics', () => {
    const { rerender } = render(<AsyncStateView state="loading" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    rerender(<AsyncStateView state="empty" emptyLabel="No rows" />);
    expect(screen.getByRole('status')).toHaveTextContent('No rows');
    rerender(<AsyncStateView state="error" message="Request failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
    rerender(<AsyncStateView state="cancelled" />);
    expect(screen.getByRole('status')).toHaveTextContent('Cancelled');
    rerender(<AsyncStateView state="ready">ready content</AsyncStateView>);
    expect(screen.getByText('ready content')).toBeInTheDocument();
  });

  it('keeps capability differences visible and guards writes', () => {
    render(<CapabilityGate capability={{ key: 'write', status: 'unsupported', owner: 'adapter', documentation: '/docs/write', removalCondition: 'Add provider support.' }}><span>hidden</span></CapabilityGate>);
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('unsupported');
    render(<DesignerForm fields={{ name: 'orders' }} capability={{ key: 'designer', status: 'read-only', owner: 'adapter', reason: 'Read-only profile.', documentation: '/docs/designer', removalCondition: 'Use a writable profile.' }} onChange={() => undefined} onApply={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  it('offers the shared authoring dialect catalog without changing runtime connection state', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<SqlDialectSelect value="netezza" onChange={onChange} ariaLabel="Authoring dialect" />);
    const select = screen.getByRole('combobox', { name: 'Authoring dialect' });
    expect(select).toHaveValue('netezza');
    expect(screen.getByRole('option', { name: 'PostgreSQL' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'ClickHouse' })).toBeInTheDocument();
    await user.selectOptions(select, 'postgresql');
    expect(onChange).toHaveBeenCalledWith('postgresql');
  });

  it('supports keyboard tab navigation and editor command submission', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    const onSubmit = jest.fn();
    render(<><WorkspaceTabs tabs={[{ id: 'one', label: 'one.sql' }, { id: 'two', label: 'two.sql' }]} activeId="one" onSelect={onSelect} onClose={() => undefined} /><EditorSurface value="select 1" onChange={() => undefined} onSubmit={onSubmit} /></>);
    const first = screen.getByRole('tab', { name: 'one.sql' });
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('two');
    await user.click(screen.getByLabelText('SQL editor'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close two.sql' }));
  });

  it('restores both scroll axes by stable result-set identity and reports changes', () => {
    const onScroll = jest.fn();
    const onRowSelect = jest.fn();
    render(<DataGrid resultSetId={result.resultSetId} columns={[{ name: 'ID' }, { name: 'DETAILS' }]} rows={[[1, { value: 'x' }], [2, [3]]]} scroll={{ resultSetId: result.resultSetId, top: 128, left: 64, anchorRow: 4 }} onScroll={onScroll} onRowSelect={onRowSelect} />);
    const grid = screen.getByRole('table').parentElement as HTMLDivElement;
    expect(grid.scrollTop).toBe(128);
    expect(grid.scrollLeft).toBe(64);
    fireEvent.scroll(grid);
    expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({ resultSetId: result.resultSetId }));
    fireEvent.click(screen.getByRole('row', { name: /1/ }));
    expect(onRowSelect).toHaveBeenCalledWith(0);
    render(<DataGrid resultSetId={result.resultSetId} columns={result.columns} rows={[[1]]} scroll={{ resultSetId: 'different-result', top: -1, left: -1 }} />);
    render(<DataGrid resultSetId="empty-result" columns={[]} rows={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('No rows');
  });

  it('calculates a bounded virtual window with stable pixel padding', () => {
    expect(calculateDataGridVirtualWindow(0, 120, 300, 2)).toEqual({
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
    expect(calculateDataGridVirtualWindow(1000, 0, 300, 2)).toEqual({
      startIndex: 0,
      endIndex: 12,
      paddingTop: 0,
      paddingBottom: 29_640,
    });
    expect(calculateDataGridVirtualWindow(1000, 900, 300, 2)).toEqual({
      startIndex: 28,
      endIndex: 42,
      paddingTop: 840,
      paddingBottom: 28_740,
    });
    expect(calculateDataGridVirtualWindow(4, Number.NaN, 0, -2)).toEqual({
      startIndex: 0,
      endIndex: 1,
      paddingTop: 0,
      paddingBottom: 90,
    });
  });

  it('renders only the visible result window and moves it without changing row identity', () => {
    jest.useFakeTimers();
    try {
      const rows = Array.from({ length: 1000 }, (_value, index) => [index + 1, `row-${index + 1}`]);
      const { container } = render(<DataGrid resultSetId="virtual-grid" columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }]} rows={rows} />);
      const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
      expect(scroller).not.toBeNull();
      if (!scroller) return;
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
      act(() => { jest.runOnlyPendingTimers(); });
      fireEvent.scroll(scroller);
      act(() => { jest.runOnlyPendingTimers(); });
      const renderedRows = (): NodeListOf<HTMLTableRowElement> => container.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.ui-data-grid-virtual-spacer)');
      expect(renderedRows().length).toBeLessThan(100);
      expect(renderedRows()[0]).toHaveTextContent('1');

      scroller.scrollTop = 15_000;
      fireEvent.scroll(scroller);
      act(() => { jest.runOnlyPendingTimers(); });
      expect(renderedRows().length).toBeLessThan(100);
      expect(renderedRows()[0]).toHaveTextContent('493');
      expect(renderedRows()[renderedRows().length - 1]).toHaveTextContent('512');
      expect(container.querySelector('.ui-data-grid-virtual-spacer')?.getAttribute('aria-hidden')).toBe('true');
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores the virtual row anchor together with both scroll axes', () => {
    jest.useFakeTimers();
    try {
      const rows = Array.from({ length: 1000 }, (_value, index) => [index + 1]);
      const { container } = render(<DataGrid resultSetId="restored-virtual-grid" columns={[{ name: 'ID', type: 'INTEGER' }]} rows={rows} scroll={{ resultSetId: 'restored-virtual-grid', top: 15_000, left: 240, anchorRow: 500 }} />);
      const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
      expect(scroller).not.toBeNull();
      if (!scroller) return;
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
      act(() => { jest.runOnlyPendingTimers(); });
      fireEvent.scroll(scroller);
      act(() => { jest.runOnlyPendingTimers(); });
      expect(scroller.scrollTop).toBe(15_000);
      expect(scroller.scrollLeft).toBe(240);
      const renderedRows = container.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.ui-data-grid-virtual-spacer)');
      expect(renderedRows[0]).toHaveTextContent('493');
      expect(renderedRows[renderedRows.length - 1]).toHaveTextContent('512');
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries scroll restoration when rows arrive after the initial mount', () => {
    const { rerender } = render(<DataGrid resultSetId="delayed-result" columns={[{ name: 'ID' }]} rows={[]} scroll={{ resultSetId: 'delayed-result', top: 96, left: 24 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('No rows');
    rerender(<DataGrid resultSetId="delayed-result" columns={[{ name: 'ID' }]} rows={[[1]]} scroll={{ resultSetId: 'delayed-result', top: 96, left: 24 }} />);
    const grid = screen.getByRole('table').parentElement as HTMLDivElement;
    expect(grid.scrollTop).toBe(96);
    expect(grid.scrollLeft).toBe(24);
  });

  it('keeps filtering, sorting, selection, grouping and column actions in the shared grid', () => {
    const onViewChange = jest.fn();
    const onSelectionChange = jest.fn();
    const onContextMenu = jest.fn();
    const onCopySelection = jest.fn();
    const view = { globalFilter: '', columnFilters: {}, sorting: [], grouping: [] } as const;
    render(<DataGrid
      resultSetId="shared-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }]}
      rows={[[2, 'beta'], [1, 'alpha']]}
      view={view}
      onViewChange={onViewChange}
      onSelectionChange={onSelectionChange}
      onContextMenu={onContextMenu}
      onCopySelection={onCopySelection}
    />);

    expect(screen.getByRole('columnheader', { name: '#' })).toBeInTheDocument();
    expect(screen.getByText('INT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /ID Not sorted/ }));
    expect(onViewChange).toHaveBeenCalledWith({ sorting: [{ column: 'ID', descending: false }] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter NAME' }), { target: { value: 'alpha' } });
    expect(onViewChange).toHaveBeenCalledWith({ columnFilters: { NAME: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin ID' }));
    expect(onViewChange).toHaveBeenCalledWith({ pinnedColumns: ['ID'] });
    fireEvent.click(screen.getByRole('button', { name: 'Group by NAME' }));
    expect(onViewChange).toHaveBeenCalledWith({ grouping: ['NAME'] });

    const betaCell = screen.getByRole('cell', { name: 'beta' });
    const alphaCell = screen.getByRole('cell', { name: 'alpha' });
    fireEvent.mouseDown(betaCell, { button: 0 });
    fireEvent.mouseEnter(alphaCell);
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ anchorRow: 0, anchorColumn: 1, focusRow: 1, focusColumn: 1 }));
    fireEvent.contextMenu(betaCell, { clientX: 20, clientY: 40 });
    expect(onContextMenu).toHaveBeenCalledWith({ rowIndex: 0, columnIndex: 1, clientX: 20, clientY: 40 });
    fireEvent.keyDown(screen.getByRole('table').parentElement as HTMLDivElement, { key: 'c', ctrlKey: true });
    expect(onCopySelection).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.any(Object) }));
  });

  it('keeps the grid context actions identical for shared hosts', () => {
    const onViewChange = jest.fn();
    const onCopySelection = jest.fn();
    const onRowSelect = jest.fn();
    render(<DataGrid
      resultSetId="context-actions"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }]}
      rows={[[2, 'beta'], [1, 'alpha']]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onViewChange={onViewChange}
      onCopySelection={onCopySelection}
      onRowSelect={onRowSelect}
    />);
    const beta = screen.getByRole('cell', { name: 'beta' });
    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    expect(screen.getByRole('menu', { name: 'Actions for row 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by this value' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ columnFilters: { NAME: 'beta' } });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort descending' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ sorting: [{ column: 'NAME', descending: true }] });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy row' }));
    expect(onCopySelection).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [[2, 'beta']] }));

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'View full row' }));
    expect(onRowSelect).toHaveBeenLastCalledWith(0);
  });

  it('uses the shared column menu for visibility and pinning actions', () => {
    const onViewChange = jest.fn();
    render(<DataGrid
      resultSetId="column-menu"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }]}
      rows={[[1, 'Alpha']]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onViewChange={onViewChange}
    />);
    fireEvent.click(screen.getByText('Columns'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'ID' }));
    expect(onViewChange).toHaveBeenCalledWith({ columnVisibility: { ID: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin ID in column menu' }));
    expect(onViewChange).toHaveBeenCalledWith({ pinnedColumns: ['ID'] });
  });

  it('renders formatted boolean values while preserving raw selection payloads', () => {
    const onCopySelection = jest.fn();
    render(<DataGrid
      resultSetId="formatted-values"
      columns={[{ name: 'ENABLED', type: 'BOOLEAN' }]}
      rows={[[true], [false]]}
      onCopySelection={onCopySelection}
    />);
    expect(screen.getByRole('cell', { name: '✓ true' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '✗ false' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('cell', { name: '✓ true' }), { button: 0 });
    fireEvent.keyDown(screen.getByRole('table').parentElement as HTMLDivElement, { key: 'c', ctrlKey: true });
    expect(onCopySelection).toHaveBeenCalledWith(expect.objectContaining({ rows: [[true]] }));
  });

  it('keeps unavailable aggregates distinct from SQL NULL', () => {
    expect(formatDataGridCellValue(undefined, undefined, { undefinedPlaceholder: '—' })).toBe('—');
    expect(formatDataGridCellValue(null, undefined, { undefinedPlaceholder: '—' })).toBe('NULL');
  });

  it('uses per-cell metadata for client filtering and sorting', () => {
    const getCellMetadata = jest.fn((_value: unknown, _rowIndex: number, _columnIndex: number, _column: { name: string }) => ({ type: 'TEXT' }));
    render(<DataGrid
      resultSetId="per-cell-metadata"
      columns={[{ name: 'VALUE' }]}
      rows={[[1], [2]]}
      view={{ globalFilter: '1', columnFilters: {}, sorting: [], grouping: [] }}
      getCellMetadata={getCellMetadata}
    />);
    expect(screen.getAllByRole('cell')).toHaveLength(1);
    expect(getCellMetadata.mock.calls.some(call => call[0] === 2)).toBe(true);
  });

  it('matches canonical typed sorting and keeps selection coordinates in display order', () => {
    const numericColumns = [{ name: 'AMOUNT', type: 'DECIMAL' }];
    expect(processDataGridRows(numericColumns, [['9007199254740993'], ['10.00'], [null], ['2.0']], {
      globalFilter: '', columnFilters: {}, sorting: [{ column: '0', descending: false }], grouping: [],
    })).toEqual([[null], ['2.0'], ['10.00'], ['9007199254740993']]);
    expect(processDataGridRows([{ name: 'DATE', type: 'DATE' }], [['2024-12-01'], ['2024-02-01'], ['2024-10-01']], {
      globalFilter: '', columnFilters: {}, sorting: [{ column: '0', descending: false }], grouping: [],
    })).toEqual([['2024-02-01'], ['2024-10-01'], ['2024-12-01']]);

    const onCopySelection = jest.fn();
    render(<DataGrid
      resultSetId="reordered-selection"
      columns={[{ name: 'A' }, { name: 'B' }, { name: 'C' }]}
      rows={[[1, 2, 3]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [], columnOrder: ['2', '0', '1'] }}
      onCopySelection={onCopySelection}
    />);
    const cells = screen.getAllByRole('cell');
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[1]!);
    fireEvent.keyDown(screen.getByRole('table').parentElement as HTMLDivElement, { key: 'c', ctrlKey: true });
    expect(onCopySelection).toHaveBeenCalledWith(expect.objectContaining({
      columns: [expect.objectContaining({ name: 'C' }), expect.objectContaining({ name: 'A' })],
      rows: [[3, 1]],
    }));
  });

  it('can collapse and reopen grouped rows without changing the shared view', () => {
    render(<DataGrid
      resultSetId="collapsible-groups"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['A', 2], ['B', 3]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['0'] }}
    />);
    expect(screen.getByText('1 rows')).toBeInTheDocument();
    expect(screen.getByText('2 rows')).toBeInTheDocument();
    const group = screen.getByRole('button', { name: 'Collapse group A' });
    fireEvent.click(group);
    expect(screen.queryByRole('row', { name: /A 1/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand group A' }));
    expect(screen.getByRole('row', { name: /A 1/ })).toBeInTheDocument();
  });

  it('removes collapsed children from the virtual scroll extent', () => {
    jest.useFakeTimers();
    try {
      const rows = Array.from({ length: 1_000 }, (_value, index) => [index < 500 ? 'A' : 'B', index]);
      const { container } = render(<DataGrid
        resultSetId="virtual-collapsed-groups"
        columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
        rows={rows}
        view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['TEAM'] }}
      />);
      const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
      expect(scroller).not.toBeNull();
      if (!scroller) return;
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
      act(() => { jest.runOnlyPendingTimers(); });
      const spacerHeight = (): number => Array.from(container.querySelectorAll<HTMLTableRowElement>('.ui-data-grid-virtual-spacer'))
        .reduce((sum, spacer) => sum + Number.parseFloat(spacer.firstElementChild?.getAttribute('style')?.match(/height:\s*([\d.]+)px/u)?.[1] ?? '0'), 0);
      const before = spacerHeight();
      fireEvent.click(screen.getByRole('button', { name: 'Collapse group A' }));
      act(() => { jest.runOnlyPendingTimers(); });
      const after = spacerHeight();
      expect(after).toBeLessThan(before);
      expect(screen.queryByRole('row', { name: /A 1/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole('row', { name: /B 500/ }).length).toBeGreaterThanOrEqual(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps grouped row numbers and callbacks tied to the actual raw rows', () => {
    const onRowSelect = jest.fn();
    render(<DataGrid
      resultSetId="group-row-indexes"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['A', 2], ['B', 3]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['0'] }}
      onRowSelect={onRowSelect}
    />);
    expect(screen.getByRole('button', { name: 'Select row 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select row 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select row 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('cell', { name: '2' }));
    expect(onRowSelect).toHaveBeenCalledWith(1);
  });

  it('keeps resize state bounded to the pointer gesture', () => {
    const onViewChange = jest.fn();
    render(<DataGrid
      resultSetId="resize-gesture"
      columns={[{ name: 'ID' }]}
      rows={[[1]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onViewChange={onViewChange}
    />);
    fireEvent.mouseDown(screen.getByRole('separator', { name: 'Resize ID' }), { button: 0, clientX: 20 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 200 });
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it('keeps the paging trigger mounted when a loaded page has no matches', () => {
    const onLoadMore = jest.fn();
    render(<DataGrid
      resultSetId="filtered-page"
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1]]}
      totalRowCount={2}
      view={{ globalFilter: 'later', columnFilters: {}, sorting: [], grouping: [] }}
      onLoadMore={onLoadMore}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('No matching rows');
    expect(onLoadMore).toHaveBeenCalled();
    const scroller = screen.getByRole('status').parentElement as HTMLDivElement;
    fireEvent.scroll(scroller);
    expect(onLoadMore.mock.calls.length).toBeGreaterThan(1);
  });

  it('focuses the grid for copy shortcuts and clears cell selection for a new result', () => {
    const onSelectionChange = jest.fn();
    const { rerender } = render(<DataGrid
      resultSetId="selection-one"
      columns={[{ name: 'ID' }]}
      rows={[[1]]}
      onSelectionChange={onSelectionChange}
    />);
    const cell = screen.getByRole('cell', { name: '1' });
    const scroller = screen.getByRole('table').parentElement;
    fireEvent.mouseDown(cell, { button: 0 });
    expect(document.activeElement).toBe(scroller);
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.any(Object));
    rerender(<DataGrid resultSetId="selection-two" columns={[{ name: 'ID' }]} rows={[[2]]} onSelectionChange={onSelectionChange} />);
    expect(onSelectionChange).toHaveBeenLastCalledWith(undefined);
  });

  it('exposes shared filter, grouping, aggregation, pivot and row-detail actions', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const callbacks = { onRefresh: jest.fn(), onCopy: jest.fn(), onExport: jest.fn() };
    const onClose = jest.fn();
    render(<><ResultViewToolbar columns={[{ name: 'ID' }]} view={{ globalFilter: '', sorting: [], grouping: [], aggregation: undefined, pivotColumn: undefined }} onChange={onChange} {...callbacks} /><RowDetail columns={[{ name: 'ID' }]} row={[7]} onClose={onClose} /></>);
    await user.type(screen.getByRole('textbox', { name: 'Filter results' }), 'orders');
    expect(onChange).toHaveBeenCalledWith({ globalFilter: 'o' });
    await user.click(screen.getByRole('button', { name: 'Group' }));
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    await user.click(screen.getByRole('button', { name: 'Aggregate' }));
    await user.click(screen.getByRole('button', { name: 'Pivot' }));
    expect(onChange).toHaveBeenCalledWith({ grouping: ['ID'] });
    expect(onChange).toHaveBeenCalledWith({ sorting: [{ column: 'ID', descending: false }] });
    expect(onChange).toHaveBeenCalledWith({ aggregation: 'count' });
    expect(onChange).toHaveBeenCalledWith({ pivotColumn: 'ID' });
    expect(screen.getByText('7')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
    expect(callbacks.onCopy).toHaveBeenCalledTimes(1);
    expect(callbacks.onExport).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('provides a focusable shell mount point', () => {
    render(<FocusOnMount><UiShell title="JustyBase" activeSurface="workspace" surfaces={[{ id: 'workspace', label: 'Workspace' }]}><p>content</p></UiShell></FocusOnMount>);
    expect(screen.getByRole('heading', { name: 'JustyBase' })).toBeVisible();
    expect(document.activeElement).toHaveAttribute('tabindex', '-1');
  });

  it('renders schema, result, history, explain and designer states through callbacks', async () => {
    const user = userEvent.setup();
    const onToggle = jest.fn();
    const onSelect = jest.fn();
    const onResultSelect = jest.fn();
    const onOpen = jest.fn();
    const onChange = jest.fn();
    const onPreview = jest.fn();
    const onApply = jest.fn();
    const onCancel = jest.fn();
    render(<>
      <SchemaTree nodes={[{ id: 'schema-1', kind: 'schema', label: 'PUBLIC', hasChildren: true }, { id: 'column-1', kind: 'column', label: 'ID', hasChildren: false }]} expandedIds={[]} onToggle={onToggle} onSelect={onSelect} />
      <ResultTabs results={[{ ...result, status: 'streaming' }]} activeResultSetId={result.resultSetId} onSelect={onResultSelect} />
      <HistoryView entries={[{ id: 'history-1', label: 'SELECT 1', status: 'complete', sqlFingerprint: 'fingerprint' }]} onOpen={onOpen} />
      <ExplainView state="loading" onCancel={onCancel} />
      <DesignerForm fields={{ name: 'orders' }} capability={{ key: 'designer', status: 'available', owner: 'adapter', documentation: '/docs', removalCondition: 'wire it' }} onChange={onChange} onPreview={onPreview} onApply={onApply} />
    </>);
    await user.click(screen.getByRole('button', { name: 'Expand PUBLIC' }));
    await user.click(screen.getByRole('button', { name: 'ID' }));
    await user.click(screen.getByRole('tab', { name: /Result 1/ }));
    await user.click(screen.getByRole('button', { name: /SELECT 1/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByDisplayValue('orders'), '2');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'schema-1' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'column-1' }));
    expect(onResultSelect).toHaveBeenCalledWith(result.resultSetId, result.sourceId);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'history-1' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('exposes common schema object actions from the shared context menu', async () => {
    const user = userEvent.setup();
    const actions = {
      onInsert: jest.fn(),
      onOpenQuery: jest.fn(),
      onOpenExplain: jest.fn(),
      onOpenDdl: jest.fn(),
      onImport: jest.fn(),
      onCopyName: jest.fn(),
    };
    const table = { id: 'table-1', kind: 'object' as const, label: 'ORDERS', objectName: 'ORDERS', objectType: 'TABLE', database: 'DB', schema: 'PUBLIC', hasChildren: true };
    render(<SchemaTree nodes={[table]} onSelect={jest.fn()} {...actions} />);
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 80, clientY: 120 });
    expect(screen.getByRole('menu', { name: 'Actions for ORDERS' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'View top 1000' }));
    expect(actions.onOpenQuery).toHaveBeenCalledWith(expect.objectContaining({ id: 'table-1' }));
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 80, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: 'Open DDL' }));
    expect(actions.onOpenDdl).toHaveBeenCalledTimes(1);
  });

  it('keeps result tabs keyboard navigable with roving focus', () => {
    const onSelect = jest.fn();
    render(<ResultTabs results={[{ ...result, resultSetId: 'result-1' }, { ...result, resultSetId: 'result-2' }]} activeResultSetId="result-1" onSelect={onSelect} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('result-2', 'source-1');
    expect(document.activeElement).toBe(tabs[1]);
  });

  it('handles optional callbacks, reverse keyboard navigation and explicit async messages', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    const onCancel = jest.fn();
    render(<>
      <WorkspaceTabs tabs={[{ id: 'one', label: 'one.sql' }, { id: 'two', label: 'two.sql' }]} activeId="two" onSelect={onSelect} onClose={() => undefined} />
      <AsyncStateView state="error" />
      <HistoryView entries={[]} state="empty" />
      <ExplainView state="ready" plan="SCAN orders" onCancel={onCancel} />
      <UiShell title="JustyBase" activeSurface="workspace" onSurfaceChange={onSelect} surfaces={[]}><span>content</span></UiShell>
    </>);
    screen.getByRole('tab', { name: 'two.sql' }).focus();
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{Home}');
    await user.keyboard('{End}');
    expect(onSelect).toHaveBeenCalledWith('one');
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(screen.getByText('SCAN orders')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
