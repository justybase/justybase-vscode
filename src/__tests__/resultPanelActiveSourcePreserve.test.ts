 
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
    getAllGrids: jest.fn(() => [{ tanTable: { options: { data: [[1]] } } }, null]),
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
}));

jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn(),
    showError: jest.fn(),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

const mockRenderResultSetTabs = jest.fn();
const mockUpdateLogsTabSpinner = jest.fn();
jest.mock('../../media/resultPanel/tabs.js', () => ({
    renderDocIndicator: jest.fn(),
    renderResultSetTabs: (...args: unknown[]) => mockRenderResultSetTabs(...args),
    switchToResultSet: jest.fn(),
    updateLogsTabSpinner: (...args: unknown[]) => mockUpdateLogsTabSpinner(...args),
}));

const mockRenderGrids = jest.fn();
const mockUpdateControlsVisibility = jest.fn();
const mockSyncGlobalFilterInput = jest.fn();
jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: (...args: unknown[]) => mockRenderGrids(...args),
    updateLoadingState: jest.fn(),
    appendLogRows: jest.fn(),
    updateControlsVisibility: (...args: unknown[]) => mockUpdateControlsVisibility(...args),
    syncGlobalFilterInput: (...args: unknown[]) => mockSyncGlobalFilterInput(...args),
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    updateRowCountInfo: jest.fn(),
    applyRowLimitReachedFlag: jest.fn(),
    isResultSetRowLimitReached: jest.fn(() => false),
    renderRowCountInfo: jest.fn()
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn()
}));

jest.mock('../../media/resultPanel/banners.js', () => ({
    updateResultLimitBanner: jest.fn()
}));

jest.mock('../../media/resultPanel/searchWorkerBridge.js', () => ({
    clearAllSearchWorkerData: jest.fn()
}));

jest.mock('../../media/resultPanel/diskBackedGrid.js', () => ({
    handleDiskBackedActivate: jest.fn(),
    handleDiskQueryResult: jest.fn(),
    handleRowCountUpdate: jest.fn(),
    handleRowWindow: jest.fn(),
    isDiskBackedResultSet: jest.fn(() => false),
    clearDiskBackedPendingRequests: jest.fn(),
    DISK_BACKED_WEBVIEW_STREAM_CAP: 250000,
    DISK_BACKED_STREAMING_PREVIEW_ROWS: 25000,
}));

jest.mock('../../media/resultPanel/diskGrouping.js', () => ({
    clearAllDiskGrouping: jest.fn()
}));

jest.mock('../../media/resultPanel/grid/persistence.js', () => ({
    saveAllGridStates: jest.fn(),
    getSavedStateFor: jest.fn(),
    findScrollStateBySource: jest.fn(),
    getScrollTarget: jest.fn(),
    getGridWrapperForResultSet: jest.fn(),
    applyScrollForResultSet: jest.fn(),
    savePinnedState: jest.fn(),
    saveScrollStatesToResultSets: jest.fn(),
    restoreScrollFromResultSet: jest.fn(),
    setPreserveScrollDuringHydrate: jest.fn(),
}));

describe('handleSetActiveSource grid preservation', () => {
    const sourceUri = 'untitled:Untitled-1';
    const resultSets = [
        {
            executionTimestamp: 1,
            isLog: true,
            data: [['10:00', 'RUNNING']],
            name: 'Logs',
        },
        {
            executionTimestamp: 2,
            isLog: false,
            data: [[1], [2]],
            name: 'Result 1',
        },
    ];

    beforeEach(() => {
        jest.resetModules();
        mockRenderGrids.mockClear();
        mockRenderResultSetTabs.mockClear();
        mockUpdateLogsTabSpinner.mockClear();
        mockUpdateControlsVisibility.mockClear();
        mockSyncGlobalFilterInput.mockClear();

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: sourceUri,
                resultSets,
                executingSources: new Set<string>(),
                sources: [sourceUri],
                pinnedSources: new Set([sourceUri]),
                pinnedResults: {},
                refreshRowView: jest.fn(),
            },
        });

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn((id: string) => {
                    if (id === 'gridContainer') {
                        return {
                            querySelectorAll: jest.fn(() => [{}, {}]),
                        };
                    }
                    return null;
                }),
                querySelectorAll: jest.fn(() => []),
            },
        });
    });

    it('skips renderGrids when only execution state changes for the active source', () => {
        const state = require('../../media/resultPanel/state.js');
        const searchWorkerBridge = require('../../media/resultPanel/searchWorkerBridge.js');
        const diskBackedGrid = require('../../media/resultPanel/diskBackedGrid.js');
        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        state.getActiveGridIndex.mockReturnValue(1);

        const { handleSetActiveSource } = require('../../media/resultPanel/messages.js');
        handleSetActiveSource({
            command: 'setActiveSource',
            sourceUri,
            activeResultSetIndex: 1,
            executingSourcesJson: JSON.stringify([sourceUri]),
            sourcesJson: JSON.stringify([sourceUri]),
            pinnedSourcesJson: JSON.stringify([sourceUri]),
        });

        expect(mockRenderGrids).not.toHaveBeenCalled();
        expect(mockRenderResultSetTabs).not.toHaveBeenCalled();
        expect(searchWorkerBridge.clearAllSearchWorkerData).not.toHaveBeenCalled();
        expect(diskBackedGrid.clearDiskBackedPendingRequests).not.toHaveBeenCalled();
        expect(diskGrouping.clearAllDiskGrouping).not.toHaveBeenCalled();
        expect(state.resetEditSession).not.toHaveBeenCalled();
        expect(mockUpdateLogsTabSpinner).toHaveBeenCalled();
        expect(mockUpdateControlsVisibility).toHaveBeenCalledWith(1);
        expect(mockSyncGlobalFilterInput).toHaveBeenCalledWith(1);
    });

    it('clears search, disk grouping, and edit state when grids are rebuilt', () => {
        const state = require('../../media/resultPanel/state.js');
        const searchWorkerBridge = require('../../media/resultPanel/searchWorkerBridge.js');
        const diskBackedGrid = require('../../media/resultPanel/diskBackedGrid.js');
        const diskGrouping = require('../../media/resultPanel/diskGrouping.js');
        state.getAllGrids.mockReturnValue([]);

        const { handleSetActiveSource } = require('../../media/resultPanel/messages.js');
        handleSetActiveSource({
            command: 'setActiveSource',
            sourceUri,
            activeResultSetIndex: 0,
            executingSourcesJson: JSON.stringify([]),
            sourcesJson: JSON.stringify([sourceUri]),
            pinnedSourcesJson: JSON.stringify([sourceUri]),
        });

        expect(mockRenderGrids).toHaveBeenCalled();
        expect(searchWorkerBridge.clearAllSearchWorkerData).toHaveBeenCalled();
        expect(diskBackedGrid.clearDiskBackedPendingRequests).toHaveBeenCalled();
        expect(diskGrouping.clearAllDiskGrouping).toHaveBeenCalled();
        expect(state.resetEditSession).toHaveBeenCalled();
    });
});

export {};
