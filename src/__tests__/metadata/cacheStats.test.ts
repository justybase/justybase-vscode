import { CacheStatsTracker } from '../../metadata/cacheStats';
import { Logger } from '../../utils/logger';

jest.mock('../../utils/logger', () => ({
    Logger: {
        getInstance: jest.fn(() => ({ warn: jest.fn() })),
    },
}));

describe('CacheStatsTracker live query counters', () => {
    it('records live catalog fallbacks by source', () => {
        const tracker = new CacheStatsTracker();
        tracker.recordLiveQuery('CONN', 'schema-tree');
        tracker.recordLiveQuery('CONN', 'schema-tree');
        tracker.recordLiveQuery('CONN', 'completion');

        const snapshot = tracker.getSnapshot('CONN', 0);
        expect(snapshot?.liveQueries).toEqual({ 'schema-tree': 2, completion: 1 });
        expect(snapshot?.lastLiveQueryAt).toEqual(expect.any(Number));
    });

    it('warns once the rolling ten-minute window exceeds the threshold', () => {
        const warn = jest.fn();
        (Logger.getInstance as jest.Mock).mockReturnValue({ warn });
        const tracker = new CacheStatsTracker();

        for (let index = 0; index < 21; index += 1) {
            tracker.recordLiveQuery('CONN', 'schema-tree');
        }

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('live catalog queries'));
    });

    it('resets live query counters with the connection stats', () => {
        const tracker = new CacheStatsTracker();
        tracker.recordLiveQuery('CONN', 'schema-tree');
        tracker.clearConnection('CONN');

        expect(tracker.getSnapshot('CONN', 0)).toBeUndefined();
    });
});
