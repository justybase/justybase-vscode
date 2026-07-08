// Integration: Result ↔ Logs tab scroll with real persistence + tabs (no mocked scroll fns).

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    setActiveGridIndex: jest.fn(),
    getAllGrids: jest.fn(() => []),
    getGrid: jest.fn(),
    resetEditSession: jest.fn(),
    saveScrollStateToCache: jest.fn((source: string, rsIndex: number, scroll: unknown) => {
        const cache = (global as { __scrollCache?: Record<string, Record<number, unknown>> }).__scrollCache ?? {};
        if (!cache[source]) cache[source] = {};
        cache[source][rsIndex] = scroll;
        (global as { __scrollCache?: Record<string, Record<number, unknown>> }).__scrollCache = cache;
    }),
    getScrollStateFromGlobalCache: jest.fn((source: string, rsIndex: number) => {
        return (global as { __scrollCache?: Record<string, Record<number, unknown>> }).__scrollCache?.[source]?.[rsIndex] ?? null;
    }),
    getColumnFilterState: jest.fn(() => ({})),
    getAggregationState: jest.fn(() => ({})),
    getPinnedColumnsState: jest.fn(() => []),
    getResultFormattingState: jest.fn(() => null),
    getLayoutMode: jest.fn(() => 'table'),
}));

jest.mock('../../media/resultPanel/protocol.js', () => ({
    getHostState: jest.fn(() => ({})),
    setHostState: jest.fn((state: unknown) => {
        (global as { __hostState?: unknown }).__hostState = state;
    }),
    postHostMessage: jest.fn(),
}));

jest.mock('../../media/resultPanel/banners.js', () => ({
    updateResultLimitBanner: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    updateControlsVisibility: jest.fn(),
    syncGlobalFilterInput: jest.fn(),
}));

jest.mock('../../media/resultPanel/export.js', () => ({
    clearLogs: jest.fn(),
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn(),
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    renderRowCountInfo: jest.fn(),
}));

jest.mock('../../media/resultPanel/diskGrouping.js', () => ({
    getDiskGroupingExpandedKeys: jest.fn(() => []),
}));

function createDataWrapper(rsIndex: number, scrollTop = 0) {
    return {
        scrollTop,
        scrollLeft: 0,
        scrollHeight: 10_000,
        clientHeight: 400,
        dataset: { index: String(rsIndex) },
        style: { display: rsIndex === 0 ? 'block' : 'none', visibility: '' },
        offsetParent: rsIndex === 0 ? {} : null,
        classList: {
            contains: jest.fn((cls: string) => cls === 'console-wrapper' ? false : false),
            toggle: jest.fn(),
            add: jest.fn(),
            remove: jest.fn(),
        },
        querySelector: jest.fn(() => null),
    };
}

function createConsoleWrapper(rsIndex: number, scrollTop = 0) {
    const consoleView = {
        scrollTop,
        scrollLeft: 0,
        scrollHeight: 8000,
        clientHeight: 400,
    };
    return {
        scrollTop: 0,
        scrollLeft: 0,
        dataset: { index: String(rsIndex) },
        style: { display: rsIndex === 1 ? 'block' : 'none' },
        offsetParent: rsIndex === 1 ? {} : null,
        classList: {
            contains: jest.fn((cls: string) => cls === 'console-wrapper'),
            toggle: jest.fn(),
            add: jest.fn(),
            remove: jest.fn(),
        },
        querySelector: jest.fn((sel: string) => sel === '.console-view' ? consoleView : null),
        _consoleView: consoleView,
    };
}

describe('Result ↔ Logs tab scroll integration', () => {
    const testSource = 'file:///query.sql';
    let dataWrapper: ReturnType<typeof createDataWrapper>;
    let logsWrapper: ReturnType<typeof createConsoleWrapper>;
    let mockGrids: Array<{
        executionTimestamp: number;
        render: jest.Mock;
        updateRowCount: jest.Mock;
        getScrollAnchorIndex?: jest.Mock;
        scrollToIndex?: jest.Mock;
        tanTable?: unknown;
    }>;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        (global as { __hostState?: unknown }).__hostState = {};
        (global as { __scrollCache?: Record<string, Record<number, unknown>> }).__scrollCache = {};

        dataWrapper = createDataWrapper(0, 2500);
        logsWrapper = createConsoleWrapper(1, 0);

        mockGrids = [
            {
                executionTimestamp: 1000,
                render: jest.fn(),
                updateRowCount: jest.fn(),
                getScrollAnchorIndex: jest.fn(() => Math.round(dataWrapper.scrollTop / 5)),
                scrollToIndex: jest.fn((index: number) => {
                    dataWrapper.scrollTop = index * 5;
                }),
                tanTable: {
                    getState: jest.fn(() => ({
                        sorting: [],
                        grouping: [],
                        expanded: [],
                        columnOrder: [],
                        columnFilters: {},
                        columnPinning: {},
                        columnVisibility: {},
                        globalFilter: '',
                    })),
                },
            },
            { executionTimestamp: 1001, render: jest.fn(), updateRowCount: jest.fn() },
        ];

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0; },
                activeSource: testSource,
                resultSets: [
                    { executionTimestamp: 1000, isLog: false, data: [[1]] },
                    { executionTimestamp: 1001, isLog: true, data: [[1]] },
                ],
                pinnedResults: [],
                refreshRowView: jest.fn(),
            },
        });

        (global as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = (cb) => {
            cb(0);
            return 0;
        };

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                querySelector: jest.fn((sel: string) => {
                    if (sel === '.grid-wrapper[data-index="0"]') return dataWrapper;
                    if (sel === '.grid-wrapper[data-index="1"]') return logsWrapper;
                    return null;
                }),
                querySelectorAll: jest.fn((sel: string) => {
                    if (sel === '.grid-wrapper') return [dataWrapper, logsWrapper];
                    if (sel === '.result-set-tab') return [{ classList: { add: jest.fn(), remove: jest.fn() } }, { classList: { add: jest.fn(), remove: jest.fn() } }];
                    return [];
                }),
                getElementById: jest.fn(() => null),
                body: {
                    appendChild: jest.fn(),
                    classList: { contains: jest.fn(() => false) },
                },
            },
        });

        const state = require('../../media/resultPanel/state.js');
        state.setActiveGridIndex.mockImplementation((idx: number) => {
            state.getActiveGridIndex.mockReturnValue(idx);
            dataWrapper.style.display = idx === 0 ? 'block' : 'none';
            logsWrapper.style.display = idx === 1 ? 'block' : 'none';
            dataWrapper.offsetParent = idx === 0 ? {} : null;
            logsWrapper.offsetParent = idx === 1 ? {} : null;
        });
        state.getAllGrids.mockReturnValue(mockGrids);
        state.getGrid.mockImplementation((idx: number) => mockGrids[idx]);

        const protocol = require('../../media/resultPanel/protocol.js');
        (protocol.getHostState as jest.Mock).mockImplementation(() => (global as { __hostState?: unknown }).__hostState ?? {});
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('preserves Result scroll after switching to Logs and back', () => {
        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');

        switchToResultSet(1);
        switchToResultSet(0);
        jest.advanceTimersByTime(50);

        expect(dataWrapper.scrollTop).toBe(2500);
    });

    it('does not apply Logs bottom scroll to Result grid', () => {
        logsWrapper._consoleView.scrollTop = 7600;

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(1);
        switchToResultSet(0);
        jest.advanceTimersByTime(50);

        expect(dataWrapper.scrollTop).not.toBe(7600);
        expect(dataWrapper.scrollTop).toBe(2500);
    });

    it('preserves Result scroll when render would reset scroll position', () => {
        mockGrids[0].render.mockImplementation(() => {
            dataWrapper.scrollTop = 9000;
        });

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(1);
        switchToResultSet(0);
        jest.advanceTimersByTime(50);

        expect(mockGrids[0].scrollToIndex).not.toHaveBeenCalled();
        expect(dataWrapper.scrollTop).toBe(2500);
    });
});

export {};
