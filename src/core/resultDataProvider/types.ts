import type { ColumnDefinition } from '../../types/columnDefinition';

export interface RowRange {
    offset: number;
    limit: number;
}

export interface DiskBackedResultsSettings {
    enabled: boolean;
    /** Hard upper bound — spill must happen by this row count. */
    rowThreshold: number;
    /** Host RAM spill trigger (independent of webview stream cap). */
    memoryRowThreshold: number;
    /** Host RAM spill trigger measured in approximate bytes. */
    memoryByteThreshold?: number;
    insertBatchSize: number;
    /** Minutes of inactivity before idle spill (0 = disabled). */
    idleSpillMinutes: number;
    /** Minimum row count for idle spill eligibility. */
    idleSpillRowThreshold: number;
}

export interface IResultRowSource {
    getTotalRows(): number;
    getRows(range: RowRange): unknown[][];
    dispose(): void;
}

export interface DiskBackedActivateProps {
    command: 'diskBackedActivate';
    sourceUri: string;
    resultSetIndex: number;
    /** Stable identity used by the webview for grid/scroll state persistence. */
    resultSetId?: string;
    totalRows: number;
    columns: ColumnDefinition[];
    firstPageRows: unknown[][];
    limitReached: boolean;
}

export interface RowCountUpdateProps {
    command: 'rowCountUpdate';
    sourceUri: string;
    resultSetIndex: number;
    /** Stable identity used to reject delayed counts from an older execution. */
    resultSetId?: string;
    totalRows: number;
    limitReached: boolean;
}

export const DISK_BACKED_FIRST_PAGE_SIZE = 200;
export const DISK_BACKED_WINDOW_ROWS = 2_000;
export const DISK_BACKED_PAGE_SIZE = 800;
/** Default host spill threshold — spill to SQLite once reached. */
export const DISK_BACKED_DEFAULT_MEMORY_ROW_THRESHOLD = 25_000;
/** Default approximate in-memory result budget (128 MiB). */
export const DISK_BACKED_DEFAULT_MEMORY_BYTE_THRESHOLD = 128 * 1024 * 1024;
/** Hard upper bound before disk-backed storage must activate. */
export const DISK_BACKED_DEFAULT_ROW_THRESHOLD = 500_000;
/** Max rows streamed into webview before stream cap (preview-only phase). */
export const DISK_BACKED_WEBVIEW_STREAM_CAP = 250_000;
/** Rows kept visible in the webview while a large result is still streaming. */
export const DISK_BACKED_STREAMING_PREVIEW_ROWS = DISK_BACKED_WINDOW_ROWS;
/** Minimum row delta between streaming row-count updates posted to the webview (disk-backed phase). */
export const STREAMING_ROW_COUNT_REPORT_INTERVAL = 25_000;
/** Row-count report interval near the disk-backed migration threshold (pre-SQLite phase). */
export const STREAMING_ROW_COUNT_REPORT_INTERVAL_NEAR_THRESHOLD = 10_000;

export const DISK_QUERY_DISTINCT_LIMIT = 10_001;

export interface DiskSortSpec {
    columnIndex: number;
    desc: boolean;
}

export interface DiskColumnConditionSpec {
    type: string;
    value: string;
    value2?: string;
}

export interface DiskColumnFilterSpec {
    columnIndex: number;
    /** Raw cell values from SQLite (use null entry for SQL NULL). Values-tab filter. */
    values?: unknown[];
    /** Conditions-tab filter (mutually exclusive with values). */
    conditions?: DiskColumnConditionSpec[];
    conditionLogic?: 'and' | 'or';
}

export interface DiskQuerySpec {
    globalSearch?: string;
    columnFilters?: DiskColumnFilterSpec[];
    sorting?: DiskSortSpec[];
}

export interface DiskDistinctValue {
    raw: unknown;
    count: number;
}

export interface DiskAggregationRequest {
    columnIndex: number;
    fn: string;
}

export interface DiskAggregationResult {
    columnIndex: number;
    fn: string;
    value: unknown;
}

export interface DiskGroupLevel {
    columnIndex: number;
}

export interface DiskGroupPathItem {
    columnIndex: number;
    value: unknown;
}

export interface DiskGroupRow {
    kind: 'group';
    columnIndex: number;
    depth: number;
    value: unknown;
    count: number;
    path: DiskGroupPathItem[];
    hasChildren: boolean;
    aggregations?: DiskAggregationResult[];
}

export interface DiskGroupQueryResult {
    kind: 'groups' | 'leafRows';
    path: DiskGroupPathItem[];
    depth: number;
    totalCount: number;
    groups?: DiskGroupRow[];
    rows?: unknown[][];
    aggregations?: DiskAggregationResult[];
}

/**
 * Exact grouped statistics over every spilled row (grid filters are not applied).
 * Columns are requested in batches so one SQL pass never grows unbounded.
 */
export interface DiskGroupStatsRequest {
    /** Grouping columns in priority order, at most three. */
    groupColumns: number[];
    /** Columns whose statistics are returned in this batch. */
    statColumns: number[];
    /**
     * Optional scope: when the spec carries filters, every statistic (population, groups, quartiles,
     * top values, quartiles) is computed over the filtered rows only, so an analysis can be scoped
     * to what the user currently sees without copying the result.
     */
    spec?: DiskQuerySpec;
    /** Largest groups to list; clamped by the store. */
    limit: number;
    /** Columns that should also report top values (population and per group, when bounded). */
    topColumns?: number[];
    topLimit?: number;
    /** Dimension columns that should also report RARE_VALUE per group. Must be among statColumns. */
    rareColumns?: number[];
    /** Numeric columns whose quartiles are returned per group and for the population (robust mode). */
    quantileColumns?: number[];
    /** Dimension columns whose full distribution is returned when at most ANALYTICAL_CATEGORY_MAX_DISTINCT values. */
    categoryColumns?: number[];
}

export interface DiskQuartiles {
    q1: number;
    median: number;
    q3: number;
}

export interface DiskRareValues {
    total: number;
    examples: string[];
}

export interface DiskTopValue {
    value: unknown;
    count: number;
}

export interface DiskColumnGroupStats {
    columnIndex: number;
    /** Non-null values, matching COUNT(column). */
    nonNullCount: number;
    distinctCount: number;
    min: unknown;
    max: unknown;
    /** Present only when the column is stored as INTEGER or REAL. Population standard deviation. */
    numeric?: { mean: number | null; stddev: number | null; quartiles?: DiskQuartiles };
    topValues?: DiskTopValue[];
    /** Full distribution of a dimension column with few distinct values (MIX_SHIFT). */
    categories?: DiskTopValue[];
    /** Group statistics only: values of this column owned by this group alone, at most a few times. */
    rare?: DiskRareValues;
}

export interface DiskGroupStatsRow {
    /** One value per grouping column; null is a SQL NULL group. */
    values: unknown[];
    count: number;
    columns: DiskColumnGroupStats[];
}

/** A statistic the store skipped because of a bound (distinct or group count) or the column's storage. */
export interface DiskGroupStatsOmission {
    columnIndex: number;
    field: 'topValues' | 'categories' | 'rare' | 'quartiles';
    reason: 'too-many-distinct' | 'too-many-groups' | 'not-numeric';
}

export interface DiskGroupStatsResult {
    groupColumns: number[];
    totalRows: number;
    /** Distinct group keys across the whole result, including unlisted groups. */
    totalGroups: number;
    groups: DiskGroupStatsRow[];
    /** Rows that belong to groups which are not listed. */
    unlistedRows: number;
    population: DiskColumnGroupStats[];
    /** Evaluations the store skipped, so the view can report reduced coverage. Absent when nothing was skipped. */
    omitted?: DiskGroupStatsOmission[];
}

export function diskQuerySpecHasFilters(spec: DiskQuerySpec | undefined): boolean {
    if (!spec) {
        return false;
    }
    if (spec.globalSearch?.trim()) {
        return true;
    }
    return (spec.columnFilters ?? []).some((filter) => {
        if ((filter.conditions?.length ?? 0) > 0) {
            return true;
        }
        return (filter.values?.length ?? 0) > 0;
    });
}

export function diskQuerySpecIsActive(spec: DiskQuerySpec | undefined): boolean {
    if (!spec) {
        return false;
    }
    return diskQuerySpecHasFilters(spec) || (spec.sorting?.length ?? 0) > 0;
}
