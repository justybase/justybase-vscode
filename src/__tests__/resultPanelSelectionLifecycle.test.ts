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
    public textContent: string;

    constructor(textContent: string, classNames: string[] = []) {
        this.textContent = textContent;
        this.classList = new FakeClassList(classNames);
    }

    getBoundingClientRect() {
        return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    }
}

class FakeRow {
    public readonly dataset: Record<string, string>;
    public readonly children: FakeCell[];

    constructor(index: number, cells: FakeCell[]) {
        this.dataset = { index: String(index) };
        this.children = cells;
    }

    querySelectorAll(selector: string): FakeCell[] {
        if (selector === 'td') {
            return this.children;
        }
        if (selector === 'td[data-cell-id]') {
            return this.children.filter(cell => typeof cell.dataset.cellId === 'string');
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

    constructor(rows: FakeRow[]) {
        this.rows = rows;
    }

    addEventListener() {}

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
        return null;
    }

    querySelectorAll(selector: string) {
        if (selector === 'tbody tr' || selector === 'tbody tr[data-index]') {
            return this.rows;
        }
        if (selector === 'tr.row-selected') {
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
});
