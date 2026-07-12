/**
 * Shared Result Panel webview types for grid, selection, and filter modules.
 * Consumed by TypeScript modules under media/resultPanel/ during Phase 5 migration.
 */

import type { SelectionStatsPayload } from './hostContracts.js';

export type { TanStackCellContext } from '../shared/tanstackShims.js';

/** Column metadata carried on TanStack column definitions in the result grid. */
export interface CellSelectionHandlers {
    destroy(): void;
    onTableRowsRendered?: () => void;
    copySelection?: (withHeaders?: boolean, plainTextFormat?: string) => void;
    [key: string]: unknown;
}

export interface GridScrollState {
    scrollTop?: number;
    scrollLeft?: number;
    scrollAnchorIndex?: number;
    timestamp?: number;
}

/** Common scope for per-result-set persisted state keys. */
export interface ResultSetScope {
    rsIndex: number;
    executionTimestamp?: number;
    sourceUri?: string;
}

export function asScrollState(value: unknown): GridScrollState | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as GridScrollState;
    if (
        candidate.scrollTop === undefined
        && candidate.scrollLeft === undefined
        && candidate.scrollAnchorIndex === undefined
    ) {
        return undefined;
    }
    return candidate;
}

export interface ResultColumnDef {
    header: string;
    dataType?: string;
    scale?: number;
    align?: string;
    inferredNumericKind?: 'decimal' | 'integer';
    inferredDateInteger?: boolean;
    isRowNumber?: boolean;
    accessorFn?: (row: unknown) => unknown;
    filterFn?: (row: TanStackRow, columnId: string, filterValue: ColumnFilterValue) => boolean;
}

export interface TanStackColumn {
    id: string;
    columnDef: ResultColumnDef;
    getFilterValue: () => ColumnFilterValue;
    setFilterValue: (value: ColumnFilterValue) => void;
    getIsSorted: () => false | 'asc' | 'desc';
    getSortIndex?: () => number;
    getToggleSortingHandler: () => (event: Event) => void;
    toggleVisibility: (visible: boolean) => void;
    getIsVisible: () => boolean;
}

export interface TanStackHeader {
    column: TanStackColumn;
    index: number;
}

export interface TanStackRow {
    index?: number;
    original: unknown;
    getValue: (columnId: string) => unknown;
    getVisibleCells?: () => Array<{ column: TanStackColumn; getValue: () => unknown }>;
}

export interface TanStackTableState {
    sorting?: Array<{ id: string; desc: boolean }>;
    columnFilters?: Array<{ id: string; value: ColumnFilterValue }>;
    columnOrder?: string[];
    globalFilter?: string;
    grouping?: string[];
    expanded?: Record<string, boolean>;
    columnPinning?: { left?: string[]; right?: string[] };
    columnVisibility?: Record<string, boolean>;
}

export interface TanStackTable {
    getState: () => TanStackTableState;
    getColumn: (columnId: string) => TanStackColumn;
    getCoreRowModel: () => { rows: TanStackRow[] };
    getFilteredRowModel: () => { rows: TanStackRow[] };
    getRowModel: () => { rows: TanStackRow[] };
    getAllColumns: () => TanStackColumn[];
    getVisibleLeafColumns: () => TanStackColumn[];
    getAllLeafColumns?: () => TanStackColumn[];
    setColumnOrder: (order: string[]) => void;
    setColumnFilters: (filters: Array<{ id: string; value: ColumnFilterValue }>) => void;
    setSorting: (sorting: Array<{ id: string; desc: boolean }>) => void;
    setGrouping: (grouping: string[]) => void;
    resetColumnFilters: () => void;
    setGlobalFilter: (value: string) => void;
    options?: {
        data?: unknown[];
        globalFilterFn?: (row: TanStackRow, columnId: string, filterValue: string) => boolean;
    };
}

export interface FilterCondition {
    type: string;
    value: string;
    value2?: string;
}

export interface ConditionColumnFilter {
    _isConditionFilter: true;
    conditions: FilterCondition[];
    logic: 'and' | 'or';
}

export type ColumnFilterValue = string[] | ConditionColumnFilter | undefined;

/** Single log-console row: level, message, optional metadata columns. */
export type LogRow = [unknown, unknown, ...unknown[]];

export interface ResultSetColumn {
    name: string;
    type?: string;
    header?: string;
    accessorKey?: string | number;
    index?: number;
    scale?: number;
}

export interface ResultSet {
    name?: string;
    columns: ResultSetColumn[];
    data: unknown[][];
    message?: string;
    limitReached?: boolean;
    isLog?: boolean;
    isError?: boolean;
    isCancelled?: boolean;
    isTextContent?: boolean;
    isEditable?: boolean;
    editSource?: unknown;
    executionTimestamp?: number;
    sql?: string;
    refreshSql?: string;
    _savedState?: Record<string, unknown>;
    storageMode?: 'memory' | 'sqlite';
    totalRowCount?: number;
    diskWindowStart?: number;
    diskQuerySpec?: DiskQuerySpec;
    databaseFilterSpec?: DiskQuerySpec;
    diskFilteredCount?: number;
    diskAggregationCache?: Record<string, string>;
    refreshFailure?: {
        message: string;
        sql?: string;
        failedAt: number;
    };
}

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
    values?: unknown[];
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

export interface GridHandle {
    tanTable?: TanStackTable;
    columnWidths?: Map<string, number>;
    manualColumnWidths?: Set<string>;
    render?: () => void;
    updateRowCount?: () => void;
    selectColumn?: (columnIndex: number) => void;
    autoFitColumn?: (columnId: string) => boolean;
    scrollToIndex?: (rowIndex: number, behavior: ScrollBehavior | string) => void;
    getScrollAnchorIndex?: () => number | undefined;
    hasSelection?: () => boolean;
    selectAll?: () => void;
    copySelection?: (withHeaders: boolean, format?: string) => void;
    copySelectionAsHtml?: () => void;
    copySelectionAsMd?: (withHeaders: boolean) => void;
    dispose?: () => void;
    destroyVirtualizer?: () => void;
    clearPool?: () => void;
    refreshAutoSizedLayout?: () => boolean;
    createVirtualizer?: () => void;
    renderTableRows?: () => void;
    executionTimestamp?: number;
    TableCore?: unknown;
    [key: string]: unknown;
}

export type AggregationFn =
    | 'sum'
    | 'count'
    | 'countDistinct'
    | 'avg'
    | 'min'
    | 'max'
    | 'stdev'
    | 'median'
    | string;

export interface AggregationSelection {
    fn: AggregationFn;
    precision: number | null;
    position: 'top' | 'bottom';
    scope?: 'visible' | 'database';
}

export type ColumnAggregationValue = AggregationSelection | AggregationFn;

export type ColumnAggregationState = ColumnAggregationValue | ColumnAggregationValue[];

export interface CellDescriptor {
    rowIndex: number;
    rowNumber: number;
    columnId: string;
    columnName: string;
    dataType: string;
    value: unknown;
    isNull: boolean;
}

/** Parsed sign, integer, and fractional components from a numeric string. */
export interface ParsedDecimalParts {
    sign: '' | '-';
    integerPart: string;
    fractionalPart: string;
}

/** Validated YYYYMMDD integer date components. */
export interface ParsedYyyymmddDate {
    raw: string;
    year: number;
    month: string;
    day: string;
}

export interface RoundedDecimalParts {
    integerPart: string;
    fractionalPart: string;
}

export interface FormattingIntegerSettings {
    useGrouping?: boolean;
    groupSeparator?: string;
}

export interface FormattingDecimalSettings {
    useGrouping?: boolean;
    groupSeparator?: string;
    decimalSeparator?: string;
    scale?: number;
    preserveTrailingZeros?: boolean;
    roundingMode?: 'half-up' | 'half-even' | 'ceil' | 'floor' | 'truncate' | string;
}

export interface FormattingSettings {
    integer: FormattingIntegerSettings;
    decimal: FormattingDecimalSettings;
    useFormattedValuesForExport: boolean;
}

export interface FormatCellValueContext {
    columnId?: string;
    inferredNumericKind?: 'decimal' | 'integer';
    inferredDateInteger?: boolean;
    rsIndex?: number;
    executionTimestamp?: number;
    [key: string]: unknown;
}

/** Context passed to numeric cell formatting helpers. */
export type FormatNumericContext = FormatCellValueContext;

export interface ColumnFormattingOverride {
    kind?: 'integer' | 'decimal';
    integer?: Partial<FormattingIntegerSettings>;
    decimal?: Partial<FormattingDecimalSettings>;
}

export interface ColumnSearchMapItem {
    id: string;
    name: string;
}

export type SelectionStats = SelectionStatsPayload;

export interface AutoColumnWidthOptions {
    maxRows?: number;
    sampleStep?: number;
    headerWidth?: number;
    initialWidth?: number;
}

export interface MeasureTextFn {
    (text: string): number;
}

/** Window globals used by the result panel webview. */
export interface ResultPanelGlobals {
    queryRowLimit?: number;
    resultSets?: ResultSet[];
    activeSource?: string;
    executingSources?: Set<string>;
    columnSearchMap?: Record<number, Array<{ id: string; name: string }>>;
    clearGroupDropTargets?: () => void;
    grids?: GridHandle[];
    selectAll?: () => void;
    getIsEditMode?: () => boolean;
    addPendingEdit?: (
        rowIndex: number,
        columnIndex: number,
        oldValue: unknown,
        newValue: unknown,
    ) => void;
    isRowMarkedForDelete?: (rowIndex: number) => boolean;
    markRowForDelete?: (rowIndex: number) => void;
    copySelection?: (withHeaders: boolean, format?: string) => void;
    copySelectionAsMd?: (withHeaders: boolean) => void;
    openValueViewer?: (descriptor: CellDescriptor) => void;
    openResultFormattingPanel?: (options?: {
        scope?: 'column' | 'result' | 'global' | 'connection';
        columnId?: string;
        columnName?: string;
    }) => void;
    exportSelectionToCsv?: () => void;
    exportSelectionToJson?: () => void;
    exportSelectionToExcel?: () => void;
    exportAllVisibleToCsv?: () => void;
    exportAllVisibleToJson?: () => void;
    exportAllVisibleToExcel?: () => void;
    pinnedResults?: Array<{ sourceUri?: string; resultSetIndex?: number }>;
    refreshRowView?: () => void;
    refreshActiveResult?: () => void;
    refreshResultAt?: (resultSetIndex: number) => void;
    refreshResultsGrid?: () => void;
    sources?: string[];
    pinnedSources?: Set<string>;
    defaultCopyFormat?: string;
    maxDataResults?: number;
    /** Host-aligned stream cap for large in-memory results (see DISK_BACKED_WEBVIEW_STREAM_CAP). */
    diskBackedStreamCapEnabled?: boolean;
    updateEditButtons?: () => void;
    syncViewModeBar?: (mode: string) => void;
    setLayoutSwitcherDisabled?: (disabled: boolean) => void;
    updateResultLimitBanner?: () => void;
    syncLayoutSwitcher?: (viewMode: string) => void;
    justybaseUseHostCopyShortcut?: boolean;
    postToHost?: (message: Record<string, unknown>) => void;
    __getHostState?: () => Record<string, unknown> | null;
    __setHostState?: (state: Record<string, unknown>) => void;
    renderSidebarSchema?: () => void;
    onFilterChanged?: () => void;
    clearFilter?: () => void;
    clearAllFilters?: () => void;
    onDropGroup?: (event: DragEvent) => void;
    onDragOverGroup?: (event: DragEvent) => void;
    onDragLeaveGroup?: (event: DragEvent) => void;
    toggleRowView?: () => void;
    toggleDatabaseGroupingPanel?: () => void;
    closeDatabaseGroupingPanel?: () => void;
    __toggleDatabaseGroupingPanel?: () => void;
    __clearGroupingConfig?: () => void;
    __runGroupingQuery?: () => void;
    __exportActiveGridAsXlsb?: () => void;
    exportActiveGridAsXlsb?: () => void;
    toggleExportSplitMenu?: (event: Event) => void;
    toggleExportPrimaryMenu?: (event?: Event) => void;
    toggleToolbarMoreMenu?: (event: Event) => void;
    handleToolbarMoreMenuClick?: (event: MouseEvent) => void;
    handleExportSplitMenuClick?: (event: MouseEvent) => void;
    init?: () => void;
    sourceResultsCache?: Record<string, unknown>;
    resultFormattingPayload?: unknown;
    layoutMode?: string;
    [key: string]: unknown;
}

export function getResultPanelWindow(): ResultPanelGlobals & Window {
    return window as unknown as ResultPanelGlobals & Window;
}

export function getResultSets(): ResultSet[] {
    return getResultPanelWindow().resultSets ?? [];
}

export function setActiveSourceUri(sourceUri: string | undefined): void {
    getResultPanelWindow().activeSource = sourceUri;
}

function compactResultSetArray(resultSets: ResultSet[]): ResultSet[] {
    if (!Array.isArray(resultSets)) {
        return [];
    }
    if (!resultSets.some((rs, index) => rs == null && index < resultSets.length)) {
        return resultSets;
    }
    console.warn('[resultPanel] Compacting sparse resultSets array (length=%s)', resultSets.length);
    return resultSets.filter((rs): rs is ResultSet => rs != null);
}

export function setResultSets(resultSets: ResultSet[]): void {
    getResultPanelWindow().resultSets = compactResultSetArray(resultSets);
}

export function ensureExecutingSources(): Set<string> {
    const panel = getResultPanelWindow();
    if (!panel.executingSources) {
        panel.executingSources = new Set<string>();
    }
    return panel.executingSources;
}

export function getActiveSourceUri(): string | undefined {
    return getResultPanelWindow().activeSource;
}

export function requireActiveSourceUri(): string {
    return getActiveSourceUri() ?? '';
}

/** Invoke an optional panel callback without repeating typeof guards. */
export function callPanelMethod(
    method: keyof ResultPanelGlobals,
    ...args: unknown[]
): void {
    const fn = getResultPanelWindow()[method];
    if (typeof fn === 'function') {
        (fn as (...params: unknown[]) => unknown)(...args);
    }
}

export function getResultSetAt(index: number): ResultSet | undefined {
    return getResultSets()[index];
}

export function isActiveSourceExecuting(): boolean {
    const panel = getResultPanelWindow();
    return !!(
        panel.activeSource
        && panel.executingSources?.has(panel.activeSource)
    );
}

/** @deprecated Import from `./dom` instead. */
export function asHTMLElement(
    node: Element | EventTarget | null | undefined,
): HTMLElement | null {
    return (node as HTMLElement | null) ?? null;
}

export function isInferredNumericDetail(
    value: unknown,
): value is { numericKind: string; scale?: number; dataType?: string } {
    return typeof value === 'object' && value !== null && 'numericKind' in value;
}
