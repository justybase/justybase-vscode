import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS } from '../hostContracts.js';
import {
    buildFilterHistoryScope,
    getFilterHistoryAvailability,
    getFilterHistoryTarget,
    moveFilterHistoryCursor,
    recordFilterHistorySnapshot,
    setFilterHistoryRestoring,
    addPendingEdit,
    clearPendingEdits,
    clearPendingDeletes,
    getPendingEdits,
    markRowForDelete,
} from '../state.js';
import {
    editValuesEqual,
    isNumericEditType,
    parseTypedEditValue,
    toEditableCellText,
} from '../editValue.js';
import { setupCellEditing } from '../grid/cellEditing.js';
import { createResultSetGrid } from '../grid/tableBuilder.js';
import { showColumnFilterDropdown } from '../filter.js';
import { showContextMenu } from '../selection/menu.js';
import '../init.js';
import { createTable, getCoreRowModel, getExpandedRowModel, getFilteredRowModel, getGroupedRowModel, getSortedRowModel } from '@tanstack/table-core';
import type { CreateTableFn, GridColumnDef, ResultSetWithExtras, RowModelFactoryFn } from '../grid/types.js';
import { addGrid, getGrid, resetGrids, setActiveGridIndex } from '../state.js';
import type { FilterHistorySnapshot } from '../state.js';
import type { GridHandle, ResultSet, DiskQuerySpec } from '../types.js';

jest.mock('../rangeChart.js', () => ({ canCreateRangeChart: jest.fn(() => false) }));
jest.mock('../databaseFilters.js', () => ({
    applyDatabaseFilter: jest.fn(async () => undefined),
    queryDatabaseFilterValues: jest.fn(async () => ({ values: [], truncated: false })),
}));
jest.mock('../analysis.js', () => ({
    getActiveResultViewMode: jest.fn(() => 'table'),
    getAnalysisLimitWarning: jest.fn(() => undefined),
    initializeAnalysisModeControls: jest.fn(),
    setActiveResultViewMode: jest.fn(),
    syncAnalysisView: jest.fn(),
}));

type EditingWindow = Window & {
    activeSource?: string;
    resultSets?: ResultSet[];
    getIsEditMode?: () => boolean;
    addPendingEdit?: (...args: unknown[]) => void;
    openRelatedRows?: (rowIndex: number, columnIndex: number) => void;
    getActiveGridIndex?: () => number;
    undoFilterHistory?: () => void;
    redoFilterHistory?: () => void;
    updateFilterHistoryButtons?: () => void;
    recordDatabaseFilterHistoryBefore?: (resultSetIndex: number) => void;
    recordDatabaseFilterHistoryApplied?: (resultSetIndex: number, spec?: ResultSet['databaseFilterSpec']) => void;
    clearAllFilters?: () => void;
    saveEdits?: () => void;
    markRowForDelete?: (rowIndex: number) => void;
};

const initialPanelCallbacks: Pick<EditingWindow,
    | 'undoFilterHistory'
    | 'redoFilterHistory'
    | 'updateFilterHistoryButtons'
    | 'recordDatabaseFilterHistoryBefore'
    | 'recordDatabaseFilterHistoryApplied'
    | 'clearAllFilters'
    | 'saveEdits'
    | 'markRowForDelete'
> = (() => {
    const panel = window as EditingWindow;
    return {
        undoFilterHistory: panel.undoFilterHistory,
        redoFilterHistory: panel.redoFilterHistory,
        updateFilterHistoryButtons: panel.updateFilterHistoryButtons,
        recordDatabaseFilterHistoryBefore: panel.recordDatabaseFilterHistoryBefore,
        recordDatabaseFilterHistoryApplied: panel.recordDatabaseFilterHistoryApplied,
        clearAllFilters: panel.clearAllFilters,
        saveEdits: panel.saveEdits,
        markRowForDelete: panel.markRowForDelete,
    };
})();

const emptySnapshot: FilterHistorySnapshot = {
    globalFilter: '',
    columnFilters: [],
    sorting: [],
    filterScope: 'loaded',
};

describe('SQL editor result panel quick-win coverage', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        clearPendingEdits();
        clearPendingDeletes();
        Object.assign(window, {
            activeSource: undefined,
            resultSets: undefined,
            getIsEditMode: () => true,
            addPendingEdit: undefined,
            openRelatedRows: undefined,
            getActiveGridIndex: undefined,
            ...initialPanelCallbacks,
        });
    });

    afterEach(() => {
        clearPendingEdits();
        clearPendingDeletes();
        resetGrids();
        document.body.innerHTML = '';
    });

    it('records bounded, per-result filter history and ignores snapshots during restore', () => {
        const scope = buildFilterHistoryScope('file:///query.sql', {
            resultSetId: 'stable-result',
        } as ResultSet, 7);
        const fallbackScope = buildFilterHistoryScope(undefined, { executionTimestamp: 9 } as ResultSet, 2);
        const indexScope = buildFilterHistoryScope(undefined, undefined, 3);
        expect(scope).toBe('file:///query.sql\u001fstable-result');
        expect(fallbackScope).toBe('\u001fts:9');
        expect(indexScope).toBe('\u001findex:3');

        recordFilterHistorySnapshot(scope, emptySnapshot);
        recordFilterHistorySnapshot(scope, emptySnapshot);
        setFilterHistoryRestoring(scope, true);
        recordFilterHistorySnapshot(scope, { ...emptySnapshot, globalFilter: 'ignored' });
        setFilterHistoryRestoring(scope, false);
        for (let index = 1; index <= 11; index += 1) {
            recordFilterHistorySnapshot(scope, { ...emptySnapshot, globalFilter: `filter-${index}` });
        }
        expect(getFilterHistoryAvailability(scope)).toEqual({ canUndo: true, canRedo: false });
        expect(getFilterHistoryTarget(scope, 'undo')?.globalFilter).toBe('filter-10');
        expect(moveFilterHistoryCursor(scope, 'undo')).toBe(true);
        expect(getFilterHistoryAvailability(scope)).toEqual({ canUndo: true, canRedo: true });
        expect(moveFilterHistoryCursor(scope, 'redo')).toBe(true);
        expect(moveFilterHistoryCursor('missing', 'undo')).toBe(false);
        expect(getFilterHistoryTarget('missing', 'redo')).toBeUndefined();

        for (let index = 0; index < 51; index += 1) {
            recordFilterHistorySnapshot(`scope-${index}`, { ...emptySnapshot, globalFilter: String(index) });
        }
        expect(getFilterHistoryTarget('scope-0', 'undo')).toBeUndefined();
    });

    it('stages typed edits without conflating NULL, empty text or high precision numbers', () => {
        expect(isNumericEditType('HUGEINT')).toBe(true);
        expect(isNumericEditType('DECIMAL(30,2)')).toBe(true);
        expect(isNumericEditType('INTERVAL')).toBe(false);
        expect(parseTypedEditValue('900719925474099312345.67', 'DECIMAL(30,2)', false)).toEqual({
            valid: true,
            value: '900719925474099312345.67',
        });
        expect(parseTypedEditValue('1.5', 'INTEGER', false).valid).toBe(false);
        expect(parseTypedEditValue('true', 'BOOLEAN', false)).toEqual({ valid: true, value: true });
        expect(parseTypedEditValue('false', 'BIT(1)', false)).toEqual({ valid: true, value: false });
        expect(parseTypedEditValue('1', 'BIT(8)', false)).toEqual({ valid: true, value: '1' });
        expect(parseTypedEditValue('maybe', 'BOOLEAN', false).valid).toBe(false);
        expect(parseTypedEditValue('2024-02-29', 'DATE', false).valid).toBe(true);
        expect(parseTypedEditValue('2023-02-29', 'DATE', false).valid).toBe(false);
        expect(parseTypedEditValue('{"id":1}', 'JSON', false).valid).toBe(true);
        expect(parseTypedEditValue('{bad}', 'JSON', false).valid).toBe(false);
        expect(parseTypedEditValue('', 'VARCHAR', true)).toEqual({ valid: true, value: null });
        expect(parseTypedEditValue('', 'VARCHAR', false)).toEqual({ valid: true, value: '' });
        expect(editValuesEqual(42, '42')).toBe(true);
        expect(editValuesEqual('', null)).toBe(false);
        expect(editValuesEqual(new Date(0), new Date(0))).toBe(true);
        expect(editValuesEqual(new Date(0), new Date(1))).toBe(false);
        expect(editValuesEqual({}, {})).toBe(false);
        expect(toEditableCellText(new Date('2024-02-03T04:05:06.007Z'), 'DATE')).toBe('2024-02-03');
        expect(toEditableCellText(new Date('2024-02-03T04:05:06.007Z'), 'TIMESTAMP')).toBe('2024-02-03T04:05:06.007Z');
        expect(toEditableCellText(undefined, 'VARCHAR')).toBe('');

        addPendingEdit(2, 1, 'old', 'new');
        addPendingEdit(2, 1, 'old', 'old');
        addPendingEdit(3, 1, 1, '1');
        addPendingEdit(4, 1, 1, '2');
        expect(getPendingEdits()).toEqual([{ rowIndex: 4, columnIndex: 1, oldValue: 1, newValue: '2' }]);
    });

    it('renders numeric, boolean, date, JSON and NULL editors against the source row', () => {
        const pendingEdit = jest.fn();
        Object.assign(window, { addPendingEdit: pendingEdit });
        const tbody = document.createElement('tbody');
        document.body.appendChild(tbody);
        const resultSet = {
            data: [[101, true, '2024-02-03', '{"old":1}', null, 'binary']],
            columns: [
                { name: 'ID', type: 'INTEGER' },
                { name: 'ACTIVE', type: 'BOOLEAN' },
                { name: 'CREATED', type: 'DATE' },
                { name: 'DETAIL', type: 'JSON' },
                { name: 'OPTIONAL', type: 'VARCHAR' },
                { name: 'BINARY_DATA', type: 'BLOB' },
            ],
        } as ResultSetWithExtras;
        const columns = resultSet.columns.map((column, index) => ({
            id: String(index),
            header: column.name,
            dataType: column.type,
            scale: undefined,
        })) as GridColumnDef[];
        setupCellEditing(tbody, columns, resultSet);

        const addCell = (columnIndex: number, rowIndex = 0): HTMLTableCellElement => {
            const row = document.createElement('tr');
            row.dataset.index = '0';
            row.dataset.dataRowIndex = String(rowIndex);
            row.appendChild(document.createElement('td')).className = 'row-number-cell';
            const cell = document.createElement('td');
            cell.dataset.columnIndex = String(columnIndex);
            cell.textContent = String(resultSet.data[rowIndex]?.[columnIndex] ?? 'NULL');
            row.appendChild(cell);
            tbody.appendChild(row);
            return cell;
        };
        const doubleClick = (cell: HTMLTableCellElement): void => {
            cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        };
        const press = (element: HTMLElement, key: string, modifiers: KeyboardEventInit = {}): void => {
            element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
        };

        const numberCell = addCell(0);
        doubleClick(numberCell);
        const numberInput = numberCell.querySelector('input')!;
        numberInput.value = 'not-a-number';
        press(numberInput, 'Enter');
        expect(numberInput.validationMessage).toBeTruthy();
        numberInput.value = '102';
        numberInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(numberInput.validationMessage).toBe('');
        press(numberInput, 'Enter');
        expect(pendingEdit).toHaveBeenLastCalledWith(0, 0, 101, '102');

        const booleanCell = addCell(1);
        doubleClick(booleanCell);
        const booleanSelect = booleanCell.querySelector('select')!;
        booleanSelect.value = 'false';
        press(booleanSelect, 'Enter');
        expect(pendingEdit).toHaveBeenLastCalledWith(0, 1, true, false);

        const dateCell = addCell(2);
        doubleClick(dateCell);
        expect(dateCell.querySelector('input')?.type).toBe('date');
        press(dateCell.querySelector('input')!, 'Escape');
        expect(dateCell.textContent).toBe('2024-02-03');

        const jsonCell = addCell(3);
        doubleClick(jsonCell);
        const jsonEditor = jsonCell.querySelector('textarea')!;
        jsonEditor.value = '{"new":2}';
        press(jsonEditor, 'Enter');
        expect(jsonEditor.isConnected).toBe(true);
        press(jsonEditor, 'Enter', { ctrlKey: true });
        expect(pendingEdit).toHaveBeenLastCalledWith(0, 3, '{"old":1}', '{"new":2}');

        const nullCell = addCell(4);
        doubleClick(nullCell);
        const nullToggle = nullCell.querySelector('button')!;
        const nullInput = nullCell.querySelector('input')!;
        expect(nullInput.disabled).toBe(true);
        nullToggle.click();
        expect(nullInput.disabled).toBe(false);
        nullInput.value = 'filled';
        press(nullInput, 'Enter');
        expect(pendingEdit).toHaveBeenLastCalledWith(0, 4, null, 'filled');

        const binaryCell = addCell(5);
        doubleClick(binaryCell);
        expect(binaryCell.querySelector('input,textarea,select')).toBeNull();
    });

    it('records filter transitions and edits the original source row in a rendered grid', () => {
        type VirtualOptions = { count: number; [key: string]: unknown };
        class TestVirtualizer {
            public options: VirtualOptions;
            constructor(options: VirtualOptions) { this.options = options; }
            _didMount(): () => void { return () => undefined; }
            _willUpdate(): void { /* deterministic test virtualizer */ }
            getVirtualItems(): Array<{ index: number; start: number; size: number; end: number }> {
                return Array.from({ length: this.options.count }, (_value, index) => ({
                    index, start: index * 28, size: 28, end: (index + 1) * 28,
                }));
            }
            getTotalSize(): number { return this.options.count * 28; }
            getMaxScrollOffset(): number { return this.getTotalSize(); }
            scrollToIndex(): void { /* no scroll needed in JSDOM */ }
        }
        const globals = globalThis as typeof globalThis & { VirtualCore?: unknown };
        const previousVirtualCore = globals.VirtualCore;
        Object.assign(globals, {
            VirtualCore: {
                Virtualizer: TestVirtualizer,
                elementScroll: jest.fn(),
                observeElementRect: jest.fn(),
                observeElementOffset: jest.fn(),
            },
        });
        resetGrids();
        setActiveGridIndex(0);

        const pendingEdit = jest.fn();
        const resultSet = {
            resultSetId: 'grid-result',
            executionTimestamp: 100,
            columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'LABEL', type: 'VARCHAR' }],
            data: [[1, 'ONE'], [2, 'TWO'], [3, 'THREE']],
            totalRowCount: 3,
        } as ResultSetWithExtras;
        Object.assign(window, {
            activeSource: 'file:///grid.sql',
            resultSets: [resultSet],
            queryRowLimit: 100,
            getIsEditMode: () => true,
            addPendingEdit: pendingEdit,
        });

        const container = document.createElement('div');
        document.body.appendChild(container);
        const factories = [getCoreRowModel, getSortedRowModel, getFilteredRowModel, getGroupedRowModel, getExpandedRowModel] as unknown as RowModelFactoryFn[];
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = (() => ({
            measureText: (value: string) => ({ width: value.length * 8 }),
        } as unknown as CanvasRenderingContext2D)) as unknown as typeof HTMLCanvasElement.prototype.getContext;
        try {
            createResultSetGrid(
                resultSet,
                0,
                container,
                createTable as unknown as CreateTableFn,
                factories[0],
                factories[1],
                factories[2],
                factories[3],
                factories[4],
            );
        } finally {
            HTMLCanvasElement.prototype.getContext = originalGetContext;
        }
        const grid = getGrid(0)!;
        const table = grid.tanTable!;
        table.setGlobalFilter('TWO');
        table.setSorting([{ id: '0', desc: true }]);
        table.setColumnFilters([{ id: '1', value: ['TWO'] }]);
        expect(getFilterHistoryAvailability(buildFilterHistoryScope(
            'file:///grid.sql', resultSet, 0,
        )).canUndo).toBe(true);

        table.setGlobalFilter('TWO');
        grid.renderTableRows?.();
        const renderedRow = container.querySelector('tbody tr[data-index]') as HTMLTableRowElement | null;
        expect(renderedRow?.dataset.dataRowIndex).toBe('1');
        const cell = renderedRow?.querySelector('td[data-column-index="0"]') as HTMLTableCellElement | null;
        expect(cell).not.toBeNull();
        cell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const editor = cell?.querySelector('input');
        if (editor) {
            editor.value = '22';
            editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        expect(pendingEdit).toHaveBeenCalledWith(1, 0, 2, '22');

        resultSet.storageMode = 'memory';
        resultSet.databaseFilterSpec = { globalSearch: 'database scoped' };
        table.setSorting([{ id: '1', desc: false }]);
        resultSet.storageMode = 'sqlite';
        resultSet.databaseFilterSpec = undefined;
        Object.assign(window, { resultSets: [] });
        table.setGlobalFilter(undefined as unknown as string);

        grid.dispose?.();
        if (previousVirtualCore === undefined) delete globals.VirtualCore;
        else Object.assign(globals, { VirtualCore: previousVirtualCore });
    });

    it('offers related-row navigation only for a direct non-null source cell', () => {
        const openRelatedRows = jest.fn();
        Object.assign(window, {
            activeSource: 'file:///orders.sql',
            resultSets: [{ isEditable: true, storageMode: 'memory', editSource: { table: 'ORDERS' } }],
            getActiveGridIndex: () => 0,
            openRelatedRows,
        });
        const cell = document.createElement('td');
        cell.textContent = '17';
        const row = document.createElement('tr');
        row.dataset.index = '0';
        row.append(document.createElement('td'), cell);
        const tableElement = document.createElement('table');
        tableElement.appendChild(row);
        document.body.appendChild(tableElement);
        const column = {
            id: '0',
            columnDef: { header: 'ORDER_ID', dataType: 'INTEGER' },
            getFilterValue: () => undefined,
            setFilterValue: jest.fn(),
            getIsSorted: () => false,
            getToggleSortingHandler: () => jest.fn(),
            toggleVisibility: jest.fn(),
            getIsVisible: () => true,
        };
        const table = {
            getVisibleLeafColumns: () => [column],
            getRowModel: () => ({ rows: [{ index: 7, getValue: () => 17 }] }),
            getState: () => ({ sorting: [], columnFilters: [], grouping: [] }),
            setSorting: jest.fn(),
            setColumnFilters: jest.fn(),
            setGrouping: jest.fn(),
        };

        showContextMenu({
            table: table as unknown as Parameters<typeof showContextMenu>[0]['table'],
            wrapper: document.createElement('div'),
            model: { selectedCells: new Set() } as never,
        }, 1, 2, cell);
        const relatedItem = Array.from(document.querySelectorAll('.grid-context-menu-item'))
            .find((button) => button.textContent === 'Find Related Rows');
        expect(relatedItem).toBeDefined();
        (relatedItem as HTMLElement | undefined)?.click();
        expect(openRelatedRows).toHaveBeenCalledWith(7, 0);

        document.querySelector('.grid-context-menu')?.remove();
        Object.assign(window, {
            resultSets: [{ isEditable: true, storageMode: 'sqlite', editSource: { table: 'ORDERS' } }],
        });
        showContextMenu({
            table: table as unknown as Parameters<typeof showContextMenu>[0]['table'],
            wrapper: document.createElement('div'),
            model: { selectedCells: new Set() } as never,
        }, 1, 2, cell);
        expect(Array.from(document.querySelectorAll('.grid-context-menu-item'))
            .some((button) => button.textContent === 'Find Related Rows')).toBe(false);
    });

    it('records database-filter history around apply and retries without recording a second snapshot', async () => {
        const databaseFilters = jest.requireMock('../databaseFilters.js') as {
            applyDatabaseFilter: jest.MockedFunction<(sourceUri: string, resultSetIndex: number, spec: DiskQuerySpec | undefined, timing?: { isRetry?: boolean }) => Promise<void>>;
            queryDatabaseFilterValues: jest.MockedFunction<(sourceUri: string, resultSetIndex: number, columnIndex: number, spec?: DiskQuerySpec, timing?: { isRetry?: boolean }) => Promise<{ values: Array<{ raw: unknown; count: number }>; truncated: boolean }>>;
        };
        databaseFilters.applyDatabaseFilter.mockReset().mockRejectedValueOnce(new Error('temporary failure'));
        databaseFilters.queryDatabaseFilterValues.mockReset().mockResolvedValue({
            values: [{ raw: 'A', count: 2 }, { raw: 'B', count: 1 }],
            truncated: false,
        });
        const recordBefore = jest.fn();
        const recordApplied = jest.fn();
        const updateButtons = jest.fn();
        Object.assign(window, {
            activeSource: 'file:///database-filter.sql',
            resultSets: [{
                sql: 'SELECT NAME FROM ORDERS LIMIT 100',
                columns: [{ name: 'NAME', type: 'VARCHAR' }],
                data: [['A'], ['B']],
            } as ResultSet],
            recordDatabaseFilterHistoryBefore: recordBefore,
            recordDatabaseFilterHistoryApplied: recordApplied,
            updateFilterHistoryButtons: updateButtons,
        });
        const column = {
            id: '0',
            columnDef: {
                header: 'NAME',
                dataType: 'VARCHAR',
                accessorFn: (row: { NAME: string }) => row.NAME,
            },
            getFilterValue: () => undefined,
            setFilterValue: jest.fn(),
        };
        const table = {
            getCoreRowModel: () => ({ rows: [{ original: { NAME: 'A' } }, { original: { NAME: 'B' } }] }),
            getState: () => ({ columnFilters: [] }),
        };
        showColumnFilterDropdown(
            column as unknown as Parameters<typeof showColumnFilterDropdown>[0],
            table as unknown as Parameters<typeof showColumnFilterDropdown>[1],
            document.createElement('button'),
            0,
        );
        Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'All rows + LIMIT')?.click();
        await Promise.resolve();
        await Promise.resolve();
        const valueCheckbox = document.querySelector<HTMLInputElement>('.filter-values-container input[type="checkbox"]');
        expect(valueCheckbox).not.toBeNull();
        valueCheckbox!.click();
        document.querySelector<HTMLButtonElement>('.filter-actions button.primary')?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(recordBefore).toHaveBeenCalledTimes(1);
        expect(databaseFilters.applyDatabaseFilter).toHaveBeenCalledWith(
            'file:///database-filter.sql',
            0,
            { columnFilters: [{ columnIndex: 0, values: ['A'] }] },
            undefined,
        );
        const retryButton = Array.from(document.querySelectorAll('button'))
            .find((button) => /retry/i.test(button.textContent ?? ''));
        expect(retryButton).toBeDefined();
        retryButton?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(databaseFilters.applyDatabaseFilter).toHaveBeenLastCalledWith(
            'file:///database-filter.sql',
            0,
            { columnFilters: [{ columnIndex: 0, values: ['A'] }] },
            { isRetry: true },
        );
        expect(recordBefore).toHaveBeenCalledTimes(1);
        expect(recordApplied).toHaveBeenCalledWith(0, { columnFilters: [{ columnIndex: 0, values: ['A'] }] });
        expect(updateButtons).toHaveBeenCalledTimes(1);
    });

    it('declares the related-row host command in the webview protocol', () => {
        expect(RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS).toContain('openRelatedRows');
    });

    it('wires filter history, database apply, clear filters and save review callbacks', async () => {
        const panel = window as EditingWindow;
        const databaseFilters = jest.requireMock('../databaseFilters.js') as {
            applyDatabaseFilter: jest.MockedFunction<(sourceUri: string, resultSetIndex: number, spec: DiskQuerySpec | undefined, timing?: { isRetry?: boolean }) => Promise<void>>;
        };
        databaseFilters.applyDatabaseFilter.mockReset().mockResolvedValue(undefined);

        const state = {
            sorting: [] as Array<{ id: string; desc: boolean }>,
            columnFilters: [] as Array<{ id: string; value: unknown }>,
            globalFilter: '',
        };
        const table = {
            getState: () => state,
            setSorting: (sorting: Array<{ id: string; desc: boolean }>) => { state.sorting = sorting; },
            setColumnFilters: (filters: Array<{ id: string; value: unknown }>) => { state.columnFilters = filters; },
            setGlobalFilter: (filter: string) => { state.globalFilter = filter; },
            resetColumnFilters: () => { state.columnFilters = []; },
        };
        const grid: GridHandle = { tanTable: table as never, render: jest.fn() };
        resetGrids();
        setActiveGridIndex(0);
        addGrid(grid);
        const resultSet = {
            resultSetId: 'init-history-result',
            executionTimestamp: 500,
            columns: [{ name: 'ID', type: 'INTEGER' }],
            data: [[1]],
            editSource: { table: 'ORDERS' },
            isEditable: true,
        } as ResultSet;
        const historySource = `file:///history-${Date.now()}-${Math.random()}.sql`;
        Object.assign(window, {
            activeSource: historySource,
            resultSets: [resultSet],
        });
        const undoButton = document.createElement('button');
        undoButton.id = 'undoFilterBtn';
        const redoButton = document.createElement('button');
        redoButton.id = 'redoFilterBtn';
        const globalFilter = document.createElement('input');
        globalFilter.id = 'globalFilter';
        document.body.append(undoButton, redoButton, globalFilter);

        expect(panel.updateFilterHistoryButtons).toEqual(expect.any(Function));
        expect(getFilterHistoryAvailability(buildFilterHistoryScope(historySource, resultSet, 0)))
            .toEqual({ canUndo: false, canRedo: false });
        panel.updateFilterHistoryButtons?.();
        expect(undoButton.disabled).toBe(true);
        panel.undoFilterHistory?.();
        panel.recordDatabaseFilterHistoryBefore?.(0);
        state.globalFilter = 'alpha';
        panel.recordDatabaseFilterHistoryBefore?.(0);
        panel.updateFilterHistoryButtons?.();
        expect(undoButton.disabled).toBe(false);
        panel.undoFilterHistory?.();
        expect(state.globalFilter).toBe('');
        expect(redoButton.disabled).toBe(false);
        panel.redoFilterHistory?.();
        expect(state.globalFilter).toBe('alpha');

        state.globalFilter = 'database value';
        panel.recordDatabaseFilterHistoryApplied?.(0, { globalSearch: 'database value' });
        panel.undoFilterHistory?.();
        panel.redoFilterHistory?.();
        await Promise.resolve();
        expect(databaseFilters.applyDatabaseFilter).toHaveBeenCalledWith(
            historySource, 0, { globalSearch: 'database value' },
        );

        state.globalFilter = 'failed apply';
        panel.recordDatabaseFilterHistoryApplied?.(0, { globalSearch: 'failed apply' });
        databaseFilters.applyDatabaseFilter.mockRejectedValueOnce(new Error('database unavailable'));
        panel.undoFilterHistory?.();
        panel.redoFilterHistory?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(undoButton.disabled).toBe(false);
        expect(redoButton.disabled).toBe(true);

        databaseFilters.applyDatabaseFilter.mockResolvedValue(undefined);
        resultSet.databaseFilterSpec = { globalSearch: 'old search' };
        panel.clearAllFilters?.();
        await Promise.resolve();
        expect(databaseFilters.applyDatabaseFilter).toHaveBeenLastCalledWith(
            historySource, 0, undefined,
        );

        const confirmation = jest.fn((message: string) => {
            void message;
            return false;
        });
        Object.assign(window, { confirm: confirmation });
        for (let index = 0; index < 14; index += 1) {
            addPendingEdit(index, 0, index === 0 ? null : `old-${index}`, index === 1 ? '' : `new-${index}`);
        }
        addPendingEdit(15, 0, 'old', 'x'.repeat(130));
        markRowForDelete(16);
        panel.saveEdits?.();
        const calls = confirmation.mock.calls;
        const summary = calls[calls.length - 1]?.[0] as string;
        expect(summary).toContain('empty string');
        expect(summary).toContain('and 1 row deletion');
        expect(summary).toContain('more cell change');
        confirmation.mockReturnValue(true);
        panel.saveEdits?.();
        expect(confirmation).toHaveBeenCalledTimes(2);
    });
});
