// Explore filter model + undo/redo history (client-side, pure).

import type { ExploreDateGrain, ExploreFilterModel } from './types.js';

export type { ExploreDateGrain, ExploreFilterModel };

/** Maximum number of undo steps kept. */
export const EXPLORE_FILTER_HISTORY_LIMIT = 50;

export function createEmptyExploreFilters(): ExploreFilterModel {
    return { dimensions: [], dates: [], measures: [] };
}

export function exploreFiltersAreEmpty(filters: ExploreFilterModel): boolean {
    return filters.dimensions.length === 0 && filters.dates.length === 0 && filters.measures.length === 0;
}

function cloneFilters(filters: ExploreFilterModel): ExploreFilterModel {
    return {
        dimensions: filters.dimensions.map(dimension => ({ ...dimension, values: [...dimension.values] })),
        dates: filters.dates.map(date => ({ ...date })),
        measures: filters.measures.map(measure => ({ ...measure })),
    };
}

export class ExploreFilterState {
    private _filters: ExploreFilterModel;
    private _history: ExploreFilterModel[];
    private _future: ExploreFilterModel[];
    private readonly _onChange: (filters: ExploreFilterModel) => void;

    constructor(initial: ExploreFilterModel = createEmptyExploreFilters(), onChange?: (filters: ExploreFilterModel) => void) {
        this._filters = cloneFilters(initial);
        this._history = [];
        this._future = [];
        this._onChange = onChange ?? (() => undefined);
    }

    get filters(): ExploreFilterModel {
        return cloneFilters(this._filters);
    }

    get canUndo(): boolean {
        return this._history.length > 0;
    }

    get canRedo(): boolean {
        return this._future.length > 0;
    }

    get historyDepth(): number {
        return this._history.length;
    }

    private commit(next: ExploreFilterModel): void {
        this._history.push(cloneFilters(this._filters));
        if (this._history.length > EXPLORE_FILTER_HISTORY_LIMIT) {
            this._history.shift();
        }
        this._future = [];
        this._filters = cloneFilters(next);
        this._onChange(this.filters);
    }

    undo(): ExploreFilterModel | null {
        const previous = this._history.pop();
        if (!previous) {
            return null;
        }
        this._future.push(cloneFilters(this._filters));
        this._filters = cloneFilters(previous);
        this._onChange(this.filters);
        return this.filters;
    }

    redo(): ExploreFilterModel | null {
        const next = this._future.pop();
        if (!next) {
            return null;
        }
        this._history.push(cloneFilters(this._filters));
        this._filters = cloneFilters(next);
        this._onChange(this.filters);
        return this.filters;
    }

    clear(): ExploreFilterModel {
        const empty = createEmptyExploreFilters();
        if (!exploreFiltersAreEmpty(this._filters)) {
            this.commit(empty);
        }
        return this.filters;
    }

    toggleDimensionValue(columnIndex: number, value: string): ExploreFilterModel {
        const next = cloneFilters(this._filters);
        const existing = next.dimensions.find(dimension => dimension.columnIndex === columnIndex);
        if (!existing) {
            next.dimensions.push({ columnIndex, values: [value] });
        } else if (existing.values.includes(value)) {
            existing.values = existing.values.filter(item => item !== value);
            if (existing.values.length === 0) {
                next.dimensions = next.dimensions.filter(dimension => dimension.columnIndex !== columnIndex);
            }
        } else {
            existing.values.push(value);
        }
        this.commit(next);
        return this.filters;
    }

    setDimensionValues(columnIndex: number, values: string[]): ExploreFilterModel {
        const next = cloneFilters(this._filters);
        if (values.length === 0) {
            next.dimensions = next.dimensions.filter(dimension => dimension.columnIndex !== columnIndex);
        } else {
            const existing = next.dimensions.find(dimension => dimension.columnIndex === columnIndex);
            if (existing) {
                existing.values = [...values];
            } else {
                next.dimensions.push({ columnIndex, values: [...values] });
            }
        }
        this.commit(next);
        return this.filters;
    }

    setDateFilter(columnIndex: number, grain: ExploreDateGrain, from?: string, to?: string): ExploreFilterModel {
        const next = cloneFilters(this._filters);
        const existing = next.dates.find(date => date.columnIndex === columnIndex);
        if (existing) {
            existing.grain = grain;
            existing.from = from;
            existing.to = to;
            if (!from && !to) {
                next.dates = next.dates.filter(date => date.columnIndex !== columnIndex);
            }
        } else if (from || to) {
            next.dates.push({ columnIndex, grain, from, to });
        }
        this.commit(next);
        return this.filters;
    }

    setMeasureRange(columnIndex: number, min?: number, max?: number): ExploreFilterModel {
        const next = cloneFilters(this._filters);
        const existing = next.measures.find(measure => measure.columnIndex === columnIndex);
        if (existing) {
            existing.min = min;
            existing.max = max;
            if (min === undefined && max === undefined) {
                next.measures = next.measures.filter(measure => measure.columnIndex !== columnIndex);
            }
        } else if (min !== undefined || max !== undefined) {
            next.measures.push({ columnIndex, min, max });
        }
        this.commit(next);
        return this.filters;
    }

    /** Number of active filter conditions across all filter kinds. */
    get activeCount(): number {
        let count = 0;
        for (const dimension of this._filters.dimensions) {
            count += dimension.values.length;
        }
        for (const date of this._filters.dates) {
            if (date.from) count += 1;
            if (date.to) count += 1;
        }
        for (const measure of this._filters.measures) {
            if (measure.min !== undefined) count += 1;
            if (measure.max !== undefined) count += 1;
        }
        return count;
    }
}
