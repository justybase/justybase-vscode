// Unit tests for tabs.js scroll restoration in switchToResultSet.
// Tests the 3-tier fallback: global cache → getSavedStateFor → findScrollStateBySource.

jest.mock('../../media/resultPanel/state.js', () => ({
    getActiveGridIndex: jest.fn(() => 0),
    setActiveGridIndex: jest.fn(),
    getAllGrids: jest.fn(() => []),
    getGrid: jest.fn(),
    resetEditSession: jest.fn(),
    saveScrollStateToCache: jest.fn(),
    getScrollStateFromGlobalCache: jest.fn()
}));

jest.mock('../../media/resultPanel/grid/persistence.js', () => ({
    saveAllGridStates: jest.fn(),
    getSavedStateFor: jest.fn(),
    findScrollStateBySource: jest.fn(),
    getGridWrapperForResultSet: jest.fn((index: number) => {
        const documentMock = global.document as unknown as {
            querySelector: (selector: string) => unknown;
            querySelectorAll: (selector: string) => unknown[];
        };
        return documentMock.querySelector(`.grid-wrapper[data-index="${index}"`)
            ?? documentMock.querySelectorAll('.grid-wrapper')[index];
    }),
    getScrollTarget: jest.fn((wrapper: { classList?: { contains: (cls: string) => boolean }; querySelector?: (sel: string) => unknown; scrollTop?: number } | null) => {
        if (!wrapper) return null;
        if (wrapper.classList?.contains('console-wrapper')) {
            return wrapper.querySelector?.('.console-view') as { scrollTop: number; scrollLeft: number; scrollHeight: number } | null;
        }
        return wrapper as { scrollTop: number; scrollLeft: number; scrollHeight: number };
    }),
    applyScrollForResultSet: jest.fn((index: number, options?: { preferScrollAnchor?: boolean }) => {
        const persistence = require('../../media/resultPanel/grid/persistence.js');
        const state = require('../../media/resultPanel/state.js');
        const documentMock = global.document as unknown as {
            querySelector: (selector: string) => unknown;
            querySelectorAll: (selector: string) => ReturnType<typeof createMockWrapper>[];
        };
        const wrapper = (documentMock.querySelector(`.grid-wrapper[data-index="${index}"`)
            ?? documentMock.querySelectorAll('.grid-wrapper')[index]) as {
            classList: { contains: (cls: string) => boolean };
            scrollTop?: number;
        } | undefined;
        if (!wrapper) return;
        const scrollTarget = persistence.getScrollTarget(wrapper);
        if (!scrollTarget) return;
        const target = scrollTarget as { scrollTop: number; scrollLeft: number; scrollHeight: number };

        const scrollState = state.getScrollStateFromGlobalCache()
            || persistence.getSavedStateFor()
            || persistence.findScrollStateBySource();
        const grid = state.getGrid(index);
        if (options?.preferScrollAnchor && scrollState?.scrollAnchorIndex != null && grid?.scrollToIndex) {
            grid.scrollToIndex(scrollState.scrollAnchorIndex, 'start');
            return;
        }
        if (scrollState) {
            target.scrollTop = scrollState.scrollTop ?? 0;
            target.scrollLeft = scrollState.scrollLeft ?? 0;
        } else if (wrapper.classList.contains('console-wrapper')) {
            target.scrollTop = target.scrollHeight;
        }
    }),
}));

jest.mock('../../media/resultPanel/banners.js', () => ({
    updateResultLimitBanner: jest.fn()
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    updateControlsVisibility: jest.fn(),
    syncGlobalFilterInput: jest.fn()
}));

jest.mock('../../media/resultPanel/export.js', () => ({
    clearLogs: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn()
}));

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn(),
    getHostState: jest.fn(),
    setHostState: jest.fn(),
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    renderRowCountInfo: jest.fn()
}));

function createMockWrapper(scrollTop = 0, isConsole = false) {
    const consoleView = { scrollTop: 0, scrollLeft: 0, scrollHeight: 999 };
    const wrapper = {
        scrollTop,
        scrollLeft: 0,
        dataset: { index: '' },
        style: { display: '', visibility: '' },
        classList: {
            contains: jest.fn((cls: string) => {
                if (cls === 'console-wrapper') return isConsole;
                return false;
            }),
            toggle: jest.fn(),
            add: jest.fn(),
            remove: jest.fn()
        },
        querySelector: jest.fn((sel: string) => {
            if (sel === '.console-view') return consoleView;
            return null;
        })
    };
    return wrapper;
}

function createMockGrid(executionTimestamp = 1000) {
    return {
        executionTimestamp,
        render: jest.fn(),
        updateRowCount: jest.fn(),
        getScrollAnchorIndex: jest.fn(() => undefined),
        scrollToIndex: jest.fn(),
    };
}

describe('tabs.js switchToResultSet scroll restoration', () => {
    let mockWrappers: ReturnType<typeof createMockWrapper>[];
    let mockGrids: ReturnType<typeof createMockGrid>[];
    const testSource = 'file:///test.sql';

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();

        mockWrappers = [createMockWrapper(0), createMockWrapper(0)];
        mockWrappers[0].dataset.index = '0';
        mockWrappers[1].dataset.index = '1';
        mockGrids = [createMockGrid(1000), createMockGrid(1001)];

        const state = require('../../media/resultPanel/state.js');
        state.getAllGrids.mockReturnValue(mockGrids);
        state.getGrid.mockImplementation((idx: number) => mockGrids[idx]);
        state.getActiveGridIndex.mockReturnValue(0);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                requestAnimationFrame: (callback: FrameRequestCallback) => {
                    callback(0);
                    return 0;
                },
                activeSource: testSource,
                resultSets: [
                    { executionTimestamp: 1000, data: [[1], [2]] },
                    { executionTimestamp: 1001, data: [[3]] }
                ],
                pinnedResults: [],
                refreshRowView: jest.fn()
            }
        });

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                querySelector: jest.fn((sel: string) => {
                    const match = sel.match(/data-index="(\d+)"/);
                    if (!match) return null;
                    return mockWrappers.find((wrapper) => wrapper.dataset.index === match[1]) ?? null;
                }),
                querySelectorAll: jest.fn((sel: string) => {
                    if (sel === '.grid-wrapper') return mockWrappers;
                    if (sel === '.result-set-tab') return [{ classList: { add: jest.fn(), remove: jest.fn() } }, { classList: { add: jest.fn(), remove: jest.fn() } }];
                    return [];
                }),
                getElementById: jest.fn(() => null),
                addEventListener: jest.fn(),
                body: {
                    classList: { contains: jest.fn(() => false) }
                }
            }
        });

        Object.defineProperty(global, 'vscode', {
            configurable: true, writable: true, value: { postMessage: jest.fn() }
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // ── 1st fallback: global cache ────────────────────────────────

    it('restores scroll from global cache (1st fallback)', () => {
        const state = require('../../media/resultPanel/state.js');
        state.getScrollStateFromGlobalCache.mockReturnValue({ scrollTop: 150, scrollLeft: 10 });

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);
        jest.advanceTimersByTime(50);

        expect(mockWrappers[0].scrollTop).toBe(150);
        expect(mockWrappers[0].scrollLeft).toBe(10);
    });

    // ── Deferred restore after layout settles ─────────────────────
    it('defers scroll restore until setTimeout(50) after render', () => {
        mockWrappers[0].scrollTop = 999;

        const state = require('../../media/resultPanel/state.js');
        state.getScrollStateFromGlobalCache.mockReturnValue({ scrollTop: 150, scrollLeft: 10 });

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);

        expect(mockWrappers[0].style.visibility).toBe('hidden');
        expect(mockWrappers[0].scrollTop).toBe(150);
        jest.advanceTimersByTime(50);
        expect(mockWrappers[0].style.visibility).toBe('');
        expect(mockWrappers[0].scrollLeft).toBe(10);
    });

    // ── Console auto-scroll to bottom ─────────────────────────────
    it('auto-scrolls console wrapper to bottom when no saved scroll', () => {
        const consoleWrapper = createMockWrapper(0, true);
        mockWrappers[0] = consoleWrapper;

        const state = require('../../media/resultPanel/state.js');
        state.getScrollStateFromGlobalCache.mockReturnValue(null);

        const persistence = require('../../media/resultPanel/grid/persistence.js');
        persistence.getSavedStateFor.mockReturnValue(null);
        persistence.findScrollStateBySource.mockReturnValue(null);

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);
        jest.advanceTimersByTime(50);

        const consoleView = consoleWrapper.querySelector('.console-view') as { scrollTop: number; scrollHeight: number };
        expect(consoleView.scrollTop).toBe(999); // scrollHeight
    });

    // ── skipScrollRestore flag ────────────────────────────────────

    it('skips scroll restoration when skipScrollRestore is true', () => {
        const state = require('../../media/resultPanel/state.js');
        state.getScrollStateFromGlobalCache.mockReturnValue({ scrollTop: 150, scrollLeft: 10 });

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0, true);

        expect(mockWrappers[0].scrollTop).toBe(0);
    });

    it('updates row count for the newly active tab', () => {
        const filter = require('../../media/resultPanel/filter.js');

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(1);

        expect(filter.renderRowCountInfo).toHaveBeenCalledWith(1);
    });

    it('updates row count even when the active grid is missing', () => {
        const state = require('../../media/resultPanel/state.js');
        state.getGrid.mockReturnValue(null);

        const filter = require('../../media/resultPanel/filter.js');

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(1);

        expect(filter.renderRowCountInfo).toHaveBeenCalledWith(1);
    });

    // ── saveAllGridStates called before switching ─────────────────

    it('calls saveAllGridStates before switching', () => {
        const persistence = require('../../media/resultPanel/grid/persistence.js');
        const banners = require('../../media/resultPanel/banners.js');

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);

        expect(persistence.saveAllGridStates).toHaveBeenCalledTimes(1);
        expect(banners.updateResultLimitBanner).toHaveBeenCalled();
    });

    // ── grid.render() called ──────────────────────────────────────

    it('defers applyScrollForResultSet until after grid.render() via setTimeout', () => {
        const persistence = require('../../media/resultPanel/grid/persistence.js');

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);

        expect(mockWrappers[0].style.visibility).toBe('hidden');
        expect(persistence.applyScrollForResultSet).toHaveBeenCalledTimes(1);
        expect(mockGrids[0].render).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(50);
        expect(persistence.applyScrollForResultSet).toHaveBeenCalledTimes(2);
        expect(mockWrappers[0].style.visibility).toBe('');
        const renderOrder = mockGrids[0].render.mock.invocationCallOrder[0];
        const firstScrollOrder = persistence.applyScrollForResultSet.mock.invocationCallOrder[0];
        const secondScrollOrder = persistence.applyScrollForResultSet.mock.invocationCallOrder[1];
        expect(renderOrder).toBeLessThan(firstScrollOrder);
        expect(firstScrollOrder).toBeLessThan(secondScrollOrder);
    });

    it('does not mask log console tab while restoring scroll', () => {
        const consoleWrapper = createMockWrapper(0, true);
        mockWrappers[0] = consoleWrapper;
        mockGrids[0] = createMockGrid(1000);

        const state = require('../../media/resultPanel/state.js');
        state.getAllGrids.mockReturnValue(mockGrids);
        state.getGrid.mockImplementation((idx: number) => mockGrids[idx]);
        (global.window as unknown as { resultSets: Array<{ executionTimestamp: number; isLog?: boolean }> }).resultSets = [
            { executionTimestamp: 1000, isLog: true },
            { executionTimestamp: 1001 },
        ];

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);

        expect(consoleWrapper.style.visibility).toBe('');
    });

    it('renders target grid after its wrapper is visible', () => {
        mockGrids[1].render.mockImplementation(() => {
            expect(mockWrappers[1].style.display).toBe('block');
        });

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(1);

        expect(mockGrids[1].render).toHaveBeenCalledTimes(1);
    });

    it('uses wrapper data-index instead of DOM order when switching tabs', () => {
        mockWrappers[0].dataset.index = '1';
        mockWrappers[1].dataset.index = '0';
        mockWrappers[0].scrollTop = 0;
        mockWrappers[1].scrollTop = 999;

        const state = require('../../media/resultPanel/state.js');
        state.getScrollStateFromGlobalCache.mockReturnValue({ scrollTop: 250, scrollLeft: 12 });

        mockGrids[1].render.mockImplementation(() => {
            expect(mockWrappers[0].style.display).toBe('block');
            expect(mockWrappers[1].style.display).toBe('none');
        });

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(1);
        jest.advanceTimersByTime(50);

        expect(mockWrappers[0].scrollTop).toBe(250);
        expect(mockWrappers[0].scrollLeft).toBe(12);
        expect(mockWrappers[1].scrollTop).toBe(999);
    });

    // ── No scroll state sources available ─────────────────────────

    it('handles gracefully when no scroll state is available', () => {
        const state = require('../../media/resultPanel/state.js');
        state.getScrollStateFromGlobalCache.mockReturnValue(null);

        const persistence = require('../../media/resultPanel/grid/persistence.js');
        persistence.getSavedStateFor.mockReturnValue(null);
        persistence.findScrollStateBySource.mockReturnValue(null);

        const { switchToResultSet } = require('../../media/resultPanel/tabs.js');
        switchToResultSet(0);

        // scrollTop should stay 0 — no crash
        expect(mockWrappers[0].scrollTop).toBe(0);
    });
});

export {};
