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
    appendLogRows: jest.fn(),
    replaceLogRows: jest.fn()
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
    applyScrollForResultSet: jest.fn(),
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

    it('hydrates the host completion marker so an executing source remains finalizing', () => {
        const { handleHydrate, inferExecutionState } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
            inferExecutionState: () => string;
        };
        const win = window as any;

        handleHydrate({
            ...buildHydrateData([sourceUri]),
            streamingCompletedSourcesJson: JSON.stringify([sourceUri]),
        });

        expect(win.streamingCompletedSources.has(sourceUri)).toBe(true);
        expect(inferExecutionState()).toBe('finalizing');
    });

    it('applies hydrate when dataVersion changes but payload size matches', () => {
        const { handleHydrate } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
        };

        handleHydrate({
            ...buildHydrateData([]),
            dataVersion: 1,
        });
        mockUpdateLoadingState.mockClear();

        handleHydrate({
            ...buildHydrateData([]),
            dataVersion: 2,
        });

        expect(mockUpdateLoadingState).toHaveBeenCalled();
    });

    it('applies an authoritative recovery hydrate even when the ordinary fingerprint matches', () => {
        const { handleHydrate } = require('../../media/resultPanel/messages.js') as {
            handleHydrate: (data: Record<string, unknown>) => void;
        };

        handleHydrate({
            ...buildHydrateData([]),
            dataVersion: 4,
            resultSyncVersion: 0,
        });
        mockUpdateLoadingState.mockClear();

        handleHydrate({
            ...buildHydrateData([]),
            dataVersion: 4,
            resultSyncVersion: 1,
        });

        expect(mockUpdateLoadingState).toHaveBeenCalled();
    });

    it('requests authoritative state instead of dropping data when the Logs shell is missing', () => {
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        protocol.postHostMessage.mockClear();
        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[42]],
            totalRows: 1,
            isFirstChunk: true,
            isLastChunk: true,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });

        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri,
            reason: 'missing-log-shell-before-data',
        });
        expect((window as any).resultSets).toEqual([]);
    });

    it('also requests recovery when the first data append incorrectly targets index zero', () => {
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        const { handleAppendRows, getResultSyncPendingRequestCount } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
            getResultSyncPendingRequestCount: () => number;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 0,
            rows: [[42]],
            totalRows: 1,
            isFirstChunk: true,
            isLastChunk: true,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });

        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri,
            reason: 'missing-log-shell-before-data',
        });
        expect(getResultSyncPendingRequestCount()).toBe(1);
        expect((window as any).resultSets).toEqual([]);
    });

    it('forgets pending source recovery when the source is removed from the active list', () => {
        const { handleAppendRows, handleSetActiveSource, getResultSyncPendingRequestCount } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
            handleSetActiveSource: (message: Record<string, unknown>) => void;
            getResultSyncPendingRequestCount: () => number;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[42]],
            totalRows: 1,
            isFirstChunk: true,
            isLastChunk: true,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });
        expect(getResultSyncPendingRequestCount()).toBe(1);

        handleSetActiveSource({
            sourceUri: 'untitled:Untitled-2',
            sourcesJson: JSON.stringify(['untitled:Untitled-2']),
        });

        expect(getResultSyncPendingRequestCount()).toBe(0);
    });

    it('allows a recovery request to be retried after the source changes', () => {
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        const { handleAppendRows, handleSetActiveSource } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
            handleSetActiveSource: (message: Record<string, unknown>) => void;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[42]],
            totalRows: 1,
            isFirstChunk: true,
            isLastChunk: true,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });
        protocol.postHostMessage.mockClear();

        handleSetActiveSource({ sourceUri: 'untitled:Untitled-2' });
        handleSetActiveSource({ sourceUri });
        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[43]],
            totalRows: 1,
            isFirstChunk: true,
            isLastChunk: true,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 43',
            executionTimestamp: 21,
        });

        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri,
            reason: 'missing-log-shell-before-data',
        });
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

    it('requests a log resync when an incremental row arrives with a gap', () => {
        const win = window as any;
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [['10:00', 'existing']],
            executionTimestamp: 9,
            isLog: true,
            name: 'Logs',
        }];
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 0,
            rows: [['10:01', 'missing predecessor']],
            fromRow: 3,
            totalRows: 4,
            logExecutionTimestamp: 9,
            isLog: true,
            isLastChunk: false,
            limitReached: false,
        });

        expect(win.resultSets[0].data).toHaveLength(1);
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestLogSync',
            sourceUri,
            executionTimestamp: 9,
            currentRows: 1,
        });
    });

    it('replaces stale log rows and acknowledges an authoritative execution sync', () => {
        const win = window as any;
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [['10:00', 'old execution']],
            executionTimestamp: 9,
            isLog: true,
            name: 'Logs',
        }];
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        const grid = require('../../media/resultPanel/grid.js') as { replaceLogRows: jest.Mock };
        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };
        const rows = [['10:02', '--- New Execution Started ---'], ['10:02', '▶ RUNNING: SELECT 1']];

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 0,
            rows,
            fromRow: 0,
            totalRows: 2,
            logExecutionTimestamp: 10,
            isLog: true,
            isLastChunk: false,
            limitReached: false,
        });

        expect(win.resultSets[0].data).toEqual(rows);
        expect(win.resultSets[0].executionTimestamp).toBe(10);
        expect(grid.replaceLogRows).toHaveBeenCalledWith(0, rows);
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'logRowsApplied',
            sourceUri,
            executionTimestamp: 10,
            totalRows: 2,
        });
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

    it('does not replace an existing shell when the first chunk is duplicated', () => {
        const win = window as any;
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [['10:00', 'previous']],
            executionTimestamp: 9,
            isLog: true,
            name: 'Logs',
        }, {
            columns: [{ name: 'id', type: 'int' }],
            data: [[1], [2]],
            executionTimestamp: 20,
            resultSetId: 'stream-result-1',
            isLog: false,
            isStreamingComplete: false,
        }];
        win.streamingCompletedSources = new Set([sourceUri]);

        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };
        const existingResultSet = win.resultSets[1];
        const firstChunk = {
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[9], [10]],
            totalRows: 2,
            isFirstChunk: true,
            isLastChunk: false,
            limitReached: false,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT id FROM t',
            executionTimestamp: 21,
            resultSetId: 'stream-result-1',
            chunkSequence: 0,
            fromRow: 0,
        };

        handleAppendRows(firstChunk);
        const acceptedResultSet = win.resultSets[1];
        win.streamingCompletedSources = new Set([sourceUri]);
        handleAppendRows(firstChunk);

        expect(acceptedResultSet).not.toBe(existingResultSet);
        expect(win.resultSets[1]).toBe(acceptedResultSet);
        expect(win.resultSets[1].data).toEqual([[9], [10]]);
        expect(win.streamingCompletedSources.has(sourceUri)).toBe(true);
    });

    it('keeps execution loading when a completion arrives ahead of the stream', () => {
        const win = window as any;
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [],
            executionTimestamp: 9,
            isLog: true,
            name: 'Logs',
        }, {
            columns: [{ name: 'id', type: 'int' }],
            data: [[1], [2]],
            executionTimestamp: 20,
            resultSetId: 'stream-result-1',
            isLog: false,
            isStreamingComplete: false,
        }];

        const { handleAppendRows, handleStreamingComplete, inferExecutionState } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
            handleStreamingComplete: (message: Record<string, unknown>) => void;
            inferExecutionState: () => string;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[3]],
            fromRow: 2,
            totalRows: 3,
            resultSetId: 'stream-result-1',
            chunkSequence: 0,
            isFirstChunk: false,
            isLastChunk: false,
            limitReached: false,
        });
        handleStreamingComplete({
            command: 'streamingComplete',
            sourceUri,
            resultSetIndex: 1,
            totalRows: 4,
            resultSetId: 'stream-result-1',
            lastChunkSequence: 2,
            limitReached: false,
        });

        expect(win.resultSets[1].data).toEqual([[1], [2], [3]]);
        expect(win.resultSets[1].isStreamingComplete).toBe(false);
        expect(win.streamingCompletedSources?.has(sourceUri)).not.toBe(true);
        expect(inferExecutionState()).toBe('loading');
    });

    it('accepts identity-only completion after legacy append messages', () => {
        const win = window as any;
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [],
            executionTimestamp: 9,
            isLog: true,
            name: 'Logs',
        }];

        const { handleAppendRows, handleStreamingComplete, inferExecutionState } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
            handleStreamingComplete: (message: Record<string, unknown>) => void;
            inferExecutionState: () => string;
        };

        handleAppendRows({
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[42]],
            totalRows: 1,
            isFirstChunk: true,
            isLastChunk: true,
            limitReached: false,
            resultSetId: 'legacy-result',
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT 42',
            executionTimestamp: 20,
        });
        handleStreamingComplete({
            command: 'streamingComplete',
            sourceUri,
            resultSetIndex: 1,
            totalRows: 1,
            limitReached: false,
            resultSetId: 'legacy-result',
        });

        expect(win.resultSets[1].data).toEqual([[42]]);
        expect(win.resultSets[1].isStreamingComplete).toBe(true);
        expect(win.streamingCompletedSources.has(sourceUri)).toBe(true);
        expect(inferExecutionState()).toBe('finalizing');
    });

    it('does not apply completion for a result identity that no longer owns the slot', () => {
        const win = window as any;
        const originalRows = [[7]];
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [],
            isLog: true,
            name: 'Logs',
        }, {
            columns: [{ name: 'id', type: 'int' }],
            data: originalRows,
            resultSetId: 'current-result',
            isStreamingComplete: false,
        }];
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        protocol.postHostMessage.mockClear();

        const { handleStreamingComplete, inferExecutionState } = require('../../media/resultPanel/messages.js') as {
            handleStreamingComplete: (message: Record<string, unknown>) => void;
            inferExecutionState: () => string;
        };

        handleStreamingComplete({
            command: 'streamingComplete',
            sourceUri,
            resultSetIndex: 1,
            totalRows: 1,
            limitReached: false,
            resultSetId: 'stale-result',
        });

        expect(win.resultSets[1].data).toBe(originalRows);
        expect(win.resultSets[1].isStreamingComplete).toBe(false);
        expect(win.streamingCompletedSources?.has(sourceUri)).not.toBe(true);
        expect(inferExecutionState()).toBe('loading');
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri,
            reason: 'streaming-complete-result-identity-mismatch',
        });
    });

    it('applies sequenced chunks once and requests one authoritative sync after a gap', () => {
        const win = window as any;
        win.resultSets = [{
            columns: [{ name: 'Time' }, { name: 'Message' }],
            data: [],
            executionTimestamp: 9,
            isLog: true,
            name: 'Logs',
        }];
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        const { handleAppendRows } = require('../../media/resultPanel/messages.js') as {
            handleAppendRows: (message: Record<string, unknown>) => void;
        };
        const first = {
            command: 'appendRows',
            sourceUri,
            resultSetIndex: 1,
            rows: [[1], [2]],
            fromRow: 0,
            totalRows: 2,
            resultSetId: 'stream-result-1',
            chunkSequence: 0,
            isFirstChunk: true,
            isLastChunk: false,
            limitReached: false,
            columns: [{ name: 'id', type: 'int' }],
            sql: 'SELECT id FROM t',
            executionTimestamp: 20,
        };

        handleAppendRows(first);
        handleAppendRows({ ...first, isFirstChunk: false });

        expect(win.resultSets[1].data).toEqual([[1], [2]]);
        protocol.postHostMessage.mockClear();

        handleAppendRows({
            ...first,
            rows: [[5], [6]],
            fromRow: 4,
            totalRows: 6,
            chunkSequence: 2,
            isFirstChunk: false,
        });
        handleAppendRows({
            ...first,
            rows: [[7], [8]],
            fromRow: 6,
            totalRows: 8,
            chunkSequence: 3,
            isFirstChunk: false,
        });

        expect(win.resultSets[1].data).toEqual([[1], [2]]);
        expect(protocol.postHostMessage).toHaveBeenCalledTimes(1);
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri,
            reason: 'out-of-order-chunk',
        });
    });
});
