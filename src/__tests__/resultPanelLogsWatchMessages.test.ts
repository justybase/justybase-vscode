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
    postHostMessage: jest.fn(),
    asHostMessage: jest.fn((message: unknown) => message),
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    saveCurrentSourceToCache: jest.fn(),
    getCachedSource: jest.fn(),
    saveScrollStateToCache: jest.fn(),
    getScrollStateFromGlobalCache: jest.fn(),
    setActiveGridIndex: jest.fn(),
    getActiveGridIndex: jest.fn(() => 0),
    getAllGrids: jest.fn(() => [{}, {}]),
    getGrid: jest.fn(() => undefined),
    getAggregationState: jest.fn(() => ({})),
    setAggregationState: jest.fn(),
    getResultFormattingPayload: jest.fn(() => null),
    setResultFormattingPayload: jest.fn(),
    normalizeResultSetsEditability: jest.fn(),
    resetEditSession: jest.fn(),
    releaseResultSetRows: jest.fn(),
    pruneSourceResultsCache: jest.fn(),
    evictSourceCacheNotInList: jest.fn(),
}));

jest.mock('../../media/resultPanel/utils.js', () => ({
    formatCellValue: jest.fn((value: unknown) => String(value)),
    showError: jest.fn(),
    debounce: jest.fn((fn: (...args: unknown[]) => unknown) => fn)
}));

jest.mock('../../media/resultPanel/tabs.js', () => ({
    renderDocIndicator: jest.fn(),
    renderResultSetTabs: jest.fn(),
    switchToResultSet: jest.fn(),
    updateLogsTabSpinner: jest.fn(),
    shouldPreserveLogsTab: jest.fn(() => false),
    setUserWatchingLogs: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: jest.fn(),
    updateLoadingState: jest.fn(),
    appendLogRows: jest.fn(),
    replaceLogRows: jest.fn(),
    updateControlsVisibility: jest.fn(),
    syncGlobalFilterInput: jest.fn(),
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

jest.mock('../../media/resultPanel/refreshFailureBanner.js', () => ({
    updateRefreshFailureBanner: jest.fn(),
    updateAllRefreshFailureBanners: jest.fn(),
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
    applyScrollForResultSet: jest.fn(),
    setPreserveScrollDuringHydrate: jest.fn(),
    getGridWrapperForResultSet: jest.fn(() => undefined),
    getScrollTarget: jest.fn(() => undefined),
}));

describe('result panel Logs-watch wiring', () => {
    const sourceUri = 'untitled:Untitled-1';
    const sharedPayload = new Uint8Array([1, 2, 3, 4]);
    const logResultSet = {
        columns: [{ name: 'Time' }, { name: 'Message' }],
        data: [],
        executionTimestamp: 9,
        isLog: true,
        name: 'Logs',
    };
    const messageHandlers: Record<string, (event: unknown) => void> = {};

    function tabsMock() {
        return require('../../media/resultPanel/tabs.js') as {
            renderResultSetTabs: jest.Mock;
            switchToResultSet: jest.Mock;
            shouldPreserveLogsTab: jest.Mock;
            setUserWatchingLogs: jest.Mock;
        };
    }

    function stateMock() {
        return require('../../media/resultPanel/state.js') as {
            setActiveGridIndex: jest.Mock;
            getActiveGridIndex: jest.Mock;
            getAllGrids: jest.Mock;
        };
    }

    function gridMock() {
        return require('../../media/resultPanel/grid.js') as { updateControlsVisibility: jest.Mock };
    }

    beforeEach(() => {
        jest.resetModules();
        for (const key of Object.keys(messageHandlers)) {
            delete messageHandlers[key];
        }

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: sourceUri,
                executingSources: new Set([sourceUri]),
                resultSets: [{ ...logResultSet }],
                sources: [sourceUri],
                pinnedSources: new Set([sourceUri]),
                pinnedResults: [],
                addEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
                    messageHandlers[type] = handler;
                }),
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
                getElementById: jest.fn((id: string) =>
                    id === 'gridContainer' ? { querySelectorAll: jest.fn(() => [{}, {}]) } : null),
                querySelectorAll: jest.fn(() => []),
                body: { classList: { contains: jest.fn(() => false) } },
            }
        });

        Object.defineProperty(global, 'performance', {
            configurable: true,
            writable: true,
            value: { now: () => 0 }
        });
    });

    function buildHydrateData() {
        return {
            activeSourceJson: JSON.stringify(sourceUri),
            activeResultSetIndex: 1,
            resultSetsMsgPack: sharedPayload,
            executingSourcesJson: JSON.stringify([]),
            sourcesJson: JSON.stringify([sourceUri]),
            pinnedSourcesJson: JSON.stringify([sourceUri]),
            pinnedResultsJson: JSON.stringify([]),
            dataVersion: 7,
            resultSyncVersion: 0,
        };
    }

    it('renders a new streaming tab in the background while Logs is watched', () => {
        const tabs = tabsMock();
        const state = stateMock();
        tabs.shouldPreserveLogsTab.mockReturnValue(true);
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
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });

        // The shell is created and tabs re-render, but the Logs selection stays.
        expect((window as any).resultSets).toHaveLength(2);
        expect(state.setActiveGridIndex).not.toHaveBeenCalled();
        expect(tabs.renderResultSetTabs).toHaveBeenCalled();
    });

    it('auto-selects a new streaming tab when Logs is not watched', () => {
        const tabs = tabsMock();
        const state = stateMock();
        tabs.shouldPreserveLogsTab.mockReturnValue(false);
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
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });

        expect(state.setActiveGridIndex).toHaveBeenCalledWith(1);
    });

    it('keeps the Logs tab on hydrate while it is watched', () => {
        const tabs = tabsMock();
        tabs.shouldPreserveLogsTab.mockReturnValue(true);
        const grid = gridMock();
        const { handleHydrate } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
        };

        handleHydrate(buildHydrateData());

        expect(tabs.switchToResultSet).not.toHaveBeenCalled();
        expect(grid.updateControlsVisibility).toHaveBeenCalled();
        expect(tabs.renderResultSetTabs).toHaveBeenCalled();
    });

    it('follows the host selection on hydrate when Logs is not watched', () => {
        const tabs = tabsMock();
        tabs.shouldPreserveLogsTab.mockReturnValue(false);
        const { handleHydrate } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
        };

        handleHydrate(buildHydrateData());

        expect(tabs.switchToResultSet).toHaveBeenCalled();
    });

    it('keeps the Logs tab on lightweight source refresh while it is watched', () => {
        const tabs = tabsMock();
        const state = stateMock();
        (window as any).resultSets = [{ ...logResultSet }, {
            columns: [{ name: 'id', type: 'int' }],
            data: [[1]],
            executionTimestamp: 20,
            isLog: false,
            name: 'Result 1',
        }];
        tabs.shouldPreserveLogsTab.mockReturnValue(true);
        const { handleSetActiveSource } = require('../../media/resultPanel/messages.js') as {
            handleSetActiveSource: (message: Record<string, unknown>) => void;
        };

        handleSetActiveSource({
            sourceUri,
            activeResultSetIndex: 1,
            sourcesJson: JSON.stringify([sourceUri]),
            pinnedSourcesJson: JSON.stringify([sourceUri]),
            executingSourcesJson: JSON.stringify([sourceUri]),
        });

        expect(state.setActiveGridIndex).not.toHaveBeenCalledWith(1);
        expect(tabs.switchToResultSet).not.toHaveBeenCalled();
    });

    it('treats an explicit host tab instruction as a Logs-watch selection', () => {
        const tabs = tabsMock();
        const messages = require('../../media/resultPanel/messages.js') as {
            setupStreamingMessageHandler: () => void;
        };
        messages.setupStreamingMessageHandler();
        const dispatch = messageHandlers['message'];
        expect(typeof dispatch).toBe('function');

        dispatch({ data: { command: 'switchToResultSet', resultSetIndex: 0 } });
        expect(tabs.setUserWatchingLogs).toHaveBeenCalledWith(true);

        dispatch({ data: { command: 'switchToResultSet', resultSetIndex: 1 } });
        expect(tabs.setUserWatchingLogs).toHaveBeenCalledWith(false);
    });
});
