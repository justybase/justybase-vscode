import type { ColumnDefinition } from '../../types';

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
    totalRows: number;
    columns: ColumnDefinition[];
    firstPageRows: unknown[][];
    limitReached: boolean;
}

export interface RowCountUpdateProps {
    command: 'rowCountUpdate';
    sourceUri: string;
    resultSetIndex: number;
    totalRows: number;
    limitReached: boolean;
}

export const DISK_BACKED_FIRST_PAGE_SIZE = 200;
export const DISK_BACKED_WINDOW_ROWS = 2_000;
export const DISK_BACKED_PAGE_SIZE = 800;
/** Default host spill threshold — spill to SQLite once reached. */
export const DISK_BACKED_DEFAULT_MEMORY_ROW_THRESHOLD = 25_000;
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
