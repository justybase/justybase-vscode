import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UiResultSurfaceState } from '@justybase/ui-core';
import {
  AsyncStateView,
  CellValueViewer,
  CapabilityGate,
  DataGrid,
  DesignerForm,
  DiffView,
  EditorSurface,
  ExecutionElapsed,
  ExplainView,
  FocusOnMount,
  HistoryView,
  LogConsole,
  PivotDialog,
  ResultColumnSidebar,
  ResultErrorView,
  ResultExecutionBanner,
  ResultLayoutSwitcher,
  ResultTabs,
  ResultAnalysisPanel,
  ResultViewToolbar,
  RowDetail,
  RowViewPanel,
  SchemaTree,
  SqlDialectSelect,
  UiShell,
  WorkspaceTabs,
  calculateDataGridColumnWindow,
  calculateDataGridVirtualWindow,
  createDataGridClipboardPayload,
  downloadBlobFile,
  formatDataGridCellValue,
  formatDataGridClipboard,
  formatDataGridIdentifierForSql,
  moveDataGridColumnOrder,
  processDataGridRows,
  reorderDataGridGrouping,
  resolveDataGridColumnOrder,
  resolveDataGridNavigationTarget,
  resolveDataGridScrollTop,
} from '../src';
import type { DataGridHandle } from '../src';

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
  it('exposes selection export actions in the shared context menu', async () => {
    const user = userEvent.setup();
    const onExportSelection = jest.fn();
    render(<DataGrid
      resultSetId='export-menu-result'
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1], [2]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onViewChange={jest.fn()}
      onExportSelection={onExportSelection}
    />);
    fireEvent.contextMenu(screen.getByRole('cell', { name: '1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export selection as CSV' }));
    expect(onExportSelection).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [[1]] }),
      'csv',
    );
    fireEvent.contextMenu(screen.getByRole('cell', { name: '2' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export selection as JSON' }));
    expect(onExportSelection).toHaveBeenLastCalledWith(expect.anything(), 'json');
  });

  it('commits a validated inline edit only in edit mode', () => {
    const onCellEdit = jest.fn();
    render(<DataGrid
      resultSetId="edit-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }]}
      rows={[[1, 'Ada']]}
      editMode
      onCellEdit={onCellEdit}
    />);
    const integerCell = screen.getByRole('cell', { name: '1' });
    fireEvent.doubleClick(integerCell);
    const editor = screen.getByRole('textbox', { name: 'Edit ID' });
    fireEvent.change(editor, { target: { value: '2' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onCellEdit).toHaveBeenCalledWith({
      rowIndex: 0,
      columnIndex: 0,
      oldValue: 1,
      newValue: '2',
    });

    // The editor stays open and reports the typed validation error.
    fireEvent.doubleClick(integerCell);
    const invalidEditor = screen.getByRole('textbox', { name: 'Edit ID' });
    fireEvent.change(invalidEditor, { target: { value: '1.5' } });
    fireEvent.keyDown(invalidEditor, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('whole number');
    expect(onCellEdit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(invalidEditor, { key: 'Escape' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not open the inline editor without edit mode', () => {
    const onCellEdit = jest.fn();
    render(<DataGrid
      resultSetId="read-only-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1]]}
      onCellEdit={onCellEdit}
    />);
    fireEvent.doubleClick(screen.getByRole('cell', { name: '1' }));
    expect(screen.queryByRole('textbox', { name: 'Edit ID' })).toBeNull();
    expect(onCellEdit).not.toHaveBeenCalled();
  });

  it('commits NULL through the inline editor toggle', () => {
    const onCellEdit = jest.fn();
    render(<DataGrid
      resultSetId="null-edit-grid"
      columns={[{ name: 'NAME', type: 'VARCHAR' }]}
      rows={[['Ada']]}
      editMode
      onCellEdit={onCellEdit}
    />);
    fireEvent.doubleClick(screen.getByRole('cell', { name: 'Ada' }));
    const editor = screen.getByRole('textbox', { name: 'Edit NAME' });
    fireEvent.click(screen.getByRole('button', { name: 'Set NULL' }));
    fireEvent.blur(editor);
    expect(onCellEdit).toHaveBeenCalledWith({
      rowIndex: 0,
      columnIndex: 0,
      oldValue: 'Ada',
      newValue: null,
    });
  });

  it('attaches the download anchor to the document for Firefox compatibility', () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:selection') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    const seen: Array<{ parent: Node | null }> = [];
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      seen.push({ parent: this.parentNode });
    });
    downloadBlobFile('selection.csv', new Blob(['a,b']));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.parent).toBe(document.body);
    expect(document.body.querySelector('a[download="selection.csv"]')).toBeNull();
    click.mockRestore();
  });

  it('keeps grouping reorder insertion indexes stable in both directions', () => {
    expect(reorderDataGridGrouping(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B']);
    expect(reorderDataGridGrouping(['A', 'B', 'C'], 0, 3)).toEqual(['B', 'C', 'A']);
  });

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

  it('formats simple and quoted SQL identifiers for editor insertion', () => {
    expect(formatDataGridIdentifierForSql('CUSTOMER_ID')).toBe('CUSTOMER_ID');
    expect(formatDataGridIdentifierForSql(' DB.SCHEMA.TABLE ')).toBe('DB.SCHEMA.TABLE');
    expect(formatDataGridIdentifierForSql('Order Date')).toBe('"Order Date"');
    expect(formatDataGridIdentifierForSql('say "hi"')).toBe('"say ""hi"""');
    expect(formatDataGridIdentifierForSql('   ')).toBe('');
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

  it('aligns copied HTML cells like the grid and keeps pasted rows compact', () => {
    const payload = createDataGridClipboardPayload({
      columns: [
        { name: 'AMOUNT', type: 'NUMERIC' },
        { name: 'LABEL', type: 'VARCHAR' },
      ],
      rows: [[12.5, 'text']],
    });
    // Numbers match the grid's right alignment; text stays left.
    expect(payload.html).toContain('align="right" style="border:1px solid #d1d1d1;padding:2px 8px;text-align:right');
    expect(payload.html).toContain('align="left" style="border:1px solid #d1d1d1;padding:2px 8px;text-align:left');
    // Word/Outlook paragraph spacing must be neutralised inside every cell.
    expect(payload.html).toContain('mso-line-height-rule:exactly');
    expect(payload.html).toContain('<p style="margin:0;line-height:1.15');
    expect(payload.html).not.toContain('padding:6px 8px');
    expect(payload.html).not.toContain('line-height:1.4');
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

  it('compares selected rows vertically and highlights only differing columns', () => {
    const onClose = jest.fn();
    const { container } = render(<RowViewPanel
      columns={[
        { name: 'SAME', type: 'INTEGER' },
        { name: 'ID', type: 'INTEGER' },
        { name: 'NOTE', type: 'VARCHAR' },
      ]}
      rows={[[1, 1, null], [1, 2, 'NULL']]}
      onClose={onClose}
    />);
    expect(screen.getByRole('complementary', { name: 'Row details and comparison' })).toBeInTheDocument();
    expect(screen.getAllByText('Row 1')).toHaveLength(3);
    expect(screen.getAllByText('Row 2')).toHaveLength(3);
    const sections = [...container.querySelectorAll('.row-view-section')];
    expect(sections[0]).not.toHaveClass('diff');
    expect(sections[1]).toHaveClass('diff');
    expect(sections[2]).toHaveClass('diff');
    // SQL NULL and the literal text "NULL" must not be treated as equal.
    expect(container.querySelectorAll('.row-view-val.null')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close row view' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches between the table and analysis layouts from the view switcher', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<ResultLayoutSwitcher active="table" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Analyze' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Analytical' }));
    expect(onSelect).toHaveBeenCalledWith('analytical');
  });

  it('builds a pivot from explicit row, column, value and aggregation choices', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const onClose = jest.fn();
    render(<PivotDialog
      columns={[
        { name: 'ID', type: 'INTEGER' },
        { name: 'AMOUNT', type: 'NUMERIC' },
        { name: 'CATEGORY', type: 'VARCHAR' },
      ]}
      defaults={{ rowColumnIndex: 0, pivotColumnIndex: 2, valueColumnIndex: 1, aggregation: 'sum' }}
      onSubmit={onSubmit}
      onClose={onClose}
    />);
    expect(screen.getByRole('combobox', { name: 'Pivot rows' })).toHaveValue('0');
    expect(screen.getByRole('combobox', { name: 'Pivot columns' })).toHaveValue('2');
    expect(screen.getByRole('combobox', { name: 'Pivot values' })).toHaveValue('1');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pivot aggregation' }), 'avg');
    await user.click(screen.getByRole('button', { name: 'Create pivot' }));
    expect(onSubmit).toHaveBeenCalledWith({
      rowColumnIndex: 0,
      pivotColumnIndex: 2,
      valueColumnIndex: 1,
      aggregation: 'avg',
    });
  });

  it('exports the row view as Markdown and XLSB from its export menu', async () => {
    const user = userEvent.setup();
    const onExportXlsb = jest.fn();
    const onNotify = jest.fn();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, write: jest.fn().mockResolvedValue(undefined) },
    });
    render(<RowViewPanel
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NOTE', type: 'VARCHAR' }]}
      rows={[[1, 'a'], [2, 'b']]}
      onClose={jest.fn()}
      onExportXlsb={onExportXlsb}
      onNotify={onNotify}
    />);
    await user.click(screen.getByRole('button', { name: 'Export row view' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('| ID | NOTE |\n| --- | --- |\n| 1 | a |\n| 2 | b |');
    expect(onNotify).toHaveBeenCalledWith('Row view copied as Markdown');

    await user.click(screen.getByRole('button', { name: 'Export row view' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download as XLSB' }));
    expect(onExportXlsb).toHaveBeenCalledTimes(1);
  });

  it('copies the row view as a PNG ClipboardItem', async () => {
    const user = userEvent.setup();
    const write = jest.fn().mockResolvedValue(undefined);
    const onNotify = jest.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined), write },
    });
    class MockClipboardItem {
      constructor(readonly data: Record<string, Blob>) {}
      get types(): string[] { return Object.keys(this.data); }
      async getType(type: string): Promise<Blob> { return this.data[type]!; }
    }
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: MockClipboardItem });
    const context = {
      scale: jest.fn(), fillRect: jest.fn(), beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(),
      quadraticCurveTo: jest.fn(), closePath: jest.fn(), stroke: jest.fn(), fill: jest.fn(), fillText: jest.fn(),
      measureText: jest.fn(() => ({ width: 20 })), textBaseline: '', textAlign: '', font: '', fillStyle: '', strokeStyle: '', lineWidth: 1,
    };
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['png'], { type: 'image/png' }), 'image/png'));
    render(<RowViewPanel
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1], [2]]}
      onClose={jest.fn()}
      onNotify={onNotify}
    />);
    await user.click(screen.getByRole('button', { name: 'Export row view' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy as Image' }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const items = write.mock.calls[0]![0] as MockClipboardItem[];
    expect(items[0]!.types).toEqual(['image/png']);
    expect(items[0]!.data['image/png']).toBeInstanceOf(Blob);
    expect(onNotify).toHaveBeenCalledWith('Row view copied as image');
  });

  it('resizes the row-view key column with the keyboard and persists the width', () => {
    window.localStorage.clear();
    render(<RowViewPanel
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1]]}
      onClose={jest.fn()}
    />);
    const splitter = screen.getByRole('separator', { name: 'Resize the column-name column' });
    expect(splitter).toHaveAttribute('aria-valuenow', '42');
    fireEvent.keyDown(splitter, { key: 'ArrowRight' });
    expect(splitter).toHaveAttribute('aria-valuenow', '44');
    expect(window.localStorage.getItem('justybase.row-view.key-column-width.v1')).toBe('44');
    fireEvent.keyDown(splitter, { key: 'ArrowLeft', shiftKey: true });
    expect(splitter).toHaveAttribute('aria-valuenow', '36');
    expect(window.localStorage.getItem('justybase.row-view.key-column-width.v1')).toBe('36');
  });

  it('renders a safe large-value viewer with copy and Escape close actions', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const onCopy = jest.fn();
    render(<CellValueViewer column={{ name: 'PAYLOAD', type: 'JSON' }} value={{ nested: true }} rowNumber={7} onClose={onClose} onCopy={onCopy} />);
    expect(screen.getByRole('dialog', { name: 'Cell Value: PAYLOAD' })).toBeInTheDocument();
    expect(screen.getByText(/"nested": true/)).toBeInTheDocument();
    expect(screen.getByText('Type: JSON | Row: 7')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy Value' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole('status').querySelector('.ui-activity-spinner')).not.toBeNull();
    // Result-panel hosts already animate the tab header, so the pane can opt out.
    rerender(<AsyncStateView state="loading" showActivity={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('status').querySelector('.ui-activity-spinner')).toBeNull();
    rerender(<AsyncStateView state="empty" emptyLabel="No rows" />);
    expect(screen.getByRole('status')).toHaveTextContent('No rows');
    rerender(<AsyncStateView state="error" message="Request failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
    rerender(<AsyncStateView state="cancelled" />);
    expect(screen.getByRole('status')).toHaveTextContent('Cancelled');
    rerender(<AsyncStateView state="ready">ready content</AsyncStateView>);
    expect(screen.getByText('ready content')).toBeInTheDocument();
  });

  it('marks a running tab and the execution banner with an animated spinner', () => {
    const { rerender } = render(<ResultTabs
      results={[{ ...result, status: 'loading', totalRowCount: 0 }]}
      activeResultSetId={result.resultSetId}
      onSelect={jest.fn()}
    />);
    const tab = screen.getByRole('tab', { name: /Result 1/ });
    expect(tab).toHaveAttribute('aria-busy', 'true');
    expect(tab.querySelector('.ui-activity-spinner.ui-result-tab-spinner')).not.toBeNull();

    // Host-level executing flags keep the Logs tab visually alive even though
    // the Logs result itself keeps a stable lifecycle.
    rerender(<ResultTabs
      results={[{ ...result, status: 'complete' }]}
      activeResultSetId={result.resultSetId}
      onSelect={jest.fn()}
      getLabel={() => 'Logs'}
      isBusy={() => true}
    />);
    const logsTab = screen.getByRole('tab', { name: 'Logs' });
    expect(logsTab).toHaveAttribute('aria-busy', 'true');
    expect(logsTab.querySelector('.ui-result-tab-spinner')).not.toBeNull();
    expect(logsTab).toHaveAttribute('title', expect.stringContaining('still running'));
  });

  it('shows an elapsed clock for a running query without a second spinner', () => {
    const onCancel = jest.fn();
    const startedAt = Date.now() - 65_000;
    const { rerender } = render(<ResultExecutionBanner status="loading" startedAt={startedAt} onCancel={onCancel} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Running query…');
    expect(banner).toHaveTextContent('1m 05s');
    // One query means one animated indicator: the tab header owns it.
    expect(banner.querySelector('.ui-activity-spinner')).toBeNull();
    expect(banner.querySelector('.ui-execution-banner-icon')?.textContent).toBe('▶');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    rerender(<ResultExecutionBanner status="success" startedAt={startedAt} onCancel={onCancel} />);
    expect(screen.queryByText(/Running query/)).not.toBeInTheDocument();
  });

  it('counts whole seconds, covers every running status and drops the clock without a start time', () => {
    jest.useFakeTimers();
    try {
      const startedAt = Date.now();
      const { rerender, container } = render(<ResultExecutionBanner status="loading" startedAt={startedAt} />);
      // Under a minute the clock renders seconds; the first tick is immediate.
      expect(screen.getByRole('status')).toHaveTextContent('0s');
      act(() => { jest.advanceTimersByTime(3000); });
      expect(screen.getByRole('status')).toHaveTextContent('3s');

      // A retry keeps the running spinner and the clock.
      rerender(<ResultExecutionBanner status="retrying" startedAt={startedAt} />);
      expect(screen.getByRole('status')).toHaveTextContent('Retrying query…');
      expect(container.querySelector('.ui-execution-banner-elapsed')).not.toBeNull();

      // Finalizing is still "running", but marks the icon as finalizing.
      rerender(<ResultExecutionBanner status="finalizing" startedAt={startedAt} />);
      expect(screen.getByRole('status')).toHaveTextContent('Finalizing result…');
      expect(container.querySelector('.ui-execution-banner-icon-finalizing')).not.toBeNull();
      // The banner never animates: the tab header owns the single spinner.
      expect(container.querySelector('.ui-activity-spinner')).toBeNull();

      // A tick that does not cross a second boundary must not re-render: freeze
      // the wall clock while the interval fires.
      const frozen = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(frozen);
      try {
        const before = container.querySelector('.ui-execution-banner-elapsed')?.textContent;
        act(() => { jest.advanceTimersByTime(1000); });
        expect(container.querySelector('.ui-execution-banner-elapsed')?.textContent).toBe(before);
      } finally {
        nowSpy.mockRestore();
      }

      // Terminal states keep a static icon and stop the clock.
      rerender(<ResultExecutionBanner status="cancelled" startedAt={startedAt} />);
      expect(screen.getByRole('status')).toHaveTextContent('Query cancelled.');
      expect(container.querySelector('.ui-execution-banner-elapsed')).toBeNull();
      expect(container.querySelector('.ui-activity-spinner')).toBeNull();

      rerender(<ResultExecutionBanner status="error" message="boom" startedAt={startedAt} />);
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
      expect(container.querySelector('.ui-activity-spinner')).toBeNull();

      // Without a start time the running banner keeps its spinner but shows no clock.
      rerender(<ResultExecutionBanner status="loading" />);
      expect(container.querySelector('.ui-execution-banner-elapsed')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('omits the elapsed clock for a missing or unusable start time', () => {
    // No start time on first mount exercises the reset path with no prior value.
    const { container, rerender } = render(<ExecutionElapsed />);
    expect(container.firstChild).toBeNull();

    // A real value followed by removal resets the stored seconds.
    rerender(<ExecutionElapsed startedAt={Date.now()} />);
    expect(container.textContent).toBe('0s');
    rerender(<ExecutionElapsed />);
    expect(container.firstChild).toBeNull();

    // A non-finite start time must not render NaN or Infinity.
    rerender(<ExecutionElapsed startedAt={Number.NaN} />);
    expect(container.textContent).toBe('');
    rerender(<ExecutionElapsed startedAt={Date.now() + 5_000} />);
    expect(container.textContent).toBe('0s');
  });

  it('marks terminal result tabs with badges, pins and running titles', () => {
    const onTogglePin = jest.fn();
    const { rerender, container } = render(<ResultTabs
      results={[
        { ...result, resultSetId: 'error', status: 'error' },
        { ...result, resultSetId: 'cancelled', status: 'cancelled' },
        { ...result, resultSetId: 'empty', status: 'empty' },
        { ...result, resultSetId: 'done', status: 'complete' },
      ]}
      activeResultSetId="done"
      onSelect={jest.fn()}
      isPinned={item => item.resultSetId === 'error'}
      onTogglePin={onTogglePin}
    />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]?.querySelector('.ui-result-tab-badge-error')?.textContent).toBe('Error');
    expect(tabs[1]?.querySelector('.ui-result-tab-badge-partial')?.textContent).toBe('Partial');
    expect(tabs[2]?.querySelector('.ui-result-tab-badge-empty')?.textContent).toBe('Empty');
    expect(tabs[3]?.querySelector('.ui-result-tab-badge')).toBeNull();
    // Only the pinned tab carries the pinned class and pressed pin state.
    expect(container.querySelectorAll('.ui-result-tab-pinned')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Unpin Result 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pin Result 2' })).toHaveAttribute('aria-pressed', 'false');

    // Statement metadata drives the inactive-tab tooltip.
    rerender(<ResultTabs
      results={[
        { ...result, resultSetId: 'error', status: 'error' },
        { ...result, resultSetId: 'statement', status: 'complete', statementIndex: 1 },
        { ...result, resultSetId: 'streaming', status: 'streaming', statementIndex: 1 },
      ]}
      activeResultSetId="error"
      onSelect={jest.fn()}
      execution={{
        sourceId: result.sourceId,
        executionId: result.executionId,
        mode: 'script',
        statementCount: 2,
        completedStatements: 1,
        status: 'running',
        statements: { 1: { statementIndex: 1, status: 'pending' } },
      }}
    />);
    expect(screen.getByRole('tab', { name: /Result 2/ })).toHaveAttribute('title', 'Statement 2: pending');
    // Only the streaming result is busy; terminal statuses stay quiet.
    const busyTabs = screen.getAllByRole('tab').filter(tab => tab.getAttribute('aria-busy') === 'true');
    expect(busyTabs).toHaveLength(1);
    expect(busyTabs[0]).toHaveTextContent('Result 3');
  });

  it('offers a Copilot fix action for failed SQL and keeps the driver caret text intact', () => {
    const onFixWithAi = jest.fn();
    const message = "ERROR: 'SELECT 1,2 FROM DIMDATE'\nerror           ^ found \",\" (at char 10) expecting an identifier";
    render(<ResultErrorView message={message} onFixWithAi={onFixWithAi} />);
    expect(screen.getByRole('alert')).toHaveTextContent('found "," (at char 10)');
    fireEvent.click(screen.getByRole('button', { name: 'Fix with Copilot' }));
    expect(onFixWithAi).toHaveBeenCalledTimes(1);
  });

  it('keeps a short echoed statement in the driver layout', () => {
    const message = "ERROR:    'SELECT 1,2\nFROM DIMDATE WHERE 1,,5'\nerror                    ^ found \",\" (at char 34) expecting a keyword";
    const { container } = render(<ResultErrorView message={message} />);
    expect(container.querySelector('.ui-result-error-message')?.textContent).toBe(message);
  });

  it('leads with the diagnostic and shortens a long echoed statement', () => {
    const columns = Array.from({ length: 40 }, (_value, index) => `d.COLUMN_WITH_A_LONG_NAME_${index}`).join(', ');
    const sql = `WITH abc as (\n\nSELECT ${columns} FROM just_data..DIMDATE d\n)\n\nSELECT ,,${columns} FROM abc`;
    const char = sql.indexOf('SELECT ,,') + 'SELECT '.length + 2;
    const message = `ERROR:  '${sql}'\nerror ^ found "," (at char ${char}) expecting an identifier`;
    const { container } = render(<ResultErrorView message={message} />);
    const text = container.querySelector('.ui-result-error-message')?.textContent ?? '';
    const [summary, excerpt, caretLine] = text.split('\n');
    expect(summary).toBe(`ERROR: found "," (at char ${char}) expecting an identifier`);
    expect(excerpt?.[caretLine!.indexOf('^')]).toBe(',');
    expect(container.querySelector('.ui-result-error-raw summary')?.textContent).toBe('Show full error details');
  });

  it('compacts long echoed SQL in log error hints', () => {
    const longSql = `SELECT ${Array.from({ length: 80 }, (_value, index) => `COL_${index}`).join(', ')} FROM T`;
    const message = `✗ ERROR: SELECT 1 | CONN | 10 ms | 1 row | ERROR:  '${longSql}'\nerror ^ found "," (at char 10) expecting an identifier`;
    const { container } = render(<LogConsole rows={[['12:00', message]]} />);
    const hint = container.querySelector('.log-error-hint')?.textContent ?? '';

    expect(hint).toContain('found "," (at char 10)');
    expect(hint.length).toBeLessThan(longSql.length);
    expect(hint).not.toContain('COL_40');
  });

  it('keeps every log badge static because the tab header owns the spinner', () => {
    const { container } = render(<LogConsole rows={[
      ['12:00', '▶ RUNNING: SELECT 1 | CONN | 5 s | 10 rows'],
      ['12:01', '✓ SUCCESS: SELECT 1 | CONN | 90 ms | 10 rows'],
      ['12:02', '✗ ERROR: SELECT 1 | CONN | 90 ms | 1 row | boom'],
    ]} />);
    const badges = [...container.querySelectorAll('.log-status')];
    expect(badges).toHaveLength(3);

    // The transcript reports state with a glyph; only the tab header animates,
    // so a running statement does not add a second ring to the same view.
    expect(badges[0]?.querySelector('.log-status-icon-spinner')).toBeNull();
    expect(badges[0]?.querySelector('.log-status-icon')?.textContent).toBe('▶');
    expect(badges[0]?.textContent).toContain('RUNNING');
    expect(badges[1]?.querySelector('.log-status-icon-spinner')).toBeNull();
    expect(badges[1]?.querySelector('.log-status-icon')?.textContent).toBe('✓');
    expect(badges[1]?.textContent).toContain('SUCCESS');
    expect(badges[2]?.querySelector('.log-status-icon-spinner')).toBeNull();
    expect(badges[2]?.querySelector('.log-status-icon')?.textContent).toBe('✗');
    expect(badges[2]?.textContent).toContain('ERROR');
  });

  it('hides the Copilot fix action when no SQL is available', () => {
    render(<ResultErrorView message="Connection lost" />);
    expect(screen.queryByRole('button', { name: 'Fix with Copilot' })).not.toBeInTheDocument();
  });

  it('renders a PostgreSQL position excerpt and structured diagnostics', () => {
    const sql = 'SELECT *\nFROM items\nWHERE idd = 1';
    const { container } = render(<ResultErrorView
      message='column "idd" does not exist'
      sql={sql}
      details={{
        code: '42703',
        severity: 'ERROR',
        position: 27,
        detail: 'The column is missing.',
        hint: 'Check the column name.',
        context: 'PL/pgSQL function f() line 4 at RETURN',
        diagnostics: { constraint: 'items_pkey', table: 'items' },
      }}
    />);
    expect(container.querySelector('.ui-result-error-excerpt')?.textContent).toContain('LINE 3: WHERE idd = 1');
    expect(container.querySelector('.ui-result-error-excerpt')?.textContent).toContain('^');
    expect(screen.getByText('42703')).toBeInTheDocument();
    expect(screen.getByText('Detail')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('items_pkey')).toBeInTheDocument();
  });

  it('keeps capability differences visible and guards writes', () => {
    render(<CapabilityGate capability={{ key: 'write', status: 'unsupported', owner: 'adapter', documentation: '/docs/write', removalCondition: 'Add provider support.' }}><span>hidden</span></CapabilityGate>);
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('unsupported');
    render(<DesignerForm fields={{ name: 'orders' }} capability={{ key: 'designer', status: 'read-only', owner: 'adapter', reason: 'Read-only profile.', documentation: '/docs/designer', removalCondition: 'Use a writable profile.' }} onChange={() => undefined} onApply={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  it('keeps a dragged rectangular selection moving while the pointer leaves the grid viewport', () => {
    const onSelectionChange = jest.fn();
    const { container } = render(<DataGrid
      resultSetId="selection-autoscroll"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'DETAILS', type: 'VARCHAR' }]}
      rows={Array.from({ length: 100 }, (_value, index) => [index + 1, `row-${index + 1}`])}
      onSelectionChange={onSelectionChange}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    const firstCell = screen.getByRole('cell', { name: 'row-1' });
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2_600 });
    jest.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 120, left: 0, right: 600, width: 600, height: 120, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);

    fireEvent.mouseDown(firstCell, { button: 0, clientX: 80, clientY: 80 });
    fireEvent.mouseMove(window, { clientX: 80, clientY: 180 });

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ focusRow: expect.any(Number) }));
  });

  it('scrolls horizontally when a dragged rectangular selection reaches a side edge', () => {
    const { container } = render(<DataGrid
      resultSetId="selection-horizontal-autoscroll"
      columns={[
        { name: 'ID', type: 'INTEGER' },
        { name: 'DETAILS', type: 'VARCHAR' },
        { name: 'STATUS', type: 'VARCHAR' },
        { name: 'CREATED_AT', type: 'DATE' },
        { name: 'OWNER', type: 'VARCHAR' },
      ]}
      rows={[[1, 'row-1', 'ready', '2026-01-01', 'alice']]}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    const firstCell = screen.getByRole('cell', { name: 'row-1' });
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 120 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1_000 });
    jest.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 120, left: 0, right: 120, width: 120, height: 120, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);

    fireEvent.mouseDown(firstCell, { button: 0, clientX: 60, clientY: 80 });
    fireEvent.mouseMove(window, { clientX: 180, clientY: 80 });

    expect(scroller.scrollLeft).toBeGreaterThan(0);
    scroller.scrollLeft = 500;
    fireEvent.mouseMove(window, { clientX: -60, clientY: 80 });
    expect(scroller.scrollLeft).toBeLessThan(500);
  });

  it('sizes result columns for the complete header, including action buttons', async () => {
    render(<DataGrid
      resultSetId="header-widths"
      columns={[{ name: 'VERY_LONG_COLUMN_NAME_WITH_FILTER_ACTIONS', type: 'VARCHAR' }]}
      rows={[['value']]}
      onOpenColumnFilter={jest.fn()}
      showInlineColumnFilters={false}
    />);
    const header = screen.getByRole('columnheader', { name: /VERY_LONG_COLUMN_NAME_WITH_FILTER_ACTIONS/ });
    await waitFor(() => expect(Number(header.getAttribute('style')?.match(/width:\s*([\d.]+)px/)?.[1] ?? 0)).toBeGreaterThan(144));
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

  it('restores both scroll axes by stable result-set identity and reports changes', async () => {
    const onScroll = jest.fn();
    const onRowSelect = jest.fn();
    render(<DataGrid resultSetId={result.resultSetId} columns={[{ name: 'ID' }, { name: 'DETAILS' }]} rows={[[1, { value: 'x' }], [2, [3]]]} scroll={{ resultSetId: result.resultSetId, top: 128, left: 64, anchorRow: 4, rowHeight: 26 }} onScroll={onScroll} onRowSelect={onRowSelect} />);
    const grid = screen.getByRole('table').parentElement as HTMLDivElement;
    expect(grid.scrollTop).toBe(128);
    expect(grid.scrollLeft).toBe(64);
    fireEvent.scroll(grid);
    await waitFor(() => expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({ resultSetId: result.resultSetId })));
    fireEvent.click(screen.getByRole('row', { name: /1/ }));
    expect(onRowSelect).toHaveBeenCalledWith(0);
    render(<DataGrid resultSetId={result.resultSetId} columns={result.columns} rows={[[1]]} scroll={{ resultSetId: 'different-result', top: -1, left: -1 }} />);
    render(<DataGrid resultSetId="empty-result" columns={[]} rows={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('No rows');
  });

  it('scrolls to and highlights a column through the imperative grid handle', () => {
    const ref = createRef<DataGridHandle>();
    const columns = ['COL_A', 'COL_B', 'COL_C', 'COL_D', 'COL_E', 'COL_F'].map(name => ({ name, type: 'VARCHAR' }));
    const onScroll = jest.fn();
    const { container } = render(<DataGrid
      ref={ref}
      resultSetId="scroll-to-column"
      columns={columns}
      rows={[columns.map((_column, index) => `value-${index}`)]}
      onScroll={onScroll}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    expect(scroller).not.toBeNull();
    if (!scroller || !ref.current) return;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 220 });

    act(() => ref.current?.scrollToColumn(5));
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: /COL_F/ }).querySelector('.ui-data-grid-column-highlight')).not.toBeNull();

    // Searching an earlier column scrolls back to the left.
    const rightScroll = scroller.scrollLeft;
    act(() => ref.current?.scrollToColumn(1));
    expect(scroller.scrollLeft).toBeLessThan(rightScroll);

    // Unknown/hidden column indexes are a no-op instead of scrolling to 0.
    const previous = scroller.scrollLeft;
    act(() => ref.current?.scrollToColumn(99));
    expect(scroller.scrollLeft).toBe(previous);
  });

  it('ignores column scroll requests without a mounted layout', () => {
    const ref = createRef<DataGridHandle>();
    const { unmount } = render(<DataGrid ref={ref} resultSetId="empty-column-handle" columns={[]} rows={[]} />);
    const handle = ref.current;
    expect(handle).not.toBeNull();
    act(() => handle?.scrollToColumn(0));
    unmount();
    act(() => handle?.scrollToColumn(0));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('calculates a bounded virtual window with stable pixel padding', () => {
    expect(resolveDataGridScrollTop(15_000, 500)).toBe(13_000);
    expect(resolveDataGridScrollTop(128, 4, 26)).toBe(128);
    expect(resolveDataGridScrollTop(96)).toBe(96);
    expect(calculateDataGridVirtualWindow(0, 120, 300, 2)).toEqual({
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
    expect(calculateDataGridVirtualWindow(1000, 0, 300, 2)).toEqual({
      startIndex: 0,
      endIndex: 14,
      paddingTop: 0,
      paddingBottom: 25_636,
    });
    expect(calculateDataGridVirtualWindow(1000, 900, 300, 2)).toEqual({
      startIndex: 32,
      endIndex: 48,
      paddingTop: 832,
      paddingBottom: 24_752,
    });
    expect(calculateDataGridVirtualWindow(1000, 900, 300, 2, 62)).toEqual({
      startIndex: 32,
      endIndex: 46,
      paddingTop: 832,
      paddingBottom: 24_804,
    });
    expect(calculateDataGridVirtualWindow(4, Number.NaN, 0, -2)).toEqual({
      startIndex: 0,
      endIndex: 1,
      paddingTop: 0,
      paddingBottom: 78,
    });

    const largeResult = calculateDataGridVirtualWindow(150_000, 0, 480);
    expect(largeResult.endIndex - largeResult.startIndex).toBeLessThan(40);
    expect(largeResult.paddingBottom).toBe((150_000 - largeResult.endIndex) * 26);
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
      expect(renderedRows()[0]).toHaveTextContent('569');
      expect(renderedRows()[renderedRows().length - 1]).toHaveTextContent('587');
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
      expect(scroller.scrollTop).toBe(13_000);
      expect(scroller.scrollLeft).toBe(240);
      const renderedRows = container.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.ui-data-grid-virtual-spacer)');
      expect(renderedRows[0]).toHaveTextContent('493');
      expect(renderedRows[renderedRows.length - 1]).toHaveTextContent('511');
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

  it('does not restore a stale controlled position while a page is appended', () => {
    const { rerender } = render(<DataGrid resultSetId="append-result" columns={[{ name: 'ID' }]} rows={[[1]]} scroll={{ resultSetId: 'append-result', top: 0, left: 0 }} />);
    const grid = screen.getByRole('table').parentElement as HTMLDivElement;
    grid.scrollTop = 420;
    fireEvent.scroll(grid);
    rerender(<DataGrid resultSetId="append-result" columns={[{ name: 'ID' }]} rows={[[1], [2]]} scroll={{ resultSetId: 'append-result', top: 0, left: 0 }} />);
    expect(grid.scrollTop).toBe(420);
  });

  it('keeps a controlled native scroll until the host confirms it, even when a page is appended', async () => {
    const onScroll = jest.fn();
    const { rerender } = render(<DataGrid
      resultSetId="controlled-append"
      columns={[{ name: 'ID' }]}
      rows={[[1]]}
      scroll={{ resultSetId: 'controlled-append', top: 0, left: 0 }}
      onScroll={onScroll}
    />);
    const grid = screen.getByRole('table').parentElement as HTMLDivElement;
    expect(grid.scrollTop).toBe(0);

    grid.scrollTop = 420;
    grid.scrollLeft = 64;
    fireEvent.scroll(grid);
    await waitFor(() => expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({
      resultSetId: 'controlled-append',
      top: 420,
      left: 64,
    })));

    // The controlled host still reports the stale 0/0 for one frame while a
    // page is appended. The grid must not restore the stale prop back.
    rerender(<DataGrid
      resultSetId="controlled-append"
      columns={[{ name: 'ID' }]}
      rows={[[1], [2]]}
      scroll={{ resultSetId: 'controlled-append', top: 0, left: 0 }}
      onScroll={onScroll}
    />);
    expect(grid.scrollTop).toBe(420);
    expect(grid.scrollLeft).toBe(64);

    // The host confirms the native position. The pending guard clears without
    // moving the viewport.
    rerender(<DataGrid
      resultSetId="controlled-append"
      columns={[{ name: 'ID' }]}
      rows={[[1], [2]]}
      scroll={{ resultSetId: 'controlled-append', top: 420, left: 64 }}
      onScroll={onScroll}
    />);
    expect(grid.scrollTop).toBe(420);
    expect(grid.scrollLeft).toBe(64);

    // An explicit host position change after the confirmation still restores.
    rerender(<DataGrid
      resultSetId="controlled-append"
      columns={[{ name: 'ID' }]}
      rows={[[1], [2], [3]]}
      scroll={{ resultSetId: 'controlled-append', top: 0, left: 0 }}
      onScroll={onScroll}
    />);
    expect(grid.scrollTop).toBe(0);
    expect(grid.scrollLeft).toBe(0);
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

    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toBeInTheDocument();
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

  it('sorts once on a single header click and inserts the column name on a double click', () => {
    jest.useFakeTimers();
    try {
      const onViewChange = jest.fn();
      const onInsertCellContent = jest.fn();
      render(<DataGrid
        resultSetId="header-double-click"
        columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'Order Date', type: 'VARCHAR' }]}
        rows={[[1, 'alpha']]}
        view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
        onViewChange={onViewChange}
        onInsertCellContent={onInsertCellContent}
      />);

      const idHeader = screen.getByRole('button', { name: /ID Not sorted/ });
      fireEvent.click(idHeader, { detail: 1 });
      expect(onViewChange).not.toHaveBeenCalled();
      act(() => { jest.advanceTimersByTime(250); });
      expect(onViewChange).toHaveBeenCalledWith({ sorting: [{ column: 'ID', descending: false }] });

      onViewChange.mockClear();
      const quotedHeader = screen.getByRole('button', { name: /Order Date Not sorted/ });
      fireEvent.click(quotedHeader, { detail: 1 });
      fireEvent.click(quotedHeader, { detail: 2 });
      fireEvent.doubleClick(quotedHeader);
      act(() => { jest.advanceTimersByTime(250); });
      expect(onViewChange).not.toHaveBeenCalled();
      expect(onInsertCellContent).toHaveBeenCalledWith({
        text: 'Order Date',
        sqlText: '"Order Date"',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the compact Excel-like filter action instead of inline fields', () => {
    const onOpenColumnFilter = jest.fn();
    const { container } = render(<DataGrid
      resultSetId="compact-filter-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }]}
      rows={[[1, 'alpha']]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onOpenColumnFilter={onOpenColumnFilter}
      showInlineColumnFilters={false}
    />);

    expect(container.querySelector('.ui-data-grid-compact')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Filter NAME' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open filter for NAME' }));
    expect(onOpenColumnFilter).toHaveBeenCalledWith(expect.objectContaining({
      columnIndex: 1,
      column: expect.objectContaining({ name: 'NAME' }),
      anchor: expect.anything(),
    }));
  });

  it('delegates clipboard writes to the host port with the typed payload', () => {
    const clipboardWriter = jest.fn();
    render(<DataGrid
      resultSetId="clipboard-port"
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[42]]}
      clipboardWriter={clipboardWriter}
    />);
    const cell = screen.getByRole('cell', { name: '42' });
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.keyDown(screen.getByRole('table').parentElement as HTMLDivElement, { key: 'c', ctrlKey: true });
    expect(clipboardWriter).toHaveBeenCalledWith(expect.objectContaining({
      columns: [expect.objectContaining({ name: 'ID' })],
      rows: [[42]],
    }), 'text');
  });

  it('keeps the grid context actions identical for shared hosts', () => {
    const onViewChange = jest.fn();
    const onCopySelection = jest.fn();
    const onRowSelect = jest.fn();
    const onViewRow = jest.fn();
    const onViewCell = jest.fn();
    const onOpenResultFormatting = jest.fn();
    render(<DataGrid
      resultSetId="context-actions"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }]}
      rows={[[2, 'beta'], [1, 'alpha']]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onViewChange={onViewChange}
      onCopySelection={onCopySelection}
      onRowSelect={onRowSelect}
      onViewRow={onViewRow}
      onViewCell={onViewCell}
      onOpenResultFormatting={onOpenResultFormatting}
    />);
    const beta = screen.getByRole('cell', { name: 'beta' });
    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    expect(screen.getByRole('menu', { name: 'Actions for row 1' })).toBeInTheDocument();
    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.length).toBeGreaterThan(5);
    for (const menuEntry of menuItems) {
      const icon = menuEntry.querySelector('.ui-menu-icon');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.querySelector('svg')).not.toBeNull();
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by this value' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ columnFilters: { NAME: 'beta' } });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort descending' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ sorting: [{ column: 'NAME', descending: true }] });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy row' }));
    expect(onCopySelection).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [[2, 'beta']] }), 'tsv');

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy row as JSON' }));
    expect(onCopySelection).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [[2, 'beta']], includeHeaders: false }), 'json');

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy row as Markdown' }));
    expect(onCopySelection).toHaveBeenLastCalledWith(expect.objectContaining({ includeHeaders: true }), 'markdown');

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear Filter' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ columnFilters: {} });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Group by This Column' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ grouping: ['NAME'] });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'View Cell Value' }));
    expect(onViewCell).toHaveBeenLastCalledWith({ rowIndex: 0, columnIndex: 1, clientX: 40, clientY: 60 });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Result Formatting…' }));
    expect(onOpenResultFormatting).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide Column' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ columnVisibility: { NAME: false } });

    fireEvent.contextMenu(beta, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'View full row' }));
    expect(onRowSelect).toHaveBeenLastCalledWith(0);
    expect(onViewRow).toHaveBeenLastCalledWith({ rowIndex: 0, columnIndex: 1, clientX: 40, clientY: 60 });
  });

  it('supports dragging a column into the grouping panel and removing its chip', () => {
    const onViewChange = jest.fn();
    const firstRender = render(<DataGrid
      resultSetId="group-panel"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['B', 2]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [] }}
      onViewChange={onViewChange}
    />);
    fireEvent.dragStart(screen.getByRole('button', { name: 'Reorder TEAM' }));
    fireEvent.drop(screen.getByRole('group', { name: 'Grouping panel' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ grouping: ['TEAM'] });
    firstRender.unmount();

    const reorderRender = render(<DataGrid
      resultSetId="group-panel-reorder"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['B', 2]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['TEAM', 'VALUE'] }}
      onViewChange={onViewChange}
    />);
    const groupingItems = screen.getAllByRole('listitem');
    fireEvent.dragStart(screen.getByRole('button', { name: 'Reorder grouping VALUE' }));
    fireEvent.drop(groupingItems[0]);
    expect(onViewChange).toHaveBeenLastCalledWith({ grouping: ['VALUE', 'TEAM'] });
    reorderRender.unmount();

    render(<DataGrid
      resultSetId="group-panel"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['B', 2]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['TEAM'] }}
      onViewChange={onViewChange}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove grouping TEAM' }));
    expect(onViewChange).toHaveBeenLastCalledWith({ grouping: [] });
  });

  it('keeps the full grid context menu inside the viewport', () => {
    render(<DataGrid
      resultSetId="context-menu-position"
      columns={[{ name: 'ID' }]}
      rows={[[1]]}
      onViewCell={jest.fn()}
      onViewRow={jest.fn()}
    />);
    fireEvent.contextMenu(screen.getByRole('cell', { name: '1' }), { clientX: 1400, clientY: 890 });
    const menu = screen.getByRole('menu', { name: 'Actions for row 1' });
    expect(Number.parseFloat(menu.style.left)).toBeLessThan(1400);
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(890);
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

  it('honours positional keys from legacy grid views after switching to semantic ids', () => {
    render(<DataGrid
      resultSetId="legacy-column-keys"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }]}
      rows={[[1, 'Alpha']]}
      view={{
        globalFilter: '',
        columnFilters: {},
        sorting: [],
        grouping: [],
        columnVisibility: { '0': false },
        columnWidths: { '1': 220 },
      }}
    />);
    expect(screen.queryByRole('columnheader', { name: /ID/ })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /NAME/ })).toHaveStyle({ width: '220px' });
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
    const getCellMetadata = jest.fn((value: unknown, rowIndex: number, columnIndex: number, column: { name: string }) => {
      void value;
      void rowIndex;
      void columnIndex;
      void column;
      return { type: 'TEXT' };
    });
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

  it('inserts a SQL-ready cell value on double-click outside edit mode', () => {
    const onInsertCellContent = jest.fn();
    render(<DataGrid
      resultSetId="sql-insert-grid"
      columns={[
        { name: 'ID', type: 'INTEGER' },
        { name: 'NAME', type: 'VARCHAR(20)' },
        { name: 'AMOUNT', type: 'NUMERIC(10,2)', scale: 2 },
        { name: 'EVENT_DATE', type: 'DATE' },
        { name: 'ACTIVE', type: 'BOOLEAN' },
      ]}
      rows={[[1, "O'Reilly", '1234.50', '2024-01-01', true]]}
      onInsertCellContent={onInsertCellContent}
    />);
    const cells = screen.getAllByRole('cell');
    fireEvent.doubleClick(cells[1]!);
    expect(onInsertCellContent).toHaveBeenLastCalledWith({
      text: "O'Reilly",
      dataType: 'VARCHAR(20)',
      sqlText: "'O''Reilly'",
    });
    fireEvent.doubleClick(cells[0]!);
    expect(onInsertCellContent).toHaveBeenLastCalledWith({
      text: '1',
      dataType: 'INTEGER',
      sqlText: '1',
    });
    fireEvent.doubleClick(cells[2]!);
    expect(onInsertCellContent).toHaveBeenLastCalledWith({
      text: '1234.50',
      dataType: 'NUMERIC(10,2)',
      sqlText: '1234.50',
    });
    fireEvent.doubleClick(cells[3]!);
    expect(onInsertCellContent).toHaveBeenLastCalledWith({
      text: '2024-01-01',
      dataType: 'DATE',
      sqlText: "'2024-01-01'",
    });
    fireEvent.doubleClick(cells[4]!);
    expect(onInsertCellContent).toHaveBeenLastCalledWith({
      text: 'true',
      dataType: 'BOOLEAN',
      sqlText: 'TRUE',
    });
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

  it('numbers group bands with the first row of the group and starts collapsed', () => {
    render(<DataGrid
      resultSetId="group-band-numbers"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['A', 2], ['B', 3]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['0'] }}
    />);
    const bands = Array.from(document.querySelectorAll('.ui-data-grid-group-row'));
    expect(bands.map(band => band.querySelector('.ui-data-grid-row-number')?.textContent)).toEqual(['1', '3']);
    expect(bands.every(band => band.querySelector('.ui-data-grid-row-number')?.getAttribute('aria-label')?.startsWith('Group starting at row'))).toBe(true);
  });

  it('uses host group counts and shows groups missing from the loaded window', () => {
    const { container } = render(<DataGrid
      resultSetId="disk-backed-group-counts"
      columns={[{ name: 'BALANCE', type: 'INTEGER' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[[875, 1], [875, 2]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['BALANCE'] }}
      groupCounts={new Map([[JSON.stringify(['875']), 197_274]])}
      extraGroups={[{ path: ['900'], count: 26_401 }]}
    />);
    const counts = Array.from(container.querySelectorAll('.ui-data-grid-group-count'))
      .map(node => (node.textContent ?? '').replace(/[^\d]/g, ''));
    expect(counts).toEqual(['197274', '26401']);
    expect(screen.getByRole('button', { name: 'Expand group BALANCE: 900' })).toHaveAttribute('title', 'Rows for this group are not in the loaded window');
  });

  it('marks local counts as lower bounds when the host group list is partial', () => {
    render(<DataGrid
      resultSetId="partial-disk-backed-groups"
      columns={[{ name: 'BALANCE', type: 'INTEGER' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[[875, 1], [875, 2]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['BALANCE'] }}
      groupCountsPartial
    />);
    expect(screen.getByText('~2 rows')).toBeInTheDocument();
  });

  it('starts grouped rows collapsed and reopens them on demand', () => {
    render(<DataGrid
      resultSetId="collapsible-groups"
      columns={[{ name: 'TEAM' }, { name: 'VALUE', type: 'INTEGER' }]}
      rows={[['A', 1], ['A', 2], ['B', 3]]}
      view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: ['0'] }}
    />);
    expect(screen.getByText('1 rows')).toBeInTheDocument();
    expect(screen.getByText('2 rows')).toBeInTheDocument();
    // Adding a grouping column shows only the group bands until a band is opened.
    expect(screen.queryByRole('row', { name: /A 1/ })).not.toBeInTheDocument();
    const expandButton = screen.getByRole('button', { name: 'Expand group TEAM: A' });
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    // The visible name is inside the toggle, so clicking the label (not only
    // the chevron) expands the band.
    const label = expandButton.querySelector('.ui-data-grid-group-label');
    expect(label).toHaveTextContent('TEAM: A');
    fireEvent.click(label!);
    expect(screen.getByRole('row', { name: /A 1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse group TEAM: A' }));
    expect(screen.queryByRole('row', { name: /A 1/ })).not.toBeInTheDocument();
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
        .reduce((sum, spacer) => sum + Number.parseFloat(spacer.querySelector('.ui-data-grid-virtual-spacer-inner')?.getAttribute('style')?.match(/height:\s*([\d.]+)px/u)?.[1] ?? '0'), 0);
      expect(screen.queryByRole('row', { name: /A 1/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Expand group TEAM: A' }));
      act(() => { jest.runOnlyPendingTimers(); });
      const expanded = spacerHeight();
      fireEvent.click(screen.getByRole('button', { name: 'Collapse group TEAM: A' }));
      act(() => { jest.runOnlyPendingTimers(); });
      const collapsed = spacerHeight();
      expect(collapsed).toBeLessThan(expanded);
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
    fireEvent.click(screen.getByRole('button', { name: 'Expand group TEAM: A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand group TEAM: B' }));
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

  it('does not start concurrent loads while the virtual scroll remains at the end', async () => {
    let resolveLoad: (() => void) | undefined;
    const onLoadMore = jest.fn(() => new Promise<void>(resolve => { resolveLoad = resolve; }));
    const { container } = render(<DataGrid
      resultSetId="guarded-paging"
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1]]}
      totalRowCount={3}
      onLoadMore={onLoadMore}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 120 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1_000 });
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    fireEvent.scroll(scroller);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });
    fireEvent.scroll(scroller);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
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

  it('can hide the redundant toolbar sort and group shortcuts', () => {
    render(<ResultViewToolbar
      columns={[{ name: 'ID' }]}
      view={{ globalFilter: '', sorting: [], grouping: [], aggregation: undefined, pivotColumn: undefined }}
      onChange={jest.fn()}
      showSort={false}
      showGroup={false}
    />);
    expect(screen.queryByRole('button', { name: 'Sort' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Group' })).not.toBeInTheDocument();
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

  it('routes analysis actions to the adapter and renders the analysis table with the shared grid', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const onAggregate = jest.fn();
    const onGroup = jest.fn();
    const onPivot = jest.fn();
    const onClose = jest.fn();
    render(<>
      <ResultViewToolbar
        columns={[{ name: 'CATEGORY' }]}
        view={{ globalFilter: '', sorting: [], grouping: [], aggregation: undefined, pivotColumn: undefined }}
        onChange={onChange}
        onAggregate={onAggregate}
        onGroup={onGroup}
        onPivot={onPivot}
        activeAnalysis="group"
      />
      <ResultAnalysisPanel
        sourceId="source-1"
        resultSetId="result-1"
        table={{ kind: 'group', title: 'Grouped result', summary: '2 groups', columns: [{ name: 'CATEGORY' }, { name: 'COUNT', type: 'BIGINT' }], rows: [['A', 2], ['B', 1]] }}
        onClose={onClose}
      />
    </>);
    expect(screen.getByRole('button', { name: 'Group' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Aggregate' }));
    await user.click(screen.getByRole('button', { name: 'Group' }));
    await user.click(screen.getByRole('button', { name: 'Pivot' }));
    expect(onAggregate).toHaveBeenCalledTimes(1);
    expect(onGroup).toHaveBeenCalledTimes(1);
    expect(onPivot).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Grouped result' })).toBeInTheDocument();
    expect(screen.getByText('2 groups')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'A' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close result analysis' }));
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
      onOpenEditData: jest.fn(),
      onOpenDdl: jest.fn(),
      onCopyDdl: jest.fn(),
      onImport: jest.fn(),
      onCopyName: jest.fn(),
    };
    const table = { id: 'table-1', kind: 'object' as const, label: 'ORDERS', objectName: 'ORDERS', objectType: 'TABLE', database: 'DB', schema: 'PUBLIC', hasChildren: true };
    render(<SchemaTree nodes={[table]} onSelect={jest.fn()} {...actions} />);
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 80, clientY: 120 });
    expect(screen.getByRole('menu', { name: 'Actions for ORDERS' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Select Top 1000' }));
    expect(actions.onOpenQuery).toHaveBeenCalledWith(expect.objectContaining({ id: 'table-1' }));
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 80, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: 'View/Edit Data (Limit 50k)' }));
    expect(actions.onOpenEditData).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 80, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: 'Create DDL Code' }));
    expect(actions.onOpenDdl).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 80, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: 'Copy DDL' }));
    expect(actions.onCopyDdl).toHaveBeenCalledTimes(1);
  });

  it('keeps shared schema search, shortcuts and lifecycle controls host-neutral', async () => {
    const user = userEvent.setup();
    const callbacks = {
      onSearchChange: jest.fn(),
      onRefresh: jest.fn(),
      onExpandAll: jest.fn(),
      onCollapseAll: jest.fn(),
      onActivate: jest.fn(),
      onToggleFavorite: jest.fn(),
      onFilterToggle: jest.fn(),
    };
    const table = { id: 'table-1', kind: 'object' as const, label: 'ORDERS', objectName: 'ORDERS', objectType: 'TABLE', database: 'DB', schema: 'PUBLIC', hasChildren: true };
    const favorite = { ...table, id: 'favorite-1', label: 'CUSTOMERS', objectName: 'CUSTOMERS' };
    render(<SchemaTree
      nodes={[table]}
      searchValue=""
      searchResults={[{ ...table, id: 'search-table-1', hasChildren: false }]}
      filters={[{ id: 'TABLE', label: 'Tables' }]}
      activeFilterIds={['TABLE']}
      favorites={[favorite]}
      recent={[table]}
      {...callbacks}
    />);
    await user.type(screen.getByRole('textbox', { name: 'Search schema' }), 'ord');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all schema nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all schema nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tables' }));
    expect(callbacks.onSearchChange).toHaveBeenCalledWith('o');
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
    expect(callbacks.onExpandAll).toHaveBeenCalledTimes(1);
    expect(callbacks.onCollapseAll).toHaveBeenCalledTimes(1);
    expect(callbacks.onFilterToggle).toHaveBeenCalledWith('TABLE');
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    const treeItem = screen.getAllByRole('treeitem', { name: /ORDERS/ }).at(-1)!;
    fireEvent.contextMenu(treeItem, { clientX: 40, clientY: 40 });
    await user.click(screen.getByRole('menuitem', { name: 'Add to favorites' }));
    expect(callbacks.onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ objectName: 'ORDERS' }));
    await user.click(treeItem.querySelector('button:last-child')!);
    expect(callbacks.onActivate).toHaveBeenCalledWith(expect.objectContaining({ objectName: 'ORDERS' }));
  });

  it('keeps history filtering and row actions in the shared presentation layer', async () => {
    const user = userEvent.setup();
    const callbacks = { onOpen: jest.fn(), onRerun: jest.fn(), onCopy: jest.fn(), onRefresh: jest.fn() };
    render(<HistoryView entries={[{ id: 'history-1', label: 'SELECT orders', status: 'success', sqlFingerprint: 'today · 3 rows', sql: 'SELECT * FROM orders' }, { id: 'history-2', label: 'DELETE old rows', status: 'error', sqlFingerprint: 'yesterday', sql: 'DELETE FROM old_rows' }]} {...callbacks} />);
    await user.type(screen.getByRole('textbox', { name: 'Filter history' }), 'orders');
    expect(screen.getByRole('button', { name: /SELECT orders/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DELETE old rows/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    await user.click(screen.getByRole('button', { name: 'Copy query' }));
    await user.click(screen.getByRole('button', { name: /SELECT orders/ }));
    await user.click(screen.getByRole('button', { name: 'Refresh history' }));
    expect(callbacks.onRerun).toHaveBeenCalledWith(expect.objectContaining({ id: 'history-1' }));
    expect(callbacks.onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: 'history-1' }));
    expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'history-1' }));
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
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

  it('calculates a pinned-aware column window with stable spacer extents', () => {
    const widths = Array.from({ length: 100 }, () => 100);
    const near = calculateDataGridColumnWindow(widths, 0, 1_000, 1);
    expect(near.windowed).toBe(true);
    expect(near.startIndex).toBe(1);
    expect(near.paddingLeft).toBe(0);
    expect(near.paddingRight).toBeGreaterThan(0);

    const far = calculateDataGridColumnWindow(widths, 5_000, 1_000, 0);
    expect(far.windowed).toBe(true);
    expect(far.startIndex).toBe(48);
    expect(far.paddingLeft).toBe(4_800);
    expect(far.endIndex).toBe(62);
    expect(far.paddingRight).toBe(3_800);

    const narrow = calculateDataGridColumnWindow(widths.slice(0, 20), 0, 1_000, 0);
    expect(narrow).toMatchObject({ startIndex: 0, endIndex: 20, paddingLeft: 0, paddingRight: 0, windowed: false });
    expect(calculateDataGridColumnWindow([], 0, 800, 0).windowed).toBe(false);
  });

  it('maps Excel-style navigation keys without taking over Tab', () => {
    const base = { row: 5, column: 2, rowCount: 10, columnCount: 5, pageRows: 3 } as const;
    expect(resolveDataGridNavigationTarget({ ...base, key: 'ArrowDown' })).toEqual({ row: 6, column: 2, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'ArrowUp', shiftKey: true })).toEqual({ row: 4, column: 2, extend: true });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'ArrowRight' })).toEqual({ row: 5, column: 3, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'Home' })).toEqual({ row: 5, column: 0, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'End', ctrlKey: true })).toEqual({ row: 9, column: 4, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'PageDown' })).toEqual({ row: 8, column: 2, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'PageUp', ctrlKey: true })).toEqual({ row: 0, column: 2, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'ArrowUp', row: 0 })).toEqual({ row: 0, column: 2, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'ArrowRight', column: 4 })).toEqual({ row: 5, column: 4, extend: false });
    expect(resolveDataGridNavigationTarget({ ...base, key: 'Tab' })).toBeUndefined();
    expect(resolveDataGridNavigationTarget({ ...base, key: 'Enter' })).toBeUndefined();
  });

  it('mounts only a window of wide result columns and keeps pinned columns mounted', () => {
    jest.useFakeTimers();
    try {
      const columns = Array.from({ length: 80 }, (_value, index) => ({ name: `COL_${index}`, type: 'INTEGER' }));
      const rows = [Array.from({ length: 80 }, (_value, index) => index)];
      const { container } = render(<DataGrid
        resultSetId="wide-grid"
        columns={columns}
        rows={rows}
        view={{ globalFilter: '', columnFilters: {}, sorting: [], grouping: [], pinnedColumns: ['COL_0'] }}
      />);
      const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
      expect(scroller).not.toBeNull();
      if (!scroller) return;
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 });
      act(() => { jest.runOnlyPendingTimers(); });

      const mountedHeaders = (): readonly string[] => Array.from(
        container.querySelectorAll<HTMLElement>('.ui-data-grid-header-label > span:first-child'),
      ).map(element => element.textContent ?? '');
      const headerSpacers = (): readonly HTMLElement[] => Array.from(
        container.querySelectorAll<HTMLElement>('thead .ui-data-grid-column-spacer'),
      );

      expect(mountedHeaders()).toContain('COL_0');
      expect(mountedHeaders()).toContain('COL_1');
      expect(mountedHeaders().length).toBeLessThan(80);
      expect(mountedHeaders()).not.toContain('COL_70');
      expect(headerSpacers().length).toBeGreaterThan(0);
      expect(headerSpacers().reduce((sum, spacer) => sum + Number.parseFloat(spacer.style.width || '0'), 0)).toBeGreaterThan(0);

      scroller.scrollLeft = 9_600;
      fireEvent.scroll(scroller);
      act(() => { jest.runOnlyPendingTimers(); });
      expect(mountedHeaders()).toContain('COL_0');
      expect(mountedHeaders()).not.toContain('COL_1');
      expect(mountedHeaders().length).toBeLessThan(80);
    } finally {
      jest.useRealTimers();
    }
  });

  it('toggles discontiguous cells with Ctrl+click and copies their bounding rectangle', () => {
    const onSelectionChange = jest.fn();
    const onCopySelection = jest.fn();
    render(<DataGrid
      resultSetId="multi-select-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }]}
      rows={[[1, 'a'], [2, 'b'], [3, 'c']]}
      onSelectionChange={onSelectionChange}
      onCopySelection={onCopySelection}
    />);
    const first = screen.getByRole('cell', { name: 'a' });
    const last = screen.getByRole('cell', { name: 'c' });

    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseDown(last, { button: 0, ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchorRow: 2,
      anchorColumn: 1,
      focusRow: 2,
      focusColumn: 1,
      additionalRanges: [{ minRow: 0, maxRow: 0, minColumn: 1, maxColumn: 1 }],
    });
    expect(first).toHaveClass('ui-data-grid-cell-selected');
    expect(last).toHaveClass('ui-data-grid-cell-selected');

    // Ctrl+click the active cell again toggles it off and promotes the
    // remaining discontiguous cell back to the active rectangle.
    fireEvent.mouseDown(last, { button: 0, ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      anchorRow: 0,
      anchorColumn: 1,
      focusRow: 0,
      focusColumn: 1,
    });
    expect(first).toHaveClass('ui-data-grid-cell-selected');
    expect(last).not.toHaveClass('ui-data-grid-cell-selected');

    fireEvent.mouseDown(last, { button: 0, ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('table').parentElement as HTMLDivElement, { key: 'c', ctrlKey: true });
    expect(onCopySelection).toHaveBeenCalledWith(expect.objectContaining({
      columns: [expect.objectContaining({ name: 'NAME' })],
      rows: [['a'], ['b'], ['c']],
    }));
  });

  it('keeps the keyboard focus row fully visible under the sticky header', () => {
    const { container } = render(<DataGrid
      resultSetId="keyboard-scroll-header"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }]}
      rows={Array.from({ length: 100 }, (_value, index) => [index + 1, `row-${index + 1}`])}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 260 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 100 * 26 });
    const header = 62;
    // Walk to the last row that still fits below the sticky header; the next
    // press must scroll by the overflow (header included), not by a whole row.
    for (let index = 0; index < 8; index += 1) fireEvent.keyDown(scroller, { key: 'ArrowDown' });
    expect(scroller.scrollTop).toBe(header + 8 * 26 + 26 - 260);
    // Scrolling back to the top must stop when row 0 sits directly below the
    // header; the header offset must never be re-subtracted into a gap.
    for (let index = 0; index < 10; index += 1) fireEvent.keyDown(scroller, { key: 'ArrowUp' });
    expect(scroller.scrollTop).toBe(0);
  });

  it('marks the current cell inside a multi-cell keyboard selection', () => {
    const { container } = render(<DataGrid
      resultSetId="keyboard-current-cell"
      columns={[{ name: 'A' }, { name: 'B' }]}
      rows={Array.from({ length: 6 }, (_value, index) => [index, index])}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    fireEvent.keyDown(scroller, { key: 'ArrowDown' });
    fireEvent.keyDown(scroller, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(scroller, { key: 'ArrowRight', shiftKey: true });
    const current = container.querySelectorAll('.ui-data-grid-cell-current');
    expect(current).toHaveLength(1);
    expect(current[0]?.closest('tr')?.getAttribute('data-row-index')).toBe('2');
    expect(current[0]?.getAttribute('data-column-index')).toBe('1');
    expect(current[0]).toHaveClass('ui-data-grid-cell-selected');
    expect(container.querySelectorAll('.ui-data-grid-cell-selected')).toHaveLength(4);
  });

  it('navigates and extends the shared grid selection from the keyboard', () => {
    const onSelectionChange = jest.fn();
    const onRowSelect = jest.fn();
    const { container } = render(<DataGrid
      resultSetId="keyboard-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }, { name: 'OWNER' }]}
      rows={Array.from({ length: 40 }, (_value, index) => [index + 1, `row-${index + 1}`, 'alice'])}
      onSelectionChange={onSelectionChange}
      onRowSelect={onRowSelect}
    />);
    const scroller = container.querySelector<HTMLDivElement>('.ui-data-grid-scroll');
    expect(scroller).not.toBeNull();
    if (!scroller) return;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 260 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 40 * 26 });

    fireEvent.keyDown(scroller, { key: 'ArrowDown' });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 1, anchorColumn: 0, focusRow: 1, focusColumn: 0 });
    fireEvent.keyDown(scroller, { key: 'Enter' });
    expect(onRowSelect).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(scroller, { key: 'ArrowDown' });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 2, anchorColumn: 0, focusRow: 2, focusColumn: 0 });
    fireEvent.keyDown(scroller, { key: 'ArrowRight', shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 2, anchorColumn: 0, focusRow: 2, focusColumn: 1 });
    fireEvent.keyDown(scroller, { key: 'End' });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 2, anchorColumn: 2, focusRow: 2, focusColumn: 2 });
    fireEvent.keyDown(scroller, { key: 'PageDown' });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 8, anchorColumn: 2, focusRow: 8, focusColumn: 2 });
    fireEvent.keyDown(scroller, { key: 'End', ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 39, anchorColumn: 2, focusRow: 39, focusColumn: 2 });
    expect(scroller.scrollTop).toBe(780);
    // The programmatic scroll must immediately move the TanStack window; the
    // native scroll event is not required for the next committed frame.
    expect(screen.getByRole('row', { name: '40 row-40 alice' })).toBeInTheDocument();
    fireEvent.keyDown(scroller, { key: 'a', ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ anchorRow: 0, anchorColumn: 0, focusRow: 39, focusColumn: 2 });
    fireEvent.keyDown(scroller, { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenLastCalledWith(undefined);
  });

  it('leaves keyboard navigation to focused filter inputs', () => {
    const onSelectionChange = jest.fn();
    render(<DataGrid
      resultSetId="keyboard-filter-input"
      columns={[{ name: 'ID', type: 'INTEGER' }]}
      rows={[[1]]}
      onSelectionChange={onSelectionChange}
    />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter ID' }), { key: 'ArrowDown' });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('re-renders only the rows whose selection actually changed', () => {
    const getCellMetadata = jest.fn((value: unknown) => ({ type: typeof value === 'number' ? 'INTEGER' : 'TEXT' }));
    render(<DataGrid
      resultSetId="memo-grid"
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME' }]}
      rows={Array.from({ length: 20 }, (_value, index) => [index, `row-${index}`])}
      getCellMetadata={getCellMetadata}
    />);
    const initialCalls = getCellMetadata.mock.calls.length;
    fireEvent.mouseDown(screen.getByRole('cell', { name: 'row-3' }), { button: 0 });
    const selectionCalls = getCellMetadata.mock.calls.length - initialCalls;
    expect(selectionCalls).toBeLessThanOrEqual(4);
    fireEvent.mouseEnter(screen.getByRole('cell', { name: 'row-4' }));
    const horizontalCalls = getCellMetadata.mock.calls.length - initialCalls - selectionCalls;
    expect(horizontalCalls).toBeLessThanOrEqual(4);
  });

  it('marks canonical boolean values for the shared cell palette', () => {
    const { container } = render(<DataGrid resultSetId="boolean-class" columns={[{ name: 'FLAG', type: 'BOOLEAN' }]} rows={[[true], [false]]} />);
    expect(container.querySelectorAll('.ui-data-grid-value-boolean-true')).toHaveLength(1);
    expect(container.querySelectorAll('.ui-data-grid-value-boolean-false')).toHaveLength(1);
  });

  it('combines multiple column filter conditions with AND/OR logic', () => {
    const columns = [{ name: 'NAME', type: 'VARCHAR' }, { name: 'AMOUNT', type: 'NUMERIC' }];
    const rows = [['abz', 1], ['abc', 2], ['zbz', 3]];
    const view = (logic: 'and' | 'or') => ({
      globalFilter: '',
      columnFilters: {},
      columnFilterDefinitions: {
        NAME: {
          operator: 'startsWith' as const,
          value: 'a',
          conditions: [
            { operator: 'startsWith' as const, value: 'a' },
            { operator: 'endsWith' as const, value: 'z' },
          ],
          logic,
        },
      },
      sorting: [],
      grouping: [],
    });
    expect(processDataGridRows(columns, rows, view('and'))).toEqual([['abz', 1]]);
    expect(processDataGridRows(columns, rows, view('or'))).toEqual([['abz', 1], ['abc', 2], ['zbz', 3]]);
  });

  it('renders the shared column sidebar and reports visibility changes', () => {
    const onToggleVisibility = jest.fn();
    render(<ResultColumnSidebar
      columns={[{ name: 'ID', type: 'INTEGER' }, { name: 'NAME', type: 'VARCHAR' }]}
      visibility={{ NAME: false }}
      onToggleVisibility={onToggleVisibility}
    />);
    expect(screen.getByRole('checkbox', { name: 'Show ID' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Show NAME' })).not.toBeChecked();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find column' }), { target: { value: 'na' } });
    expect(screen.queryByRole('button', { name: 'ID' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show NAME' }));
    expect(onToggleVisibility).toHaveBeenCalledWith(expect.objectContaining({ name: 'NAME' }), 1);
  });

  it('orders sidebar entries and reorders columns with drag and drop', () => {
    const onMoveColumn = jest.fn();
    render(<ResultColumnSidebar
      columns={[{ name: 'ID' }, { name: 'NAME' }, { name: 'AMOUNT' }]}
      order={[2, 0, 1]}
      onMoveColumn={onMoveColumn}
      onSelectColumn={jest.fn()}
    />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByRole('button', { name: 'AMOUNT' })).toBeInTheDocument();
    expect(within(items[1]!).getByRole('button', { name: 'ID' })).toBeInTheDocument();
    expect(within(items[2]!).getByRole('button', { name: 'NAME' })).toBeInTheDocument();

    fireEvent.dragStart(items[0]!);
    fireEvent.drop(items[2]!);
    expect(onMoveColumn).toHaveBeenCalledWith(2, 1, false);
  });

  it('groups a column dropped from the sidebar list', () => {
    const onGroupColumn = jest.fn();
    render(<ResultColumnSidebar
      columns={[{ name: 'ID' }, { name: 'NAME' }]}
      onGroupColumn={onGroupColumn}
    />);
    fireEvent.drop(screen.getByText('Drag a column here'), { dataTransfer: { getData: () => '1' } });
    expect(onGroupColumn).toHaveBeenCalledWith(expect.objectContaining({ name: 'NAME' }), 1);
  });

  it('jumps to the first matching column from the sidebar finder', () => {
    const onSelectColumn = jest.fn();
    render(<ResultColumnSidebar
      columns={[{ name: 'ID' }, { name: 'CUSTOMER_NAME' }]}
      onSelectColumn={onSelectColumn}
    />);
    const finder = screen.getByRole('textbox', { name: 'Find column' });
    fireEvent.change(finder, { target: { value: 'customer' } });
    fireEvent.keyDown(finder, { key: 'Enter' });
    expect(onSelectColumn).toHaveBeenCalledWith(expect.objectContaining({ name: 'CUSTOMER_NAME' }), 1);
  });

  it('resolves column order and moves persisted keys without losing unknown columns', () => {
    const columns = [{ name: 'ID' }, { name: 'NAME' }, { name: 'AMOUNT' }];
    expect(resolveDataGridColumnOrder(columns)).toEqual([0, 1, 2]);
    expect(resolveDataGridColumnOrder(columns, {
      globalFilter: '',
      columnFilters: {},
      sorting: [],
      grouping: [],
      pinnedColumns: ['AMOUNT'],
      columnOrder: ['NAME', 'ID'],
    })).toEqual([2, 1, 0]);
    expect(moveDataGridColumnOrder(columns, undefined, 2, 0, false)).toEqual(['AMOUNT', 'ID', 'NAME']);
    expect(moveDataGridColumnOrder(columns, undefined, 0, 2, true)).toEqual(['NAME', 'AMOUNT', 'ID']);
    expect(moveDataGridColumnOrder(columns, undefined, 1, 1, true)).toBeUndefined();
  });

  it('supports case and whitespace tolerant result diffs', () => {
    render(<DiffView
      target={{ label: 'Target', columns: [{ name: 'NAME', type: 'VARCHAR' }], rows: [[' abc ']] }}
      baselines={[{ id: 'base', label: 'Baseline', columns: [{ name: 'NAME', type: 'VARCHAR' }], rows: [['ABC']] }]}
      baselineId="base"
      onBaselineChange={jest.fn()}
    />);
    expect(screen.getByText(/Changed:/)).toHaveTextContent('Changed: 1');
    fireEvent.click(screen.getByRole('checkbox', { name: /Ignore case/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Ignore whitespace/ }));
    expect(screen.getByText(/Changed:/)).toHaveTextContent('Changed: 0');
    expect(screen.getByText('No differences detected.')).toBeInTheDocument();
  });

  it('reports busy state without a second progress strip in the grid', () => {
    const { container } = render(<DataGrid resultSetId="busy-grid" columns={[{ name: 'ID', type: 'INTEGER' }]} rows={[[1]]} busy />);
    expect(container.querySelector('.ui-result-grid')).toHaveAttribute('aria-busy', 'true');
    // Progress is animated in the result-tab header only, so the grid itself
    // carries the accessible busy state and no flying bar.
    expect(container.querySelector('.ui-data-grid-progress')).toBeNull();
  });
});
