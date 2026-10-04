/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('../../media/resultPanel/state.js', () => ({
    setActiveGridIndex: jest.fn(),
    getActiveGridIndex: jest.fn(() => 1),
    getAllGrids: jest.fn(() => [{}, {}]),
    getGrid: jest.fn(() => undefined),
    resetEditSession: jest.fn(),
}));

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid/persistence.js', () => ({
    saveAllGridStates: jest.fn(),
    getGridWrapperForResultSet: jest.fn(() => undefined),
    applyScrollForResultSet: jest.fn(),
}));

jest.mock('../../media/resultPanel/banners.js', () => ({
    updateResultLimitBanner: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    updateControlsVisibility: jest.fn(),
    syncGlobalFilterInput: jest.fn(),
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    renderRowCountInfo: jest.fn(),
}));

jest.mock('../../media/resultPanel/analysis.js', () => ({
    syncAnalysisView: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid/alternateViews.js', () => ({
    extractKeyNetezzaErrorInfo: jest.fn((message: unknown) => String(message)),
}));

jest.mock('../../media/resultPanel/refreshFailureBanner.js', () => ({
    updateRefreshFailureBanner: jest.fn(),
    updateAllRefreshFailureBanners: jest.fn(),
}));

describe('result panel Logs-watch flag', () => {
    const sourceUri = 'untitled:Untitled-1';
    const logResultSet = {
        columns: [{ name: 'Time' }, { name: 'Message' }],
        data: [],
        executionTimestamp: 9,
        isLog: true,
        name: 'Logs',
    };
    const dataResultSet = {
        columns: [{ name: 'id', type: 'int' }],
        data: [[1]],
        executionTimestamp: 20,
        isLog: false,
        name: 'Result 1',
    };

    beforeEach(() => {
        jest.resetModules();
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        protocol.postHostMessage.mockClear();
        const state = require('../../media/resultPanel/state.js') as {
            getActiveGridIndex: jest.Mock;
            setActiveGridIndex: jest.Mock;
            getAllGrids: jest.Mock;
        };
        state.getActiveGridIndex.mockReset();
        state.getActiveGridIndex.mockReturnValue(1);
        state.setActiveGridIndex.mockClear();
        state.getAllGrids.mockReturnValue([{}, {}]);

        Object.defineProperty(global, 'window', {
            configurable: true,
            writable: true,
            value: {
                activeSource: sourceUri,
                executingSources: new Set([sourceUri]),
                resultSets: [logResultSet, dataResultSet],
                sources: [sourceUri],
                pinnedSources: new Set([sourceUri]),
                pinnedResults: [],
            }
        });

        Object.defineProperty(global, 'document', {
            configurable: true,
            writable: true,
            value: {
                getElementById: jest.fn(() => null),
                querySelectorAll: jest.fn(() => []),
                body: { classList: { contains: jest.fn(() => false) } },
            }
        });
    });

    it('marks Logs-watch when the user explicitly selects the Logs tab', () => {
        const tabs = require('../../media/resultPanel/tabs.js') as {
            switchToResultSet: (index: number) => void;
            isUserWatchingLogs: () => boolean;
        };
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };

        expect(tabs.isUserWatchingLogs()).toBe(false);
        tabs.switchToResultSet(0);

        expect(tabs.isUserWatchingLogs()).toBe(true);
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'switchResultSet',
            sourceUri,
            resultSetIndex: 0,
        });
    });

    it('clears Logs-watch when the user selects a data tab', () => {
        const tabs = require('../../media/resultPanel/tabs.js') as {
            switchToResultSet: (index: number) => void;
            isUserWatchingLogs: () => boolean;
        };

        tabs.switchToResultSet(0);
        expect(tabs.isUserWatchingLogs()).toBe(true);

        tabs.switchToResultSet(1);
        expect(tabs.isUserWatchingLogs()).toBe(false);
    });

    it('ignores programmatic switches for Logs-watch purposes', () => {
        const tabs = require('../../media/resultPanel/tabs.js') as {
            switchToResultSet: (index: number, skip?: boolean, notify?: boolean) => void;
            isUserWatchingLogs: () => boolean;
            setUserWatchingLogs: (value: boolean) => void;
        };

        tabs.setUserWatchingLogs(true);
        tabs.switchToResultSet(1, false, false);
        expect(tabs.isUserWatchingLogs()).toBe(true);

        tabs.setUserWatchingLogs(false);
        tabs.switchToResultSet(0, false, false);
        expect(tabs.isUserWatchingLogs()).toBe(false);
    });

    it('preserves the Logs tab only while it is explicitly watched and viewed', () => {
        const tabs = require('../../media/resultPanel/tabs.js') as {
            shouldPreserveLogsTab: () => boolean;
            setUserWatchingLogs: (value: boolean) => void;
        };
        const state = require('../../media/resultPanel/state.js') as { getActiveGridIndex: jest.Mock };

        tabs.setUserWatchingLogs(true);
        state.getActiveGridIndex.mockReturnValue(0);
        expect(tabs.shouldPreserveLogsTab()).toBe(true);

        // Watching flag set, but a data tab is viewed (e.g. host moved on):
        // new results must behave normally.
        state.getActiveGridIndex.mockReturnValue(1);
        expect(tabs.shouldPreserveLogsTab()).toBe(false);

        // Not watching at all: never preserve, even on Logs.
        tabs.setUserWatchingLogs(false);
        state.getActiveGridIndex.mockReturnValue(0);
        expect(tabs.shouldPreserveLogsTab()).toBe(false);
    });

    it('does not preserve when there is no Logs tab at the active index', () => {
        const tabs = require('../../media/resultPanel/tabs.js') as {
            shouldPreserveLogsTab: () => boolean;
            setUserWatchingLogs: (value: boolean) => void;
        };
        const state = require('../../media/resultPanel/state.js') as { getActiveGridIndex: jest.Mock };
        (window as any).resultSets = [];

        tabs.setUserWatchingLogs(true);
        state.getActiveGridIndex.mockReturnValue(0);
        expect(tabs.shouldPreserveLogsTab()).toBe(false);
    });
});
