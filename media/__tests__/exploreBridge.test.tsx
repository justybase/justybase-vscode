import * as bridge from '../resultPanel/explore/hostBridge.js';
import { postHostMessage } from '../resultPanel/protocol.js';
import { getActiveSourceUri } from '../resultPanel/types.js';

jest.mock('../resultPanel/protocol.js', () => ({ postHostMessage: jest.fn() }));
jest.mock('../resultPanel/types.js', () => ({ getActiveSourceUri: jest.fn(() => 'file:///source.sql'), getResultSetAt: () => ({ resultSetId: 'stable-owner' }) }));
jest.mock('../resultPanel/state.js', () => ({ getActiveGridIndex: () => 2 }));
const filters = { dimensions: [], dates: [], measures: [] };
const last = () => jest.mocked(postHostMessage).mock.calls.at(-1)![0] as { requestId: number; command: string };
const reply = (result: Record<string, unknown>, command = 'exploreOperationResult') => bridge.handleExploreHostMessage({ command, requestId: last().requestId, result, ...result });

describe('Explore owned request bridge', () => {
    beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); jest.mocked(getActiveSourceUri).mockReturnValue('file:///source.sql'); });
    afterEach(() => { bridge.cancelExploreRequests(); jest.useRealTimers(); });
    it('captures stable owner and settles a database result exactly once', async () => {
        const pending = bridge.requestExploreOperation({ kind: 'rows', filters });
        expect(postHostMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'requestExploreOperation', sourceUri: 'file:///source.sql', resultSetIndex: 2, resultSetId: 'stable-owner' }));
        const requestId = last().requestId;
        reply({ rows: [[1]], sql: 'SELECT details' });
        await expect(pending).resolves.toMatchObject({ rows: [[1]] });
        bridge.handleExploreHostMessage({ command: 'exploreOperationResult', requestId, error: 'late duplicate' });
        jest.advanceTimersByTime(400000); expect(postHostMessage).toHaveBeenCalledTimes(1);
    });
    it('cancels only owned requests and rejects late replies after replacement', async () => {
        const pending = bridge.requestExploreOperation({ kind: 'rows', filters }); const requestId = last().requestId;
        const assertion = expect(pending).rejects.toThrow('Cancelled'); bridge.cancelExploreRequests(); await assertion;
        expect(postHostMessage).toHaveBeenLastCalledWith({ command: 'cancelExploreOperation', requestId });
        bridge.handleExploreHostMessage({ command: 'exploreOperationResult', requestId, result: { rows: [[99]] } });
    });
    it('cancels the host operation on timeout and reports execution errors', async () => {
        const pending = bridge.requestExploreOperation({ kind: 'rows', filters });
        const assertion = expect(pending).rejects.toThrow('timed out'); jest.advanceTimersByTime(302001); await assertion;
        expect(last().command).toBe('cancelExploreOperation');
        const failed = bridge.requestExploreOperation({ kind: 'rows', filters }); const failure = expect(failed).rejects.toThrow('Database failed');
        bridge.handleExploreHostMessage({ command: 'exploreOperationResult', requestId: last().requestId, error: 'Database failed' }); await failure;
    });
    it('adapts statistics, pivot and composer replies while retaining preview-only behavior', async () => {
        const stats = bridge.requestExploreFullStats(1, filters); reply({ values: { sum: 10 }, sql: 'SELECT stats' }); await expect(stats).resolves.toMatchObject({ values: { sum: 10 } });
        const pivot = { rowColumnIndexes: [0], columnColumnIndex: 0, valueColumnIndex: 1, aggFn: 'sum' as const };
        const pivotPending = bridge.requestExplorePivot(pivot); reply({ rows: [['A', 1]], sql: 'SELECT pivot' }); await expect(pivotPending).resolves.toMatchObject({ totalRows: 1 });
        const pivotSql = bridge.previewExplorePivot(pivot, ['A']); expect(postHostMessage).toHaveBeenLastCalledWith(expect.objectContaining({ preview: true })); reply({ sql: 'SELECT preview' }); await expect(pivotSql).resolves.toBe('SELECT preview');
        const composer = { dateColumnIndex: 0, measureColumnIndex: 1, grain: 'month' as const, aggFn: 'sum' as const, comparePrevious: false };
        const time = bridge.requestExploreComposer(composer); reply({ rows: [], columnIndexes: { bucket: 0, measure: 1 }, sql: 'SELECT time' }); await expect(time).resolves.toMatchObject({ sql: 'SELECT time' });
        const invalid = bridge.requestExploreComposer(composer); reply({ rows: [] }); await expect(invalid).rejects.toThrow('Missing');
        const timeSql = bridge.previewExploreComposer(composer); reply({ sql: 'SELECT time preview' }); await expect(timeSql).resolves.toBe('SELECT time preview');
        const filterSql = bridge.previewExploreFilteredSql(filters); reply({ sql: 'SELECT filtered' }, 'exploreFilteredSqlPreviewResult'); await expect(filterSql).resolves.toBe('SELECT filtered');
        bridge.openExploreSqlInEditor('SELECT only', 'Details'); expect(postHostMessage).toHaveBeenLastCalledWith({ command: 'openExploreSqlInEditor', sql: 'SELECT only', label: 'Details' });
    });
    it('rejects requests without an active source and ignores unrelated messages', () => {
        jest.mocked(getActiveSourceUri).mockReturnValue(undefined);
        expect(() => bridge.requestExploreOperation({ kind: 'rows', filters })).toThrow('No active source');
        expect(() => bridge.handleExploreHostMessage({ command: 'unrelated' })).not.toThrow();
    });
});
