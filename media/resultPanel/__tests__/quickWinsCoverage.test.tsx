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
    setGroupingPanelOpen,
    setRowViewOpen,
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
import * as panelProtocol from '../protocol.js';
import { getSavedStateFor } from '../grid/persistence.js';
import { addGrid, getGrid, resetGrids, setActiveGridIndex } from '../state.js';
import type { FilterHistorySnapshot } from '../state.js';
import type { GridHandle, ResultSet, DiskQuerySpec, TanStackColumn } from '../types.js';

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
    toggleToolbarMoreMenu?: (event: { stopPropagation: () => void }) => void;
    handleToolbarMoreMenuClick?: (event: MouseEvent) => void;
    recordDatabaseFilterHistoryBefore?: (resultSetIndex: number) => void;
    recordDatabaseFilterHistoryApplied?: (resultSetIndex: number, spec?: ResultSet['databaseFilterSpec']) => void;
    clearAllFilters?: () => void;
    saveEdits?: () => void;
    markRowForDelete?: (rowIndex: number) => void;
    toggleRowView?: () => void;
    refreshRowView?: () => void;
    copyRowViewAsMarkdown?: () => Promise<void>;
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

let restoreTestVirtualCore: (() => void) | undefined;
let restoreTestResizeObserver: (() => void) | undefined;
let restoreTestAnimationFrames: (() => void) | undefined;
const testVirtualizers: Array<{ measureElement: (element: Element) => number }> = [];

function installTestAnimationFrames(): { flush: () => void; pendingCount: () => number } {
    const previousRequest = window.requestAnimationFrame;
    const previousCancel = window.cancelAnimationFrame;
    let nextId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        value: (callback: FrameRequestCallback) => {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
        },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        value: (id: number) => { callbacks.delete(id); },
    });
    restoreTestAnimationFrames = () => {
        if (previousRequest === undefined) delete (window as Partial<Window>).requestAnimationFrame;
        else Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: previousRequest });
        if (previousCancel === undefined) delete (window as Partial<Window>).cancelAnimationFrame;
        else Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: previousCancel });
        restoreTestAnimationFrames = undefined;
    };
    return {
        flush: () => {
            let frames = 0;
            while (callbacks.size > 0 && frames < 100) {
                const current = [...callbacks.entries()];
                current.forEach(([id, callback]) => {
                    callbacks.delete(id);
                    callback(0);
                });
                frames += 1;
            }
            if (callbacks.size > 0) throw new Error('Test animation frame queue did not settle');
        },
        pendingCount: () => callbacks.size,
    };
}

function installTestVirtualCore(): void {
    type VirtualOptions = {
        count: number;
        getItemKey?: (index: number) => unknown;
        measureElement?: (element: Element) => number;
        [key: string]: unknown;
    };
    class TestVirtualizer {
        public options: VirtualOptions;
        constructor(options: VirtualOptions) {
            this.options = options;
            testVirtualizers.push(this);
        }
        _didMount(): () => void { return () => undefined; }
        _willUpdate(): void { /* deterministic test virtualizer */ }
        getVirtualItems(): Array<{ index: number; start: number; size: number; end: number }> {
            const items = Array.from({ length: this.options.count }, (_value, index) => ({
                index, start: index * 28, size: 28, end: (index + 1) * 28,
            }));
            items.forEach(item => this.options.getItemKey?.(item.index));
            return items;
        }
        getTotalSize(): number { return this.options.count * 28; }
        getMaxScrollOffset(): number { return this.getTotalSize(); }
        scrollToIndex(): void { /* no scroll needed in JSDOM */ }
        measure(): void { /* measured layout is covered by the browser suite */ }
        measureElement(element: Element): number { return this.options.measureElement?.(element) ?? 28; }
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
    restoreTestVirtualCore = () => {
        if (previousVirtualCore === undefined) delete globals.VirtualCore;
        else Object.assign(globals, { VirtualCore: previousVirtualCore });
        restoreTestVirtualCore = undefined;
    };
}

function installTestResizeObserver(): {
    instances: Array<{ observed: Element[]; disconnectCount: number; trigger: () => void }>;
} {
    type ResizeObserverConstructor = typeof ResizeObserver;
    const globals = globalThis as unknown as { ResizeObserver?: ResizeObserverConstructor };
    const previousResizeObserver = globals.ResizeObserver;
    const instances: Array<{ observed: Element[]; disconnectCount: number; trigger: () => void }> = [];
    class TestResizeObserver implements ResizeObserver {
        public observed: Element[] = [];
        public disconnectCount = 0;
        constructor(private readonly callback: ResizeObserverCallback) { instances.push(this); }
        observe(target: Element): void { this.observed.push(target); }
        unobserve(_target: Element): void { /* no observation registry needed */ }
        disconnect(): void { this.disconnectCount += 1; }
        takeRecords(): ResizeObserverEntry[] { return []; }
        trigger(): void { this.callback([], this); }
    }
    Object.assign(globals, { ResizeObserver: TestResizeObserver });
    restoreTestResizeObserver = () => {
        if (previousResizeObserver === undefined) delete globals.ResizeObserver;
        else Object.assign(globals, { ResizeObserver: previousResizeObserver });
        restoreTestResizeObserver = undefined;
    };
    return { instances };
}

describe('SQL editor result panel quick-win coverage', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        clearPendingEdits();
        clearPendingDeletes();
        setRowViewOpen(false);
        setGroupingPanelOpen(false);
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
        restoreTestVirtualCore?.();
        restoreTestResizeObserver?.();
        restoreTestAnimationFrames?.();
        testVirtualizers.length = 0;
        clearPendingEdits();
        clearPendingDeletes();
        setRowViewOpen(false);
        setGroupingPanelOpen(false);
        resetGrids();
        document.body.innerHTML = '';
    });

    it('renders selected raw rows, handles invalid scopes, and copies the compared rows', async () => {
        const panel = window as EditingWindow;
        const resultSet = {
            resultSetId: 'row-view-result',
            executionTimestamp: 940,
            columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'LABEL', type: 'VARCHAR' }],
            data: [[1, 'first'], [2, 'second']],
        } as ResultSet;
        const state = {
            sorting: [] as Array<{ id: string; desc: boolean }>,
            columnFilters: [] as Array<{ id: string; value: unknown }>,
            globalFilter: '',
            grouping: [] as string[],
        };
        const columns = [
            { id: '0', header: 'ID', type: 'INTEGER', accessorFn: (row: unknown) => (row as unknown[])[0] },
            { id: '1', header: 'LABEL', type: 'VARCHAR' },
        ].map(column => ({
            id: column.id,
            columnDef: { header: column.header, dataType: column.type, accessorFn: column.accessorFn },
            getFilterValue: () => undefined,
            setFilterValue: () => undefined,
            getIsSorted: () => false,
            getToggleSortingHandler: () => () => undefined,
            toggleVisibility: () => undefined,
            getIsVisible: () => true,
        } as unknown as TanStackColumn));
        let selectedRows = [0, 1];
        const rows = [[1, 'first'], [2, 'second']];
        const table = {
            getState: () => state,
            getAllColumns: () => columns,
            getAllLeafColumns: () => columns,
        };
        const grid: GridHandle = {
            tanTable: table as never,
            getSelectedRowIndices: () => [...selectedRows],
            resolveRowValues: rowIndex => rows[rowIndex],
            fetchRowValues: jest.fn(async (rowIndex: number) => rows[rowIndex]),
        };
        resetGrids();
        setActiveGridIndex(0);
        addGrid(grid);
        Object.assign(window, {
            activeSource: 'file:///row-view.sql',
            resultSets: [resultSet],
        });
        const rowViewPanel = document.createElement('section');
        rowViewPanel.id = 'rowViewPanel';
        const content = document.createElement('div');
        content.id = 'rowViewContent';
        rowViewPanel.appendChild(content);
        document.body.appendChild(rowViewPanel);

        expect(panel.toggleRowView).toEqual(expect.any(Function));
        panel.toggleRowView?.();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(content.querySelectorAll('.row-view-section')).toHaveLength(2);
        expect(content.querySelectorAll('.row-view-section.diff')).toHaveLength(2);
        expect(content.textContent).toContain('first');
        expect(content.textContent).toContain('second');

        const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        const writeText = jest.fn((text: string): Promise<void> => Promise.resolve(text).then(() => undefined));
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        try {
            await panel.copyRowViewAsMarkdown?.();
        } finally {
            if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
            else Reflect.deleteProperty(navigator, 'clipboard');
        }
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('| 2 | second |'));

        state.grouping = ['0'];
        panel.refreshRowView?.();
        expect(content.textContent).toContain('unavailable while results are grouped');

        state.grouping = [];
        selectedRows = [];
        panel.refreshRowView?.();
        expect(content.textContent).toContain('Select 1 to 10 rows to view details or compare');

        selectedRows = Array.from({ length: 11 }, (_, index) => index);
        panel.refreshRowView?.();
        expect(content.textContent).toContain('Select 1 to 10 rows to compare');

        selectedRows = [0];
        table.getAllLeafColumns = () => [];
        panel.refreshRowView?.();
        expect(content.textContent).toContain('This result has no data columns');

        setRowViewOpen(false);
        panel.refreshRowView?.();
        expect(content.textContent).toContain('This result has no data columns');
    });

    it('rejects stale or failed row snapshots before replacing the Row View', async () => {
        const panel = window as EditingWindow;
        const resultSet = {
            resultSetId: 'row-view-async-result',
            executionTimestamp: 941,
            columns: [{ name: 'ID', type: 'INTEGER' }],
            data: [[1]],
        } as ResultSet;
        const state = {
            sorting: [] as Array<{ id: string; desc: boolean }>,
            columnFilters: [] as Array<{ id: string; value: unknown }>,
            globalFilter: '',
            grouping: [] as string[],
        };
        const columns: TanStackColumn[] = [{
            id: '0',
            columnDef: { header: 'ID', dataType: 'INTEGER' },
            getFilterValue: () => undefined,
            setFilterValue: () => undefined,
            getIsSorted: () => false,
            getToggleSortingHandler: () => () => undefined,
            toggleVisibility: () => undefined,
            getIsVisible: () => true,
        }];
        const table = { getState: () => state, getAllColumns: () => columns, getAllLeafColumns: () => columns };
        let resolveFetch: ((row: unknown[]) => void) | undefined;
        const grid: GridHandle = {
            tanTable: table as never,
            getSelectedRowIndices: () => [0],
            resolveRowValues: () => undefined,
            fetchRowValues: () => new Promise(resolve => { resolveFetch = row => resolve(row); }),
        };
        resetGrids();
        setActiveGridIndex(0);
        addGrid(grid);
        Object.assign(window, { activeSource: 'file:///row-view-async.sql', resultSets: [resultSet] });
        const rowViewPanel = document.createElement('section');
        rowViewPanel.id = 'rowViewPanel';
        const content = document.createElement('div');
        content.id = 'rowViewContent';
        rowViewPanel.appendChild(content);
        document.body.appendChild(rowViewPanel);

        panel.toggleRowView?.();
        expect(content.textContent).toContain('Loading selected rows');
        state.globalFilter = 'changed while loading';
        resolveFetch?.([1]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(content.textContent).toContain('Loading selected rows');

        state.globalFilter = '';
        grid.fetchRowValues = async () => { throw new Error('fixture fetch failed'); };
        panel.refreshRowView?.();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(content.textContent).toContain('Unable to load selected rows');
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
        installTestVirtualCore();
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

    it('keeps responsive column collapse opt-in, expandable and suspended while grouped', () => {
        const animationFrames = installTestAnimationFrames();
        installTestVirtualCore();
        const resizeObservers = installTestResizeObserver();
        resetGrids();
        setActiveGridIndex(0);
        const resultSet = {
            resultSetId: 'responsive-grid-result',
            executionTimestamp: 900,
            columns: [
                { name: 'ID', type: 'INTEGER' },
                { name: 'LABEL', type: 'VARCHAR' },
                { name: 'NOTES', type: 'VARCHAR' },
                { name: 'ACTIVE', type: 'BOOLEAN' },
                { name: 'OPTIONAL', type: 'VARCHAR' },
            ],
            data: [[1, 'one', 'first note', true, null], [2, 'two', 'second note', false, 'present']],
        } as ResultSetWithExtras;
        Object.assign(window, {
            activeSource: 'file:///responsive-grid.sql',
            resultSets: [resultSet],
        });

        const container = document.createElement('div');
        document.body.appendChild(container);
        const factories = [
            getCoreRowModel,
            getSortedRowModel,
            getFilteredRowModel,
            getGroupedRowModel,
            getExpandedRowModel,
        ] as unknown as RowModelFactoryFn[];
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = (() => ({
            measureText: (value: string) => ({ width: value.length * 8 }),
        } as unknown as CanvasRenderingContext2D)) as unknown as typeof HTMLCanvasElement.prototype.getContext;

        let width = 210;
        let grid: GridHandle | undefined;
        let savedHostState: unknown = {};
        const getHostStateSpy = jest.spyOn(panelProtocol, 'getHostState')
            .mockImplementation(() => savedHostState);
        const setHostStateSpy = jest.spyOn(panelProtocol, 'setHostState')
            .mockImplementation((nextState) => { savedHostState = nextState; });
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
            grid = getGrid(0) ?? undefined;
            const wrapper = container.querySelector<HTMLElement>('.grid-wrapper');
            expect(wrapper).not.toBeNull();
            Object.defineProperty(wrapper, 'clientWidth', { configurable: true, get: () => width });
            grid?.columnWidths?.set('0', 90);
            grid?.columnWidths?.set('1', 90);
            grid?.columnWidths?.set('2', 90);
            grid?.columnWidths?.set('3', 90);
            grid?.columnWidths?.set('4', 90);

            expect(grid?.responsiveCollapseEnabled).toBe(false);
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(5);
            expect(container.querySelector('.responsive-details-toggle')).toBeNull();

            expect(grid?.toggleResponsiveCollapse?.()).toBe(true);
            expect(grid?.responsiveCollapseEnabled).toBe(true);
            expect(getSavedStateFor(0, 900, 'file:///responsive-grid.sql', 'responsive-grid-result')
                ?.responsiveCollapseEnabled).toBe(true);
            expect(getSavedStateFor(0, 900, 'file:///responsive-grid.sql', 'different-result'))
                .toBeNull();
            expect(setHostStateSpy).toHaveBeenCalled();
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(1);
            const disclosure = container.querySelector<HTMLButtonElement>('.responsive-details-toggle');
            expect(disclosure).not.toBeNull();
            resizeObservers.instances[0]?.trigger();
            resizeObservers.instances[0]?.trigger();
            resizeObservers.instances[1]?.trigger();
            expect(animationFrames.pendingCount()).toBe(2);
            animationFrames.flush();
            expect(container.querySelector('.responsive-details-row')).toBeNull();
            disclosure?.click();
            grid?.render?.();
            animationFrames.flush();
            const firstDetailsRow = container.querySelector<HTMLTableRowElement>('.responsive-details-row');
            expect(firstDetailsRow?.textContent).toContain('LABEL');
            expect(firstDetailsRow?.textContent).toContain('one');
            expect(firstDetailsRow?.textContent).toContain('NOTES');
            expect(firstDetailsRow?.textContent).toContain('first note');
            expect(firstDetailsRow?.textContent).toContain('✓ true');
            expect(firstDetailsRow?.textContent).toContain('NULL');
            const firstDataRow = firstDetailsRow?.previousElementSibling as HTMLTableRowElement | undefined;
            if (!firstDataRow || !firstDetailsRow) throw new Error('Expanded memory row was not rendered');
            const makeRect = (height: number): DOMRect => ({
                x: 0, y: 0, width: 180, height, top: 0, left: 0, right: 180, bottom: height,
                toJSON: () => ({}),
            });
            jest.spyOn(firstDataRow, 'getBoundingClientRect').mockReturnValue(makeRect(28));
            jest.spyOn(firstDetailsRow, 'getBoundingClientRect').mockReturnValue(makeRect(60));
            expect(testVirtualizers[testVirtualizers.length - 1]?.measureElement(firstDataRow)).toBe(88);
            const secondDisclosure = Array.from(container.querySelectorAll<HTMLButtonElement>('.responsive-details-toggle'))
                .find(button => button.closest('tr')?.dataset.dataRowIndex === '1');
            secondDisclosure?.click();
            grid?.render?.();
            animationFrames.flush();
            expect(Array.from(container.querySelectorAll('.responsive-details-row'))
                .some(row => row.textContent?.includes('✗ false'))).toBe(true);

            grid?.dispose?.();
            window.dispatchEvent(new Event('result-panel-selection-changed'));
            resetGrids();
            container.innerHTML = '';
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
            grid = getGrid(0) ?? undefined;
            const revivedWrapper = container.querySelector<HTMLElement>('.grid-wrapper');
            if (!revivedWrapper) throw new Error('Grid wrapper was not rendered after revival');
            Object.defineProperty(revivedWrapper, 'clientWidth', { configurable: true, get: () => width });
            expect(grid?.responsiveCollapseEnabled).toBe(true);
            grid?.render?.();
            expect(container.querySelector('.responsive-details-row')).toBeNull();
            const revivedDisclosure = container.querySelector<HTMLButtonElement>('.responsive-details-toggle');
            expect(revivedDisclosure).not.toBeNull();
            revivedDisclosure?.click();
            grid?.render?.();
            animationFrames.flush();
            expect(container.querySelector('.responsive-details-row')?.textContent).toContain('first note');

            grid?.selectColumn?.(0);
            expect(container.querySelector('.selected-cell')).not.toBeNull();
            expect(grid?.hasSelection?.()).toBe(true);
            expect(grid?.getSelectedRowIndices?.()).toEqual([0, 1]);
            expect(grid?.getSelectedRowIndices?.(0)).toEqual([]);
            window.dispatchEvent(new Event('result-panel-selection-changed'));
            grid?.tanTable?.setSorting([{ id: '0', desc: true }]);
            (grid as (GridHandle & { onTableRowsRendered?: () => void }) | undefined)?.onTableRowsRendered?.();
            expect(container.querySelector('.selected-cell')).toBeNull();
            grid?.tanTable?.setSorting([]);
            animationFrames.flush();
            width = 600;
            grid?.render?.();
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(5);
            expect(container.querySelector('.responsive-details-row')).toBeNull();
            resizeObservers.instances[resizeObservers.instances.length - 1]?.trigger();
            expect(animationFrames.pendingCount()).toBe(0);
            expect(container.querySelector('.selected-cell')).toBeNull();

            width = 210;
            grid?.render?.();
            expect(container.querySelector('.responsive-details-row')?.textContent).toContain('first note');

            grid?.tanTable?.setGrouping(['0']);
            grid?.render?.();
            expect(grid?.toggleResponsiveCollapse?.()).toBe(true);
            expect(container.querySelector('.responsive-details-toggle')).toBeNull();
            expect(container.querySelector('.responsive-details-row')).toBeNull();
            const menu = document.createElement('div');
            menu.id = 'toolbarMoreMenu';
            menu.style.display = 'none';
            const menuItem = document.createElement('div');
            menuItem.className = 'split-btn__menu-item';
            menuItem.dataset.action = 'responsive-collapse';
            menu.appendChild(menuItem);
            document.body.appendChild(menu);
            const panelWindow = window as EditingWindow;
            panelWindow.toggleToolbarMoreMenu?.({ stopPropagation: () => undefined });
            expect(menuItem.getAttribute('aria-disabled')).toBe('true');
            const groupedClick = new MouseEvent('click', { bubbles: true });
            menuItem.dispatchEvent(groupedClick);
            panelWindow.handleToolbarMoreMenuClick?.(groupedClick);
            expect(grid?.responsiveCollapseEnabled).toBe(true);

            grid?.tanTable?.setGrouping([]);
            grid?.render?.();
            panelWindow.toggleToolbarMoreMenu?.({ stopPropagation: () => undefined });
            expect(menuItem.getAttribute('aria-disabled')).toBe('false');
            expect(container.querySelector('.responsive-details-row')?.textContent).toContain('first note');
            resizeObservers.instances[resizeObservers.instances.length - 2]?.trigger();
            resizeObservers.instances[resizeObservers.instances.length - 2]?.trigger();
            resizeObservers.instances[resizeObservers.instances.length - 1]?.trigger();
            expect(animationFrames.pendingCount()).toBe(2);
            const enabledClick = new MouseEvent('click', { bubbles: true });
            menuItem.dispatchEvent(enabledClick);
            panelWindow.handleToolbarMoreMenuClick?.(enabledClick);
            expect(grid?.responsiveCollapseEnabled).toBe(false);
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(5);
            expect(container.querySelector('.responsive-details-row')).toBeNull();
            grid?.dispose?.();
            grid = undefined;
            expect(animationFrames.pendingCount()).toBe(0);
        } finally {
            grid?.dispose?.();
            getHostStateSpy.mockRestore();
            setHostStateSpy.mockRestore();
            HTMLCanvasElement.prototype.getContext = originalGetContext;
        }
        expect(resizeObservers.instances).toHaveLength(4);
        expect(resizeObservers.instances.every(observer => observer.disconnectCount > 0)).toBe(true);
    });

    it('renders expandable collapsed fields for an ungrouped SQLite-backed result', () => {
        installTestVirtualCore();
        resetGrids();
        setActiveGridIndex(0);
        const resultSet = {
            executionTimestamp: 901,
            storageMode: 'sqlite',
            totalRowCount: 2,
            diskFilteredCount: 2,
            diskWindowStart: 0,
            columns: [
                { name: 'ID', type: 'INTEGER' },
                { name: 'LABEL', type: 'VARCHAR' },
                { name: 'NOTES', type: 'VARCHAR' },
            ],
            data: [[1, 'disk one', 'disk note'], [2, 'disk two', 'another note']],
        } as ResultSetWithExtras;
        Object.assign(window, {
            activeSource: 'file:///responsive-disk.sql',
            resultSets: [resultSet],
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const factories = [
            getCoreRowModel,
            getSortedRowModel,
            getFilteredRowModel,
            getGroupedRowModel,
            getExpandedRowModel,
        ] as unknown as RowModelFactoryFn[];
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = (() => ({
            measureText: (value: string) => ({ width: value.length * 8 }),
        } as unknown as CanvasRenderingContext2D)) as unknown as typeof HTMLCanvasElement.prototype.getContext;
        let grid: GridHandle | undefined;
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
            grid = getGrid(0) ?? undefined;
            const wrapper = container.querySelector<HTMLElement>('.grid-wrapper');
            if (!wrapper) throw new Error('Grid wrapper was not rendered');
            let width = 210;
            Object.defineProperty(wrapper, 'clientWidth', { configurable: true, get: () => width });
            grid?.columnWidths?.set('0', 90);
            grid?.columnWidths?.set('1', 90);
            grid?.columnWidths?.set('2', 90);

            expect(grid?.toggleResponsiveCollapse?.()).toBe(true);
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(1);
            const disclosure = container.querySelector<HTMLButtonElement>('.responsive-details-toggle');
            expect(disclosure).not.toBeNull();
            disclosure?.click();
            grid?.render?.();
            expect(container.querySelector('.responsive-details-row')?.textContent).toContain('disk one');
            expect(container.querySelector('.responsive-details-row')?.textContent).toContain('disk note');

            resultSet.databaseFilterSpec = { columnFilters: [] };
            grid?.createVirtualizer?.();
            grid?.render?.();
            expect(container.querySelector('.responsive-details-row')).toBeNull();

            width = 500;
            grid?.render?.();
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(3);
        } finally {
            grid?.dispose?.();
            HTMLCanvasElement.prototype.getContext = originalGetContext;
        }
    });

    it('uses a window resize fallback when ResizeObserver is unavailable', () => {
        const animationFrames = installTestAnimationFrames();
        installTestVirtualCore();
        resetGrids();
        setActiveGridIndex(0);
        const resizeGlobal = globalThis as unknown as { ResizeObserver?: typeof ResizeObserver };
        const originalResizeObserver = resizeGlobal.ResizeObserver;
        delete resizeGlobal.ResizeObserver;
        const resultSet = {
            executionTimestamp: 902,
            columns: [
                { name: 'ID', type: 'INTEGER' },
                { name: 'LABEL', type: 'VARCHAR' },
                { name: 'NOTES', type: 'VARCHAR' },
            ],
            data: [[1, 'one', 'note']],
        } as ResultSetWithExtras;
        Object.assign(window, {
            activeSource: 'file:///responsive-fallback.sql',
            resultSets: [resultSet],
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const factories = [
            getCoreRowModel,
            getSortedRowModel,
            getFilteredRowModel,
            getGroupedRowModel,
            getExpandedRowModel,
        ] as unknown as RowModelFactoryFn[];
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = (() => ({
            measureText: (value: string) => ({ width: value.length * 8 }),
        } as unknown as CanvasRenderingContext2D)) as unknown as typeof HTMLCanvasElement.prototype.getContext;
        let grid: GridHandle | undefined;
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
            grid = getGrid(0) ?? undefined;
            const wrapper = container.querySelector<HTMLElement>('.grid-wrapper');
            if (!wrapper) throw new Error('Grid wrapper was not rendered');
            let width = 210;
            Object.defineProperty(wrapper, 'clientWidth', { configurable: true, get: () => width });
            grid?.columnWidths?.set('0', 90);
            grid?.columnWidths?.set('1', 90);
            grid?.columnWidths?.set('2', 90);
            expect(grid?.toggleResponsiveCollapse?.()).toBe(true);
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(1);

            width = 500;
            window.dispatchEvent(new Event('resize'));
            expect(animationFrames.pendingCount()).toBe(1);
            animationFrames.flush();
            expect(container.querySelectorAll('th[data-col-id]')).toHaveLength(3);

            grid?.dispose?.();
            grid = undefined;
            width = 210;
            window.dispatchEvent(new Event('resize'));
            expect(animationFrames.pendingCount()).toBe(0);
        } finally {
            grid?.dispose?.();
            if (originalResizeObserver === undefined) delete resizeGlobal.ResizeObserver;
            else Object.assign(resizeGlobal, { ResizeObserver: originalResizeObserver });
            HTMLCanvasElement.prototype.getContext = originalGetContext;
        }
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
