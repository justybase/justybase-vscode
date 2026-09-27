import {
    columnFilteringFeature,
    columnGroupingFeature,
    columnOrderingFeature,
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    constructTable as constructCoreTable,
    createColumnHelper,
    createExpandedRowModel,
    createFilteredRowModel,
    createGroupedRowModel,
    createSortedRowModel,
    globalFilteringFeature,
    rowExpandingFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    tableFeatures,
} from '@tanstack/table-core';
import type { RowData, TableFeatures, TableOptions } from '@tanstack/table-core';
import { storeReactivityBindings } from '@tanstack/table-core/store-reactivity-bindings';

/**
 * Shared feature set for the framework-agnostic tables hosted by our
 * webviews. Keeping this list explicit lets esbuild drop unused v9 features.
 */
const webviewFeatures = tableFeatures({
    coreReactivityFeature: storeReactivityBindings(),
    columnFilteringFeature,
    globalFilteringFeature,
    columnGroupingFeature,
    columnOrderingFeature,
    columnPinningFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    rowExpandingFeature,
    rowSortingFeature,
    filteredRowModel: createFilteredRowModel(),
    groupedRowModel: createGroupedRowModel(),
    expandedRowModel: createExpandedRowModel(),
    sortedRowModel: createSortedRowModel(),
    sortFns: { alphanumeric: sortFn_alphanumeric },
});

/**
 * Keep the existing webview state-reader contract while sourcing it from the
 * v9 store. This lets the migration update the core runtime in one place and
 * keeps test doubles and adjacent panels on the same state shape.
 */
function constructTable<TFeatures extends TableFeatures, TData extends RowData>(
    options: TableOptions<TFeatures, TData>,
) {
    const table = constructCoreTable(options);
    return Object.assign(table, { getState: () => table.store.state });
}

export { constructTable, createColumnHelper, webviewFeatures };
