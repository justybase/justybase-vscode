export interface InMemoryAggregationCacheKeyInput {
    filteredRowCount: number;
    dataRowCount: number;
    sorting: unknown;
    columnFilters: unknown;
    globalFilter: string;
    currentAggs: unknown;
    databaseAggregationCacheKey: string;
    databaseAggregationPendingKey: string;
    databaseAggregationErrorKey: string;
}

export function buildInMemoryAggregationCacheKey(input: InMemoryAggregationCacheKeyInput): string {
    return [
        input.filteredRowCount,
        input.dataRowCount,
        JSON.stringify(input.sorting),
        JSON.stringify(input.columnFilters),
        input.globalFilter,
        JSON.stringify(input.currentAggs),
        input.databaseAggregationCacheKey,
        input.databaseAggregationPendingKey,
        input.databaseAggregationErrorKey,
    ].join('|');
}
