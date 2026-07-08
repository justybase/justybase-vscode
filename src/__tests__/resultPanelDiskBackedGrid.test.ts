import { describe, expect, it, jest, beforeEach } from '@jest/globals';

interface MockDiskResultSet {
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
    syncDiskStreamingRowCount: jest.fn(),
}));

jest.mock('../../media/resultPanel/diskQueryUtils.js', () => ({
    diskQuerySpecIsActive: jest.fn(() => false),
}));

jest.mock('../../media/resultPanel/types.js', () => ({
    getActiveSourceUri: jest.fn(() => 'file:///large-result.sql'),
    callPanelMethod: jest.fn(),
    getResultSetAt: jest.fn(() => mockResultSet),
    getResultSets: jest.fn(() => [mockResultSet]),
    setResultSets: jest.fn(),
}));

describe('diskBackedGrid row window scroll preservation', () => {
    beforeEach(() => {
        mockResultSet.data = [];
        mockResultSet.totalRowCount = 700_000;
        mockWrapper.scrollTop = 12_345;
        mockWrapper.scrollLeft = 67;
        mockGrid.tanTable.options.data = [];
        mockGrid.render.mockClear();
        mockGrid.scrollToIndex.mockClear();
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
});
