import { buildInMemoryAggregationCacheKey } from '../../media/resultPanel/grid/aggregationCacheKey';

const baseInput = {
    filteredRowCount: 50,
    dataRowCount: 50,
    sorting: [],
    columnFilters: [],
    globalFilter: '',
    currentAggs: {
        '0': [{ fn: 'sum', precision: null, position: 'bottom', scope: 'database' }],
    },
};

describe('buildInMemoryAggregationCacheKey', () => {
    it('produces a stable key when database aggregation state is unchanged', () => {
        const pendingKey = 'uri|0|123|SELECT * FROM T LIMIT 50|[{"columnIndex":0,"fn":"sum"}]';
        const first = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: '',
            databaseAggregationPendingKey: pendingKey,
            databaseAggregationErrorKey: '',
        });
        const second = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: '',
            databaseAggregationPendingKey: pendingKey,
            databaseAggregationErrorKey: '',
        });

        expect(first).toBe(second);
    });

    it('changes when database aggregation cache is populated after a pending request', () => {
        const databaseKey = 'uri|0|123|SELECT * FROM T LIMIT 50|[{"columnIndex":0,"fn":"sum"}]';
        const pendingKey = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: '',
            databaseAggregationPendingKey: databaseKey,
            databaseAggregationErrorKey: '',
        });
        const completedKey = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: databaseKey,
            databaseAggregationPendingKey: '',
            databaseAggregationErrorKey: '',
        });

        expect(pendingKey).not.toBe(completedKey);
    });

    it('changes when database aggregation fails', () => {
        const databaseKey = 'uri|0|123|SELECT * FROM T LIMIT 50|[{"columnIndex":0,"fn":"sum"}]';
        const pendingKey = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: '',
            databaseAggregationPendingKey: databaseKey,
            databaseAggregationErrorKey: '',
        });
        const errorKey = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: '',
            databaseAggregationPendingKey: '',
            databaseAggregationErrorKey: databaseKey,
        });

        expect(pendingKey).not.toBe(errorKey);
    });

    it('does not reuse a pending cache key after database results arrive', () => {
        const databaseKey = 'uri|0|123|SELECT * FROM T LIMIT 50|[{"columnIndex":0,"fn":"sum"}]';
        const aggregationCacheKey = '';
        const pendingRenderKey = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: aggregationCacheKey,
            databaseAggregationPendingKey: databaseKey,
            databaseAggregationErrorKey: '',
        });

        const completedRenderKey = buildInMemoryAggregationCacheKey({
            ...baseInput,
            databaseAggregationCacheKey: databaseKey,
            databaseAggregationPendingKey: '',
            databaseAggregationErrorKey: '',
        });

        const wouldReuseStaleCache = pendingRenderKey === completedRenderKey;
        expect(wouldReuseStaleCache).toBe(false);
    });
});
