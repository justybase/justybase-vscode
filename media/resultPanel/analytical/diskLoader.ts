// Sequential column-batch loader for exact disk-backed group statistics. Batches run one at a time,
// so the extension host regains control between SQL passes, and a cancelled analysis stops
// before sending the next batch.

import { queryDiskGroupStats } from '../diskBackedGrid.js';
import type { ExploreColumnRole } from '../explore/types.js';
import { DISK_STAT_BATCH_COLUMNS, type AnalysisColumn } from './diskAdapter.js';
import { ANALYTICAL_MAX_GROUPS, ANALYTICAL_TOP_VALUES } from './types.js';
import type { DiskGroupStatsRequest, DiskGroupStatsResult, DiskQuerySpec } from '../types.js';

export interface DiskLoadParams {
    rsIndex: number;
    groupColumns: readonly number[];
    /** Columns to analyse, already restricted to the analysed set. */
    statColumns: readonly AnalysisColumn[];
    isCancelled: () => boolean;
    /** Request quartiles for measure columns (robust mode). Off by default: it adds window passes. */
    quantiles?: boolean;
    /**
     * Analysis scope: when it carries filters, the store computes every statistic over the matching
     * rows only, so the document can analyse exactly the population it displays.
     */
    spec?: DiskQuerySpec;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let start = 0; start < items.length; start += size) {
        batches.push(items.slice(start, start + size));
    }
    return batches;
}

/** Top values are requested only for dimension-like columns, where dominance and detail are meaningful. */
function wantsTopValues(role: ExploreColumnRole): boolean {
    return role === 'dimension' || role === 'unknown';
}

/**
 * Returns one response per batch, always at least one (the group list comes from the first response,
 * even when no column is analysed). Quartiles for measure columns ride along in the same batch request,
 * so one batch is one host round trip. Returns null when cancelled before all batches finished.
 */
export async function collectDiskGroupStats(params: DiskLoadParams): Promise<DiskGroupStatsResult[] | null> {
    const batches = chunk(params.statColumns, DISK_STAT_BATCH_COLUMNS);
    if (batches.length === 0) {
        batches.push([]);
    }

    const results: DiskGroupStatsResult[] = [];
    for (const batch of batches) {
        if (params.isCancelled()) {
            return null;
        }
        const dimensionColumns = batch.filter(column => wantsTopValues(column.role)).map(column => column.index);
        const request: DiskGroupStatsRequest = {
            groupColumns: [...params.groupColumns],
            statColumns: batch.map(column => column.index),
            limit: ANALYTICAL_MAX_GROUPS,
            topColumns: dimensionColumns,
            topLimit: ANALYTICAL_TOP_VALUES,
            rareColumns: dimensionColumns,
            categoryColumns: dimensionColumns,
        };
        if (params.spec) {
            request.spec = params.spec;
        }
        if (params.quantiles) {
            const quantileColumns = batch.filter(column => column.role === 'measure').map(column => column.index);
            if (quantileColumns.length > 0) {
                request.quantileColumns = quantileColumns;
            }
        }
        results.push(await queryDiskGroupStats(params.rsIndex, request));
    }
    return params.isCancelled() ? null : results;
}
