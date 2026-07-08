/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('@msgpack/msgpack', () => ({
    decode: jest.fn(() => [
        {
            columns: [{ name: 'c1', type: 'int' }],
            data: [[1]],
            executionTimestamp: 1,
            isLog: false,
            name: 'Result 1'
        }
    ])
}));

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
    getActiveGridIndex: jest.fn(() => 1),
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
    getLayoutMode: jest.fn(() => 'table'),
    pruneSourceResultsCache: jest.fn(),
    evictSourceCacheNotInList: jest.fn(),
    normalizeResultSetsEditability: jest.fn(),
    resetEditSession: jest.fn(),
    releaseResultSetRows: jest.fn((resultSet: { data?: unknown[] } | undefined) => {
        if (Array.isArray(resultSet?.data)) {
            resultSet.data.length = 0;
        }
    }),
}));

jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn((value: unknown) => String(value)),
    showError: jest.fn(),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

jest.mock('../../media/resultPanel/tabs.js', () => ({
    renderDocIndicator: jest.fn(),
    renderResultSetTabs: jest.fn(),
    switchToResultSet: jest.fn()
}));

const mockUpdateLoadingState = jest.fn();
jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: jest.fn(),
    updateLoadingState: (...args: unknown[]) => mockUpdateLoadingState(...args),
    appendLogRows: jest.fn()
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    updateRowCountInfo: jest.fn(),
    applyRowLimitReachedFlag: jest.fn(),
    isResultSetRowLimitReached: jest.fn(() => false),
    renderRowCountInfo: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn(),
    getActiveResultViewMode: jest.fn(() => 'table')
}));

jest.mock('../../media/resultPanel/banners.js', () => ({
    updateResultLimitBanner: jest.fn()
}));

jest.mock('../../media/resultPanel/searchWorkerBridge.js', () => ({
    clearAllSearchWorkerData: jest.fn()
}));

jest.mock('../../media/resultPanel/grid/persistence.js', () => ({
    saveAllGridStates: jest.fn(),
    getSavedStateFor: jest.fn(),
    findScrollStateBySource: jest.fn(),
    savePinnedState: jest.fn(),
    saveScrollStatesToResultSets: jest.fn(),
    restoreScrollFromResultSet: jest.fn(),
    setPreserveScrollDuringHydrate: jest.fn(),
}));

describe('handleHydrate executingSources dedup', () => {
    const sourceUri = 'untitled:Untitled-1';
    const sharedPayload = new Uint8Array([1, 2, 3, 4]);

    beforeEach(() => {
        jest.resetModules();
        mockUpdateLoadingState.mockClear();

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: sourceUri,
                executingSources: new Set([sourceUri]),
                resultSets: [],
                sources: [sourceUri],
                pinnedSources: new Set([sourceUri]),
                pinnedResults: {},
                requestAnimationFrame: (cb: FrameRequestCallback) => {
                    cb(0);
                    return 0;
                }
            }
        });

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn(() => null),
                querySelectorAll: jest.fn(() => [])
            }
        });

        Object.defineProperty(global, 'performance', {
            configurable: true,
            writable: true,
            value: { now: () => 0 }
        });
    });

    function buildHydrateData(executingSources: string[]) {
        return {
            activeSourceJson: JSON.stringify(sourceUri),
            activeResultSetIndex: 1,
            resultSetsMsgPack: sharedPayload,
            executingSourcesJson: JSON.stringify(executingSources),
            sourcesJson: JSON.stringify([sourceUri]),
            pinnedSourcesJson: JSON.stringify([sourceUri]),
            pinnedResultsJson: JSON.stringify({})
        };
    }

    it('applies hydrate when only executingSources changes but payload fingerprint matches', () => {
        const { handleHydrate } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
        };
        const win = window as any;

        handleHydrate(buildHydrateData([sourceUri]));
        expect(win.executingSources.has(sourceUri)).toBe(true);
        mockUpdateLoadingState.mockClear();

        handleHydrate(buildHydrateData([]));

        expect(win.executingSources.has(sourceUri)).toBe(false);
        expect(mockUpdateLoadingState).toHaveBeenCalled();
    });

    it('replaces stale active result rows on first streaming chunk', () => {
        const staleResult = {
            columns: [{ name: 'old_col', type: 'int' }],
            data: [[1], [2], [3]],
            executionTimestamp: 10,
            isLog: false,
            name: 'Old Result'
        };
        const win = window as any;
        win.resultSets = [
            {
                columns: [{ name: 'Time', type: 'string' }, { name: 'Message', type: 'string' }],
                data: [['10:00', 'previous']],
                executionTimestamp: 9,
                isLog: true,
                name: 'Logs'
            },
            staleResult
        ];

        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[42]],
            totalRows: 1,
            isLastChunk: false,
            limitReached: false,
            isFirstChunk: true,
            columns: [{ name: 'new_col', type: 'int' }],
            sql: 'select 42',
            executionTimestamp: 20
        });

        expect(staleResult.data).toHaveLength(0);
        expect(win.resultSets).toHaveLength(2);
        expect(win.resultSets[1]).not.toBe(staleResult);
        expect(win.resultSets[1]).toEqual(expect.objectContaining({
            columns: [{ name: 'new_col', type: 'int' }],
            data: [[42]],
            executionTimestamp: 20,
            sql: 'select 42'
        }));
    });

    it('refreshes table data with a new array reference for streamed row batches', () => {
        const initialRows = Array.from({ length: 5000 }, (_, index) => [index]);
        const nextRows = Array.from({ length: 10000 }, (_, index) => [index + 5000]);
        const resultSet = {
            columns: [{ name: 'id', type: 'int' }],
            data: initialRows,
            executionTimestamp: 20,
            isLog: false,
            sql: 'select * from t limit 15000'
        };
        const win = window as any;
        win.resultSets = [
            {
                columns: [{ name: 'Time', type: 'string' }, { name: 'Message', type: 'string' }],
                data: [['10:00', 'previous']],
                executionTimestamp: 9,
                isLog: true,
                name: 'Logs'
            },
            resultSet
        ];

        const tableOptions = { data: initialRows };
        const grid = {
            tanTable: { options: tableOptions },
            createVirtualizer: jest.fn(),
            renderTableRows: jest.fn(),
            refreshAutoSizedLayout: jest.fn(() => false)
        };
        const state = require('../../media/resultPanel/state.js') as {
            getGrid: jest.Mock;
        };
        state.getGrid.mockReturnValue(grid);

        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: nextRows,
            totalRows: 15000,
            isLastChunk: true,
            limitReached: false
        });

        expect(resultSet.data).toHaveLength(15000);
        expect(resultSet.data).not.toBe(initialRows);
        expect(tableOptions.data).toBe(resultSet.data);
        expect(tableOptions.data).toHaveLength(15000);
        expect(grid.createVirtualizer).toHaveBeenCalled();
        expect(grid.renderTableRows).toHaveBeenCalled();
    });

    it('releases stale active result rows when hydrate replaces the same source', () => {
        const staleResult = {
            columns: [{ name: 'old_col', type: 'int' }],
            data: [[1], [2], [3]],
            executionTimestamp: 10,
            isLog: false,
            name: 'Old Result'
        };
        const win = window as any;
        win.resultSets = [staleResult];

        const { handleHydrate } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
        };

        handleHydrate(buildHydrateData([]));

        expect(staleResult.data).toHaveLength(0);
        expect(win.resultSets).toHaveLength(1);
        expect(win.resultSets[0]).not.toBe(staleResult);
        expect(win.resultSets[0]).toEqual(expect.objectContaining({
            name: 'Result 1',
            data: [[1]]
        }));
    });
});
