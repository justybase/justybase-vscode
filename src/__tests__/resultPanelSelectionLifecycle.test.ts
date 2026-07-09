import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn(),
    formatCellValueForSql: jest.fn(),
    getNumericTypeInfo: jest.fn(() => ({ isNumeric: false })),
    isTemporalType: jest.fn(() => false)
}));

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn()
}));

jest.mock('../../media/resultPanel/rangeChart.js', () => ({
    RANGE_CHART_MENU: [],
    canCreateRangeChart: jest.fn(() => false),
    openRangeChartModal: jest.fn()
}));

class FakeClassList {
    private readonly _classes = new Set<string>();

    constructor(initial: string[] = []) {
        initial.forEach(value => this._classes.add(value));
    }

    add(value: string) {
        this._classes.add(value);
    }

    remove(value: string) {
        this._classes.delete(value);
    }

    contains(value: string) {
        return this._classes.has(value);
    }
}

class FakeCell {
    public readonly dataset: Record<string, string> = {};
    public readonly classList: FakeClassList;
    public readonly style: Record<string, string> = {};
    public textContent: string;
    public colSpan = 1;
    public row: FakeRow | null = null;

    constructor(textContent: string, classNames: string[] = []) {
        this.textContent = textContent;
        this.classList = new FakeClassList(classNames);
    }

    closest(selector: string) {
        if (selector === 'td') {
            return this;
        }
        if (selector === 'tr') {
            return this.row;
        }
        return null;
    }

    getBoundingClientRect() {
        return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    }
}

class FakeRow {
    public readonly dataset: Record<string, string>;
    public readonly children: FakeCell[];
    public readonly classList = new FakeClassList();

    constructor(index: number, cells: FakeCell[]) {
        this.dataset = { index: String(index) };
        this.children = cells;
        cells.forEach(cell => {
            cell.row = this;
        });
    }

    querySelectorAll(selector: string): FakeCell[] {
        if (selector === 'td') {
            return this.children;
        }
        if (selector === 'td[data-cell-id]') {
            return this.children.filter(cell => typeof cell.dataset.cellId === 'string');
        }
        if (selector === 'td[data-cell-id]:not(.row-number-cell)') {
            return this.children.filter(
                cell => typeof cell.dataset.cellId === 'string' && !cell.classList.contains('row-number-cell')
            );
        }
        return [];
    }
}

class FakeWrapper {
    public readonly classList = new FakeClassList(['grid-wrapper', 'active']);
    public readonly style = { display: 'block', outline: 'none' };
    public readonly rows: FakeRow[];
    public isConnected = true;
    public tabIndex = 0;
    private readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

    constructor(rows: FakeRow[]) {
        this.rows = rows;
    }

    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        const entries = this.listeners.get(type) || [];
        entries.push(listener);
        this.listeners.set(type, entries);
    }

    dispatchMouseDown(target: FakeCell, options: Record<string, unknown> = {}) {
        const event = {
            target,
            button: 0,
            ctrlKey: false,
            metaKey: false,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            ...options,
        };
        for (const listener of this.listeners.get('mousedown') || []) {
            listener(event);
        }
    }

    appendChild() {}

    getBoundingClientRect() {
        return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    }

    remove() {
        this.isConnected = false;
    }

    focus() {}

    querySelector(selector: string) {
        if (selector === 'tbody') {
            return {};
        }
        const cellIdMatch = selector.match(/^\[data-cell-id="(.+)"\]$/);
        if (cellIdMatch) {
            const cellId = cellIdMatch[1];
            for (const row of this.rows) {
                const found = row.children.find(cell => cell.dataset.cellId === cellId);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    }

    querySelectorAll(selector: string) {
        if (selector === 'tbody tr' || selector === 'tbody tr[data-index]') {
            return this.rows;
        }
        if (selector === 'tr.row-selected') {
            return [];
        }
        if (selector === '.selected-cell') {
            return this.rows.flatMap(row => row.children.filter(cell => cell.classList.contains('selected-cell')));
        }
        if (selector === '.anchor-cell') {
            return [];
        }
        return [];
    }
}

describe('result panel selection lifecycle', () => {
    beforeEach(() => {
        jest.resetModules();

        const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
        const wrappers: FakeWrapper[] = [];

        const windowMock = {
            focus: jest.fn(),
            getSelection: () => ({ removeAllRanges: jest.fn() }),
            dispatchEvent: jest.fn()
        };

        const documentMock = {
            activeWrapper: null as FakeWrapper | null,
            addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
                const entries = listeners.get(type) || [];
                entries.push(listener);
                listeners.set(type, entries);
            },
            removeEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
                const entries = listeners.get(type) || [];
                listeners.set(type, entries.filter(entry => entry !== listener));
            },
            createElement: (tagName: string) => ({
                tagName,
                style: {} as Record<string, string>,
                className: '',
                classList: new FakeClassList(),
                appendChild: jest.fn(),
                remove: jest.fn()
            }),
            querySelector: (selector: string) => {
                if (selector === '.grid-wrapper.active') {
                    return documentMock.activeWrapper;
                }

                const cellIdMatch = selector.match(/^\[data-cell-id="(.+)"\]$/);
                if (!cellIdMatch) {
                    return null;
                }

                const cellId = cellIdMatch[1];
                for (const wrapper of wrappers) {
                    for (const row of wrapper.rows) {
                        const found = row.children.find(cell => cell.dataset.cellId === cellId);
                        if (found) {
                            return found;
                        }
                    }
                }

                return null;
            },
            dispatchKeydown: (event: Record<string, unknown>) => {
                for (const listener of listeners.get('keydown') || []) {
                    listener(event);
                }
            }
        };

        class FakeMutationObserver {
            observe() {}
            disconnect() {}
        }

        Object.defineProperty(global, 'window', { configurable: true, writable: true, value: windowMock });
        Object.defineProperty(global, 'document', { configurable: true, writable: true, value: documentMock });
        Object.defineProperty(global, 'HTMLElement', { configurable: true, writable: true, value: class {} });
        Object.defineProperty(global, 'MutationObserver', { configurable: true, writable: true, value: FakeMutationObserver });
        Object.defineProperty(global, 'CustomEvent', {
            configurable: true,
            writable: true,
            value: class {
                constructor(public type: string) {}
            }
        });

        Object.defineProperty(global, '__selectionTestState', {
            configurable: true,
            writable: true,
            value: { wrappers, documentMock }
        });
    });

    it('does not let a detached old grid intercept Ctrl+A for a newly rendered grid', () => {
        const { setupCellSelectionEvents } = require('../../media/resultPanel/selection.js');
        const { wrappers, documentMock } = (global as typeof globalThis & {
            __selectionTestState: {
                wrappers: FakeWrapper[];
                documentMock: { activeWrapper: FakeWrapper | null; dispatchKeydown: (event: Record<string, unknown>) => void };
            };
        }).__selectionTestState;

        const createGrid = (label: string) => {
            const rowNumberCell = new FakeCell('1', ['row-number-cell']);
            const dataCell = new FakeCell(label);
            const row = new FakeRow(0, [rowNumberCell, dataCell]);
            const wrapper = new FakeWrapper([row]);
            wrappers.push(wrapper);
            documentMock.activeWrapper = wrapper;

            const tableApi = {
                getAllColumns: () => [],
                getRowModel: () => ({ rows: [] }),
                getFilteredRowModel: () => ({ rows: [] })
            };

            setupCellSelectionEvents(wrapper, tableApi, 1);
            return { wrapper, dataCell };
        };

        const firstGrid = createGrid('first');
        firstGrid.wrapper.remove();

        const secondGrid = createGrid('second');

        const event = {
            key: 'a',
            ctrlKey: true,
            metaKey: false,
            target: null,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopImmediatePropagation() {}
        };

        documentMock.dispatchKeydown(event);

        expect(secondGrid.dataCell.classList.contains('selected-cell')).toBe(true);
        expect(firstGrid.dataCell.classList.contains('selected-cell')).toBe(false);
        expect(event.defaultPrevented).toBe(true);
    });

    it('keeps row-number column out of Ctrl+A selection even with stale cell ids', () => {
        const { setupCellSelectionEvents } = require('../../media/resultPanel/selection.js');
        const { wrappers, documentMock } = (global as typeof globalThis & {
            __selectionTestState: {
                wrappers: FakeWrapper[];
                documentMock: { activeWrapper: FakeWrapper | null; dispatchKeydown: (event: Record<string, unknown>) => void };
            };
        }).__selectionTestState;

        const rowNumberCell = new FakeCell('1', ['row-number-cell']);
        rowNumberCell.dataset.cellId = 'stale-row-header-cell-id';
        const dataCell = new FakeCell('value');
        const row = new FakeRow(0, [rowNumberCell, dataCell]);
        const wrapper = new FakeWrapper([row]);
        wrappers.push(wrapper);
        documentMock.activeWrapper = wrapper;

        const tableApi = {
            getAllColumns: () => [],
            getRowModel: () => ({ rows: [] }),
            getFilteredRowModel: () => ({ rows: [] })
        };

        setupCellSelectionEvents(wrapper, tableApi, 1);

        const event = {
            key: 'a',
            ctrlKey: true,
            metaKey: false,
            target: null,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopImmediatePropagation() {}
        };

        documentMock.dispatchKeydown(event);

        expect(dataCell.classList.contains('selected-cell')).toBe(true);
        expect(rowNumberCell.classList.contains('selected-cell')).toBe(false);
        expect(rowNumberCell.dataset.cellId).toBeUndefined();
    });

    it('clears virtualized Ctrl+A selection on click and selects only the clicked cell', () => {
        const { setupCellSelectionEvents } = require('../../media/resultPanel/selection.js');
        const { wrappers, documentMock } = (global as typeof globalThis & {
            __selectionTestState: {
                wrappers: FakeWrapper[];
                documentMock: { activeWrapper: FakeWrapper | null; dispatchKeydown: (event: Record<string, unknown>) => void };
            };
        }).__selectionTestState;

        const createRow = (index: number, label: string) => {
            const rowNumberCell = new FakeCell(String(index + 1), ['row-number-cell']);
            const dataCell = new FakeCell(label);
            dataCell.dataset.cellId = `${index}-0`;
            return new FakeRow(index, [rowNumberCell, dataCell]);
        };

        const initialRow = createRow(0, 'initial');
        const virtualizedRow = createRow(5, 'virtualized');
        const clickedRow = createRow(7, 'clicked');
        const wrapper = new FakeWrapper([initialRow, virtualizedRow, clickedRow]);
        wrappers.push(wrapper);
        documentMock.activeWrapper = wrapper;

        const tableApi = {
            getAllColumns: () => [],
            getRowModel: () => ({ rows: [{}, {}, {}, {}, {}, {}, {}, {}] }),
            getFilteredRowModel: () => ({ rows: [] }),
            getVisibleLeafColumns: () => [{ id: '0', columnDef: { header: 'col' } }],
        };

        const handlers = setupCellSelectionEvents(wrapper, tableApi, 1);

        documentMock.dispatchKeydown({
            key: 'a',
            ctrlKey: true,
            metaKey: false,
            target: null,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopImmediatePropagation() {}
        });

        // Simulate virtualization re-render: isAllSelected paints new rows without updating selectedCells.
        virtualizedRow.children[1].classList.add('selected-cell');

        const clickedCell = clickedRow.children[1];
        wrapper.dispatchMouseDown(clickedCell);

        const selectedCount = wrapper.querySelectorAll('.selected-cell').length;
        expect(selectedCount).toBe(1);
        expect(clickedCell.classList.contains('selected-cell')).toBe(true);
        expect(initialRow.children[1].classList.contains('selected-cell')).toBe(false);
        expect(virtualizedRow.children[1].classList.contains('selected-cell')).toBe(false);
        expect(handlers.hasSelection()).toBe(true);
    });
});
