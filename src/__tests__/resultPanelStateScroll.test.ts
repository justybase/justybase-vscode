// Unit tests for state.js scroll persistence functions.
// These are pure functions operating on module-level caches — no DOM or window needed.

describe('state.js scroll persistence', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    describe('saveScrollStateToCache / getScrollStateFromGlobalCache', () => {
        it('saves and retrieves scroll state for a source+rsIndex', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///test.sql', 0, { scrollTop: 150, scrollLeft: 10, timestamp: 1000 });
            const retrieved = state.getScrollStateFromGlobalCache('file:///test.sql', 0);
            expect(retrieved).toEqual({ scrollTop: 150, scrollLeft: 10, timestamp: 1000 });
        });

        it('returns null for unknown source', () => {
            const state = require('../../media/resultPanel/state.js');
            expect(state.getScrollStateFromGlobalCache('file:///unknown.sql', 0)).toBeNull();
        });

        it('returns null for unknown rsIndex on known source', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///test.sql', 0, { scrollTop: 100, scrollLeft: 0, timestamp: 1 });
            expect(state.getScrollStateFromGlobalCache('file:///test.sql', 1)).toBeNull();
        });

        it('preserves separate scroll states for multiple sources', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///a.sql', 0, { scrollTop: 10, scrollLeft: 0, timestamp: 1 });
            state.saveScrollStateToCache('file:///b.sql', 0, { scrollTop: 99, scrollLeft: 5, timestamp: 2 });
            expect(state.getScrollStateFromGlobalCache('file:///a.sql', 0)!.scrollTop).toBe(10);
            expect(state.getScrollStateFromGlobalCache('file:///b.sql', 0)!.scrollTop).toBe(99);
        });

        it('preserves separate scroll states for multiple rsIndex on same source', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///test.sql', 0, { scrollTop: 10, scrollLeft: 0, timestamp: 1 });
            state.saveScrollStateToCache('file:///test.sql', 1, { scrollTop: 200, scrollLeft: 30, timestamp: 1 });
            expect(state.getScrollStateFromGlobalCache('file:///test.sql', 0)!.scrollTop).toBe(10);
            expect(state.getScrollStateFromGlobalCache('file:///test.sql', 1)!.scrollTop).toBe(200);
        });

        it('overwrites existing scroll state for same key', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///test.sql', 0, { scrollTop: 100, scrollLeft: 0, timestamp: 1 });
            state.saveScrollStateToCache('file:///test.sql', 0, { scrollTop: 999, scrollLeft: 50, timestamp: 2 });
            expect(state.getScrollStateFromGlobalCache('file:///test.sql', 0)!.scrollTop).toBe(999);
        });

        it('ignores save when sourceUri is empty', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('', 0, { scrollTop: 100, scrollLeft: 0, timestamp: 1 });
            // Should not throw and cache stays empty
            expect(state.getScrollStateFromGlobalCache('', 0)).toBeNull();
        });
    });

    describe('clearScrollStatesForSource', () => {
        it('removes all scroll states for a source', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///test.sql', 0, { scrollTop: 100, scrollLeft: 0, timestamp: 1 });
            state.saveScrollStateToCache('file:///test.sql', 1, { scrollTop: 200, scrollLeft: 0, timestamp: 1 });
            state.clearScrollStatesForSource('file:///test.sql');
            expect(state.getScrollStateFromGlobalCache('file:///test.sql', 0)).toBeNull();
            expect(state.getScrollStateFromGlobalCache('file:///test.sql', 1)).toBeNull();
        });

        it('does not affect other sources', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveScrollStateToCache('file:///a.sql', 0, { scrollTop: 100, scrollLeft: 0, timestamp: 1 });
            state.saveScrollStateToCache('file:///b.sql', 0, { scrollTop: 200, scrollLeft: 0, timestamp: 1 });
            state.clearScrollStatesForSource('file:///a.sql');
            expect(state.getScrollStateFromGlobalCache('file:///b.sql', 0)!.scrollTop).toBe(200);
        });
    });

    describe('saveScrollStateForSource / getScrollStateForSource / getScrollStateFromCache', () => {
        it('saves and retrieves scroll state via sourceResultsCache', () => {
            const state = require('../../media/resultPanel/state.js');
            // sourceResultsCache is seeded by saveCurrentSourceToCache
            state.saveCurrentSourceToCache('file:///test.sql', [{ name: 'Result 1', data: [[1]] }], 0);
            state.saveScrollStateForSource('file:///test.sql', 0, { scrollTop: 300, scrollLeft: 20 });
            expect(state.getScrollStateForSource('file:///test.sql', 0)).toEqual(
                expect.objectContaining({ scrollTop: 300, scrollLeft: 20 })
            );
            expect(state.getScrollStateFromCache('file:///test.sql', 0)).toEqual(
                expect.objectContaining({ scrollTop: 300, scrollLeft: 20 })
            );
        });

        it('returns null when no source is cached', () => {
            const state = require('../../media/resultPanel/state.js');
            expect(state.getScrollStateForSource('file:///unknown.sql', 0)).toBeNull();
            expect(state.getScrollStateFromCache('file:///unknown.sql', 0)).toBeNull();
        });

        it('does nothing when saving without cached source', () => {
            const state = require('../../media/resultPanel/state.js');
            // Should not throw, just return early
            expect(() => state.saveScrollStateForSource('file:///test.sql', 0, { scrollTop: 100, scrollLeft: 0 })).not.toThrow();
        });

        it('separates states per rsIndex in sourceResultsCache', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveCurrentSourceToCache('file:///test.sql', [{ name: 'R1' }, { name: 'R2' }], 0);
            state.saveScrollStateForSource('file:///test.sql', 0, { scrollTop: 50, scrollLeft: 0 });
            state.saveScrollStateForSource('file:///test.sql', 1, { scrollTop: 500, scrollLeft: 10 });
            expect(state.getScrollStateFromCache('file:///test.sql', 0)!.scrollTop).toBe(50);
            expect(state.getScrollStateFromCache('file:///test.sql', 1)!.scrollTop).toBe(500);
        });
    });

    describe('sourceResultsCache LRU', () => {
        it('evicts oldest cached source when exceeding max entries', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveCurrentSourceToCache('file:///a.sql', [{ name: 'A' } as never], 0);
            state.saveCurrentSourceToCache('file:///b.sql', [{ name: 'B' } as never], 0);
            state.saveCurrentSourceToCache('file:///c.sql', [{ name: 'C' } as never], 0);
            expect(state.getCachedSource('file:///a.sql')).toBeUndefined();
            expect(state.getCachedSource('file:///b.sql')).toBeDefined();
            expect(state.getCachedSource('file:///c.sql')).toBeDefined();
        });

        it('releases cached result rows when evicting a source', () => {
            const state = require('../../media/resultPanel/state.js');
            const evictedResult = { name: 'A', data: [[1], [2], [3]] };
            state.saveCurrentSourceToCache('file:///a.sql', [evictedResult], 0);
            state.saveCurrentSourceToCache('file:///b.sql', [{ name: 'B', data: [[4]] }], 0);
            state.saveCurrentSourceToCache('file:///c.sql', [{ name: 'C', data: [[5]] }], 0);

            expect(state.getCachedSource('file:///a.sql')).toBeUndefined();
            expect(evictedResult.data).toHaveLength(0);
        });

        it('releases cached result rows when source list no longer contains the source', () => {
            const state = require('../../media/resultPanel/state.js');
            const closedResult = { name: 'Closed', data: [[1], [2]] };
            state.saveCurrentSourceToCache('file:///closed.sql', [closedResult], 0);
            state.saveCurrentSourceToCache('file:///open.sql', [{ name: 'Open', data: [[3]] }], 0);

            state.evictSourceCacheNotInList(['file:///open.sql']);

            expect(state.getCachedSource('file:///closed.sql')).toBeUndefined();
            expect(closedResult.data).toHaveLength(0);
        });
    });

    describe('clearSourceCache', () => {
        it('removes the cached source entry', () => {
            const state = require('../../media/resultPanel/state.js');
            state.saveCurrentSourceToCache('file:///test.sql', [{ name: 'R1' }], 0);
            state.saveScrollStateForSource('file:///test.sql', 0, { scrollTop: 100, scrollLeft: 0 });
            state.clearSourceCache('file:///test.sql');
            expect(state.getScrollStateForSource('file:///test.sql', 0)).toBeNull();
        });

        it('releases cached result rows', () => {
            const state = require('../../media/resultPanel/state.js');
            const result = { name: 'R1', data: [[1], [2]] };
            state.saveCurrentSourceToCache('file:///test.sql', [result], 0);

            state.clearSourceCache('file:///test.sql');

            expect(result.data).toHaveLength(0);
            expect(state.getCachedSource('file:///test.sql')).toBeUndefined();
        });
    });

    describe('clearAllSearchMatches', () => {
        it('removes all worker-backed search match indexes', () => {
            const state = require('../../media/resultPanel/state.js');
            state.setSearchMatches(0, new Set([1, 3, 5]));
            state.setSearchMatches(1, new Set([2, 4]));

            state.clearAllSearchMatches();

            expect(state.getSearchMatches(0)).toBeUndefined();
            expect(state.getSearchMatches(1)).toBeUndefined();
            expect(state.getSortedSearchMatchIndices(0)).toBeUndefined();
            expect(state.getSortedSearchMatchIndices(1)).toBeUndefined();
        });
    });
});
