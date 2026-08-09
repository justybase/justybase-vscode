import {
    ExploreFilterState,
    EXPLORE_FILTER_HISTORY_LIMIT,
    createEmptyExploreFilters,
    exploreFiltersAreEmpty,
} from '../../../media/resultPanel/explore/filterState.js';

describe('explore filterState', () => {
    it('starts empty', () => {
        const state = new ExploreFilterState();
        expect(exploreFiltersAreEmpty(state.filters)).toBe(true);
        expect(state.canUndo).toBe(false);
        expect(state.canRedo).toBe(false);
    });

    it('toggles dimension values and exposes history', () => {
        const state = new ExploreFilterState();
        state.toggleDimensionValue(2, 'EU');
        state.toggleDimensionValue(2, 'US');
        expect(state.filters.dimensions).toEqual([{ columnIndex: 2, values: ['EU', 'US'] }]);
        expect(state.historyDepth).toBe(2);

        state.toggleDimensionValue(2, 'EU');
        expect(state.filters.dimensions).toEqual([{ columnIndex: 2, values: ['US'] }]);

        state.toggleDimensionValue(2, 'US');
        expect(exploreFiltersAreEmpty(state.filters)).toBe(true);
    });

    it('undo/redo restores previous states', () => {
        const state = new ExploreFilterState();
        state.toggleDimensionValue(0, 'A');
        state.setMeasureRange(1, 10, 100);
        const after = state.filters;
        expect(after.dimensions).toHaveLength(1);
        expect(after.measures).toHaveLength(1);

        state.undo();
        expect(state.filters.dimensions).toHaveLength(1);
        expect(state.filters.measures).toHaveLength(0);

        state.undo();
        expect(exploreFiltersAreEmpty(state.filters)).toBe(true);
        expect(state.canUndo).toBe(false);

        state.redo();
        state.redo();
        expect(state.filters.measures).toEqual([{ columnIndex: 1, min: 10, max: 100 }]);
    });

    it('caps history at the limit', () => {
        const state = new ExploreFilterState();
        for (let i = 0; i < EXPLORE_FILTER_HISTORY_LIMIT + 10; i++) {
            state.toggleDimensionValue(0, `v${i}`);
        }
        expect(state.historyDepth).toBe(EXPLORE_FILTER_HISTORY_LIMIT);
    });

    it('clears all filters in one undo step', () => {
        const state = new ExploreFilterState();
        state.toggleDimensionValue(0, 'A');
        state.setMeasureRange(1, 0, 5);
        const beforeClearDepth = state.historyDepth;
        state.clear();
        expect(exploreFiltersAreEmpty(state.filters)).toBe(true);
        expect(state.historyDepth).toBe(beforeClearDepth + 1);
        state.undo();
        expect(state.filters.dimensions).toHaveLength(1);
    });

    it('notifies onChange', () => {
        const changes: Array<{ dimensions: number }> = [];
        const state = new ExploreFilterState(undefined, filters => {
            changes.push({ dimensions: filters.dimensions.length });
        });
        state.toggleDimensionValue(0, 'X');
        state.setDateFilter(1, 'month', '2024-01-01');
        expect(changes).toEqual([{ dimensions: 1 }, { dimensions: 1 }]);
    });

    it('computes the active condition count', () => {
        const state = new ExploreFilterState();
        expect(state.activeCount).toBe(0);
        state.toggleDimensionValue(0, 'A');
        state.toggleDimensionValue(0, 'B');
        state.setMeasureRange(1, 5, 10);
        state.setDateFilter(2, 'month', '2024-01-01');
        expect(state.activeCount).toBe(2 + 2 + 1);
    });

    it('restores from a persisted model', () => {
        const persisted = {
            dimensions: [{ columnIndex: 0, values: ['A'] }],
            dates: [],
            measures: [],
        };
        const state = new ExploreFilterState(persisted);
        expect(state.filters.dimensions[0].values).toEqual(['A']);
        expect(state.historyDepth).toBe(0);
    });

    it('createEmptyExploreFilters returns a fresh object each time', () => {
        const a = createEmptyExploreFilters();
        const b = createEmptyExploreFilters();
        expect(a).not.toBe(b);
    });
});
