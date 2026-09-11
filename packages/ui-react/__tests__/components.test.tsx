import { fireEvent, render, screen } from '@testing-library/react';
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
  UiShell,
  WorkspaceTabs,
  formatDataGridCellValue,
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
    expect(onViewChange).toHaveBeenCalledWith({ sorting: [{ column: '0', descending: false }] });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter NAME' }), { target: { value: 'alpha' } });
    expect(onViewChange).toHaveBeenCalledWith({ columnFilters: { '1': 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin ID' }));
    expect(onViewChange).toHaveBeenCalledWith({ pinnedColumns: ['0'] });
    fireEvent.click(screen.getByRole('button', { name: 'Group by NAME' }));
    expect(onViewChange).toHaveBeenCalledWith({ grouping: ['1'] });

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
      columns: [{ name: 'C' }, { name: 'A' }],
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
