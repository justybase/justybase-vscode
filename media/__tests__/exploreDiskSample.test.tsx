import { fetchRowsFromHost, handleRowWindow, handleDiskQueryResult, clearDiskBackedPendingRequests } from '../resultPanel/diskBackedGrid.js';
import { postHostMessage } from '../resultPanel/protocol.js';
import { getDiskQuerySpec } from '../resultPanel/diskQuerySpec.js';
jest.mock('../resultPanel/protocol.js', () => ({ postHostMessage: jest.fn() }));
jest.mock('../resultPanel/searchWorkerBridge.js', () => ({ clearAllSearchWorkerData: jest.fn() }));
jest.mock('../resultPanel/rowCount.js', () => ({ updateRowCountInfo: jest.fn() }));
jest.mock('../resultPanel/state.js', () => ({ getGrid: jest.fn(), resetEditSession: jest.fn() }));
jest.mock('../resultPanel/grid/persistence.js', () => ({ getGridWrapperForResultSet: jest.fn(), getScrollTarget: jest.fn() }));
jest.mock('../resultPanel/diskQuerySpec.js', () => ({ getDiskQuerySpec: jest.fn(), syncDiskQuerySpecFromGrid: jest.fn() }));
jest.mock('../resultPanel/types.js', () => ({ getActiveSourceUri: () => 'file:///disk.sql', getResultSets: () => [] }));
describe('Explore unfiltered disk sample', () => {
    beforeEach(() => { jest.clearAllMocks(); jest.mocked(getDiskQuerySpec).mockReturnValue({ globalSearch: 'only matching rows' }); });
    afterEach(() => clearDiskBackedPendingRequests());
    it('bypasses grid filters only for the explicit sample fetch', async () => {
        const sample = fetchRowsFromHost('file:///disk.sql', 0, 0, 50000, true);
        const request = jest.mocked(postHostMessage).mock.calls.at(-1)![0] as { requestId: number };
        expect(postHostMessage).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'requestRows', limit: 50000 }));
        handleRowWindow({ requestId: request.requestId, rows: [['unfiltered']] }); await expect(sample).resolves.toEqual([['unfiltered']]);
        const grid = fetchRowsFromHost('file:///disk.sql', 0, 0, 100);
        const filtered = jest.mocked(postHostMessage).mock.calls.at(-1)![0] as { requestId: number };
        expect(postHostMessage).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'diskQuery', querySpec: { globalSearch: 'only matching rows' } }));
        handleDiskQueryResult({ requestId: filtered.requestId, action: 'window', rows: [['filtered']] }); await expect(grid).resolves.toEqual([['filtered']]);
    });
});
