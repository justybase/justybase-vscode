import { describe, expect, it, jest, beforeEach } from '@jest/globals';

interface MockDiskResultSet {
    resultSetId?: string;
    columns: Array<{ name: string; type: string }>;
    data: unknown[][];
    storageMode: 'sqlite';
    totalRowCount: number;
    limitReached: boolean;
    diskWindowStart?: number;
    diskFilteredCount?: number;
}

const mockResultSet: MockDiskResultSet = {
    columns: [{ name: 'id', type: 'INTEGER' }],
    data: [],
    storageMode: 'sqlite',
    totalRowCount: 700_000,
    limitReached: false,
};

let mockActiveSource = 'file:///large-result.sql';
const mockSyncDiskStreamingRowCount = jest.fn((resultSet: MockDiskResultSet, totalRows: number) => {
    resultSet.totalRowCount = totalRows;
    resultSet.diskFilteredCount = totalRows;
});

const mockWrapper = {
    scrollTop: 12_345,
    scrollLeft: 67,
} as unknown as HTMLElement;

const mockGrid = {
    tanTable: { options: { data: [] as unknown[][] } },
    render: jest.fn(() => {
        mockWrapper.scrollTop = 0;
        mockWrapper.scrollLeft = 0;
    }),
    scrollToIndex: jest.fn(),
};

jest.mock('../../media/resultPanel/protocol.js', () => ({
    postHostMessage: jest.fn(),
}));

jest.mock('../../media/resultPanel/searchWorkerBridge.js', () => ({
    clearAllSearchWorkerData: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid.js', () => ({
    renderGrids: jest.fn(),
}));

jest.mock('../../media/resultPanel/filter.js', () => ({
    updateRowCountInfo: jest.fn(),
}));

jest.mock('../../media/resultPanel/state.js', () => ({
    getGrid: jest.fn(() => mockGrid),
    getSortedSearchMatchIndices: jest.fn(() => []),
    resetEditSession: jest.fn(),
}));

jest.mock('../../media/resultPanel/grid/persistence.js', () => ({
    getGridWrapperForResultSet: jest.fn(() => mockWrapper),
    getScrollTarget: jest.fn(() => mockWrapper),
}));

jest.mock('../../media/resultPanel/diskQuerySpec.js', () => ({
    diskQueryChangesRowCount: jest.fn(() => false),
    getDiskFilteredCount: jest.fn((rs: { diskFilteredCount?: number; totalRowCount?: number } | undefined) =>
        rs?.diskFilteredCount ?? rs?.totalRowCount ?? 0
    ),
    getDiskQuerySpec: jest.fn(() => undefined),
    syncDiskQuerySpecFromGrid: jest.fn(() => undefined),
    syncDiskStreamingRowCount: mockSyncDiskStreamingRowCount,
}));

jest.mock('../../media/resultPanel/diskQueryUtils.js', () => ({
    diskQuerySpecIsActive: jest.fn(() => false),
}));

jest.mock('../../media/resultPanel/types.js', () => ({
    getActiveSourceUri: jest.fn(() => mockActiveSource),
    callPanelMethod: jest.fn(),
    getResultSetAt: jest.fn(() => mockResultSet),
    getResultSets: jest.fn(() => [mockResultSet]),
    setResultSets: jest.fn(),
}));

describe('diskBackedGrid row window scroll preservation', () => {
    beforeEach(() => {
        mockResultSet.data = [];
        mockResultSet.totalRowCount = 700_000;
        mockResultSet.resultSetId = undefined;
        mockActiveSource = 'file:///large-result.sql';
        mockWrapper.scrollTop = 12_345;
        mockWrapper.scrollLeft = 67;
        mockGrid.tanTable.options.data = [];
        mockGrid.render.mockClear();
        mockGrid.scrollToIndex.mockClear();
        mockSyncDiskStreamingRowCount.mockClear();
    });

    it('preserves active pixel scroll position when a SQLite window is applied', () => {
        const { handleRowWindow } = require('../../media/resultPanel/diskBackedGrid.js') as {
            handleRowWindow: (message: Record<string, unknown>) => void;
        };

        handleRowWindow({
            command: 'rowWindow',
            resultSetIndex: 0,
            offset: 50_000,
            rows: [[50_001], [50_002]],
            totalRows: 700_000,
        });

        expect(mockResultSet.data).toEqual([[50_001], [50_002]]);
        expect(mockResultSet.diskWindowStart).toBe(50_000);
        expect(mockGrid.render).toHaveBeenCalledTimes(1);
        expect(mockGrid.scrollToIndex).not.toHaveBeenCalled();
        expect(mockWrapper.scrollTop).toBe(12_345);
        expect(mockWrapper.scrollLeft).toBe(67);
    });

    it('uses a larger SQLite window and prefetch margin', () => {
        const diskBackedGrid = require('../../media/resultPanel/diskBackedGrid.js') as {
            DISK_WINDOW_ROWS: number;
            DISK_PAGE_SIZE: number;
        };

        expect(diskBackedGrid.DISK_WINDOW_ROWS).toBe(2_000);
        expect(diskBackedGrid.DISK_PAGE_SIZE).toBe(800);
    });

    it('preserves the stable result identity when disk activation arrives', () => {
        mockResultSet.resultSetId = 'stable-result-1';
        const { handleDiskBackedActivate } = require('../../media/resultPanel/diskBackedGrid.js') as {
            handleDiskBackedActivate: (message: Record<string, unknown>) => void;
        };

        handleDiskBackedActivate({
            command: 'diskBackedActivate',
            sourceUri: mockActiveSource,
            resultSetIndex: 0,
            resultSetId: 'stable-result-1',
            totalRows: 700_000,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1]],
            limitReached: false,
        });

        expect(mockResultSet.resultSetId).toBe('stable-result-1');
        expect(mockResultSet.data).toEqual([[1]]);
    });

    it('accepts a new activation identity for a legacy result shell', () => {
        const originalRows = [[7]];
        mockResultSet.data = originalRows;
        const { handleDiskBackedActivate } = require('../../media/resultPanel/diskBackedGrid.js') as {
            handleDiskBackedActivate: (message: Record<string, unknown>) => void;
        };

        handleDiskBackedActivate({
            command: 'diskBackedActivate',
            sourceUri: mockActiveSource,
            resultSetIndex: 0,
            resultSetId: 'new-result',
            totalRows: 700_000,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[1]],
            limitReached: false,
        });

        expect(mockResultSet.resultSetId).toBe('new-result');
        expect(mockResultSet.data).toEqual([[1]]);
    });

    it('rejects a same-source activation for a result that no longer owns the slot', () => {
        mockResultSet.resultSetId = 'current-result';
        const originalRows = [[7]];
        mockResultSet.data = originalRows;
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        protocol.postHostMessage.mockClear();
        const { handleDiskBackedActivate } = require('../../media/resultPanel/diskBackedGrid.js') as {
            handleDiskBackedActivate: (message: Record<string, unknown>) => void;
        };

        handleDiskBackedActivate({
            command: 'diskBackedActivate',
            sourceUri: mockActiveSource,
            resultSetIndex: 0,
            resultSetId: 'stale-result',
            totalRows: 700_000,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[99]],
            limitReached: false,
        });

        expect(mockResultSet.resultSetId).toBe('current-result');
        expect(mockResultSet.data).toBe(originalRows);
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri: mockActiveSource,
            reason: 'disk-backed-activation-result-mismatch',
        });
        expect(mockGrid.render).not.toHaveBeenCalled();
    });

    it('rejects a stale row-count update for a result that no longer owns the slot', () => {
        mockResultSet.resultSetId = 'current-result';
        mockResultSet.totalRowCount = 12;
        const protocol = require('../../media/resultPanel/protocol.js') as { postHostMessage: jest.Mock };
        protocol.postHostMessage.mockClear();
        const { handleRowCountUpdate } = require('../../media/resultPanel/diskBackedGrid.js') as {
            handleRowCountUpdate: (message: Record<string, unknown>) => void;
        };

        handleRowCountUpdate({
            command: 'rowCountUpdate',
            sourceUri: mockActiveSource,
            resultSetIndex: 0,
            resultSetId: 'stale-result',
            totalRows: 700_000,
            limitReached: true,
        });

        expect(mockResultSet.totalRowCount).toBe(12);
        expect(mockResultSet.limitReached).toBe(false);
        expect(mockSyncDiskStreamingRowCount).not.toHaveBeenCalled();
        expect(protocol.postHostMessage).toHaveBeenCalledWith({
            command: 'requestResultSync',
            sourceUri: mockActiveSource,
            reason: 'row-count-update-result-identity-mismatch',
        });
    });

    it('ignores delayed disk messages for a source that is no longer active', () => {
        const originalRows = [[7]];
        mockResultSet.data = originalRows;
        mockResultSet.totalRowCount = 7;
        mockActiveSource = 'file:///other-result.sql';
        const { handleDiskBackedActivate, handleRowCountUpdate } = require('../../media/resultPanel/diskBackedGrid.js') as {
            handleDiskBackedActivate: (message: Record<string, unknown>) => void;
            handleRowCountUpdate: (message: Record<string, unknown>) => void;
        };

        handleDiskBackedActivate({
            command: 'diskBackedActivate',
            sourceUri: 'file:///large-result.sql',
            resultSetIndex: 0,
            resultSetId: 'stale-result',
            totalRows: 700_000,
            columns: [{ name: 'id', type: 'INTEGER' }],
            rows: [[99]],
            limitReached: false,
        });
        handleRowCountUpdate({
            command: 'rowCountUpdate',
            sourceUri: 'file:///large-result.sql',
            resultSetIndex: 0,
            totalRows: 700_000,
            limitReached: true,
        });

        expect(mockResultSet.data).toBe(originalRows);
        expect(mockResultSet.totalRowCount).toBe(7);
        expect(mockResultSet.limitReached).toBe(false);
    });
});
