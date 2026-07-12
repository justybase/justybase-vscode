/* eslint-disable @typescript-eslint/no-explicit-any */
// Unit tests for messages.js scroll persistence functions.
// Tests saveAllGridStates, getSavedStateFor, findScrollStateBySource,
// handleSaveScrollState, saveScrollStatesToResultSets, restoreScrollFromResultSet.

jest.mock('../../media/resultPanel/protocol.js', () => ({
    getHostState: jest.fn(() => ({})),
    setHostState: jest.fn(),
    postHostMessage: jest.fn()
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    saveCurrentSourceToCache: jest.fn(),
    getCachedSource: jest.fn(),
    saveScrollStateForSource: jest.fn(),
    getScrollStateFromCache: jest.fn(),
    saveScrollStateToCache: jest.fn(),
    getScrollStateFromGlobalCache: jest.fn(),
    setActiveGridIndex: jest.fn(),
    getActiveGridIndex: jest.fn(() => 0),
    getSearchWorker: jest.fn(),
    setSearchMatches: jest.fn(),
    setIsSearching: jest.fn(),
    getAllGrids: jest.fn(() => []),
    getGrid: jest.fn(),
    getColumnFilterState: jest.fn(() => ({})),
    getAggregationState: jest.fn(() => ({})),
    getPinnedColumnsState: jest.fn(() => []),
    getResultFormattingState: jest.fn(() => null),
    setResultFormattingPayload: jest.fn(),
    setResultFormattingState: jest.fn(),
    clearScrollStatesForSource: jest.fn(),
    getLayoutMode: jest.fn(() => 'table')
}));

jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn(v => String(v)),
    showError: jest.fn(),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

jest.mock('../../media/resultPanel/tabs.js', () => ({
    renderDocIndicator: jest.fn(),
    renderResultSetTabs: jest.fn(),
    switchToResultSet: jest.fn()
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: jest.fn(),
    updateLoadingState: jest.fn(),
    appendLogRows: jest.fn()
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    updateRowCountInfo: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn(),
    getActiveResultViewMode: jest.fn(() => 'table')
}));

function createMockGrid(executionTimestamp = 1000) {
    return {
        executionTimestamp,
        tanTable: {
            getState: jest.fn(() => ({
                sorting: [],
                grouping: [],
                expanded: [],
                columnOrder: [],
                columnFilters: {},
                columnPinning: {},
                columnVisibility: {},
                globalFilter: ''
            }))
        },
        columnWidths: new Set(),
        manualColumnWidths: new Set()
    } as { executionTimestamp: number; tanTable: { getState: jest.Mock }; columnWidths: Set<never>; manualColumnWidths: Set<never> };
}

function createMockWrapper(isConsole = false) {
    const consoleView = {
        scrollTop: 200,
        scrollLeft: 10,
        style: {},
        classList: { contains: jest.fn(() => false) }
    };
    return {
        scrollTop: 200,
        scrollLeft: 10,
        style: { display: 'block' },
        classList: {
            contains: jest.fn((cls: string) => {
                if (cls === 'console-wrapper') return isConsole;
                return false;
            })
        },
        querySelector: jest.fn((sel: string) => {
            if (sel === '.console-view' && isConsole) {
                return consoleView;
            }
            return null;
        })
    };
}

describe('messages.js scroll functions', () => {
    const testSource = 'file:///test.sql';

    beforeEach(() => {
        jest.resetModules();

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: testSource,
                resultSets: [
                    { executionTimestamp: 1000, isLog: false, data: [[1]] },
                    { executionTimestamp: 1001, isLog: false, data: [[2]] }
                ],
                sources: [],
                pinnedResults: [],
                pinnedSources: new Set(),
                executingSources: new Set(),
                focusQueryInput: jest.fn(),
                refreshRowView: jest.fn()
            }
        });

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                querySelectorAll: jest.fn(() => []),
                querySelector: jest.fn(() => null),
                getElementById: jest.fn(() => null),
                addEventListener: jest.fn(),
                removeEventListener: jest.fn()
            }
        });

        (global as any).acquireVsCodeApi = jest.fn(() => ({
            postMessage: jest.fn(),
            setState: jest.fn(),
            getState: jest.fn(() => ({}))
        }));
    });

    // ── saveAllGridStates ─────────────────────────────────────────

    describe('saveAllGridStates', () => {
        it('saves grid state to host state for each grid', () => {
            const state = require('../../media/resultPanel/state.js');
            const mockGrids = [createMockGrid(1000), createMockGrid(1001)];
            state.getAllGrids.mockReturnValue(mockGrids);

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockReturnValue([createMockWrapper(), createMockWrapper()]);

            const { saveAllGridStates } = require('../../media/resultPanel/messages.js');
            saveAllGridStates();

            const { setHostState } = require('../../media/resultPanel/protocol.js');
            expect(setHostState).toHaveBeenCalledTimes(1);

            const savedState = (setHostState as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
            expect(savedState[`${testSource}:0:1000`]).toBeDefined();
            expect(savedState[`${testSource}:1:1001`]).toBeDefined();
        });

        it('includes sorting/grouping/filter state from Tabulator', () => {
            const state = require('../../media/resultPanel/state.js');
            const grid = createMockGrid(1000);
            (grid.tanTable.getState as jest.Mock).mockReturnValue({
                sorting: [{ column: 'id', dir: 'asc' }],
                grouping: ['category'],
                expanded: [],
                columnOrder: ['name', 'id'],
                columnFilters: { name: 'test' },
                columnPinning: {},
                columnVisibility: {},
                globalFilter: 'test'
            });
            state.getAllGrids.mockReturnValue([grid]);

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockReturnValue([createMockWrapper()]);

            const { saveAllGridStates } = require('../../media/resultPanel/messages.js');
            saveAllGridStates();

            const { setHostState } = require('../../media/resultPanel/protocol.js');
            const savedState = (setHostState as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
            const entry = savedState[`${testSource}:0:1000`] as Record<string, unknown>;
            expect(entry.sorting).toEqual([{ column: 'id', dir: 'asc' }]);
            expect(entry.grouping).toEqual(['category']);
            expect(entry.columnFilters).toEqual({ name: 'test' });
            expect(entry.globalFilter).toBe('test');
        });

        it('saves scroll-only state for grids without tanTable', () => {
            const state = require('../../media/resultPanel/state.js');
            state.getAllGrids.mockReturnValue([{ executionTimestamp: 1000, tanTable: null }]);

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockReturnValue([createMockWrapper(true)]);

            const { saveAllGridStates } = require('../../media/resultPanel/messages.js');
            saveAllGridStates();

            const { setHostState } = require('../../media/resultPanel/protocol.js');
            expect(setHostState).toHaveBeenCalled();

            const savedState = (setHostState as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
            const entry = savedState[`${testSource}:0:1000`] as Record<string, unknown>;
            expect(entry.scrollTop).toBe(200);
            expect(entry.scrollLeft).toBe(10);
            expect(state.saveScrollStateToCache).toHaveBeenCalledWith(testSource, 0,
                expect.objectContaining({ scrollTop: 200, scrollLeft: 10 })
            );
        });

        it('also saves to global cache via saveScrollStateToCache', () => {
            const state = require('../../media/resultPanel/state.js');
            state.getAllGrids.mockReturnValue([createMockGrid(1000)]);

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockReturnValue([createMockWrapper()]);

            const { saveAllGridStates } = require('../../media/resultPanel/messages.js');
            saveAllGridStates();

            expect(state.saveScrollStateToCache).toHaveBeenCalledWith(testSource, 0,
                expect.objectContaining({ scrollTop: 200, scrollLeft: 10 })
            );
        });
    });

    // ── getSavedStateFor ──────────────────────────────────────────

    describe('getSavedStateFor', () => {
        it('returns saved state by exact key (source:rsIndex:timestamp)', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`${testSource}:0:1000`]: { scrollTop: 150, scrollLeft: 10 }
            });

            const { getSavedStateFor } = require('../../media/resultPanel/messages.js');
            const result = getSavedStateFor(0, 1000, testSource);
            expect(result).toEqual({ scrollTop: 150, scrollLeft: 10 });
        });

        it('returns null when no matching key exists', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({});

            const { getSavedStateFor } = require('../../media/resultPanel/messages.js');
            const result = getSavedStateFor(0, 1000, testSource);
            expect(result).toBeNull();
        });

        it('returns null when host state is null', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue(null);

            const { getSavedStateFor } = require('../../media/resultPanel/messages.js');
            const result = getSavedStateFor(0, 1000, testSource);
            expect(result).toBeNull();
        });

        it('uses window.activeSource when sourceUri is null', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`${testSource}:0:1000`]: { scrollTop: 150, scrollLeft: 10 }
            });

            const { getSavedStateFor } = require('../../media/resultPanel/messages.js');
            const result = getSavedStateFor(0, 1000);
            expect(result).toBeDefined();
        });

        it('does not let a zero global cache entry hide an exact saved scroll position', () => {
            const state = require('../../media/resultPanel/state.js');
            state.getScrollStateFromGlobalCache.mockReturnValue({
                scrollTop: 0,
                scrollLeft: 0,
                timestamp: 1000
            });

            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`${testSource}:0:1000`]: { scrollTop: 420, scrollLeft: 30 }
            });

            const { resolveScrollStateForResultSet } = require('../../media/resultPanel/grid/persistence.js');
            expect(resolveScrollStateForResultSet(0, testSource)).toEqual({
                scrollTop: 420,
                scrollLeft: 30
            });
        });

        it('does not restore a previous execution scroll position for a new result', () => {
            const state = require('../../media/resultPanel/state.js');
            state.getScrollStateFromGlobalCache.mockReturnValue(null);

            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`${testSource}:0:old-execution`]: { scrollTop: 9_999, scrollLeft: 0 }
            });

            (global.window as unknown as {
                resultSets: Array<{ executionTimestamp: number; isLog: boolean; data: unknown[][] }>;
            }).resultSets[0].executionTimestamp = 2000;

            const { resolveScrollStateForResultSet } = require('../../media/resultPanel/grid/persistence.js');
            expect(resolveScrollStateForResultSet(0, testSource)).toBeNull();
        });
    });

    // ── findScrollStateBySource ───────────────────────────────────

    describe('findScrollStateBySource', () => {
        it('finds state by source+rsIndex prefix ignoring timestamp', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`${testSource}:0:old`]: { scrollTop: 300, scrollLeft: 20 },
                [`${testSource}:1:1001`]: { scrollTop: 400, scrollLeft: 30 }
            });

            const { findScrollStateBySource } = require('../../media/resultPanel/messages.js');
            const result = findScrollStateBySource(testSource, 0);
            expect(result).toEqual({ scrollTop: 300, scrollLeft: 20 });
        });

        it('returns null when no state matches source+rsIndex', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`other.sql:0:1000`]: { scrollTop: 300, scrollLeft: 20 }
            });

            const { findScrollStateBySource } = require('../../media/resultPanel/messages.js');
            const result = findScrollStateBySource(testSource, 0);
            expect(result).toBeNull();
        });

        it('prefers entries with scrollTop > 0', () => {
            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({
                [`${testSource}:0:zero`]: { scrollTop: 0, scrollLeft: 0 },
                [`${testSource}:0:good`]: { scrollTop: 500, scrollLeft: 5 }
            });

            const { findScrollStateBySource } = require('../../media/resultPanel/messages.js');
            const result = findScrollStateBySource(testSource, 0);
            expect(result).toEqual({ scrollTop: 500, scrollLeft: 5 });
        });
    });

    describe('applyScrollForResultSet', () => {
        it('auto-scrolls logs to bottom when cached log scroll is zero', () => {
            const consoleView = {
                scrollTop: 0,
                scrollLeft: 0,
                scrollHeight: 999,
                style: {},
                classList: { contains: jest.fn(() => false) }
            };
            const consoleWrapper = {
                style: { display: 'block' },
                classList: {
                    contains: jest.fn((cls: string) => cls === 'console-wrapper')
                },
                querySelector: jest.fn((sel: string) => sel === '.console-view' ? consoleView : null)
            };

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockImplementation((sel: string) => {
                if (sel === '.grid-wrapper') return [consoleWrapper];
                return [];
            });

            const state = require('../../media/resultPanel/state.js');
            state.getScrollStateFromGlobalCache.mockReturnValue({ scrollTop: 0, scrollLeft: 0 });

            const { applyScrollForResultSet } = require('../../media/resultPanel/grid/persistence.js');
            applyScrollForResultSet(0, {
                sourceUri: testSource,
                autoBottomLogs: true,
                verifyAfterFrame: false
            });

            expect(consoleView.scrollTop).toBe(999);
        });

        it('does not reset data grid scroll when resolved state has scrollTop 0', () => {
            const dataWrapper = {
                scrollTop: 800,
                scrollLeft: 0,
                scrollHeight: 10_000,
                style: { display: 'block' },
                classList: { contains: jest.fn(() => false) },
                querySelector: jest.fn(() => null),
            };

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockImplementation((sel: string) => {
                if (sel === '.grid-wrapper') return [dataWrapper];
                return [];
            });

            const state = require('../../media/resultPanel/state.js');
            state.getScrollStateFromGlobalCache.mockReturnValue({ scrollTop: 0, scrollLeft: 0 });

            const protocol = require('../../media/resultPanel/protocol.js');
            (protocol.getHostState as jest.Mock).mockReturnValue({});

            const { applyScrollForResultSet } = require('../../media/resultPanel/grid/persistence.js');
            applyScrollForResultSet(0, { sourceUri: testSource, verifyAfterFrame: false });

            expect(dataWrapper.scrollTop).toBe(800);
        });
    });

    // ── handleSaveScrollState ─────────────────────────────────────

    describe('handleSaveScrollState', () => {
        it('saves scroll for all grid wrappers to global cache', () => {
            const wrappers = [createMockWrapper(), createMockWrapper()];
            wrappers[0].scrollTop = 100;
            wrappers[1].scrollTop = 200;
            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockImplementation((sel: string) => {
                if (sel === '.grid-wrapper') return wrappers;
                return [];
            });

            const { handleSaveScrollState } = require('../../media/resultPanel/messages.js');
            handleSaveScrollState();

            const state = require('../../media/resultPanel/state.js');
            expect(state.saveScrollStateToCache).toHaveBeenCalledWith(testSource, 0,
                expect.objectContaining({ scrollTop: 100, scrollLeft: 10 })
            );
            expect(state.saveScrollStateToCache).toHaveBeenCalledWith(testSource, 1,
                expect.objectContaining({ scrollTop: 200, scrollLeft: 10 })
            );
        });

        it('preserves cached scroll for hidden grids instead of writing zero', () => {
            const visibleWrapper = createMockWrapper();
            visibleWrapper.scrollTop = 50;
            visibleWrapper.style.display = 'block';

            const hiddenWrapper = createMockWrapper();
            hiddenWrapper.scrollTop = 0;
            hiddenWrapper.style.display = 'none';

            const doc = global.document as unknown as { querySelectorAll: jest.Mock; querySelector: jest.Mock };
            doc.querySelectorAll.mockImplementation((sel: string) => {
                if (sel === '.grid-wrapper') return [visibleWrapper, hiddenWrapper];
                return [];
            });
            doc.querySelector.mockImplementation((sel: string) => {
                if (sel === '.grid-wrapper[data-index="0"]') return visibleWrapper;
                if (sel === '.grid-wrapper[data-index="1"]') return hiddenWrapper;
                return null;
            });

            const state = require('../../media/resultPanel/state.js');
            state.getScrollStateFromGlobalCache.mockImplementation((_source: string, rsIndex: number) => {
                if (rsIndex === 1) return { scrollTop: 2500, scrollLeft: 0, timestamp: 1001 };
                return null;
            });

            const { handleSaveScrollState } = require('../../media/resultPanel/messages.js');
            handleSaveScrollState();

            expect(state.saveScrollStateToCache).toHaveBeenCalledWith(testSource, 1,
                expect.objectContaining({ scrollTop: 2500, scrollLeft: 0 })
            );
        });

        it('does not crash', () => {
            const { handleSaveScrollState } = require('../../media/resultPanel/messages.js');
            expect(() => handleSaveScrollState()).not.toThrow();
        });

        it('does nothing when activeSource or resultSets is missing', () => {
            (global.window as any).activeSource = null;

            const { handleSaveScrollState } = require('../../media/resultPanel/messages.js');
            expect(() => handleSaveScrollState()).not.toThrow();
        });
    });

    // ── saveScrollStatesToResultSets / restoreScrollFromResultSet ─

    describe('saveScrollStatesToResultSets', () => {
        it('saves scroll state to each resultSet._savedState', () => {
            const wrappers = [createMockWrapper(), createMockWrapper()];
            wrappers[0].scrollTop = 100;
            wrappers[0].scrollLeft = 5;
            wrappers[1].scrollTop = 300;
            wrappers[1].scrollLeft = 15;

            const doc = global.document as unknown as { querySelectorAll: jest.Mock };
            doc.querySelectorAll.mockReturnValue(wrappers);

            const { saveScrollStatesToResultSets } = require('../../media/resultPanel/messages.js');
            saveScrollStatesToResultSets();

            const rs = (global.window as any).resultSets;
            expect(rs[0]._savedState).toEqual({ scrollTop: 100, scrollLeft: 5 });
            expect(rs[1]._savedState).toEqual({ scrollTop: 300, scrollLeft: 15 });
        });

        it('does nothing when window.resultSets is missing', () => {
            (global.window as any).resultSets = null;

            const { saveScrollStatesToResultSets } = require('../../media/resultPanel/messages.js');
            expect(() => saveScrollStatesToResultSets()).not.toThrow();
        });
    });

    describe('restoreScrollFromResultSet', () => {
        it('returns _savedState for given rsIndex', () => {
            (global.window as any).resultSets = [
                { executionTimestamp: 1000, _savedState: { scrollTop: 100, scrollLeft: 5 } }
            ];

            const { restoreScrollFromResultSet } = require('../../media/resultPanel/messages.js');
            const state = restoreScrollFromResultSet(0);
            expect(state).toEqual({ scrollTop: 100, scrollLeft: 5 });
        });

        it('returns null when resultSet has no _savedState', () => {
            (global.window as any).resultSets = [{ executionTimestamp: 1000 }];

            const { restoreScrollFromResultSet } = require('../../media/resultPanel/messages.js');
            const state = restoreScrollFromResultSet(0);
            expect(state).toBeNull();
        });

        it('returns null when rsIndex is out of bounds', () => {
            (global.window as any).resultSets = [{ executionTimestamp: 1000 }];

            const { restoreScrollFromResultSet } = require('../../media/resultPanel/messages.js');
            const state = restoreScrollFromResultSet(5);
            expect(state).toBeNull();
        });
    });
});

export {};
