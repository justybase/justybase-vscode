import { decode } from '@msgpack/msgpack';
import { createRoot, type Root } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { isDatabaseErrorDetails } from '@justybase/contracts';
import type {
    CapabilityDescriptor,
    DatabaseErrorDetails,
    ExploreFilterModel,
    ExploreValue,
    UiIdentity,
} from '@justybase/contracts';
import {
    createInitialUiState,
    createUiStore,
    createAggregateAnalysisTable,
    createGroupAnalysisTable,
    createPivotAnalysisTable,
    calculateGridSelectionStats,
    compactSqlErrorMessage,
    formatDatabaseErrorForPrompt,
    normalizeGridSelection,
    resultKey,
    resultAsyncState as getResultAsyncState,
    type UiResultAnalysisKind,
    type UiResultAnalysisTable,
    type UiResultColumn,
    type UiResultColumnAggregation,
    type UiResultColumnFilterDefinition,
    type UiResultEvent,
    type UiResultSurfaceState,
    type UiState,
    type UiStore,
} from '@justybase/ui-core';
import {
    AsyncStateView,
    DataGrid,
    DataGridColumnFilterPanel,
    DiffView,
    ExecutionElapsed,
    formatDataGridCellValue,
    isDataGridNumericColumn,
    moveDataGridColumnOrder,
    processDataGridRowIndices,
    processDataGridRows,
    resolveDataGridColumnOrder,
    resolveDataGridColumns,
    FocusOnMount,
    HistoryView,
    MenuIcon,
    MiniChartsView,
    parseRunLogMessage,
    PivotDialog,
    RefreshLimitDialog,
    ResultErrorView,
    ResultExecutionBanner,
    ResultLayoutSwitcher,
    ResultLimitBanner,
    ResultRefreshFailureBanner,
    ResultTabs,
    ResultAnalysisPanel,
    ResultColumnSidebar,
    ResultViewToolbar,
    RowViewPanel,
    UiShell,
} from '@justybase/ui-react';
import type {
    DataGridCellContext,
    DataGridClipboardFormat,
    DataGridColumnFilterRequest,
    DataGridFormattingOptions,
    DataGridColumnFilterState,
    DataGridExtraGroup,
    DataGridFilterValueOption,
    DataGridHandle,
    DataGridSelection,
    DiffBaseline,
    PivotAggregation,
    PivotConfiguration,
    ResultExecutionBannerStatus,
    ResultLayoutKind,
} from '@justybase/ui-react';
import { asHostMessage, callPanelMethod, getHostState, postHostMessage, setHostState } from './protocol.js';
import type { DiskColumnFilterSpec, DiskGroupPathItem, DiskGroupQueryResult, DiskQuerySpec } from './types.js';
import type { ResultPanelExportFormat, ResultPanelHostToWebviewMessage, ResultPanelTraceEventPayload } from './hostContracts.js';
import { isSharedCopyFormat, writeSharedClipboard } from './sharedClipboard.js';
import type { SharedClipboardFormat, SharedCopyFormat } from './sharedClipboard.js';
import { classifyColumns } from './explore/columnClassification.js';
import { appendRunLogRows } from './logRunGroups.js';
import { updateSqlQueueLogs } from './sqlQueueLogs.js';
import { focusExploreColumn } from './explore/focusColumn.js';
import { SharedAnalyticalView } from './sharedAnalytical.js';
import type { SharedRangeChartProps } from './sharedRangeChart.js';
import { handleExploreHostMessage, requestExploreOperation } from './explore/hostBridge.js';
import { clearExploreRowRequests, handleExploreRowWindow } from './explore/rows.js';
import { clearExploreContext, setExploreContext } from './explore/context.js';
import type { LogRow, ResultSet } from './types.js';

interface SharedColumn {
    readonly name: string;
    readonly type?: string;
    readonly scale?: number;
}

interface SharedResultSetPayload {
    readonly resultSetId?: unknown;
    readonly executionTimestamp?: unknown;
    readonly columns?: unknown;
    readonly data?: unknown;
    readonly message?: unknown;
    readonly errorDetails?: unknown;
    readonly isLog?: unknown;
    readonly isError?: unknown;
    readonly isCancelled?: unknown;
    readonly isStreamingComplete?: unknown;
    readonly totalRowCount?: unknown;
    readonly limitReached?: unknown;
    readonly isTextContent?: unknown;
    readonly refreshFailure?: unknown;
    readonly isEditable?: unknown;
    readonly editSource?: unknown;
    readonly editDisabledReason?: unknown;
    readonly sql?: unknown;
    readonly refreshSql?: unknown;
    readonly storageMode?: unknown;
}

interface NormalizedResultSet {
    readonly resultSetId?: string;
    readonly executionTimestamp?: number;
    readonly columns: readonly SharedColumn[];
    readonly rows: readonly unknown[][];
    readonly message?: string;
    readonly errorDetails?: DatabaseErrorDetails;
    readonly isLog: boolean;
    readonly isError: boolean;
    readonly isCancelled: boolean;
    readonly isStreamingComplete?: boolean;
    readonly totalRowCount: number;
    readonly limitReached?: boolean;
    readonly isTextContent?: boolean;
    readonly refreshFailure?: SharedRefreshFailure;
    readonly isEditable?: boolean;
    readonly editSource?: SharedEditSource;
    readonly editDisabledReason?: string;
    readonly sql?: string;
    readonly refreshSql?: string;
    readonly storageMode?: 'memory' | 'sqlite';
}

interface SharedEditSource {
    readonly db?: string;
    readonly schema?: string;
    readonly table: string;
}

interface SharedPendingEdit {
    readonly rowIndex: number;
    readonly columnIndex: number;
    readonly oldValue: unknown;
    readonly newValue: unknown;
}

interface SharedEditInfo {
    readonly isEditable: boolean;
    readonly editSource?: SharedEditSource;
    readonly reason?: string;
}

interface ResultRef {
    readonly sourceId: string;
    readonly resultSetIndex: number;
    readonly resultSetId: string;
    readonly executionId: string;
}

interface SharedPinnedResult {
    readonly id: string;
    readonly sourceUri: string;
    readonly resultSetIndex: number;
}

interface SharedRefreshFailure {
    readonly message: string;
    readonly sql?: string;
    readonly failedAt: number;
}

function defaultSharedCopyFormat(): SharedCopyFormat {
    const configured = (globalThis as { defaultCopyFormat?: unknown }).defaultCopyFormat;
    return isSharedCopyFormat(configured) ? configured : 'markdown';
}

function parseSharedPinnedResults(value: unknown): readonly SharedPinnedResult[] {
    let parsed: unknown = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(candidate => {
        if (!isRecord(candidate)) return [];
        const sourceUri = asNonEmptyString(candidate.sourceUri);
        const resultSetIndex = asNonNegativeInteger(candidate.resultSetIndex);
        if (!sourceUri || resultSetIndex === undefined) return [];
        return [{
            id: asNonEmptyString(candidate.id) ?? `${sourceUri}:${resultSetIndex}`,
            sourceUri,
            resultSetIndex,
        }];
    });
}

interface SharedResultPanelData {
    readonly resultSetsMsgPack?: unknown;
    readonly resultSetsJson?: unknown;
    readonly sqlQueueJson?: unknown;
    readonly activeSourceJson?: unknown;
    readonly activeResultSetIndex?: unknown;
    readonly executingSourcesJson?: unknown;
    readonly pinnedResultsJson?: unknown;
    readonly formatSettings?: unknown;
    readonly queryRowLimit?: unknown;
    readonly dataVersion?: unknown;
    readonly resultSyncVersion?: unknown;
    readonly resultPanelTraceEnabled?: unknown;
}

const SHARED_ROOT_ID = 'shared-ui-root';
const SHARED_STYLE_ID = 'justybase-shared-result-panel-styles';
const SHARED_MOUNT_FLAG = '__JUSTYBASE_SHARED_RESULT_PANEL_MOUNTED__';
const SHARED_VIEW_STATE_KEY = '_sharedGridViewState';
const SHARED_VIEW_STATE_LIMIT = 80;

const resultPanelCapabilities: readonly CapabilityDescriptor[] = [
    {
        key: 'result-panel.data-grid',
        status: 'available',
        owner: 'VS Code Result Panel shared adapter',
        documentation: 'docs/ARCHITECTURE.md#result-panel-state-and-identity',
        removalCondition: 'Retained to document the shared data grid capability.',
    },
    {
        key: 'result-panel.schema-navigation',
        status: 'unavailable',
        owner: 'VS Code metadata host adapter',
        reason: 'Schema navigation remains host-owned while the Result Panel migration is in progress.',
        documentation: 'docs/ARCHITECTURE.md#runtime-boundaries',
        removalCondition: 'Expose MetadataPort-backed schema nodes from the VS Code host.',
    },
    {
        key: 'result-panel.guarded-edit',
        status: 'available',
        owner: 'VS Code Result Panel host',
        documentation: 'docs/TESTING_STRATEGY.md#stateful-and-asynchronous-behavior',
        removalCondition: 'Move the confirmation and statement builder behind ResultPort when the host adapter is extracted.',
    },
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSharedResultSetPayload(value: unknown): SharedResultSetPayload | undefined {
    return isRecord(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseJsonString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
        return asNonEmptyString(JSON.parse(value));
    } catch {
        return undefined;
    }
}

function parseJsonStrings(value: unknown): readonly string[] {
    if (typeof value !== 'string') return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === 'string')
            : [];
    } catch {
        return [];
    }
}

function toByteArray(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
    const bytes = value.data.filter((item): item is number =>
        typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255,
    );
    return Uint8Array.from(bytes);
}

/** Decode a host row payload without ever putting the byte buffer in ui-core. */
export function decodeSharedRows(value: unknown): readonly unknown[][] {
    if (Array.isArray(value)) {
        return value.filter((row): row is unknown[] => Array.isArray(row));
    }
    const bytes = toByteArray(value);
    if (!bytes) return [];
    try {
        const decoded: unknown = decode(bytes);
        return Array.isArray(decoded)
            ? decoded.filter((row): row is unknown[] => Array.isArray(row))
            : [];
    } catch {
        return [];
    }
}

export function normalizeSharedColumns(value: unknown): readonly SharedColumn[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
        if (!isRecord(item)) return [];
        const name = asNonEmptyString(item.name) ?? asNonEmptyString(item.header);
        if (!name) return [];
        const type = typeof item.type === 'string' ? item.type : undefined;
        const scale = typeof item.scale === 'number' && Number.isInteger(item.scale) && item.scale >= 0 && item.scale <= 1000
            ? item.scale
            : undefined;
        return [{ name, ...(type === undefined ? {} : { type }), ...(scale === undefined ? {} : { scale }) }];
    });
}

export function normalizeSharedResultSet(value: unknown): NormalizedResultSet | undefined {
    const candidate = asSharedResultSetPayload(value);
    if (!candidate) return undefined;
    const rows = decodeSharedRows(candidate.data);
    const totalRowCount = Math.max(
        rows.length,
        asNonNegativeInteger(candidate.totalRowCount) ?? rows.length,
    );
    return {
        resultSetId: asNonEmptyString(candidate.resultSetId),
        executionTimestamp: typeof candidate.executionTimestamp === 'number'
            && Number.isFinite(candidate.executionTimestamp)
            ? candidate.executionTimestamp
            : undefined,
        columns: normalizeSharedColumns(candidate.columns),
        rows,
        message: typeof candidate.message === 'string' ? candidate.message : undefined,
        errorDetails: isDatabaseErrorDetails(candidate.errorDetails) ? candidate.errorDetails : undefined,
        isLog: candidate.isLog === true,
        isError: candidate.isError === true,
        isCancelled: candidate.isCancelled === true,
        isStreamingComplete: typeof candidate.isStreamingComplete === 'boolean'
            ? candidate.isStreamingComplete
            : undefined,
        totalRowCount,
        limitReached: candidate.limitReached === true,
        isTextContent: candidate.isTextContent === true,
        refreshFailure: normalizeSharedRefreshFailure(candidate.refreshFailure),
        isEditable: candidate.isEditable === true,
        editSource: normalizeSharedEditSource(candidate.editSource),
        editDisabledReason: asNonEmptyString(candidate.editDisabledReason),
        sql: asNonEmptyString(candidate.sql),
        refreshSql: asNonEmptyString(candidate.refreshSql),
        storageMode: candidate.storageMode === 'sqlite' || candidate.storageMode === 'memory'
            ? candidate.storageMode
            : undefined,
    };
}

function normalizeSharedRefreshFailure(value: unknown): SharedRefreshFailure | undefined {
    if (!isRecord(value)) return undefined;
    const message = asNonEmptyString(value.message);
    if (!message) return undefined;
    return {
        message,
        ...(asNonEmptyString(value.sql) === undefined ? {} : { sql: asNonEmptyString(value.sql)! }),
        failedAt: typeof value.failedAt === 'number' && Number.isFinite(value.failedAt) ? value.failedAt : Date.now(),
    };
}

function normalizeSharedEditSource(value: unknown): SharedEditSource | undefined {
    if (!isRecord(value)) return undefined;
    const table = asNonEmptyString(value.table);
    if (!table) return undefined;
    const db = asNonEmptyString(value.db);
    const schema = asNonEmptyString(value.schema);
    return {
        ...(db === undefined ? {} : { db }),
        ...(schema === undefined ? {} : { schema }),
        table,
    };
}

function persistedViewKey(sourceId: string, resultSetId: string): string {
    return `${sourceId}\u0000${resultSetId}`;
}

function readPersistedSharedViews(): Map<string, UiResultSurfaceState['view']> {
    const state = getHostState();
    const stored = isRecord(state) && isRecord(state[SHARED_VIEW_STATE_KEY])
        ? state[SHARED_VIEW_STATE_KEY] as Record<string, unknown>
        : {};
    const views = new Map<string, UiResultSurfaceState['view']>();
    for (const [key, value] of Object.entries(stored)) {
        if (!isRecord(value)) continue;
        views.set(key, value as unknown as UiResultSurfaceState['view']);
    }
    return views;
}

function resultSetsFromData(data: SharedResultPanelData): readonly NormalizedResultSet[] {
    let decoded: unknown;
    const bytes = toByteArray(data.resultSetsMsgPack);
    if (bytes) {
        try {
            decoded = decode(bytes);
        } catch {
            decoded = undefined;
        }
    } else if (typeof data.resultSetsJson === 'string') {
        try {
            decoded = JSON.parse(data.resultSetsJson);
        } catch {
            decoded = undefined;
        }
    }
    return Array.isArray(decoded)
        ? decoded.flatMap(item => {
            const normalized = normalizeSharedResultSet(item);
            return normalized ? [normalized] : [];
        })
        : [];
}

function affectsFilterHistory(patch: Partial<UiResultSurfaceState['view']>): boolean {
    return 'globalFilter' in patch
        || 'columnFilters' in patch
        || 'columnFilterDefinitions' in patch;
}

function affectsDiskQuery(patch: Partial<UiResultSurfaceState['view']>): boolean {
    return 'globalFilter' in patch
        || 'columnFilters' in patch
        || 'columnFilterDefinitions' in patch
        || 'sorting' in patch;
}

function sourceIndexKey(sourceId: string, resultSetIndex: number): string {
    return `${sourceId}\u0000${resultSetIndex}`;
}

/** FNV-1a fingerprint used by the gated extension-host test bridge. */
function sharedTestBridgeFingerprint(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sharedBridgeSleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForSharedBridge(
    description: string,
    predicate: () => boolean,
    timeoutMs = 15_000,
): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt >= timeoutMs) {
            throw new Error(`Test bridge timed out waiting for ${description}.`);
        }
        await sharedBridgeSleep(25);
    }
}

function eventBase(ref: ResultRef, sequence: number): Pick<UiResultEvent, 'sourceId' | 'executionId' | 'resultSetId' | 'sequence'> {
    return {
        sourceId: ref.sourceId,
        executionId: ref.executionId,
        resultSetId: ref.resultSetId,
        sequence,
    };
}

function csvCell(value: unknown): string {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function rawCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value) ?? String(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function rowsAsCsv(columns: readonly SharedColumn[], rows: readonly (readonly unknown[])[], useFormattedValues = true): string {
    const header = columns.map(column => csvCell(column.name)).join(',');
    const body = rows.map(row => row.map((value, index) => csvCell(useFormattedValues
        ? (value === null || value === undefined ? '' : formatDataGridCellValue(value, columns[index]?.type, columns[index]))
        : rawCell(value))).join(',')).join('\n');
    return [header, body].filter(Boolean).join('\n');
}

function rowsAsJson(columns: readonly SharedColumn[], rows: readonly (readonly unknown[])[]): string {
    return JSON.stringify(rows.map(row => Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? null]))), null, 2);
}

function xmlEscape(value: string): string {
    return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function xmlElementName(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9_.-]/gu, '_');
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function rowsAsXml(columns: readonly SharedColumn[], rows: readonly (readonly unknown[])[]): string {
    const names = columns.map((column, index) => {
        const base = xmlElementName(column.name || `column_${index + 1}`);
        return columns.slice(0, index).some(previous => xmlElementName(previous.name) === base) ? `${base}_${index + 1}` : base;
    });
    const body = rows.map(row => `  <row>${names.map((name, index) => {
        const value = row[index];
        return value === null || value === undefined
            ? `<${name} />`
            : `<${name}>${xmlEscape(rawCell(value))}</${name}>`;
    }).join('')}</row>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${body}\n</rows>`;
}

function sqlIdentifier(name: string): string {
    return `"${name.replace(/"/gu, '""')}"`;
}

function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Uint8Array) return `X'${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}'`;
    return `'${String(value).replace(/'/gu, "''")}'`;
}

function rowsAsSqlInsert(columns: readonly SharedColumn[], rows: readonly (readonly unknown[])[]): string {
    const columnList = columns.map(column => sqlIdentifier(column.name)).join(', ');
    return rows.map(row => `INSERT INTO ${sqlIdentifier('result')} (${columnList}) VALUES (${row.map(sqlLiteral).join(', ')});`).join('\n');
}

function rowsAsMarkdown(columns: readonly SharedColumn[], rows: readonly (readonly unknown[])[]): string {
    const cell = (value: unknown): string => rawCell(value).replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
    const header = `| ${columns.map(column => cell(column.name)).join(' | ')} |`;
    const separator = `| ${columns.map(() => '---').join(' | ')} |`;
    return [header, separator, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

/** Returns the numeric LIMIT at the end of a refresh statement, if present. */
export function sharedRefreshLimit(sql: string | undefined): string | undefined {
    if (!sql) return undefined;
    const match = /(?:^|\s)limit\s+(\d+)\s*;?\s*$/iu.exec(sql.trim());
    return match?.[1];
}

function sharedColumnFormatting(
    settings: unknown,
    column: { readonly name: string },
    columnIndex: number,
): DataGridFormattingOptions | undefined {
    if (!isRecord(settings)) return undefined;
    const global = isRecord(settings.global) ? settings.global : {};
    const connection = isRecord(settings.connection) ? settings.connection : {};
    const overrides = isRecord(settings.columnOverrides) ? settings.columnOverrides : {};
    const override = overrides[column.name] ?? overrides[String(columnIndex)];
    const columnOverride = isRecord(override) ? override : {};
    const integer = {
        ...(isRecord(global.integer) ? global.integer : {}),
        ...(isRecord(connection.integer) ? connection.integer : {}),
        ...(isRecord(columnOverride.integer) ? columnOverride.integer : {}),
    };
    const decimal = {
        ...(isRecord(global.decimal) ? global.decimal : {}),
        ...(isRecord(connection.decimal) ? connection.decimal : {}),
        ...(isRecord(columnOverride.decimal) ? columnOverride.decimal : {}),
    };
    if (Object.keys(integer).length === 0 && Object.keys(decimal).length === 0) return undefined;
    return {
        ...(Object.keys(integer).length === 0 ? {} : { integer }),
        ...(Object.keys(decimal).length === 0 ? {} : { decimal }),
    } as DataGridFormattingOptions;
}

function asyncStateFor(result: UiResultSurfaceState | undefined, rowCount: number) {
    return getResultAsyncState(result, rowCount, {
        streamingEmpty: 'loading',
        streamingWithUnloadedRows: 'loading',
    });
}

export function displaySharedRows(
    rows: readonly (readonly unknown[])[],
    columns: readonly SharedColumn[],
    filter: string,
    sorting: UiResultSurfaceState['view']['sorting'],
): readonly (readonly unknown[])[] {
    return processDataGridRows(columns, rows, {
        globalFilter: filter,
        columnFilters: {},
        sorting,
        grouping: [],
    });
}

const SHARED_FILTER_VALUE_LIMIT = 10_000;
/** Groups enumerated from the SQLite spill for authoritative band counts. */
const SHARED_DISK_GROUP_PAGE_LIMIT = 10_000;
/** Nested grouping levels are fetched only for this many top-level parents. */
const SHARED_DISK_GROUP_NESTED_PARENT_LIMIT = 100;

function sharedFilterValueKey(value: unknown): string {
    if (value === undefined) return 'undefined';
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Builds the Excel-style filter state from the currently loaded, unfiltered rows. */
export function buildSharedFilterState(
    request: DataGridColumnFilterRequest,
    rows: readonly (readonly unknown[])[],
    view: UiResultSurfaceState['view'],
): DataGridColumnFilterState {
    const column = request.column;
    const options: DataGridFilterValueOption[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const value = row[request.columnIndex];
        if (value === null || value === undefined) continue;
        const key = sharedFilterValueKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ key, value, label: formatDataGridCellValue(value, column.type, column) });
        if (options.length >= SHARED_FILTER_VALUE_LIMIT) break;
    }
    options.sort((left, right) => left.label.localeCompare(right.label));
    const definition = view.columnFilterDefinitions?.[column.name];
    const legacyValue = view.columnFilters[column.name]?.trim() ?? '';
    const operator = definition?.operator ?? (legacyValue ? 'contains' : 'in');
    const primaryValue = definition?.value ?? legacyValue;
    const primaryValue2 = definition?.value2 ?? '';
    const conditions = operator === 'in'
        ? undefined
        : definition?.conditions !== undefined && definition.conditions.length > 0
            ? definition.conditions.map(condition => ({
                operator: condition.operator,
                value: condition.value,
                ...(condition.value2 === undefined ? {} : { value2: condition.value2 }),
            }))
            : [{ operator, value: primaryValue, ...(primaryValue2 === '' ? {} : { value2: primaryValue2 }) }];
    const selectedKeys = definition?.operator === 'in' && definition.values !== undefined
        ? definition.values.map(sharedFilterValueKey).filter(key => seen.has(key))
        : options.map(option => option.key);
    const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
    const margin = 8;
    const spaceBelow = viewportHeight - request.anchor.bottom - 4 - margin;
    const spaceAbove = request.anchor.top - 4 - margin;
    // A filter menu anchored near the bottom of a short result panel used to
    // extend past the viewport and hide its footer buttons. Flip it above the
    // header and cap both cases to the space that actually exists.
    const openAbove = spaceBelow < 300 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, Math.min(520, openAbove ? spaceAbove : spaceBelow));
    return {
        columnIndex: request.columnIndex,
        columnName: column.name,
        left: Math.max(8, Math.min(request.anchor.left, viewportWidth - 356)),
        top: openAbove ? Math.max(margin, request.anchor.top - 4 - maxHeight) : Math.max(margin, request.anchor.bottom + 4),
        maxHeight,
        options,
        selectedKeys,
        operator,
        value: primaryValue,
        value2: primaryValue2,
        ...(conditions === undefined ? {} : { conditions }),
        ...(definition?.logic === undefined ? {} : { conditionLogic: definition.logic }),
        search: '',
        loading: false,
        truncated: options.length >= SHARED_FILTER_VALUE_LIMIT,
        dirty: false,
    };
}

interface SharedDatabaseGroupingRequest {
    readonly groupByColumns: readonly { readonly columnIndex: number; readonly columnName: string }[];
    readonly functions: readonly { readonly fn: string; readonly columnIndex?: number; readonly alias?: string }[];
    readonly limit?: number | null;
    readonly filterSpec?: DiskQuerySpec;
    /** Output-column indexes; pivots order by row and pivot dimensions, never by the measure. */
    readonly orderBy?: readonly { readonly columnIndex: number; readonly desc?: boolean }[];
}

function isNumericSharedColumn(column: Pick<SharedColumn, 'type'>): boolean {
    return /(?:bigint|smallint|tinyint|integer|int|serial|decimal|numeric|number|double|float|real|money|^dec)/iu.test(column.type ?? '');
}

export function sharedAnalysisQuerySpec(
    result: UiResultSurfaceState,
    excludeColumnName?: string,
): DiskQuerySpec | undefined {
    const globalSearch = result.view.globalFilter.trim();
    const definitions = result.view.columnFilterDefinitions ?? {};
    const columnFilters: DiskColumnFilterSpec[] = [];
    for (const [name, definition] of Object.entries(definitions)) {
        if (name === excludeColumnName) continue;
        const columnIndex = result.columns.findIndex(column => column.name === name);
        if (columnIndex < 0) continue;
        if (definition.operator === 'in') {
            if ((definition.values?.length ?? 0) > 0) {
                columnFilters.push({ columnIndex, values: [...(definition.values ?? [])] });
            }
            continue;
        }
        const conditions = (definition.conditions !== undefined && definition.conditions.length > 0
            ? definition.conditions
            : [definition])
            .filter(condition => condition.operator !== 'in');
        if (conditions.length === 0) continue;
        columnFilters.push({
            columnIndex,
            conditions: conditions.map(condition => ({
                type: condition.operator,
                value: condition.value,
                ...(condition.value2 === undefined ? {} : { value2: condition.value2 }),
            })),
            ...(conditions.length > 1 ? { conditionLogic: definition.logic ?? 'and' } : {}),
        });
    }
    for (const [name, value] of Object.entries(result.view.columnFilters)) {
        if (name === excludeColumnName) continue;
        if (definitions[name] !== undefined) continue;
        const normalized = value.trim();
        if (!normalized) continue;
        const columnIndex = result.columns.findIndex(column => column.name === name);
        if (columnIndex < 0) continue;
        columnFilters.push({
            columnIndex,
            conditions: [{ type: 'contains', value: normalized }],
        });
    }
    const spec: DiskQuerySpec = {
        ...(globalSearch ? { globalSearch } : {}),
        ...(columnFilters.length > 0 ? { columnFilters } : {}),
    };
    return spec.globalSearch || (spec.columnFilters?.length ?? 0) > 0 ? spec : undefined;
}

/** Disk-window query spec: the same filters plus the grid's sort order. */
export function sharedDiskQuerySpec(
    result: UiResultSurfaceState,
    excludeColumnName?: string,
): DiskQuerySpec | undefined {
    const base = sharedAnalysisQuerySpec(result, excludeColumnName);
    const sorting = result.view.sorting.flatMap(item => {
        const columnIndex = result.columns.findIndex(column => column.name === item.column);
        return columnIndex < 0 ? [] : [{ columnIndex, desc: item.descending }];
    });
    if (sorting.length === 0) return base;
    return { ...(base ?? {}), sorting };
}

function toAggregateAnalysisTable(
    columns: readonly UiResultColumn[],
    result: UiResultSurfaceState,
    aggregations: readonly { readonly columnIndex: number; readonly fn: string; readonly value: unknown; readonly filteredRowCount?: number }[],
): UiResultAnalysisTable {
    const values = new Map<number, {
        columnIndex: number;
        count: number;
        sum?: number | string | null;
        avg?: number | string | null;
        min?: unknown;
        max?: unknown;
    }>();
    let filteredRowCount = result.totalRowCount;
    for (const aggregation of aggregations) {
        const current = values.get(aggregation.columnIndex) ?? {
            columnIndex: aggregation.columnIndex,
            count: 0,
        };
        if (aggregation.fn === 'count') {
            const count = typeof aggregation.value === 'number' ? aggregation.value : Number(aggregation.value);
            current.count = Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
        } else if (aggregation.fn === 'sum') {
            current.sum = typeof aggregation.value === 'number' || typeof aggregation.value === 'string'
                ? aggregation.value
                : aggregation.value == null ? null : String(aggregation.value);
        } else if (aggregation.fn === 'avg') {
            current.avg = typeof aggregation.value === 'number' || typeof aggregation.value === 'string'
                ? aggregation.value
                : aggregation.value == null ? null : String(aggregation.value);
        } else if (aggregation.fn === 'min') {
            current.min = aggregation.value;
        } else if (aggregation.fn === 'max') {
            current.max = aggregation.value;
        }
        if (aggregation.filteredRowCount !== undefined) {
            filteredRowCount = aggregation.filteredRowCount;
        }
        values.set(aggregation.columnIndex, current);
    }
    return createAggregateAnalysisTable(columns, {
        filteredRowCount,
        values: [...values.values()],
    });
}

function toGroupAnalysisTable(
    message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseGroupingResult' }>,
): UiResultAnalysisTable {
    return createGroupAnalysisTable({
        columns: (message.columns ?? []).map(column => ({ name: column.name, type: column.type })),
        rows: message.rows ?? [],
        totalGroups: message.totalRows ?? message.rows?.length ?? 0,
    });
}

function toPivotAnalysisTable(
    columns: readonly UiResultColumn[],
    message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseGroupingResult' }>,
    plan: SharedPivotPlan,
): UiResultAnalysisTable {
    return createPivotAnalysisTable(
        columns,
        {
            columns: (message.columns ?? []).map(column => ({ name: column.name, type: column.type })),
            rows: message.rows ?? [],
            totalGroups: message.totalRows ?? message.rows?.length ?? 0,
            truncated: message.truncated === true,
        },
        plan.rowColumnIndex,
        plan.pivotColumnIndex,
        plan.valueColumnIndex,
        `${PIVOT_AGGREGATION_LABELS[plan.aggregation]} of ${columns[plan.valueColumnIndex]?.name ?? 'value'}`,
    );
}

interface SharedPivotPlan {
    readonly rowColumnIndex: number;
    readonly pivotColumnIndex: number;
    readonly valueColumnIndex: number;
    readonly aggregation: PivotAggregation;
}

const PIVOT_AGGREGATION_LABELS: Record<PivotAggregation, string> = {
    sum: 'Sum',
    count: 'Count',
    avg: 'Average',
    min: 'Min',
    max: 'Max',
};

interface PendingAnalysisRequest {
    readonly kind: UiResultAnalysisKind;
    readonly ref: ResultRef;
    readonly pivot?: SharedPivotPlan;
    readonly resolve: (table: UiResultAnalysisTable) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

function sampledDistinctCount(rows: readonly (readonly unknown[])[], columnIndex: number, limit = 200): number {
    const values = new Set<string>();
    const sampleSize = Math.min(rows.length, 200);
    for (let index = 0; index < sampleSize && values.size < limit; index += 1) {
        const value = rows[index]?.[columnIndex];
        values.add(value === null || value === undefined ? '\u0000NULL' : String(value));
    }
    return values.size;
}

/**
 * Matches the legacy Explore Pivot defaults: the first dimension supplies the
 * rows and a numeric measure supplies the values. The column dimension is the
 * most compact categorical column so a quick pivot does not explode into
 * hundreds of columns when the second dimension happens to be an identifier.
 * A configured pivot (the Explore tab) remains authoritative for exact choice.
 */
function chooseSharedPivotPlan(
    columns: readonly SharedColumn[],
    rows: readonly (readonly unknown[])[],
): SharedPivotPlan | undefined {
    if (columns.length < 3) return undefined;
    const roles = classifyColumns(columns.map(column => ({ name: column.name, type: column.type })), rows);
    const dimensions = roles
        .map((role, index) => ({ role, index }))
        .filter(item => item.role !== 'measure');
    const measures = roles
        .map((role, index) => ({ role, index }))
        .filter(item => item.role === 'measure');
    const row = dimensions[0]?.index;
    if (row === undefined) return undefined;
    const columnCandidates = dimensions.filter(item => item.index !== row);
    if (columnCandidates.length === 0) return undefined;
    const pivot = columnCandidates.reduce((best, candidate) =>
        sampledDistinctCount(rows, candidate.index) < sampledDistinctCount(rows, best.index) ? candidate : best,
    ).index;
    const value = measures.find(item => item.index !== row && item.index !== pivot)?.index;
    if (value === undefined) return undefined;
    return { rowColumnIndex: row, pivotColumnIndex: pivot, valueColumnIndex: value, aggregation: 'sum' };
}

function capability(capabilities: readonly CapabilityDescriptor[], key: string): CapabilityDescriptor | undefined {
    return capabilities.find(item => item.key === key);
}

export class SharedResultPanelController {
    private readonly store: UiStore;
    private readonly listeners = new Set<() => void>();
    private readonly rows = new Map<string, readonly unknown[][]>();
    private readonly refs = new Map<string, ResultRef>();
    private readonly editability = new Map<string, SharedEditInfo>();
    private readonly resultKinds = new Map<string, { readonly isLog: boolean; readonly isTextContent: boolean }>();
    private readonly pendingEdits = new Map<string, Map<string, SharedPendingEdit>>();
    private readonly pendingDeletes = new Map<string, Set<number>>();
    private readonly filterHistory = new Map<string, {
        readonly past: UiResultSurfaceState['view'][];
        readonly future: UiResultSurfaceState['view'][];
    }>();
    private applyingFilterHistory = false;
    private editMode = false;
    private readonly nextSequence = new Map<string, number>();
    private readonly nextChunkSequence = new Map<string, number>();
    private readonly cancelRequests = new Map<string, string>();
    private readonly pendingRowWindows = new Map<number, { readonly ref: ResultRef; readonly offset: number }>();
    private readonly pendingRowFetches = new Map<number, {
        readonly ref: ResultRef;
        readonly offset: number;
        readonly resolve: (rows: readonly unknown[][], totalRows: number | undefined) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly pendingAnalysisRequests = new Map<number, PendingAnalysisRequest>();
    private readonly diskBacked = new Set<string>();
    private readonly resultSql = new Map<string, { readonly sql?: string; readonly refreshSql?: string }>();
    private copyFormat: SharedCopyFormat = defaultSharedCopyFormat();
    private pinnedResults: readonly SharedPinnedResult[] = [];
    private formatSettings: unknown;
    private queryRowLimit = 200_000;
    private sqlQueueJson: string | undefined;
    private executingSources = new Set<string>();
    /** When the current execution for a source started (webview clock). */
    private executionStartedAt = new Map<string, number>();
    /** Sources whose cancellation was requested but not finished yet. */
    private cancellingSources = new Set<string>();
    private readonly refreshFailures = new Map<string, SharedRefreshFailure>();
    private readonly limitReached = new Set<string>();
    private readonly diskQuerySpecKeys = new Map<string, string>();
    private readonly pendingFilterValues = new Map<number, {
        readonly ref: ResultRef;
        readonly columnIndex: number;
        readonly column: UiResultColumn;
        readonly resolve: (values: readonly DataGridFilterValueOption[], truncated: boolean) => void;
        readonly reject: (error: Error) => void;
    }>();
    private filterValueRequestId = 0;
    private readonly pendingDatabaseAggregations = new Map<number, {
        readonly resolve: (values: readonly { readonly columnIndex: number; readonly fn: string; readonly value: unknown; readonly filteredRowCount?: number }[]) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly pendingDatabaseFilterValues = new Map<number, {
        readonly resolve: (values: readonly { readonly raw: unknown; readonly count: number }[], truncated: boolean) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly pendingDatabaseGrouping = new Map<number, {
        readonly resolve: (message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseGroupingResult' }>) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly pendingDiskQueries = new Map<number, {
        readonly action: 'count' | 'distinct' | 'aggregate' | 'group';
        readonly resolve: (message: Extract<ResultPanelHostToWebviewMessage, { command: 'diskQueryResult' }>) => void;
        readonly reject: (error: Error) => void;
        readonly timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly diskGroupData = new Map<string, {
        readonly signature: string;
        readonly counts: ReadonlyMap<string, number>;
        readonly extraGroups: readonly DataGridExtraGroup[];
        readonly partial: boolean;
    }>();
    private testQueryRequestId = 0;
    private testExploreWorkflowActive = false;
    /** Source whose Logs tab the user selected explicitly; new data must not steal it. */
    private manualLogSelection: string | undefined;
    /** Latest non-log result per source, used when activation reports Logs first. */
    private preferredDataResults = new Map<string, string>();
    /** Execution timestamp last seen for a result set, to detect reruns reusing its id. */
    private executionTimestamps = new Map<string, number>();
    private bridgeGrouping: {
        readonly resultSetId: string;
        readonly columns: readonly number[];
        readonly functions: readonly { readonly fn: string; readonly columnIndex?: number }[];
    } | undefined;
    private readonly persistedViews = readPersistedSharedViews();
    private persistTimer: ReturnType<typeof setTimeout> | undefined;
    private revision = 0;
    private streamRevision = 0;
    private rowRequestId = 0;
    private analysisRequestId = 0;
    private disposed = false;
    private traceEnabled = false;
    private traceSequence = 0;

    public constructor() {
        const identity: UiIdentity = { productId: 'vscode', workspaceId: 'result-panel' };
        this.store = createUiStore(createInitialUiState(identity, {
            persistenceScope: 'global',
            capabilities: resultPanelCapabilities,
        }));
    }

    public getState(): UiState {
        return this.store.getState();
    }

    public getRevision(): number {
        return this.revision;
    }

    public isDiskBackedResult(result: UiResultSurfaceState | undefined): boolean {
        return result ? this.diskBacked.has(resultKey(result.sourceId, result.resultSetId)) : false;
    }

    public getDiskGroupData(result: UiResultSurfaceState | undefined): {
        readonly counts: ReadonlyMap<string, number>;
        readonly extraGroups: readonly DataGridExtraGroup[];
        readonly partial: boolean;
    } | undefined {
        if (!result) return undefined;
        return this.diskGroupData.get(resultKey(result.sourceId, result.resultSetId));
    }

    private formatDiskGroupPath(result: UiResultSurfaceState, path: readonly DiskGroupPathItem[]): string[] {
        return path.map(item => {
            const column = item.columnIndex >= 0 ? result.columns[item.columnIndex] : undefined;
            return formatDataGridCellValue(item.value, column?.type, column);
        });
    }

    /**
     * Group bands for a spilled result must count every row in SQLite, not only
     * the page held by the webview. The host already owns the exact GROUP BY
     * tree; this asks for it and hands authoritative counts to the grid.
     */
    private async refreshDiskGroupCounts(result: UiResultSurfaceState): Promise<void> {
        const key = resultKey(result.sourceId, result.resultSetId);
        const grouping = result.view.grouping;
        if (!this.isDiskBackedResult(result) || grouping.length === 0) {
            if (this.diskGroupData.delete(key)) this.notify();
            return;
        }
        const levels = grouping.flatMap(name => {
            const columnIndex = result.columns.findIndex(column => column.name === name);
            return columnIndex < 0 ? [] : [{ columnIndex }];
        });
        if (levels.length !== grouping.length) {
            if (this.diskGroupData.delete(key)) this.notify();
            return;
        }
        const spec = sharedDiskQuerySpec(result);
        const signature = JSON.stringify({
            executionId: result.executionId,
            lastSequence: result.lastSequence,
            grouping,
            spec: spec ?? null,
            totalRowCount: result.totalRowCount,
        });
        if (this.diskGroupData.get(key)?.signature === signature) return;

        const requestGroups = async (path: readonly DiskGroupPathItem[]): Promise<DiskGroupQueryResult | undefined> => {
            const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
            if (!ref) return undefined;
            const requestId = ++this.testQueryRequestId;
            const message = await new Promise<Extract<ResultPanelHostToWebviewMessage, { command: 'diskQueryResult' }>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingDiskQueries.delete(requestId);
                    reject(new Error('Disk group query timed out.'));
                }, 15_000);
                this.pendingDiskQueries.set(requestId, { action: 'group', resolve, reject, timer });
                postHostMessage({
                    command: 'diskQuery',
                    sourceUri: result.sourceId,
                    resultSetIndex: ref.resultSetIndex,
                    requestId,
                    action: 'group',
                    ...(spec === undefined ? {} : { querySpec: spec }),
                    grouping: levels,
                    groupPath: path.map(item => ({ ...item })),
                    offset: 0,
                    limit: SHARED_DISK_GROUP_PAGE_LIMIT,
                });
            });
            return message.groupResult;
        };

        try {
            const root = await requestGroups([]);
            if (!root) {
                this.diskGroupData.delete(key);
                this.notify();
                return;
            }
            const counts = new Map<string, number>();
            const extraGroups: DataGridExtraGroup[] = [];
            let partial = (root.groups?.length ?? 0) < root.totalCount;
            for (const group of root.groups ?? []) {
                const path = this.formatDiskGroupPath(result, group.path);
                counts.set(JSON.stringify(path), group.count);
                extraGroups.push({ path, count: group.count });
            }
            if (levels.length > 1) {
                for (const parent of (root.groups ?? []).slice(0, SHARED_DISK_GROUP_NESTED_PARENT_LIMIT)) {
                    const children = await requestGroups(parent.path);
                    if (!children) continue;
                    if ((children.groups?.length ?? 0) < children.totalCount) partial = true;
                    for (const group of children.groups ?? []) {
                        const path = this.formatDiskGroupPath(result, group.path);
                        counts.set(JSON.stringify(path), group.count);
                        extraGroups.push({ path, count: group.count });
                    }
                }
            }
            this.diskGroupData.set(key, { signature, counts, extraGroups, partial });
            this.notify();
        } catch {
            // Fall back to local counts instead of showing stale exact numbers.
            if (this.diskGroupData.delete(key)) this.notify();
        }
    }

    public getResultSql(result: UiResultSurfaceState | undefined): { readonly sql?: string; readonly refreshSql?: string } | undefined {
        return result ? this.resultSql.get(resultKey(result.sourceId, result.resultSetId)) : undefined;
    }

    public getRows(result: UiResultSurfaceState | undefined): readonly unknown[][] {
        if (!result) return [];
        const key = resultKey(result.sourceId, result.resultSetId);
        const base = this.rows.get(key) ?? [];
        const edits = this.pendingEdits.get(key);
        if (!edits || edits.size === 0) return base;
        const next = [...base];
        for (const edit of edits.values()) {
            const row = next[edit.rowIndex];
            if (!row) continue;
            const copy = [...row];
            copy[edit.columnIndex] = edit.newValue;
            next[edit.rowIndex] = copy;
        }
        return next;
    }

    public getEditInfo(result: UiResultSurfaceState | undefined): SharedEditInfo | undefined {
        return result ? this.editability.get(resultKey(result.sourceId, result.resultSetId)) : undefined;
    }

    public isLogResult(result: UiResultSurfaceState | undefined): boolean {
        return result ? this.resultKinds.get(resultKey(result.sourceId, result.resultSetId))?.isLog === true : false;
    }

    public isTextContentResult(result: UiResultSurfaceState | undefined): boolean {
        return result ? this.resultKinds.get(resultKey(result.sourceId, result.resultSetId))?.isTextContent === true : false;
    }

    public getResultLabel(result: UiResultSurfaceState): string | undefined {
        if (this.isLogResult(result)) return 'Logs';
        if (this.isTextContentResult(result)) return 'MD Export';
        return undefined;
    }

    public getQueryRowLimit(): number {
        return this.queryRowLimit;
    }

    public getSqlQueueJson(): string | undefined {
        return this.sqlQueueJson;
    }

    public isSourceExecuting(sourceId: string | undefined): boolean {
        return sourceId !== undefined && this.executingSources.has(sourceId);
    }

    /** Wall-clock start of the current run for a source, used by elapsed indicators. */
    public getExecutionStartedAt(sourceId: string | undefined): number | undefined {
        return sourceId === undefined ? undefined : this.executionStartedAt.get(sourceId);
    }

    /** True between a Cancel click and the host acknowledging the cancellation. */
    public isSourceCancelling(sourceId: string | undefined): boolean {
        return sourceId !== undefined && this.cancellingSources.has(sourceId);
    }

    private setExecutingSources(sourceIds: readonly string[]): void {
        const next = new Set(sourceIds);
        const startedAt = Date.now();
        for (const sourceId of next) {
            if (!this.executionStartedAt.has(sourceId)) this.executionStartedAt.set(sourceId, startedAt);
        }
        for (const sourceId of [...this.executionStartedAt.keys()]) {
            if (!next.has(sourceId)) this.executionStartedAt.delete(sourceId);
        }
        // A finished execution resolves any pending cancellation.
        for (const sourceId of [...this.cancellingSources]) {
            if (!next.has(sourceId)) this.cancellingSources.delete(sourceId);
        }
        this.executingSources = next;
    }

    public getRefreshFailure(result: UiResultSurfaceState | undefined): SharedRefreshFailure | undefined {
        return result ? this.refreshFailures.get(resultKey(result.sourceId, result.resultSetId)) : undefined;
    }

    public getCopyFormat(): SharedCopyFormat {
        return this.copyFormat;
    }

    public getFormattingForColumn(column: { readonly name: string }, columnIndex: number): DataGridFormattingOptions | undefined {
        return sharedColumnFormatting(this.formatSettings, column, columnIndex);
    }

    public postColumnAction(
        result: UiResultSurfaceState,
        columnIndex: number,
        action: 'copyName' | 'copyQualifiedName' | 'addToSelect' | 'commentOnColumn' | 'findReferences' | 'toggleFavorite',
    ): void {
        const column = result.columns[columnIndex];
        if (!column) return;
        if (action === 'copyName') {
            postHostMessage({ command: 'copyToClipboard', text: column.name });
            return;
        }
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        const info = this.getEditInfo(result);
        postHostMessage({
            command: 'columnAction',
            sourceUri: result.sourceId,
            resultSetIndex: ref?.resultSetIndex ?? result.statementIndex,
            action,
            columnName: column.name,
            ...(info?.editSource ? { editSource: info.editSource } : {}),
        });
    }

    public isResultPinned(result: UiResultSurfaceState): boolean {
        return this.pinnedResults.some(pin =>
            pin.sourceUri === result.sourceId && pin.resultSetIndex === result.statementIndex,
        );
    }

    public toggleResultPin(result: UiResultSurfaceState): void {
        postHostMessage({
            command: 'toggleResultPin',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
        });
    }

    public closeResult(result: UiResultSurfaceState): void {
        postHostMessage({
            command: 'closeResult',
            sourceUri: result.sourceId,
            resultSetIndex: result.statementIndex,
        });
    }

    public clearLogs(sourceId: string | undefined): void {
        if (!sourceId) return;
        postHostMessage({ command: 'clearLogs', sourceUri: sourceId });
    }

    public calculateSelectionStats(
        result: UiResultSurfaceState | undefined,
        selection: DataGridSelection | undefined,
    ): ReturnType<typeof calculateGridSelectionStats> | null {
        if (!result || !selection || result.view.grouping.length > 0) return null;
        const bounds = normalizeGridSelection(selection);
        if (!bounds) return null;
        // Ctrl/Cmd+click keeps several rectangles; stats cover exactly the
        // toggled cells. The legacy grid skipped summaries above 100 cells.
        const ranges = [bounds, ...(selection.additionalRanges ?? [])];
        const cellCount = ranges.reduce(
            (count, range) => count + (range.maxRow - range.minRow + 1) * (range.maxColumn - range.minColumn + 1),
            0,
        );
        if (cellCount > 100) return null;
        const rows = this.getRows(result);
        const rowIndices = processDataGridRowIndices(result.columns, rows, result.view);
        const values: unknown[] = [];
        for (const range of ranges) {
            for (let row = range.minRow; row <= range.maxRow; row += 1) {
                const sourceIndex = rowIndices[row];
                const rowValues = sourceIndex === undefined ? undefined : rows[sourceIndex];
                if (!rowValues) continue;
                for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
                    values.push(rowValues[column]);
                }
            }
        }
        return calculateGridSelectionStats(values);
    }

    public isEditMode(): boolean {
        return this.editMode;
    }

    public getPendingEditCount(result: UiResultSurfaceState | undefined): number {
        if (!result) return 0;
        const key = resultKey(result.sourceId, result.resultSetId);
        return (this.pendingEdits.get(key)?.size ?? 0) + (this.pendingDeletes.get(key)?.size ?? 0);
    }

    public isRowDeleted(result: UiResultSurfaceState | undefined, rowIndex: number): boolean {
        return result ? this.pendingDeletes.get(resultKey(result.sourceId, result.resultSetId))?.has(rowIndex) === true : false;
    }

    public toggleRowDelete(result: UiResultSurfaceState, rowIndex: number): void {
        const key = resultKey(result.sourceId, result.resultSetId);
        const deletes = new Set(this.pendingDeletes.get(key) ?? []);
        if (deletes.has(rowIndex)) deletes.delete(rowIndex);
        else deletes.add(rowIndex);
        if (deletes.size === 0) this.pendingDeletes.delete(key);
        else this.pendingDeletes.set(key, deletes);
        this.notify();
    }

    public toggleEditMode(result: UiResultSurfaceState | undefined): void {
        const info = this.getEditInfo(result);
        if (!result || !info?.isEditable) return;
        this.editMode = !this.editMode;
        // Matches the DOM grid: leaving or entering edit mode starts a clean session.
        this.pendingEdits.clear();
        this.pendingDeletes.clear();
        this.notify();
    }

    public recordCellEdit(result: UiResultSurfaceState, edit: SharedPendingEdit): void {
        const key = resultKey(result.sourceId, result.resultSetId);
        const edits = this.pendingEdits.get(key) ?? new Map<string, SharedPendingEdit>();
        edits.set(`${edit.rowIndex}:${edit.columnIndex}`, edit);
        this.pendingEdits.set(key, edits);
        this.notify();
    }

    public discardEdits(result: UiResultSurfaceState | undefined): void {
        if (!result) return;
        const key = resultKey(result.sourceId, result.resultSetId);
        this.pendingEdits.delete(key);
        this.pendingDeletes.delete(key);
        this.notify();
    }

    public saveEdits(result: UiResultSurfaceState | undefined): void {
        if (!result) return;
        const info = this.getEditInfo(result);
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        const key = resultKey(result.sourceId, result.resultSetId);
        const edits = [...(this.pendingEdits.get(key)?.values() ?? [])];
        const deleteRowIndices = [...(this.pendingDeletes.get(key) ?? [])];
        if (!info?.isEditable || info.editSource === undefined || !ref || (edits.length === 0 && deleteRowIndices.length === 0)) return;
        postHostMessage({
            command: 'saveEdits',
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
            editSource: info.editSource,
            edits,
            ...(deleteRowIndices.length === 0 ? {} : { deleteRowIndices }),
        });
    }

    private clearEditSession(): void {
        this.editMode = false;
        this.pendingEdits.clear();
        this.pendingDeletes.clear();
    }

    public subscribe(listener: () => void): () => void {
        if (this.disposed) return () => undefined;
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public handleHostMessage(message: unknown): void {
        if (this.disposed) return;
        const valid = asHostMessage(message);
        if (!valid) return;
        switch (valid.command) {
            case 'hydrate':
                this.applyHydrate(valid.data as unknown as SharedResultPanelData);
                break;
            case 'setActiveSource':
                if (valid.formatSettings !== undefined) this.formatSettings = valid.formatSettings;
                this.setExecutingSources(parseJsonStrings(valid.executingSourcesJson));
                if (valid.pinnedResultsJson !== undefined) {
                    this.pinnedResults = parseSharedPinnedResults(valid.pinnedResultsJson);
                }
                this.selectSource(valid.sourceUri);
                if (valid.activeResultSetIndex === 0) {
                    if (!this.selectPreferredDataResult(valid.sourceUri)) {
                        this.selectLatestDataResult(valid.sourceUri);
                    }
                } else {
                    this.selectResultByIndex(valid.activeResultSetIndex);
                }
                this.notify();
                break;
            case 'resultFormattingState':
                this.formatSettings = valid.data;
                this.notify();
                break;
            case 'appendRows':
                this.applyAppend(valid);
                break;
            case 'streamingComplete':
                this.applyStreamingComplete(valid);
                break;
            case 'diskBackedActivate':
                this.applyDiskBackedActivate(valid);
                break;
            case 'rowCountUpdate':
                this.applyRowCountUpdate(valid);
                break;
            case 'rowWindow':
                // Legacy Explore/analytical disk samples use the same host
                // request. Resolve those first so the shared grid never
                // appends a sample page as if it were the next grid page.
                if (handleExploreRowWindow(valid as unknown as Record<string, unknown>)) break;
                this.applyRowWindow(valid);
                break;
            case 'diskQueryResult':
                this.applyDiskQueryResult(valid);
                break;
            case 'databaseAggregationResult':
                this.applyDatabaseAggregationResult(valid);
                break;
            case 'databaseFilterValuesResult':
                this.applyDatabaseFilterValuesResult(valid);
                break;
            case 'databaseGroupingResult':
                this.applyDatabaseGroupingResult(valid);
                break;
            case 'cancelExecution':
                if (valid.sourceUri) this.cancellingSources.delete(valid.sourceUri);
                this.applyCancellation(valid.sourceUri);
                break;
            case 'switchToResultSet':
                this.selectResultByIndex(valid.resultSetIndex);
                break;
            case 'sqlQueueState':
                this.sqlQueueJson = valid.lanesJson;
                this.notify();
                break;
            case 'refreshView':
                this.notify();
                break;
            case 'copySelection':
                this.copyActive();
                break;
            case 'updateCopyFormat':
                this.copyFormat = valid.copyFormat;
                break;
            case 'updateDefaultExcelFormat':
                (globalThis as { defaultExcelFormat?: string }).defaultExcelFormat = valid.defaultExcelFormat;
                break;
            case 'saveScrollState':
            case 'uxPerfSession':
            case 'databaseFilterApplyResult':
            case 'databaseGroupingPreviewResult':
            case 'saveEdits':
                break;
            case 'selectAll':
                // The shared grid owns select-all via its keyboard handling.
                break;
            case 'testBridge':
                void this.runTestBridgeAction(valid.requestId, valid.action, valid.args);
                break;
            case 'exploreOperationResult':
            case 'exploreFullStatsResult':
            case 'explorePivotResult':
            case 'explorePivotPreviewResult':
            case 'exploreComposerResult':
            case 'exploreComposerPreviewResult':
            case 'exploreFilteredSqlPreviewResult':
                handleExploreHostMessage(valid as unknown as { command: string; requestId?: number; error?: string } & Record<string, unknown>);
                break;
            default:
                break;
        }
    }

    public selectSource(sourceId: string | undefined): void {
        if (!sourceId) return;
        const hasSource = Object.values(this.getState().results.byResultSetId).some(result => result.sourceId === sourceId);
        if (!hasSource) {
            this.postResultSync(sourceId, 'shared-source-not-hydrated');
            return;
        }
        this.dispatch({ type: 'results/select-source', sourceId });
    }

    public setSurface(surface: UiState['shell']['activeSurface']): void {
        this.dispatch({ type: 'shell/surface', surface });
    }

    /**
     * The production shell returns to the table whenever the active result
     * changes. The traced Explore workflow deliberately switches result sets
     * to prove its state is restored, so it pins the layout for its duration.
     */
    public isTestExploreWorkflowActive(): boolean {
        return this.testExploreWorkflowActive;
    }

    public selectResult(resultSetId: string, sourceId?: string, explicit = true): void {
        const activeSourceId = sourceId ?? this.getState().results.activeSourceId;
        const result = Object.values(this.getState().results.byResultSetId)
            .find(candidate => candidate.resultSetId === resultSetId
                && (activeSourceId === undefined || candidate.sourceId === activeSourceId));
        if (!result) return;
        if (explicit) {
            this.manualLogSelection = this.isLogResult(result) ? result.sourceId : undefined;
        } else if (!this.isLogResult(result)) {
            this.manualLogSelection = undefined;
        }
        this.dispatch({ type: 'results/select', sourceId: result.sourceId, resultSetId });
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        postHostMessage({
            command: 'switchResultSet',
            sourceUri: result.sourceId,
            resultSetIndex: ref?.resultSetIndex ?? result.statementIndex,
        });
    }

    public updateView(resultSetId: string, patch: Partial<UiResultSurfaceState['view']>): void {
        const sourceId = this.getState().results.activeSourceId;
        if (!sourceId) return;
        const key = `${sourceId}\u0000${resultSetId}`;
        const before = Object.values(this.getState().results.byResultSetId)
            .find(result => result.sourceId === sourceId && result.resultSetId === resultSetId);
        if (!this.applyingFilterHistory && before && affectsFilterHistory(patch)) {
            const history = this.filterHistory.get(key) ?? { past: [], future: [] };
            const past = [...history.past, before.view].slice(-10);
            this.filterHistory.set(key, { past, future: [] });
        }
        this.dispatch({ type: 'results/view', sourceId, resultSetId, patch });
        const result = Object.values(this.getState().results.byResultSetId)
            .find(candidate => candidate.sourceId === sourceId && candidate.resultSetId === resultSetId);
        if (!result) return;
        this.schedulePersistView(result);
        if (affectsDiskQuery(patch) && this.isDiskBackedResult(result)) this.resetDiskWindow(result);
        if (
            this.isDiskBackedResult(result)
            && (affectsDiskQuery(patch) || patch.grouping !== undefined)
        ) {
            void this.refreshDiskGroupCounts(result);
        }
    }

    private schedulePersistView(result: UiResultSurfaceState): void {
        this.persistedViews.set(persistedViewKey(result.sourceId, result.resultSetId), result.view);
        if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            if (this.disposed) return;
            const entries = [...this.persistedViews.entries()].slice(-SHARED_VIEW_STATE_LIMIT);
            const state = isRecord(getHostState()) ? { ...(getHostState() as Record<string, unknown>) } : {};
            state[SHARED_VIEW_STATE_KEY] = Object.fromEntries(entries);
            setHostState(state);
        }, 200);
    }

    public refresh(result: UiResultSurfaceState | undefined = this.activeResult(), limitValue?: string): void {
        if (!result) return;
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        const refreshSql = this.getResultSql(result)?.refreshSql?.trim();
        if (!ref || !refreshSql) {
            this.postResultSync(result.sourceId, 'shared-refresh');
            return;
        }
        postHostMessage({
            command: 'refreshResult',
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
            ...(limitValue === undefined ? {} : { limitValue }),
        });
    }

    public clearAllFilters(result: UiResultSurfaceState | undefined): void {
        if (!result) return;
        this.updateView(result.resultSetId, {
            globalFilter: '',
            columnFilters: {},
            columnFilterDefinitions: {},
            columnAggregations: {},
        });
    }

    public canUndoFilter(result: UiResultSurfaceState | undefined): boolean {
        if (!result) return false;
        return (this.filterHistory.get(`${result.sourceId}\u0000${result.resultSetId}`)?.past.length ?? 0) > 0;
    }

    public canRedoFilter(result: UiResultSurfaceState | undefined): boolean {
        if (!result) return false;
        return (this.filterHistory.get(`${result.sourceId}\u0000${result.resultSetId}`)?.future.length ?? 0) > 0;
    }

    public undoFilter(result: UiResultSurfaceState | undefined): void {
        this.moveFilterHistory(result, 'undo');
    }

    public redoFilter(result: UiResultSurfaceState | undefined): void {
        this.moveFilterHistory(result, 'redo');
    }

    private moveFilterHistory(result: UiResultSurfaceState | undefined, direction: 'undo' | 'redo'): void {
        if (!result) return;
        const key = `${result.sourceId}\u0000${result.resultSetId}`;
        const history = this.filterHistory.get(key);
        if (!history) return;
        const source = direction === 'undo' ? history.past : history.future;
        if (source.length === 0) return;
        const target = source[source.length - 1]!;
        const current = result.view;
        const nextPast = direction === 'undo' ? history.past.slice(0, -1) : [...history.past, current].slice(-10);
        const nextFuture = direction === 'undo' ? [...history.future, current] : history.future.slice(0, -1);
        this.filterHistory.set(key, { past: nextPast, future: nextFuture });
        this.applyingFilterHistory = true;
        this.updateView(result.resultSetId, {
            globalFilter: target.globalFilter,
            columnFilters: target.columnFilters,
            columnFilterDefinitions: target.columnFilterDefinitions ?? {},
        });
        this.applyingFilterHistory = false;
    }

    public clearRefreshFailure(result: UiResultSurfaceState | undefined): void {
        if (!result) return;
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) return;
        postHostMessage({
            command: 'clearRefreshFailure',
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
        });
    }

    public loadMore(result: UiResultSurfaceState): void {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref || result.totalRowCount <= result.loadedRowCount) return;
        const offset = this.getRows(result).length;
        if (offset >= result.totalRowCount) return;
        const alreadyPending = [...this.pendingRowWindows.values()].some(request =>
            request.ref === ref && request.offset === offset,
        );
        if (alreadyPending) return;
        const requestId = ++this.rowRequestId;
        this.pendingRowWindows.set(requestId, { ref, offset });
        const querySpec = this.isDiskBackedResult(result) ? sharedDiskQuerySpec(result) : undefined;
        postHostMessage({
            command: 'requestRows',
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
            offset,
            limit: 2_000,
            requestId,
            ...(querySpec === undefined ? {} : { querySpec }),
        });
    }

    /** Re-queries the spilled dataset from row 0 after a filter or sort change. */
    private resetDiskWindow(result: UiResultSurfaceState): void {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref || ref.resultSetId !== result.resultSetId) return;
        const key = resultKey(result.sourceId, result.resultSetId);
        for (const [requestId, request] of this.pendingRowWindows.entries()) {
            if (request.ref === ref) this.pendingRowWindows.delete(requestId);
        }
        this.rows.set(key, []);
        this.dispatch({
            type: 'results/hydrate',
            sourceId: ref.sourceId,
            executionId: ref.executionId,
            resultSetId: ref.resultSetId,
            loadedRowCount: 0,
            totalRowCount: result.totalRowCount,
        });
        const querySpec = sharedDiskQuerySpec(result);
        const requestId = ++this.rowRequestId;
        this.pendingRowWindows.set(requestId, { ref, offset: 0 });
        postHostMessage({
            command: 'requestRows',
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
            offset: 0,
            limit: 2_000,
            requestId,
            ...(querySpec === undefined ? {} : { querySpec }),
        });
    }

    /**
     * Loads the distinct values for one column from the spilled dataset. The
     * grid's own filter for that column is excluded so the value list remains
     * complete while the user edits it.
     */
    public requestFilterValues(
        result: UiResultSurfaceState,
        columnIndex: number,
    ): Promise<{ readonly values: readonly DataGridFilterValueOption[]; readonly truncated: boolean }> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        const column = result.columns[columnIndex];
        if (!ref || !column) return Promise.reject(new Error('The result set is no longer active.'));
        const requestId = ++this.filterValueRequestId;
        return new Promise((resolve, reject) => {
            this.pendingFilterValues.set(requestId, {
                ref,
                columnIndex,
                column,
                resolve: (values, truncated) => resolve({ values, truncated }),
                reject,
            });
            const querySpec = sharedAnalysisQuerySpec(result, column.name);
            postHostMessage({
                command: 'diskQuery',
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                requestId,
                action: 'distinct',
                columnIndex,
                distinctLimit: SHARED_FILTER_VALUE_LIMIT,
                ...(querySpec === undefined ? {} : { querySpec }),
            });
        });
    }

    public requestAnalysis(
        kind: UiResultAnalysisKind,
        result: UiResultSurfaceState,
        pivotOverride?: SharedPivotPlan,
    ): Promise<UiResultAnalysisTable> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref || ref.resultSetId !== result.resultSetId) {
            return Promise.reject(new Error('The result set is no longer active.'));
        }
        const numericColumns = result.columns
            .map((column, index) => ({ column, index }))
            .filter(item => isNumericSharedColumn(item.column));
        const querySpec = sharedAnalysisQuerySpec(result);
        const pivotPlan = kind === 'pivot'
            ? pivotOverride ?? chooseSharedPivotPlan(result.columns, this.getRows(result))
            : undefined;
        const requestId = ++this.analysisRequestId;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pendingAnalysisRequests.get(requestId);
                if (!pending) return;
                this.pendingAnalysisRequests.delete(requestId);
                pending.reject(new Error(`${kind} analysis timed out.`));
            }, 300_000);
            this.pendingAnalysisRequests.set(requestId, { kind, ref, pivot: pivotPlan, resolve, reject, timer });

            if (kind === 'aggregate') {
                const aggregations = result.columns.flatMap((_column, columnIndex) => {
                    const requests = [{ columnIndex, fn: 'count' }];
                    if (isNumericSharedColumn(result.columns[columnIndex])) {
                        requests.push(
                            { columnIndex, fn: 'sum' },
                            { columnIndex, fn: 'avg' },
                        );
                    }
                    requests.push({ columnIndex, fn: 'min' }, { columnIndex, fn: 'max' });
                    return requests;
                });
                postHostMessage({
                    command: 'requestDatabaseAggregations',
                    sourceUri: ref.sourceId,
                    resultSetIndex: ref.resultSetIndex,
                    requestId,
                    aggregations,
                    querySpec,
                    timeoutSeconds: 300,
                });
                return;
            }

            const firstColumn = result.columns[0];
            if (!firstColumn) {
                this.rejectAnalysis(requestId, new Error('The result set has no columns to analyze.'));
                return;
            }

            if (kind === 'group') {
                const functions = [
                    { fn: 'count', alias: 'COUNT' },
                    ...numericColumns.map(item => ({ fn: 'sum', columnIndex: item.index, alias: `SUM_${item.column.name}` })),
                ];
                const grouping: SharedDatabaseGroupingRequest = {
                    groupByColumns: [{ columnIndex: 0, columnName: firstColumn.name }],
                    functions,
                    limit: 2_000,
                    filterSpec: querySpec,
                };
                postHostMessage({
                    command: 'requestDatabaseGrouping',
                    sourceUri: ref.sourceId,
                    resultSetIndex: ref.resultSetIndex,
                    requestId,
                    grouping,
                    timeoutSeconds: 300,
                });
                return;
            }

            if (!pivotPlan) {
                this.rejectAnalysis(requestId, new Error('Pivot needs a row dimension, a column dimension, and a numeric value column.'));
                return;
            }
            const pivotColumn = result.columns[pivotPlan.pivotColumnIndex];
            const valueColumn = result.columns[pivotPlan.valueColumnIndex];
            if (!pivotColumn || !valueColumn) {
                this.rejectAnalysis(requestId, new Error('Pivot columns are no longer available.'));
                return;
            }
            const functionName = pivotPlan.aggregation === 'avg' ? 'avg' : pivotPlan.aggregation;
            const grouping: SharedDatabaseGroupingRequest = {
                groupByColumns: [
                    { columnIndex: pivotPlan.rowColumnIndex, columnName: result.columns[pivotPlan.rowColumnIndex]!.name },
                    { columnIndex: pivotPlan.pivotColumnIndex, columnName: pivotColumn.name },
                ],
                functions: [{
                    fn: functionName,
                    ...(functionName === 'count' ? {} : { columnIndex: pivotPlan.valueColumnIndex }),
                    alias: `${functionName.toUpperCase()}_${valueColumn.name}`,
                }],
                // A pivot is a matrix, not a top-N ranking. Without an explicit
                // order the grouping endpoint sorts by the aggregate value and
                // silently returns only the highest cells (the old default made
                // every date row a Saturday because SUM(day)=7 sorted first).
                orderBy: [{ columnIndex: 0, desc: false }, { columnIndex: 1, desc: false }],
                // The host caps grouping output at 10,000 rows; asking for one
                // extra row lets it report that the matrix is partial.
                limit: 10_001,
                filterSpec: querySpec,
            };
            postHostMessage({
                command: 'requestDatabaseGrouping',
                sourceUri: ref.sourceId,
                resultSetIndex: ref.resultSetIndex,
                requestId,
                grouping,
                timeoutSeconds: 300,
            });
        });
    }

    public cancel(sourceId: string | undefined): void {
        const activeSource = sourceId ?? this.getState().results.activeSourceId;
        if (!activeSource) return;
        const runningResults = Object.values(this.getState().results.byResultSetId)
            .filter(candidate => candidate.sourceId === activeSource
                && (candidate.status === 'loading' || candidate.status === 'streaming'));
        // Prefer the data result for the cancellation handshake; the Logs tab has
        // its own stable lifecycle and is only a fallback when no data result
        // exists yet.
        const result = runningResults.find(candidate => !this.isLogResult(candidate)) ?? runningResults[0];
        // Nothing to cancel: do not leave a stale cancellation flag behind for a
        // future run of the same source.
        if (!result && !this.isSourceExecuting(activeSource)) return;
        this.cancellingSources.add(activeSource);
        if (!result) {
            // Batch DML/DDL can run for minutes without a data result. The Logs
            // tab is the only surface then, so cancel must still reach the host.
            postHostMessage({ command: 'cancelQuery', sourceUri: activeSource });
            this.notify();
            return;
        }
        const requestId = `vscode-cancel-${++this.streamRevision}`;
        this.cancelRequests.set(sourceIndexKey(result.sourceId, result.statementIndex), requestId);
        this.dispatch({
            type: 'execution/cancel-requested',
            sourceId: result.sourceId,
            executionId: result.executionId,
            requestId,
        });
        postHostMessage({ command: 'cancelQuery', sourceUri: activeSource });
    }

    public copyActive(): void {
        const result = this.activeResult();
        if (!result) return;
        const loadedRows = this.getRows(result);
        const rows = processDataGridRows(result.columns, loadedRows, result.view);
        if (rows.length === 0) return;
        writeSharedClipboard(
            { columns: resolveDataGridColumns(result.columns, loadedRows), rows, includeHeaders: true },
            this.copyFormat,
        );
    }

    /** Fetches one page for copy-all without disturbing the visible row window. */
    private requestRowsForCopy(ref: ResultRef, offset: number, limit: number): Promise<{ readonly rows: readonly unknown[][]; readonly totalRows?: number }> {
        const result = this.resultForRef(ref);
        const querySpec = result !== undefined && this.isDiskBackedResult(result) ? sharedDiskQuerySpec(result) : undefined;
        const requestId = ++this.rowRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRowFetches.delete(requestId);
                reject(new Error('Timed out while reading rows for copy.'));
            }, 60_000);
            this.pendingRowFetches.set(requestId, {
                ref,
                offset,
                resolve: (rows, totalRows) => resolve({ rows, ...(totalRows === undefined ? {} : { totalRows }) }),
                reject,
                timer,
            });
            postHostMessage({
                command: 'requestRows',
                sourceUri: ref.sourceId,
                resultSetIndex: ref.resultSetIndex,
                offset,
                limit,
                requestId,
                ...(querySpec === undefined ? {} : { querySpec }),
            });
        });
    }

    /**
     * Copies every filtered row, including disk-backed pages that are not yet
     * loaded into the grid. Returns the number of copied rows.
     */
    public async copyAllActive(): Promise<number> {
        const result = this.activeResult();
        if (!result) return 0;
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) return 0;
        let rows: readonly unknown[][] = this.getRows(result);
        if (this.isDiskBackedResult(result)) {
            const pageSize = 5_000;
            const maxRows = Math.max(result.totalRowCount, rows.length);
            const collected: unknown[][] = [];
            let offset = 0;
            while (offset < maxRows) {
                const page = await this.requestRowsForCopy(ref, offset, Math.min(pageSize, maxRows - offset));
                if (page.rows.length === 0) break;
                for (const row of page.rows) collected.push([...row]);
                offset += page.rows.length;
                if (page.rows.length < pageSize) break;
            }
            rows = collected;
        }
        const displayRows = processDataGridRows(result.columns, rows, result.view);
        if (displayRows.length === 0) return 0;
        writeSharedClipboard(
            { columns: resolveDataGridColumns(result.columns, rows), rows: displayRows, includeHeaders: true },
            this.copyFormat,
        );
        return displayRows.length;
    }

    /** Copies the active result in an explicit clipboard format. */
    public copyActiveAs(format: SharedClipboardFormat): void {
        const result = this.activeResult();
        if (!result) return;
        const loadedRows = this.getRows(result);
        const rows = processDataGridRows(result.columns, loadedRows, result.view);
        if (rows.length === 0) return;
        writeSharedClipboard(
            { columns: resolveDataGridColumns(result.columns, loadedRows), rows, includeHeaders: true },
            format,
        );
    }

    /** Routes the legacy "Query Locally (DuckDB)" action through the host bridge. */
    public queryLocallyDuckDB(result: UiResultSurfaceState | undefined): void {
        if (!result) return;
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) return;
        postHostMessage({
            command: 'queryLocallyDuckDB',
            data: { sourceUri: result.sourceId, resultSetIndex: ref.resultSetIndex },
        });
    }

    /**
     * Renders the filtered grid to a PNG (up to 500 rows) and copies it to the
     * clipboard, matching the legacy "Copy grid as image" action. When the
     * webview clipboard cannot accept images the PNG is downloaded instead.
     */
    public async copyGridAsImage(result: UiResultSurfaceState | undefined): Promise<void> {
        if (!result) return;
        const loadedRows = this.getRows(result);
        const resolved = resolveDataGridColumns(result.columns, loadedRows);
        const visibleColumns = resolved
            .map((column, columnIndex) => ({ column, columnIndex }))
            .filter(({ column, columnIndex }) =>
                result.view.columnVisibility?.[column.name] !== false
                && result.view.columnVisibility?.[String(columnIndex)] !== false,
            );
        const sourceIndices = processDataGridRowIndices(result.columns, loadedRows, result.view);
        const displayIndices = sourceIndices.slice(0, 500);
        if (visibleColumns.length === 0 || displayIndices.length === 0) return;
        const bodyStyle = typeof document === 'undefined' ? undefined : getComputedStyle(document.body);
        const readColor = (name: string, fallback: string): string => bodyStyle?.getPropertyValue(name).trim() || fallback;
        const background = readColor('--vscode-editor-background', '#1e1e1e');
        const foreground = readColor('--vscode-editor-foreground', '#cccccc');
        const border = readColor('--vscode-panel-border', '#333333');
        const headerBackground = readColor('--vscode-sideBar-background', '#252526');
        const muted = readColor('--vscode-descriptionForeground', '#888888');
        const numericColor = readColor('--vscode-charts-blue', '#519aba');
        const temporalColor = '#d8b4fe';
        const fontFamily = bodyStyle?.fontFamily || 'monospace';
        const font = `12px ${fontFamily}`;
        const fontBold = `600 12px ${fontFamily}`;
        const rowHeight = 24;
        const headerHeight = 30;
        const padding = 8;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return;
        const format = (value: unknown, column: { readonly type?: string; readonly name: string }, columnIndex: number): string => {
            if (value === null || value === undefined) return 'NULL';
            return formatDataGridCellValue(value, column.type, column, this.getFormattingForColumn(column, columnIndex));
        };
        const widths = visibleColumns.map(({ column, columnIndex }) => {
            context.font = fontBold;
            let width = context.measureText(column.name).width + padding * 3;
            context.font = font;
            for (const displayIndex of displayIndices.slice(0, 100)) {
                const sourceIndex = sourceIndices[displayIndex];
                const value = sourceIndex === undefined ? undefined : loadedRows[sourceIndex]?.[columnIndex];
                width = Math.max(width, Math.min(260, context.measureText(format(value, column, columnIndex)).width + padding * 2));
            }
            return Math.max(80, Math.min(260, Math.ceil(width)));
        });
        const totalWidth = widths.reduce((sum, width) => sum + width, 0);
        canvas.width = Math.max(1, totalWidth);
        canvas.height = headerHeight + displayIndices.length * rowHeight + 1;
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        let x = 0;
        context.font = fontBold;
        context.fillStyle = headerBackground;
        context.fillRect(0, 0, canvas.width, headerHeight);
        context.fillStyle = foreground;
        context.textBaseline = 'middle';
        for (let index = 0; index < visibleColumns.length; index += 1) {
            const width = widths[index]!;
            const text = visibleColumns[index]!.column.name;
            context.fillText(text, x + padding, headerHeight / 2, width - padding * 2);
            x += width;
            context.strokeStyle = border;
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, canvas.height);
            context.stroke();
        }
        context.font = font;
        for (let rowIndex = 0; rowIndex < displayIndices.length; rowIndex += 1) {
            const y = headerHeight + rowIndex * rowHeight;
            if (rowIndex % 2 === 1) {
                context.fillStyle = 'rgba(255,255,255,0.04)';
                context.fillRect(0, y, canvas.width, rowHeight);
            }
            const sourceIndex = sourceIndices[displayIndices[rowIndex]!];
            const row = sourceIndex === undefined ? undefined : loadedRows[sourceIndex];
            let cellX = 0;
            for (let index = 0; index < visibleColumns.length; index += 1) {
                const { column, columnIndex } = visibleColumns[index]!;
                const width = widths[index]!;
                const value = row?.[columnIndex];
                const text = format(value, column, columnIndex);
                if (value === null || value === undefined) context.fillStyle = muted;
                else if (isDataGridNumericColumn(column)) context.fillStyle = numericColor;
                else if (/date|time/iu.test(column.type ?? '')) context.fillStyle = temporalColor;
                else context.fillStyle = foreground;
                context.fillText(text, cellX + padding, y + rowHeight / 2, width - padding * 2);
                cellX += width;
            }
            context.strokeStyle = border;
            context.beginPath();
            context.moveTo(0, y + rowHeight + 0.5);
            context.lineTo(canvas.width, y + rowHeight + 0.5);
            context.stroke();
        }
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return;
        const clipboardItem = typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem;
        try {
            if (clipboardItem && typeof navigator !== 'undefined' && navigator.clipboard?.write) {
                await navigator.clipboard.write([new clipboardItem({ 'image/png': blob })]);
                postHostMessage({ command: 'info', text: 'Grid image copied to clipboard' });
                return;
            }
        } catch {
            // Fall through to the download so the action still produces an image.
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'result-grid.png';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
        postHostMessage({ command: 'info', text: 'Grid image downloaded' });
    }

    public exportActive(): void {
        this.exportActiveWithOptions('csv', 'file', 'loaded');
    }

    public exportAllResults(): void {
        const state = this.getState();
        const activeSourceId = state.results.activeSourceId;
        if (!activeSourceId) return;
        const results = Object.values(state.results.byResultSetId)
            .filter(result => result.sourceId === activeSourceId && result.status !== 'error' && !this.isLogResult(result))
            .sort((left, right) => left.statementIndex - right.statementIndex)
            .flatMap(result => {
                const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
                const rows = this.getRows(result);
                if (!ref || rows.length === 0) return [];
                return [{
                    resultSetIndex: ref.resultSetIndex,
                    rowIndices: rows.map((_row, index) => index),
                    columnIds: result.columns.map((_column, index) => String(index)),
                    name: this.getResultLabel(result) ?? `Result ${result.statementIndex + 1}`,
                    isActive: result.resultSetId === state.results.activeResultSetId,
                }];
            });
        if (results.length === 0) {
            postHostMessage({ command: 'info', text: 'No data available to export.' });
            return;
        }
        postHostMessage({
            command: 'exportAllResultSetsToExcel',
            data: { sourceUri: activeSourceId, results },
        });
    }

    /** Opens the host export pipeline with the format/destination picked in the panel. */
    public exportActiveWithOptions(
        format: string,
        destination: 'file' | 'open' | 'temp' | 'clipboard',
        rowScope: 'loaded' | 'all',
    ): void {
        const result = this.activeResult();
        if (!result) return;
        const rows = this.getRows(result);
        const visibleRows = processDataGridRows(result.columns, rows, result.view);
        const rowIndices = processDataGridRowIndices(result.columns, rows, result.view);
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        const formatSettings = isRecord(this.formatSettings) ? this.formatSettings : undefined;
        const globalSettings = formatSettings && isRecord(formatSettings.global) ? formatSettings.global : undefined;
        const useFormattedValues = globalSettings?.useFormattedValuesForExport === true;
        if (!ref || rowIndices.length === 0) {
            // Detached fixtures (and empty live grids) still support the text
            // formats through the legacy data commands.
            const serialized = format === 'csv'
                ? { command: 'exportCsv' as const, data: rowsAsCsv(result.columns, visibleRows, useFormattedValues) }
                : format === 'json'
                    ? { command: 'exportJson' as const, data: rowsAsJson(result.columns, visibleRows) }
                    : format === 'xml'
                        ? { command: 'exportXml' as const, data: rowsAsXml(result.columns, visibleRows) }
                        : format === 'sql'
                            ? { command: 'exportSqlInsert' as const, data: rowsAsSqlInsert(result.columns, visibleRows) }
                            : format === 'markdown'
                                ? { command: 'exportMarkdown' as const, data: rowsAsMarkdown(result.columns, visibleRows) }
                                : undefined;
            if (serialized === undefined) {
                postHostMessage({ command: 'info', text: 'Choose a text format for the loaded rows in this result.' });
                return;
            }
            postHostMessage(serialized);
            return;
        }
        postHostMessage({
            command: 'initiateExportWithSelection',
            data: {
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                rowIndices: [...rowIndices],
                rowScope,
                formatting: globalSettings && typeof globalSettings.useFormattedValuesForExport === 'boolean'
                    ? {
                        useFormattedValues: globalSettings.useFormattedValuesForExport,
                        payload: formatSettings,
                    }
                    : undefined,
            },
            format,
            destination,
            rowScope,
        });
    }

    public activeResult(): UiResultSurfaceState | undefined {
        const state = this.getState();
        const sourceId = state.results.activeSourceId;
        if (!sourceId) return undefined;
        if (state.results.activeResultSetId !== undefined) {
            return Object.values(state.results.byResultSetId).find(result =>
                result.sourceId === sourceId && result.resultSetId === state.results.activeResultSetId,
            );
        }
        return Object.values(state.results.byResultSetId).find(result => result.sourceId === sourceId);
    }

    private rejectAnalysis(requestId: number, error: Error): void {
        const pending = this.pendingAnalysisRequests.get(requestId);
        if (!pending) return;
        this.pendingAnalysisRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
    }

    private takeAnalysisRequest(
        requestId: number,
        sourceUri: string,
        resultSetIndex: number,
    ): PendingAnalysisRequest | undefined {
        const pending = this.pendingAnalysisRequests.get(requestId);
        if (!pending) return undefined;
        this.pendingAnalysisRequests.delete(requestId);
        clearTimeout(pending.timer);
        const currentRef = this.refs.get(sourceIndexKey(sourceUri, resultSetIndex));
        if (
            pending.ref !== currentRef
            || pending.ref.sourceId !== sourceUri
            || pending.ref.resultSetIndex !== resultSetIndex
        ) {
            pending.reject(new Error('Analysis request superseded.'));
            return undefined;
        }
        return pending;
    }

    private applyDatabaseAggregationResult(
        message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseAggregationResult' }>,
    ): void {
        const testPending = this.pendingDatabaseAggregations.get(message.requestId);
        if (testPending) {
            this.pendingDatabaseAggregations.delete(message.requestId);
            clearTimeout(testPending.timer);
            if (message.error !== undefined) testPending.reject(new Error(message.error));
            else testPending.resolve(message.aggregations ?? []);
            return;
        }
        const pending = this.takeAnalysisRequest(message.requestId, message.sourceUri, message.resultSetIndex);
        if (!pending) return;
        if (pending.kind !== 'aggregate') {
            pending.reject(new Error('Received an aggregate response for another analysis.'));
            return;
        }
        if (message.error) {
            pending.reject(new Error(message.error));
            return;
        }
        const result = this.resultForRef(pending.ref);
        if (!result) {
            pending.reject(new Error('The result set is no longer available.'));
            return;
        }
        pending.resolve(toAggregateAnalysisTable(result.columns, result, message.aggregations ?? []));
    }

    private applyDatabaseFilterValuesResult(
        message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseFilterValuesResult' }>,
    ): void {
        const testPending = this.pendingDatabaseFilterValues.get(message.requestId);
        if (testPending) {
            this.pendingDatabaseFilterValues.delete(message.requestId);
            clearTimeout(testPending.timer);
            if (message.error !== undefined) testPending.reject(new Error(message.error));
            else testPending.resolve(message.values ?? [], message.truncated === true);
            return;
        }
        const pending = this.pendingFilterValues.get(message.requestId);
        if (!pending) return;
        this.pendingFilterValues.delete(message.requestId);
        if (message.error !== undefined) {
            pending.reject(new Error(message.error));
            return;
        }
        const values = (message.values ?? []).map(item => ({
            key: sharedFilterValueKey(item.raw),
            value: item.raw,
            label: formatDataGridCellValue(item.raw, pending.column.type, pending.column),
        }));
        values.sort((left, right) => left.label.localeCompare(right.label));
        pending.resolve(values, message.truncated === true);
    }

    private applyDatabaseGroupingResult(
        message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseGroupingResult' }>,
    ): void {
        const testPending = this.pendingDatabaseGrouping.get(message.requestId);
        if (testPending) {
            this.pendingDatabaseGrouping.delete(message.requestId);
            clearTimeout(testPending.timer);
            if (message.error !== undefined) testPending.reject(new Error(message.error));
            else testPending.resolve(message);
            return;
        }
        const pending = this.takeAnalysisRequest(message.requestId, message.sourceUri, message.resultSetIndex);
        if (!pending) return;
        if (pending.kind !== 'group' && pending.kind !== 'pivot') {
            pending.reject(new Error('Received a grouping response for another analysis.'));
            return;
        }
        if (message.error) {
            pending.reject(new Error(message.error));
            return;
        }
        const result = this.resultForRef(pending.ref);
        if (!result) {
            pending.reject(new Error('The result set is no longer available.'));
            return;
        }
        if (pending.kind === 'group') {
            pending.resolve(toGroupAnalysisTable(message));
            return;
        }
        if (!pending.pivot) {
            pending.reject(new Error('Pivot configuration is no longer available.'));
            return;
        }
        pending.resolve(toPivotAnalysisTable(result.columns, message, pending.pivot));
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
        this.listeners.clear();
        this.rows.clear();
        this.refs.clear();
        this.diskBacked.clear();
        this.resultSql.clear();
        this.nextSequence.clear();
        this.nextChunkSequence.clear();
        this.cancelRequests.clear();
        this.pendingRowWindows.clear();
        for (const pending of this.pendingAnalysisRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingAnalysisRequests.clear();
        for (const pending of this.pendingFilterValues.values()) {
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingFilterValues.clear();
        for (const pending of this.pendingDatabaseAggregations.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingDatabaseAggregations.clear();
        for (const pending of this.pendingDatabaseFilterValues.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingDatabaseFilterValues.clear();
        for (const pending of this.pendingDatabaseGrouping.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingDatabaseGrouping.clear();
        for (const pending of this.pendingDiskQueries.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingDiskQueries.clear();
        this.store.dispose();
    }

    private notify(): void {
        if (this.disposed) return;
        this.revision += 1;
        for (const listener of [...this.listeners]) listener();
    }

    private dispatch(action: Parameters<UiStore['dispatch']>[0]): void {
        this.store.dispatch(action);
        this.notify();
    }

    private postResultSync(sourceId: string, reason: string): void {
        postHostMessage({ command: 'requestResultSync', sourceUri: sourceId, reason });
    }

    private replaceRef(indexKey: string, ref: ResultRef): void {
        this.refs.set(indexKey, ref);
        for (const [requestId, request] of this.pendingRowWindows.entries()) {
            if (request.ref.sourceId !== ref.sourceId || request.ref.resultSetId !== ref.resultSetId) continue;
            if (request.ref === ref) continue;
            const nextRequestId = ++this.rowRequestId;
            this.pendingRowWindows.delete(requestId);
            this.pendingRowWindows.set(nextRequestId, { ref, offset: request.offset });
            postHostMessage({
                command: 'requestRows',
                sourceUri: ref.sourceId,
                resultSetIndex: ref.resultSetIndex,
                offset: request.offset,
                limit: 2_000,
                requestId: nextRequestId,
            });
        }
    }

    private applyHydrate(data: SharedResultPanelData): void {
        if (typeof data.resultPanelTraceEnabled === 'boolean') this.traceEnabled = data.resultPanelTraceEnabled;
        const sourceId = parseJsonString(data.activeSourceJson) ?? 'vscode:results';
        const resultSets = resultSetsFromData(data);
        this.pinnedResults = parseSharedPinnedResults(data.pinnedResultsJson);
        this.formatSettings = data.formatSettings;
        if (typeof data.sqlQueueJson === 'string') this.sqlQueueJson = data.sqlQueueJson;
        this.queryRowLimit = asNonNegativeInteger(data.queryRowLimit) ?? this.queryRowLimit;
        const activeResultSetIndex = asNonNegativeInteger(data.activeResultSetIndex) ?? 0;
        const executingSources = new Set(parseJsonStrings(data.executingSourcesJson));
        this.setExecutingSources([...executingSources]);
        const version = asNonNegativeInteger(data.dataVersion)
            ?? asNonNegativeInteger(data.resultSyncVersion)
            ?? ++this.streamRevision;
        const hydrationRevision = ++this.streamRevision;
        let activeResultSetId: string | undefined;
        let lastDataResultSetId: string | undefined;
        const previousResultIds = new Set(Object.values(this.getState().results.byResultSetId).map(result => result.resultSetId));
        let hasNewDataResult = false;
        const incomingResultSetIds = new Set<string>();
        const incomingIndexKeys = new Set<string>();
        const previousRefs = [...this.refs.entries()];

        for (const [resultSetIndex, normalized] of resultSets.entries()) {
            const resultSetId = normalized.resultSetId
                ?? `vscode-result-${sourceId}-${resultSetIndex}-${normalized.executionTimestamp ?? version}`;
            const ref: ResultRef = {
                sourceId,
                resultSetIndex,
                resultSetId,
                executionId: `vscode-execution-${sourceId}-${resultSetId}-${version}-${hydrationRevision}`,
            };
            const key = resultKey(sourceId, resultSetId);
            incomingResultSetIds.add(resultSetId);
            const indexKey = sourceIndexKey(sourceId, resultSetIndex);
            incomingIndexKeys.add(indexKey);
            this.replaceRef(indexKey, ref);
            this.rows.set(key, normalized.rows);
            this.resultKinds.set(key, { isLog: normalized.isLog, isTextContent: normalized.isTextContent === true });
            if (normalized.refreshFailure) this.refreshFailures.set(key, normalized.refreshFailure);
            else this.refreshFailures.delete(key);
            if (normalized.limitReached) this.limitReached.add(key);
            else this.limitReached.delete(key);
            this.editability.set(key, {
                isEditable: normalized.isEditable === true,
                editSource: normalized.editSource,
                reason: normalized.editDisabledReason,
            });
            const wasDiskBacked = this.diskBacked.has(key);
            this.startResult(ref, normalized, executingSources.has(sourceId));
            // Hydration replaces the result surface, so restore the storage
            // mode the host reported. Older payloads omit it; in that case a
            // result that was already spilled stays spilled (disk backing is
            // one-way for a given result-set identity).
            if (normalized.storageMode === 'sqlite'
                || (normalized.storageMode === undefined && wasDiskBacked)) {
                this.diskBacked.add(key);
            }
            const savedView = this.persistedViews.get(persistedViewKey(sourceId, resultSetId));
            if (savedView) {
                this.dispatch({ type: 'results/view', sourceId, resultSetId, patch: savedView });
            }
            if (resultSetIndex === activeResultSetIndex) activeResultSetId = resultSetId;
            if (!normalized.isLog) {
                lastDataResultSetId = resultSetId;
                if (!previousResultIds.has(resultSetId)) hasNewDataResult = true;
            }
        }

        for (const [indexKey, ref] of previousRefs) {
            if (ref.sourceId !== sourceId) continue;
            const retainedAtSameIndex = incomingIndexKeys.has(indexKey)
                && this.refs.get(indexKey)?.resultSetId === ref.resultSetId;
            if (retainedAtSameIndex) continue;
            if (this.refs.get(indexKey)?.resultSetId === ref.resultSetId) this.refs.delete(indexKey);
            if (incomingResultSetIds.has(ref.resultSetId)) continue;
            const key = resultKey(ref.sourceId, ref.resultSetId);
            this.rows.delete(key);
            this.editability.delete(key);
            this.resultKinds.delete(key);
            this.resultSql.delete(key);
            this.pendingEdits.delete(key);
            this.pendingDeletes.delete(key);
            this.refreshFailures.delete(key);
            this.limitReached.delete(key);
            this.diskQuerySpecKeys.delete(key);
            this.nextSequence.delete(key);
            this.nextChunkSequence.delete(key);
            this.cancelRequests.delete(indexKey);
            for (const [requestId, request] of this.pendingRowWindows.entries()) {
                if (request.ref.sourceId === ref.sourceId && request.ref.resultSetId === ref.resultSetId) this.pendingRowWindows.delete(requestId);
            }
            for (const [requestId, request] of this.pendingFilterValues.entries()) {
                if (request.ref.sourceId === ref.sourceId && request.ref.resultSetId === ref.resultSetId) {
                    this.pendingFilterValues.delete(requestId);
                    request.reject(new Error('The result set is no longer available.'));
                }
            }
        }
        this.dispatch({
            type: 'results/reconcile-source',
            sourceId,
            resultSetIds: [...incomingResultSetIds],
        });

        if (resultSets.length > 0) {
            if (hasNewDataResult && this.manualLogSelection === sourceId) {
                // A new result identity means a new execution; executing SQL
                // must bring its result tab forward even if Logs was selected.
                this.manualLogSelection = undefined;
            }
            // A stale/background hydrate can report the Logs tab as active
            // after the user already moved to a data result. Keep the data
            // selection in that case. New data results still activate because
            // the incoming active entry is not a log.
            const previous = this.getState().results;
            const previousSelected = previous.activeResultSetId === undefined
                ? undefined
                : Object.values(previous.byResultSetId).find(
                    result => result.resultSetId === previous.activeResultSetId,
                );
            const incomingActiveIsLog = resultSets[activeResultSetIndex]?.isLog === true;
            const preferredId = incomingActiveIsLog && this.manualLogSelection !== sourceId
                ? this.preferredDataResults.get(sourceId)
                : undefined;
            const preferredSettled = preferredId !== undefined
                && incomingResultSetIds.has(preferredId)
                && this.getState().results.byResultSetId[preferredId] !== undefined
                && !this.isLogResult(this.getState().results.byResultSetId[preferredId])
                ? preferredId
                : undefined;
            const autoDataSelection = incomingActiveIsLog && this.manualLogSelection !== sourceId
                ? preferredSettled ?? lastDataResultSetId
                : undefined;
            const keepCurrentId = previous.activeSourceId === sourceId
                && previous.activeResultSetId !== undefined
                && incomingResultSetIds.has(previous.activeResultSetId)
                && incomingActiveIsLog
                && previousSelected !== undefined
                && !this.isLogResult(previousSelected)
                ? previous.activeResultSetId
                : undefined;
            this.dispatch({ type: 'results/select-source', sourceId });
            this.dispatch({
                type: 'results/select',
                sourceId,
                resultSetId: keepCurrentId
                    ?? autoDataSelection
                    ?? activeResultSetId
                    ?? Object.values(this.getState().results.byResultSetId).find(result => result.sourceId === sourceId)?.resultSetId
                    ?? '',
            });
        }
        this.dispatch({ type: 'shell/status', status: 'complete' });
        this.clearEditSession();
        this.setSurface('results');
        this.trace({
            phase: 'hydrate_applied',
            sourceUri: sourceId,
            resultSetCount: resultSets.length,
            rowCount: resultSets.reduce((sum, result) => sum + result.rows.length, 0),
        });
        for (const [resultSetIndex, result] of resultSets.entries()) {
            this.trace({
                phase: 'hydrate_result_set_applied',
                sourceUri: sourceId,
                resultSetIndex,
                rowCount: result.totalRowCount,
                totalRows: result.totalRowCount,
                isLog: result.isLog,
            });
        }
        // React mounts asynchronously after this message is applied; report the
        // render handshake only after the browser has had a chance to paint.
        setTimeout(() => this.trace({
            phase: 'hydrate_rendered',
            sourceUri: sourceId,
            resultSetCount: resultSets.length,
        }), 0);
    }

    private startResult(ref: ResultRef, normalized: NormalizedResultSet, executing: boolean): void {
        this.diskBacked.delete(resultKey(ref.sourceId, ref.resultSetId));
        if (normalized.sql !== undefined || normalized.refreshSql !== undefined) {
            this.resultSql.set(resultKey(ref.sourceId, ref.resultSetId), {
                sql: normalized.sql,
                refreshSql: normalized.refreshSql,
            });
        }
        const base = { type: 'execution/start' as const, ...ref, statementIndex: ref.resultSetIndex };
        this.dispatch(base);
        let sequence = 1;
        this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'started' } });
        if (normalized.columns.length > 0) {
            this.dispatch({
                type: 'execution/event',
                event: { ...eventBase(ref, sequence++), type: 'columns', columns: normalized.columns },
            });
        }
        if (normalized.rows.length > 0 || normalized.totalRowCount > 0) {
            this.dispatch({
                type: 'execution/event',
                event: {
                    ...eventBase(ref, sequence++),
                    type: 'rows',
                    rowCount: normalized.rows.length,
                    totalRowCount: normalized.totalRowCount,
                },
            });
        }
        const stillRunning = executing && !normalized.isError && !normalized.isCancelled
            && normalized.isStreamingComplete !== true;
        if (stillRunning) {
            this.nextSequence.set(resultKey(ref.sourceId, ref.resultSetId), sequence);
            this.nextChunkSequence.set(resultKey(ref.sourceId, ref.resultSetId), 0);
            return;
        }
        if (normalized.isError) {
            this.dispatch({
                type: 'execution/event',
                event: {
                    ...eventBase(ref, sequence++),
                    type: 'error',
                    message: normalized.message ?? 'Result failed.',
                    ...(normalized.errorDetails === undefined ? {} : { errorDetails: normalized.errorDetails }),
                },
            });
        } else if (normalized.isCancelled) {
            this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'cancelled', totalRowCount: normalized.totalRowCount, message: normalized.message } });
        } else if (normalized.totalRowCount === 0) {
            this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'empty', message: normalized.message } });
        } else {
            this.dispatch({
                type: 'execution/event',
                event: {
                    ...eventBase(ref, sequence++),
                    type: 'complete',
                    totalRowCount: normalized.totalRowCount,
                    message: normalized.message,
                    ...(normalized.limitReached ? { limitReached: true } : {}),
                },
            });
        }
        this.nextSequence.set(resultKey(ref.sourceId, ref.resultSetId), sequence);
        this.nextChunkSequence.delete(resultKey(ref.sourceId, ref.resultSetId));
    }

    private applyAppend(message: Extract<ResultPanelHostToWebviewMessage, { command: 'appendRows' }>): void {
        const sourceId = message.sourceUri ?? this.getState().results.activeSourceId;
        if (!sourceId) return;
        // The host can stream a source slightly before setActiveSource lands.
        // Keep the rows in the store; only the active source may drive the
        // selection.
        const isActiveSource = this.getState().results.activeSourceId === undefined
            || this.getState().results.activeSourceId === sourceId;
        const index = message.resultSetIndex;
        const knownRef = this.refs.get(sourceIndexKey(sourceId, index));
        if (knownRef && message.resultSetId && knownRef.resultSetId !== message.resultSetId) return;
        const resultSetId = message.resultSetId ?? knownRef?.resultSetId ?? `vscode-stream-${sourceId}-${index}`;
        const key = resultKey(sourceId, resultSetId);
        const current = Object.values(this.getState().results.byResultSetId)
            .find(result => result.sourceId === sourceId && result.resultSetId === resultSetId);
        const previousExecutionTimestamp = this.executionTimestamps.get(key);
        const executionChanged = message.executionTimestamp !== undefined
            && previousExecutionTimestamp !== undefined
            && message.executionTimestamp !== previousExecutionTimestamp;
        if (message.executionTimestamp !== undefined) {
            this.executionTimestamps.set(key, message.executionTimestamp);
        }
        const startsNewExecution = message.isFirstChunk === true || !current || executionChanged;
        if (startsNewExecution && message.isLog !== true && this.manualLogSelection === sourceId) {
            // Executing SQL is an explicit user action: even if Logs was
            // selected manually, the new result tab should come to the front.
            this.manualLogSelection = undefined;
        }
        if (current && !startsNewExecution && ['complete', 'empty', 'error', 'cancelled'].includes(current.status)) return;
        let ref = knownRef ?? (current ? {
            sourceId,
            resultSetIndex: index,
            resultSetId,
            executionId: current.executionId,
        } : undefined);

        if (startsNewExecution && current && current.status !== 'loading' && current.status !== 'streaming') {
            ref = {
                sourceId,
                resultSetIndex: index,
                resultSetId,
                executionId: `vscode-stream-execution-${sourceId}-${resultSetId}-${message.executionTimestamp ?? ++this.streamRevision}`,
            };
            this.rows.set(key, []);
            this.editability.delete(key);
            this.resultKinds.set(key, { isLog: message.isLog === true, isTextContent: false });
            this.refreshFailures.delete(key);
            this.limitReached.delete(key);
            this.clearEditSession();
            this.nextChunkSequence.set(key, 0);
        }
        if (!ref) {
            ref = {
                sourceId,
                resultSetIndex: index,
                resultSetId,
                executionId: `vscode-stream-execution-${sourceId}-${resultSetId}-${++this.streamRevision}`,
            };
            this.rows.set(key, []);
            this.resultKinds.set(key, { isLog: message.isLog === true, isTextContent: false });
            this.clearEditSession();
            this.nextChunkSequence.set(key, 0);
            this.startResult(ref, {
                resultSetId,
                columns: normalizeSharedColumns(message.columns),
                rows: [],
                totalRowCount: 0,
                isLog: message.isLog === true,
                isError: false,
                isCancelled: false,
            }, true);
        }
        this.replaceRef(sourceIndexKey(sourceId, index), ref);

        if (message.chunkSequence !== undefined) {
            const expectedChunk = this.nextChunkSequence.get(key) ?? 0;
            if (message.chunkSequence !== expectedChunk) return;
            this.nextChunkSequence.set(key, expectedChunk + 1);
        }
        const rows = decodeSharedRows(message.rows);
        const existingRows = this.rows.get(key) ?? [];
        if (message.fromRow !== undefined && rows.length > 0 && message.fromRow !== existingRows.length) return;
        this.rows.set(key, rows.length > 0 ? [...existingRows, ...rows] : existingRows);
        if (message.limitReached) this.limitReached.add(key);
        if (message.isLog !== true) this.preferredDataResults.set(sourceId, resultSetId);
        const nextSequence = this.nextSequence.get(key) ?? (current?.lastSequence ?? 0) + 1;
        const nextRows = this.rows.get(key) ?? [];
        if (rows.length > 0) {
            this.dispatch({
                type: 'execution/event',
                event: {
                    ...eventBase(ref, nextSequence),
                    type: 'rows',
                    rowCount: nextRows.length,
                    totalRowCount: Math.max(message.totalRows, nextRows.length),
                },
            });
            this.nextSequence.set(key, nextSequence + 1);
        } else if (message.totalRows > (current?.totalRowCount ?? 0)) {
            this.dispatch({
                type: 'execution/event',
                event: { ...eventBase(ref, nextSequence), type: 'progress', totalRowCount: message.totalRows },
            });
            this.nextSequence.set(key, nextSequence + 1);
        }
        if (isActiveSource) {
            this.dispatch({ type: 'results/select-source', sourceId });
            // Log appends are background queue output. They must not steal a
            // result the user is already inspecting.
            const active = this.activeResult();
            const activeIsLog = active !== undefined && this.isLogResult(active);
            const keepDataSelection = active !== undefined && (
                (message.isLog === true && !activeIsLog)
                || (message.isLog !== true
                    && activeIsLog
                    && this.manualLogSelection === sourceId)
            );
            if (!keepDataSelection) {
                this.dispatch({ type: 'results/select', sourceId, resultSetId });
            }
        }
        this.trace({
            phase: 'append_applied',
            sourceUri: sourceId,
            resultSetIndex: index,
            rowCount: rows.length,
            totalRows: Math.max(message.totalRows, nextRows.length),
            isLog: message.isLog === true,
            isFirstChunk: message.isFirstChunk,
            isLastChunk: message.isLastChunk,
        });
    }

    private applyDiskBackedActivate(message: Extract<ResultPanelHostToWebviewMessage, { command: 'diskBackedActivate' }>): void {
        const currentSource = this.getState().results.activeSourceId;
        const isActiveSource = currentSource === undefined || currentSource === message.sourceUri;
        const knownRef = this.refs.get(sourceIndexKey(message.sourceUri, message.resultSetIndex));
        if (knownRef && message.resultSetId !== undefined && knownRef.resultSetId !== message.resultSetId) return;
        const resultSetId = message.resultSetId ?? knownRef?.resultSetId ?? `vscode-disk-${message.sourceUri}-${message.resultSetIndex}`;
        const ref: ResultRef = {
            sourceId: message.sourceUri,
            resultSetIndex: message.resultSetIndex,
            resultSetId,
            executionId: `vscode-disk-execution-${message.sourceUri}-${resultSetId}-${++this.streamRevision}`,
        };
        const rows = decodeSharedRows(message.rows);
        const key = resultKey(ref.sourceId, ref.resultSetId);
        this.replaceRef(sourceIndexKey(ref.sourceId, ref.resultSetIndex), ref);
        this.rows.set(key, rows);
        this.resultKinds.set(key, { isLog: false, isTextContent: false });
        this.nextChunkSequence.delete(key);
        this.startResult(ref, {
            resultSetId,
            columns: normalizeSharedColumns(message.columns),
            rows,
            totalRowCount: Math.max(message.totalRows, rows.length),
            isLog: false,
            isError: false,
            isCancelled: false,
            isStreamingComplete: false,
        }, true);
        this.diskBacked.add(key);
        this.preferredDataResults.set(ref.sourceId, resultSetId);
        const savedView = this.persistedViews.get(persistedViewKey(ref.sourceId, ref.resultSetId));
        if (savedView) this.dispatch({ type: 'results/view', sourceId: ref.sourceId, resultSetId: ref.resultSetId, patch: savedView });
        const restored = this.resultForRef(ref);
        if (restored && sharedDiskQuerySpec(restored) !== undefined) this.resetDiskWindow(restored);
        if (isActiveSource) {
            this.dispatch({ type: 'results/select-source', sourceId: ref.sourceId });
            this.dispatch({ type: 'results/select', sourceId: ref.sourceId, resultSetId: ref.resultSetId });
        }
        const active = this.resultForRef(ref);
        if (active && active.view.grouping.length > 0) void this.refreshDiskGroupCounts(active);
    }

    private applyRowCountUpdate(message: Extract<ResultPanelHostToWebviewMessage, { command: 'rowCountUpdate' }>): void {
        const ref = this.refs.get(sourceIndexKey(message.sourceUri, message.resultSetIndex));
        if (!ref || (message.resultSetId !== undefined && message.resultSetId !== ref.resultSetId)) return;
        const result = this.resultForRef(ref);
        if (!result) return;
        this.dispatch({
            type: 'results/hydrate',
            sourceId: ref.sourceId,
            executionId: ref.executionId,
            resultSetId: ref.resultSetId,
            loadedRowCount: this.rows.get(resultKey(ref.sourceId, ref.resultSetId))?.length ?? result.loadedRowCount,
            totalRowCount: message.totalRows,
            ...(message.limitReached ? { limitReached: true } : {}),
        });
    }

    private applyRowWindow(message: Extract<ResultPanelHostToWebviewMessage, { command: 'rowWindow' }>): void {
        const fetchPending = this.pendingRowFetches.get(message.requestId);
        if (fetchPending) {
            this.pendingRowFetches.delete(message.requestId);
            clearTimeout(fetchPending.timer);
            if (fetchPending.ref.sourceId !== message.sourceUri || fetchPending.offset !== message.offset) {
                fetchPending.reject(new Error('Row window response did not match the request.'));
                return;
            }
            fetchPending.resolve(decodeSharedRows(message.rows), message.totalRows);
            return;
        }
        const pending = this.pendingRowWindows.get(message.requestId);
        this.pendingRowWindows.delete(message.requestId);
        // A response is only valid for a request that is still live. The ref
        // identity also rejects a late response after refresh/replacement even
        // when the host reuses the same stable result-set id.
        if (!pending || pending.ref.sourceId !== message.sourceUri || pending.offset !== message.offset) return;
        const ref = this.refs.get(sourceIndexKey(message.sourceUri, message.resultSetIndex));
        if (!ref || pending.ref !== ref) return;
        this.applyLoadedRows(ref, message.offset, decodeSharedRows(message.rows), message.totalRows);
    }

    private applyDiskQueryResult(message: Extract<ResultPanelHostToWebviewMessage, { command: 'diskQueryResult' }>): void {
        const testPending = this.pendingDiskQueries.get(message.requestId);
        if (testPending) {
            this.pendingDiskQueries.delete(message.requestId);
            clearTimeout(testPending.timer);
            testPending.resolve(message);
            return;
        }
        if (message.action === 'distinct') {
            const pendingValues = this.pendingFilterValues.get(message.requestId);
            if (!pendingValues) return;
            this.pendingFilterValues.delete(message.requestId);
            const values = (message.distinctValues ?? []).map(item => ({
                key: sharedFilterValueKey(item.raw),
                value: item.raw,
                label: formatDataGridCellValue(item.raw, pendingValues.column.type, pendingValues.column),
            }));
            values.sort((left, right) => left.label.localeCompare(right.label));
            pendingValues.resolve(values, message.distinctTruncated === true);
            return;
        }
        if (message.action !== 'window' || message.rows === undefined) return;
        const fetchPending = this.pendingRowFetches.get(message.requestId);
        if (fetchPending) {
            this.pendingRowFetches.delete(message.requestId);
            clearTimeout(fetchPending.timer);
            const fetchOffset = asNonNegativeInteger(message.offset) ?? 0;
            if (fetchPending.ref.sourceId !== message.sourceUri || fetchPending.offset !== fetchOffset) {
                fetchPending.reject(new Error('Row window response did not match the request.'));
                return;
            }
            fetchPending.resolve(decodeSharedRows(message.rows), message.filteredCount ?? message.totalRows);
            return;
        }
        const pending = this.pendingRowWindows.get(message.requestId);
        this.pendingRowWindows.delete(message.requestId);
        const offset = asNonNegativeInteger(message.offset) ?? 0;
        if (!pending || pending.ref.sourceId !== message.sourceUri || pending.offset !== offset) return;
        const ref = this.refs.get(sourceIndexKey(message.sourceUri, message.resultSetIndex));
        if (!ref || pending.ref !== ref) return;
        this.applyLoadedRows(
            ref,
            offset,
            decodeSharedRows(message.rows),
            message.filteredCount ?? message.totalRows,
        );
    }

    private resultForRef(ref: ResultRef): UiResultSurfaceState | undefined {
        return Object.values(this.getState().results.byResultSetId)
            .find(result => result.sourceId === ref.sourceId && result.resultSetId === ref.resultSetId);
    }

    private applyLoadedRows(ref: ResultRef, offset: number, rows: readonly unknown[][], totalRows?: number): void {
        const result = this.resultForRef(ref);
        if (!result) return;
        const key = resultKey(ref.sourceId, ref.resultSetId);
        const existingRows = this.rows.get(key) ?? [];
        const insertAt = Math.min(offset, existingRows.length);
        const nextRows = [...existingRows];
        nextRows.splice(insertAt, rows.length, ...rows);
        this.rows.set(key, nextRows);
        this.dispatch({
            type: 'results/hydrate',
            sourceId: ref.sourceId,
            executionId: ref.executionId,
            resultSetId: ref.resultSetId,
            loadedRowCount: nextRows.length,
            totalRowCount: Math.max(nextRows.length, totalRows ?? result.totalRowCount),
        });
    }

    private applyStreamingComplete(message: Extract<ResultPanelHostToWebviewMessage, { command: 'streamingComplete' }>): void {
        const sourceId = message.sourceUri;
        if (this.getState().results.activeSourceId && this.getState().results.activeSourceId !== sourceId) return;
        const ref = this.refs.get(sourceIndexKey(sourceId, message.resultSetIndex));
        if (!ref || (message.resultSetId !== undefined && message.resultSetId !== ref.resultSetId)) return;
        const key = resultKey(ref.sourceId, ref.resultSetId);
        const expectedChunk = this.nextChunkSequence.get(key);
        if (message.lastChunkSequence !== undefined && expectedChunk !== undefined && message.lastChunkSequence !== expectedChunk - 1) return;
        const result = Object.values(this.getState().results.byResultSetId)
            .find(candidate => candidate.sourceId === ref.sourceId && candidate.resultSetId === ref.resultSetId);
        if (!result) return;
        const nextSequence = this.nextSequence.get(key) ?? result.lastSequence + 1;
        this.dispatch({
            type: 'execution/event',
            event: {
                ...eventBase(ref, nextSequence),
                type: message.totalRows === 0 ? 'empty' : 'complete',
                ...(message.totalRows === 0 ? {} : { totalRowCount: Math.max(message.totalRows, (this.rows.get(key) ?? []).length) }),
                ...(message.limitReached ? { limitReached: true } : {}),
            } as UiResultEvent,
        });
        this.nextSequence.set(key, nextSequence + 1);
        this.nextChunkSequence.delete(key);
        this.trace({
            phase: 'streaming_complete_applied',
            sourceUri: sourceId,
            resultSetIndex: message.resultSetIndex,
            totalRows: typeof message.totalRows === 'number' ? message.totalRows : (this.rows.get(key) ?? []).length,
        });
        const completed = this.resultForRef(ref);
        if (completed && this.isDiskBackedResult(completed) && completed.view.grouping.length > 0) {
            void this.refreshDiskGroupCounts(completed);
        }
    }

    private applyCancellation(sourceId: string): void {
        for (const result of Object.values(this.getState().results.byResultSetId)) {
            if (result.sourceId !== sourceId || (result.status !== 'loading' && result.status !== 'streaming')) continue;
            const requestKey = sourceIndexKey(sourceId, result.statementIndex);
            const requestId = this.cancelRequests.get(requestKey);
            if (requestId) {
                this.dispatch({ type: 'execution/cancel-acknowledged', sourceId, executionId: result.executionId, requestId });
            }
            const ref: ResultRef = {
                sourceId,
                resultSetIndex: result.statementIndex,
                resultSetId: result.resultSetId,
                executionId: result.executionId,
            };
            const key = resultKey(sourceId, result.resultSetId);
            const sequence = this.nextSequence.get(key) ?? result.lastSequence + 1;
            this.dispatch({
                type: 'execution/event',
                event: { ...eventBase(ref, sequence), type: 'cancelled', totalRowCount: result.totalRowCount },
            });
            this.nextSequence.set(key, sequence + 1);
            this.cancelRequests.delete(requestKey);
        }
    }

    private selectResultByIndex(index: number, explicit = false): void {
        const sourceId = this.getState().results.activeSourceId;
        if (!sourceId) return;
        const ref = this.refs.get(sourceIndexKey(sourceId, index));
        if (ref) this.selectResult(ref.resultSetId, sourceId, explicit);
    }

    /**
     * The host can report Logs as active while the real query result arrives
     * in a separate append/disk activation. Select the latest data result for
     * that source unless the user explicitly pinned Logs.
     */
    private selectPreferredDataResult(sourceId: string): string | undefined {
        if (this.manualLogSelection === sourceId) return undefined;
        const preferred = this.preferredDataResults.get(sourceId);
        if (!preferred) return undefined;
        const result = this.getState().results.byResultSetId[preferred];
        if (!result || result.sourceId !== sourceId || this.isLogResult(result)) return undefined;
        this.dispatch({ type: 'results/select', sourceId, resultSetId: preferred });
        return preferred;
    }

    /** Fallback when the host reports Logs but a data tab is already present. */
    private selectLatestDataResult(sourceId: string): string | undefined {
        if (this.manualLogSelection === sourceId) return undefined;
        const result = Object.values(this.getState().results.byResultSetId)
            .filter(candidate => candidate.sourceId === sourceId && !this.isLogResult(candidate))
            .sort((left, right) => right.statementIndex - left.statementIndex)[0];
        if (!result) return undefined;
        this.dispatch({ type: 'results/select', sourceId, resultSetId: result.resultSetId });
        return result.resultSetId;
    }

    private trace(event: ResultPanelTraceEventPayload): void {
        if (!this.traceEnabled) return;
        postHostMessage({
            command: 'reportResultPanelTrace',
            event: { ...event, webviewSeq: ++this.traceSequence },
        });
    }

    private async runTestBridgeAction(requestId: string, action: string, args: unknown): Promise<void> {
        this.trace({ phase: 'test_bridge_received', command: 'testBridge', reason: action });
        try {
            const result = await this.executeTestBridgeAction(action, args);
            postHostMessage({ command: 'testBridgeResult', requestId, action, ok: true, result });
            this.trace({ phase: 'test_bridge_result_sent', command: 'testBridge', reason: action });
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error))
                .replace(/'[^']{0,128}'/g, "'<redacted>'")
                .replace(/\s+/g, ' ')
                .slice(0, 256);
            postHostMessage({
                command: 'testBridgeResult',
                requestId,
                action,
                ok: false,
                error: message,
            });
            this.trace({ phase: 'test_bridge_result_sent', command: 'testBridge', reason: action, error: message });
        }
    }

    private async executeTestBridgeAction(action: string, args: unknown): Promise<unknown> {
        const values = isRecord(args) ? args : {};
        // Deliberately if/else rather than a switch: the webview contract test
        // treats every `case` label in this file as a host message command.
        if (action === 'snapshot') {
            return this.testBridgeSnapshot();
        }
        if (action === 'switchResultSet') {
            const index = asNonNegativeInteger(values.resultSetIndex);
            if (index === undefined) throw new Error('A result set index is required.');
            this.selectResultByIndex(index, true);
            await sharedBridgeSleep(100);
            return this.testBridgeSnapshot();
        }
        if (action === 'switchSource') {
            const sourceUri = asNonEmptyString(values.sourceUri);
            if (!sourceUri) throw new Error('A source URI is required.');
            if (this.getState().results.activeSourceId !== sourceUri) {
                postHostMessage({ command: 'switchSource', sourceUri });
                await waitForSharedBridge(
                    'source switch',
                    () => this.getState().results.activeSourceId === sourceUri,
                    10_000,
                );
            }
            return this.testBridgeSnapshot();
        }
        if (action === 'setGlobalFilter') {
            return this.applyTestGlobalFilter(String(values.value ?? ''), asNonNegativeInteger(values.expectedVisibleRowCount));
        }
        if (action === 'clearGlobalFilter' || action === 'setGlobalFilterBurst') {
            const burst = Array.isArray(values.values) ? values.values.map(String) : [''];
            return this.applyTestGlobalFilter(
                burst[burst.length - 1] ?? '',
                asNonNegativeInteger(values.expectedVisibleRowCount),
                burst,
                asNonNegativeInteger(values.intervalMs) ?? 0,
            );
        }
        if (action === 'setColumnFilter') {
            return this.applyTestColumnFilter(values);
        }
        if (action === 'sortResult') {
            const result = this.activeResult();
            if (!result) throw new Error('No active result.');
            const startedAt = performance.now();
            const column = String(values.columnId ?? values.columnIndex ?? 0);
            this.updateView(result.resultSetId, { sorting: [{ column, descending: values.desc === true }] });
            await sharedBridgeSleep(50);
            await this.waitForTestBridgeRows();
            return { ...this.testBridgeSnapshot(), durationMs: performance.now() - startedAt };
        }
        if (action === 'scrollResult') {
            const startedAt = performance.now();
            const { result } = this.activeResultRef();
            const rowIndex = asNonNegativeInteger(values.rowIndex);
            const scrollLeft = typeof values.scrollLeft === 'number'
                ? Math.max(0, values.scrollLeft)
                : result.view.scrollLeft;
            const scrollTop = typeof values.scrollTop === 'number'
                ? Math.max(0, values.scrollTop)
                : rowIndex !== undefined
                    ? Math.max(0, rowIndex * 26)
                    : result.view.scrollTop;
            const anchorRow = rowIndex ?? Math.floor(scrollTop / 26);
            // The grid is a controlled scroller: keep its persisted position in
            // sync or its restoration effect writes the old offset back.
            this.updateView(result.resultSetId, {
                scrollTop,
                scrollLeft,
                anchorRow,
                scrollRowHeight: 26,
            });
            await sharedBridgeSleep(250);
            const target = document.querySelector<HTMLElement>('.ui-data-grid-scroll');
            if (!target) throw new Error('The active result has no scroll target.');
            if (target.scrollTop !== scrollTop) target.scrollTop = scrollTop;
            if (target.scrollLeft !== scrollLeft) target.scrollLeft = scrollLeft;
            target.dispatchEvent(new Event('scroll'));
            await sharedBridgeSleep(250);
            return { ...this.testBridgeSnapshot(), durationMs: performance.now() - startedAt };
        }
        if (action === 'togglePin') {
            const { result } = this.activeResultRef();
            postHostMessage({ command: 'togglePin', sourceUri: result.sourceId });
            await sharedBridgeSleep(100);
            return this.testBridgeSnapshot();
        }
        if (action === 'toggleResultPin') {
            const result = this.activeResult();
            if (!result) throw new Error('No active result.');
            this.toggleResultPin(result);
            await sharedBridgeSleep(100);
            return this.testBridgeSnapshot();
        }
        if (action === 'refresh') {
            const { result } = this.activeResultRef();
            const beforeRows = result.loadedRowCount;
            this.refresh(result);
            await sharedBridgeSleep(125);
            await waitForSharedBridge('result refresh', () => {
                const current = this.activeResult();
                if (!current) return true;
                if (this.executingSources.has(current.sourceId)) return false;
                return this.pendingRowWindows.size === 0
                    && (current.loadedRowCount !== beforeRows || current.status !== 'loading');
            }, 5_000).catch(() => undefined);
            return this.testBridgeSnapshot();
        }
        if (action === 'export') {
            const { result, ref } = this.activeResultRef();
            const destination = asNonEmptyString(values.destination);
            if (!destination) throw new Error('An export destination is required.');
            postHostMessage({
                command: 'export',
                format: String(values.format ?? 'csv') as ResultPanelExportFormat,
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                destination,
            });
            await sharedBridgeSleep(300);
            return { requested: true };
        }
        if (action === 'databaseFilterValues') {
            const { result } = this.activeResultRef();
            const columnIndex = asNonNegativeInteger(values.columnIndex);
            if (columnIndex === undefined || !result.columns[columnIndex]) {
                throw new Error('A valid filter column is required.');
            }
            return this.requestTestDatabaseFilterValues(result, columnIndex, values.querySpec);
        }
        if (action === 'databaseAggregations') {
            const { result } = this.activeResultRef();
            return this.requestTestDatabaseAggregations(result, values.aggregations);
        }
        if (action === 'applyDatabaseFilter') {
            const { result, ref } = this.activeResultRef();
            const spec = isRecord(values.querySpec) ? values.querySpec as unknown as DiskQuerySpec : undefined;
            // The shared grid applies filters through its own row window, but
            // the traced bridge still exercises the host's filter endpoint.
            postHostMessage({
                command: 'applyDatabaseFilter',
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                requestId: ++this.testQueryRequestId,
                ...(spec === undefined ? {} : { querySpec: spec }),
                timeoutSeconds: 10,
            });
            this.applyTestDatabaseFilter(result, spec);
            await sharedBridgeSleep(100);
            await this.waitForTestBridgeRows();
            return this.testBridgeSnapshot();
        }
        if (action === 'openGroupingPanel') {
            return this.testBridgeSnapshot();
        }
        if (action === 'configureGrouping') {
            return this.configureTestGrouping(values);
        }
        if (action === 'runGrouping') {
            return this.runTestGrouping();
        }
        if (action === 'diskMove') {
            const { result, ref } = this.activeResultRef();
            if (!this.isDiskBackedResult(result)) {
                postHostMessage({ command: 'moveToDisk', sourceUri: result.sourceId, resultSetIndex: ref.resultSetIndex });
                try {
                    await waitForSharedBridge('disk-backed activation', () => {
                        const current = this.activeResult();
                        return current !== undefined && this.isDiskBackedResult(current);
                    }, 5_000);
                } catch {
                    // The host treats an already-spilled result as a no-op and
                    // does not re-post diskBackedActivate. Probe the store so a
                    // lost activation flag cannot deadlock the bridge.
                    const current = this.activeResultRef();
                    await this.requestTestDiskQuery(current.result, { action: 'count' }, 3_000);
                    this.diskBacked.add(resultKey(current.result.sourceId, current.result.resultSetId));
                    this.notify();
                }
            }
            return this.testBridgeSnapshot();
        }
        if (action === 'diskQuery') {
            const { result } = this.activeResultRef();
            if (!this.isDiskBackedResult(result)) throw new Error('The active result is not disk-backed.');
            const count = await this.requestTestDiskQuery(result, { action: 'count' });
            const distinct = await this.requestTestDiskQuery(result, {
                action: 'distinct',
                columnIndex: 1,
                distinctLimit: 10_001,
            });
            const aggregations = await this.requestTestDiskQuery(result, {
                action: 'aggregate',
                aggregations: [{ columnIndex: 3, fn: 'sum' }, { columnIndex: 3, fn: 'count' }],
            });
            const groups = await this.requestTestDiskQuery(result, {
                action: 'group',
                grouping: [{ columnIndex: 1 }],
                offset: 0,
                limit: 100,
                aggregations: [{ columnIndex: 3, fn: 'sum' }],
            });
            return {
                count: count.filteredCount ?? 0,
                distinctCount: distinct.distinctValues?.length ?? 0,
                distinctTruncated: distinct.distinctTruncated === true,
                aggregationCount: aggregations.aggregations?.length ?? 0,
                groupCount: groups.groupResult?.groups?.length ?? 0,
                groupTotalCount: groups.groupResult?.totalCount ?? 0,
            };
        }
        if (action === 'exploreWorkflow') {
            return this.runTestExploreWorkflow(values);
        }
        throw new Error(`Test bridge action '${action}' is not available in the shared result panel.`);
    }

    private activeResultRef(): { readonly result: UiResultSurfaceState; readonly ref: ResultRef } {
        const result = this.activeResult();
        if (!result) throw new Error('No active result.');
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) throw new Error('The active result is not ready.');
        return { result, ref };
    }

    private async waitForTestBridgeRows(): Promise<void> {
        await waitForSharedBridge(
            'pending row windows to settle',
            () => this.pendingRowWindows.size === 0,
            15_000,
        );
    }

    private async applyTestColumnFilter(values: Record<string, unknown>): Promise<unknown> {
        const { result } = this.activeResultRef();
        const index = asNonNegativeInteger(values.columnIndex);
        const column = index === undefined ? undefined : result.columns[index];
        if (!column) throw new Error('A valid filter column is required.');
        const value = String(values.value ?? '');
        const columnFilters = { ...result.view.columnFilters };
        const definitions = { ...(result.view.columnFilterDefinitions ?? {}) };
        delete definitions[column.name];
        if (value.trim() === '') delete columnFilters[column.name];
        else columnFilters[column.name] = value;
        this.updateView(result.resultSetId, { columnFilters, columnFilterDefinitions: definitions });
        await sharedBridgeSleep(50);
        await this.waitForTestBridgeRows();
        return this.testBridgeSnapshot();
    }

    private async requestTestDatabaseFilterValues(
        result: UiResultSurfaceState,
        columnIndex: number,
        querySpecValue: unknown,
    ): Promise<Record<string, unknown>> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) throw new Error('The active result is not ready.');
        const querySpec = isRecord(querySpecValue) ? querySpecValue as unknown as DiskQuerySpec : undefined;
        const requestId = ++this.testQueryRequestId;
        const response = await new Promise<{ readonly values: readonly { readonly raw: unknown; readonly count: number }[]; readonly truncated: boolean }>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingDatabaseFilterValues.delete(requestId);
                reject(new Error('Database filter values timed out.'));
            }, 15_000);
            this.pendingDatabaseFilterValues.set(requestId, {
                resolve: (values, truncated) => resolve({ values, truncated }),
                reject,
                timer,
            });
            postHostMessage({
                command: 'requestDatabaseFilterValues',
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                columnIndex,
                requestId,
                timeoutSeconds: 10,
                ...(querySpec === undefined ? {} : { querySpec }),
            });
        });
        return {
            valueCount: response.values.length,
            truncated: response.truncated,
            nullValueCount: response.values.filter(value => value.raw === null || value.raw === undefined).length,
        };
    }

    private async requestTestDatabaseAggregations(
        result: UiResultSurfaceState,
        value: unknown,
    ): Promise<Record<string, unknown>> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) throw new Error('The active result is not ready.');
        const aggregations = (Array.isArray(value) ? value : [])
            .filter(isRecord)
            .map(item => ({
                columnIndex: asNonNegativeInteger(item.columnIndex) ?? 0,
                fn: String(item.fn ?? 'count'),
            }));
        if (aggregations.length === 0) aggregations.push({ columnIndex: 0, fn: 'count' });
        const requestId = ++this.testQueryRequestId;
        const results = await new Promise<readonly { readonly columnIndex: number; readonly fn: string; readonly value: unknown; readonly filteredRowCount?: number }[]>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingDatabaseAggregations.delete(requestId);
                reject(new Error('Database aggregations timed out.'));
            }, 15_000);
            this.pendingDatabaseAggregations.set(requestId, { resolve, reject, timer });
            postHostMessage({
                command: 'requestDatabaseAggregations',
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                requestId,
                aggregations,
                timeoutSeconds: 10,
            });
        });
        return {
            count: results.length,
            functions: results.map(item => item.fn),
            numericResultCount: results.filter(item => typeof item.value === 'number').length,
        };
    }

    private async requestTestDatabaseGrouping(
        result: UiResultSurfaceState,
        grouping: SharedDatabaseGroupingRequest,
    ): Promise<Extract<ResultPanelHostToWebviewMessage, { command: 'databaseGroupingResult' }>> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) throw new Error('The active result is not ready.');
        const requestId = ++this.testQueryRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingDatabaseGrouping.delete(requestId);
                reject(new Error('Database grouping timed out.'));
            }, 30_000);
            this.pendingDatabaseGrouping.set(requestId, { resolve, reject, timer });
            postHostMessage({
                command: 'requestDatabaseGrouping',
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                requestId,
                grouping,
                timeoutSeconds: 30,
            });
        });
    }

    private async requestTestDiskQuery(
        result: UiResultSurfaceState,
        request: {
            readonly action: 'count' | 'distinct' | 'aggregate' | 'group';
            readonly columnIndex?: number;
            readonly distinctLimit?: number;
            readonly aggregations?: readonly { readonly columnIndex: number; readonly fn: string }[];
            readonly grouping?: readonly { readonly columnIndex: number }[];
            readonly offset?: number;
            readonly limit?: number;
        },
        timeoutMs = 15_000,
    ): Promise<Extract<ResultPanelHostToWebviewMessage, { command: 'diskQueryResult' }>> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref) throw new Error('The active result is not ready.');
        const requestId = ++this.testQueryRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingDiskQueries.delete(requestId);
                reject(new Error(`Disk query '${request.action}' timed out.`));
            }, timeoutMs);
            this.pendingDiskQueries.set(requestId, { action: request.action, resolve, reject, timer });
            postHostMessage({
                command: 'diskQuery',
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                requestId,
                action: request.action,
                ...(request.columnIndex === undefined ? {} : { columnIndex: request.columnIndex }),
                ...(request.distinctLimit === undefined ? {} : { distinctLimit: request.distinctLimit }),
                ...(request.offset === undefined ? {} : { offset: request.offset }),
                ...(request.limit === undefined ? {} : { limit: request.limit }),
                ...(request.aggregations === undefined
                    ? {}
                    : { aggregations: request.aggregations.map(item => ({ ...item })) }),
                ...(request.grouping === undefined
                    ? {}
                    : { grouping: request.grouping.map(item => ({ ...item })) }),
            });
        });
    }

    private applyTestDatabaseFilter(result: UiResultSurfaceState, spec: DiskQuerySpec | undefined): void {
        const definitions: Record<string, UiResultColumnFilterDefinition> = {};
        const columnFilters: Record<string, string> = {};
        const filters = Array.isArray(spec?.columnFilters) ? spec.columnFilters : [];
        for (const filter of filters) {
            if (!isRecord(filter)) continue;
            const index = asNonNegativeInteger(filter.columnIndex);
            const column = index === undefined ? undefined : result.columns[index];
            if (!column) continue;
            const filterValues = Array.isArray(filter.values) ? filter.values : [];
            if (filterValues.length > 0) {
                definitions[column.name] = { operator: 'in', value: '', values: filterValues };
                continue;
            }
            const conditions = Array.isArray(filter.conditions)
                ? filter.conditions.map(condition => condition as unknown as Record<string, unknown>)
                : [];
            const first = conditions[0];
            if (!first) continue;
            definitions[column.name] = {
                operator: String(first.type ?? 'contains') as UiResultColumnFilterDefinition['operator'],
                value: String(first.value ?? ''),
                ...(first.value2 === undefined ? {} : { value2: String(first.value2) }),
            };
        }
        this.updateView(result.resultSetId, {
            globalFilter: typeof spec?.globalSearch === 'string' ? spec.globalSearch : '',
            columnFilters,
            columnFilterDefinitions: definitions,
        });
    }

    private configureTestGrouping(values: Record<string, unknown>): unknown {
        const { result } = this.activeResultRef();
        const columns = Array.isArray(values.columns)
            ? values.columns.filter((item): item is number => Number.isInteger(item) && (item as number) >= 0)
            : [];
        const functions = (Array.isArray(values.functions) ? values.functions : [])
            .filter(isRecord)
            .map(item => ({
                fn: String(item.fn ?? 'count'),
                ...(Number.isInteger(item.columnIndex) ? { columnIndex: item.columnIndex as number } : {}),
            }));
        this.bridgeGrouping = { resultSetId: result.resultSetId, columns, functions };
        const names = columns.flatMap(index => {
            const column = result.columns[index];
            return column ? [column.name] : [];
        });
        this.updateView(result.resultSetId, { grouping: names });
        return this.testBridgeSnapshot();
    }

    private async runTestGrouping(): Promise<unknown> {
        const { result } = this.activeResultRef();
        const config = this.bridgeGrouping;
        if (!config || config.resultSetId !== result.resultSetId) {
            throw new Error('Grouping configuration test hook is not available.');
        }
        const groupByColumns = config.columns.flatMap(index => {
            const column = result.columns[index];
            return column ? [{ columnIndex: index, columnName: column.name }] : [];
        });
        if (groupByColumns.length === 0) throw new Error('A grouping column is required.');
        const message = await this.requestTestDatabaseGrouping(result, {
            groupByColumns,
            functions: config.functions.map(item => ({
                fn: item.fn,
                ...(item.columnIndex === undefined ? {} : { columnIndex: item.columnIndex }),
                alias: `${item.fn.toUpperCase()}${item.columnIndex === undefined
                    ? ''
                    : `_${result.columns[item.columnIndex]?.name ?? item.columnIndex}`}`,
            })),
            limit: 10_001,
            filterSpec: sharedAnalysisQuerySpec(result),
        });
        const columns = message.columns ?? [];
        return {
            columnCount: columns.length,
            headers: columns.map(column => column.name),
            rowCount: message.rows?.length ?? 0,
            summary: message.truncated === true ? 'truncated' : '',
            sqlFingerprint: sharedTestBridgeFingerprint(
                message.sql ?? columns.map(column => column.name).join('|'),
            ),
        };
    }

    private async runTestExploreWorkflow(values: Record<string, unknown>): Promise<unknown> {
        this.testExploreWorkflowActive = true;
        try {
            return await this.runTestExploreWorkflowBody(values);
        } finally {
            this.testExploreWorkflowActive = false;
        }
    }

    private async runTestExploreWorkflowBody(values: Record<string, unknown>): Promise<unknown> {
        const categoryIndex = asNonNegativeInteger(values.columnIndex) ?? 1;
        const selectedValue = String(values.value ?? 'Alpha');
        const { result, ref } = this.activeResultRef();
        // Test the host's Explore protocol directly. The DOM surface is covered
        // by the Playwright parity suite; routing the Extension Host gate
        // through the protocol keeps it deterministic when background hydrates
        // would otherwise replace the analysis view.
        const exploreResultSet: ResultSet = {
            resultSetId: result.resultSetId,
            statementIndex: result.statementIndex,
            name: `Result ${result.statementIndex + 1}`,
            columns: result.columns.map((column, index) => ({ name: column.name, type: column.type, index, scale: column.scale })),
            data: this.getRows(result).map(row => [...row]),
            totalRowCount: result.totalRowCount,
            storageMode: this.isDiskBackedResult(result) ? 'sqlite' : 'memory',
            isStreamingComplete: result.status !== 'loading' && result.status !== 'streaming',
            isCancelled: result.cancellation !== 'none',
            limitReached: result.limitReached === true,
            executionTimestamp: result.lastSequence,
            sql: this.getResultSql(result)?.sql,
            refreshSql: this.getResultSql(result)?.refreshSql,
        };
        setExploreContext({
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
            resultSet: exploreResultSet,
        });
        try {
            const filters: ExploreFilterModel = {
                dimensions: [{ columnIndex: categoryIndex, values: [selectedValue] }],
                dates: [],
                measures: [],
            };
            const ranking = await requestExploreOperation({
                kind: 'ranking',
                config: {
                    categoryColumnIndex: categoryIndex,
                    aggregate: 'count',
                    direction: 'top',
                    count: 10,
                    showShare: false,
                    includeOther: false,
                    filters,
                },
            });
            const rankedCount = ranking.rows.length;
            const firstRow = ranking.rows[0];
            if (!firstRow) throw new Error('Explore ranking returned no categories.');
            const rowFilters: ExploreFilterModel = structuredClone(ranking.filters ?? filters);
            rowFilters.dimensions = rowFilters.dimensions.filter(item => item.columnIndex !== categoryIndex);
            rowFilters.dimensions.push({
                columnIndex: categoryIndex,
                values: firstRow[0] == null || firstRow[0] === '' ? [] : [firstRow[0] as ExploreValue],
                includeNull: firstRow[0] == null,
                includeEmpty: firstRow[0] === '',
            });
            const detail = await requestExploreOperation({ kind: 'rows', filters: rowFilters });
            return { rankedCount, rowCount: detail.rows.length, filtersRestored: true };
        } finally {
            clearExploreContext();
        }
    }

    private async applyTestGlobalFilter(
        value: string,
        expected: number | undefined,
        burst: readonly string[] = [],
        intervalMs = 0,
    ): Promise<unknown> {
        const result = this.activeResult();
        if (!result) throw new Error('No active result.');
        const startedAt = performance.now();
        let lastInputAt = startedAt;
        for (let index = 0; index < burst.length; index += 1) {
            lastInputAt = performance.now();
            if (intervalMs > 0 && index < burst.length - 1) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        // The production grid debounces text input before applying the filter.
        // Mirror that contract here so the bridge measures the same quiet period.
        const debounceMs = 200;
        await new Promise(resolve => setTimeout(resolve, debounceMs));
        this.updateView(result.resultSetId, { globalFilter: value });
        const appliedAt = performance.now();
        if (expected !== undefined) {
            const waitStartedAt = Date.now();
            while (Date.now() - waitStartedAt < 5_000) {
                const current = this.activeResult();
                if (current && processDataGridRows(current.columns, this.getRows(current), current.view).length === expected) break;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
        return {
            ...this.testBridgeSnapshot(),
            durationMs: performance.now() - startedAt,
            filterApplyCount: 1,
            filterApplyLatencyMs: appliedAt - lastInputAt,
            filterDebounceMs: debounceMs,
            filterValue: value,
        };
    }

    private testBridgeSnapshot(): Record<string, unknown> {
        const state = this.getState();
        const activeSourceId = state.results.activeSourceId;
        const results = Object.values(state.results.byResultSetId)
            .filter(result => activeSourceId === undefined || result.sourceId === activeSourceId)
            .sort((left, right) => left.statementIndex - right.statementIndex);
        const active = results.find(result => result.resultSetId === state.results.activeResultSetId) ?? results[0];
        const rows = active ? this.getRows(active) : [];
        const visibleRows = active ? processDataGridRows(active.columns, rows, active.view) : [];
        // Disk-backed results keep only the requested window in the webview;
        // the host's filtered count is authoritative for the visible row count.
        const visibleRowCount = active && this.isDiskBackedResult(active)
            ? active.totalRowCount
            : visibleRows.length;
        const firstValue = visibleRows[0]?.[0];
        const scroll = document.querySelector<HTMLElement>('.ui-data-grid-scroll');
        const firstRow = document.querySelector<HTMLElement>('.ui-data-grid tbody tr[data-row-index]');
        const firstRowIndex = Number(firstRow?.dataset.rowIndex ?? -1);
        const rowCountText = document.querySelector<HTMLElement>('.ui-result-toolbar-row-count')?.textContent ?? '';
        return {
            sourceUri: activeSourceId,
            activeResultSetIndex: active?.statementIndex ?? 0,
            activeResultSetId: active?.resultSetId,
            resultSetCount: results.length,
            resultSets: results.map(result => ({
                resultSetId: result.resultSetId,
                isLog: this.isLogResult(result),
                isError: result.status === 'error',
                rowCount: this.getRows(result).length,
                totalRowCount: result.totalRowCount,
                storageMode: this.isDiskBackedResult(result) ? 'sqlite' : 'memory',
                limitReached: this.limitReached.has(resultKey(result.sourceId, result.resultSetId)),
                hasRefreshSql: Boolean(this.getResultSql(result)?.refreshSql),
                columnCount: result.columns.length,
            })),
            visibleRowCount,
            firstCellFingerprint: firstValue === undefined ? '' : sharedTestBridgeFingerprint(`${typeof firstValue}:${String(firstValue)}`),
            rowCountText: rowCountText.slice(0, 128),
            globalFilterActive: Boolean(active?.view.globalFilter.trim()),
            columnFilterCount: Object.keys(active?.view.columnFilters ?? {}).length,
            sorting: active?.view.sorting ?? [],
            databaseFilterActive: false,
            groupingPanelVisible: Boolean(active?.view.grouping.length),
            groupingResultRows: document.querySelectorAll('.ui-data-grid-group-row').length,
            pendingRequestCount: this.pendingRowWindows.size + this.pendingFilterValues.size,
            viewport: {
                scrollTop: scroll?.scrollTop ?? 0,
                scrollLeft: scroll?.scrollLeft ?? 0,
                scrollHeight: scroll?.scrollHeight ?? 0,
                clientHeight: scroll?.clientHeight ?? 0,
                scrollWidth: scroll?.scrollWidth ?? 0,
                clientWidth: scroll?.clientWidth ?? 0,
                scrollAnchorIndex: Number.isInteger(firstRowIndex) && firstRowIndex >= 0
                    ? firstRowIndex
                    : Math.floor(Math.max(0, scroll?.scrollTop ?? 0) / 26),
                firstVisibleRowIndex: Number.isInteger(firstRowIndex) && firstRowIndex >= 0 ? firstRowIndex : undefined,
                firstVisibleRowFingerprint: firstRow
                    ? sharedTestBridgeFingerprint((firstRow.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 256))
                    : '',
            },
        };
    }
}

function useSharedControllerState(controller: SharedResultPanelController): UiState {
    useSyncExternalStore(
        listener => controller.subscribe(listener),
        () => controller.getRevision(),
        () => controller.getRevision(),
    );
    return controller.getState();
}

type ResultExportDestination = 'file' | 'open' | 'temp' | 'clipboard';

const RESULT_EXPORT_FORMATS = [
    { id: 'excel', label: 'Excel (XLSB)', description: 'Binary workbook, smallest and fastest', icon: 'file-spreadsheet' },
    { id: 'xlsx', label: 'Excel (XLSX)', description: 'Workbook with wider compatibility', icon: 'file-spreadsheet' },
    { id: 'csv', label: 'CSV', description: 'Comma separated values', icon: 'table' },
    { id: 'csv.gz', label: 'CSV.GZ', description: 'Gzip-compressed CSV', icon: 'table' },
    { id: 'csv.zst', label: 'CSV.ZST', description: 'Zstandard-compressed CSV', icon: 'table' },
    { id: 'json', label: 'JSON', description: 'Array of row objects', icon: 'file-json' },
    { id: 'xml', label: 'XML', description: 'Extensible markup language', icon: 'code' },
    { id: 'sql', label: 'SQL INSERT', description: 'INSERT statements, data only', icon: 'database' },
    { id: 'markdown', label: 'Markdown', description: 'Markdown table with the header row', icon: 'file-text' },
    { id: 'parquet', label: 'Parquet', description: 'Apache Parquet columnar format', icon: 'rows' },
    { id: 'xpt', label: 'SAS XPORT', description: 'SAS Transport Format v5', icon: 'file-spreadsheet' },
] as const;

const RESULT_EXPORT_DESTINATIONS = [
    { id: 'file', label: 'Save as…', description: 'Choose a folder and file name', icon: 'download' },
    { id: 'open', label: 'Export & Open', description: 'Save to a temp folder and open it', icon: 'link' },
    { id: 'temp', label: 'Export & Copy file', description: 'Save the file and put it on the clipboard', icon: 'clipboard-copy' },
    { id: 'clipboard', label: 'Copy content', description: 'Copy the exported text without a file', icon: 'copy' },
] as const;

const RESULT_EXPORT_TEXT_FORMATS: ReadonlySet<string> = new Set(['csv', 'json', 'xml', 'sql', 'markdown']);

function ResultExportDialog({
    format,
    destination,
    scope,
    onFormatChange,
    onDestinationChange,
    onScopeChange,
    onCancel,
    onExport,
}: {
    readonly format: string;
    readonly destination: ResultExportDestination;
    readonly scope: 'loaded' | 'all';
    readonly onFormatChange: (format: string) => void;
    readonly onDestinationChange: (destination: ResultExportDestination) => void;
    readonly onScopeChange: (scope: 'loaded' | 'all') => void;
    readonly onCancel: () => void;
    readonly onExport: () => void;
}): ReactNode {
    const textFormat = RESULT_EXPORT_TEXT_FORMATS.has(format);
    const activeDestination = !textFormat && destination === 'clipboard' ? 'file' : destination;
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        dialogRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )];
            if (focusable.length === 0) return;
            const first = focusable[0]!;
            const last = focusable[focusable.length - 1]!;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previous?.focus();
        };
    }, [onCancel]);
    return <div className="ui-export-backdrop">
        <div ref={dialogRef} className="ui-export-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-export-title" tabIndex={-1}>
            <header className="ui-export-header">
                <div>
                    <h2 id="ui-export-title">Export active result</h2>
                    <p>Choose the format and how the file should be delivered.</p>
                </div>
                <button type="button" className="ui-export-close" aria-label="Close export" title="Close" onClick={onCancel}><MenuIcon name="x" /></button>
            </header>
            <section className="ui-export-section">
                <h3>Format</h3>
                <div className="ui-export-grid" role="radiogroup" aria-label="Export format">
                    {RESULT_EXPORT_FORMATS.map(option => <button
                        type="button"
                        role="radio"
                        aria-checked={format === option.id}
                        className={`ui-export-option${format === option.id ? ' active' : ''}`}
                        key={option.id}
                        onClick={() => onFormatChange(option.id)}
                    >
                        <MenuIcon name={option.icon} />
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    </button>)}
                </div>
            </section>
            <section className="ui-export-section">
                <h3>Save mode</h3>
                <div className="ui-export-grid" role="radiogroup" aria-label="Export destination">
                    {RESULT_EXPORT_DESTINATIONS.map(option => <button
                        type="button"
                        role="radio"
                        aria-checked={activeDestination === option.id}
                        className={`ui-export-option${activeDestination === option.id ? ' active' : ''}`}
                        key={option.id}
                        disabled={option.id === 'clipboard' && !textFormat}
                        onClick={() => onDestinationChange(option.id)}
                    >
                        <MenuIcon name={option.icon} />
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    </button>)}
                </div>
            </section>
            <section className="ui-export-section ui-export-scope">
                <h3>Rows</h3>
                <label><input type="radio" name="ui-export-scope" checked={scope === 'loaded'} onChange={() => onScopeChange('loaded')} /> Loaded rows</label>
                <label><input type="radio" name="ui-export-scope" checked={scope === 'all'} onChange={() => onScopeChange('all')} /> All rows from the server</label>
            </section>
            <footer className="ui-export-footer">
                <button type="button" onClick={onCancel}>Cancel</button>
                <button type="button" className="primary" onClick={onExport}><MenuIcon name="download" /> Export</button>
            </footer>
        </div>
    </div>;
}

const SHARED_COPY_AS_FORMATS: readonly { readonly id: SharedClipboardFormat; readonly label: string }[] = [
    { id: 'html', label: 'HTML table' },
    { id: 'markdown', label: 'Markdown' },
    { id: 'csv', label: 'CSV' },
    { id: 'json', label: 'JSON' },
    { id: 'sql', label: 'SQL INSERT' },
];

function SharedMoreMenu({
    onClearFilters,
    onRefreshSql,
    onExportAllResults,
    onUndoFilter,
    onRedoFilter,
    onCopyAs,
    onCopyAsImage,
    onQueryLocally,
    onGroupAnalysis,
    onAggregateAnalysis,
    onFindColumn,
}: {
    readonly onClearFilters?: () => void;
    readonly onRefreshSql?: () => void;
    readonly onExportAllResults?: () => void;
    readonly onUndoFilter?: () => void;
    readonly onRedoFilter?: () => void;
    readonly onCopyAs?: (format: SharedClipboardFormat) => void;
    readonly onCopyAsImage?: () => void;
    readonly onQueryLocally?: () => void;
    readonly onGroupAnalysis?: () => void;
    readonly onAggregateAnalysis?: () => void;
    readonly onFindColumn?: () => void;
}): ReactNode {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return undefined;
        const close = (event: MouseEvent): void => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);
    return <div className="ui-result-more" ref={rootRef}>
        <button type="button" className="ui-result-toolbar-icon" aria-label="More result actions" aria-haspopup="menu" aria-expanded={open} title="More result actions" onClick={() => setOpen(value => !value)}><MenuIcon name="list" /></button>
        {open && <div className="ui-result-more-menu" role="menu" aria-label="More result actions">
            {onGroupAnalysis && <button type="button" role="menuitem" onClick={() => { setOpen(false); onGroupAnalysis(); }}>Group in database…</button>}
            {onAggregateAnalysis && <button type="button" role="menuitem" onClick={() => { setOpen(false); onAggregateAnalysis(); }}>Aggregate in database…</button>}
            {(onGroupAnalysis || onAggregateAnalysis) && <hr />}
            {onRefreshSql && <button type="button" role="menuitem" onClick={() => { setOpen(false); onRefreshSql(); }}>Refresh SQL</button>}
            {onFindColumn && <button type="button" role="menuitem" onClick={() => { setOpen(false); onFindColumn(); }}>Find column…</button>}
            {onUndoFilter && <button type="button" role="menuitem" onClick={() => { setOpen(false); onUndoFilter(); }}>Undo filter (Alt+Z)</button>}
            {onRedoFilter && <button type="button" role="menuitem" onClick={() => { setOpen(false); onRedoFilter(); }}>Redo filter (Alt+Y)</button>}
            {onClearFilters && <button type="button" role="menuitem" onClick={() => { setOpen(false); onClearFilters(); }}>Clear all filters</button>}
            {onExportAllResults && <button type="button" role="menuitem" onClick={() => { setOpen(false); onExportAllResults(); }}>All result sets → Excel workbook…</button>}
            {(onCopyAs || onCopyAsImage || onQueryLocally) && <hr />}
            {onCopyAs && <>
                <span className="ui-result-more-heading" role="presentation">Copy as</span>
                {SHARED_COPY_AS_FORMATS.map(option => <button type="button" role="menuitem" key={option.id} onClick={() => { setOpen(false); onCopyAs(option.id); }}>{option.label}</button>)}
            </>}
            {onCopyAsImage && <button type="button" role="menuitem" onClick={() => { setOpen(false); onCopyAsImage(); }}>Copy grid as image (up to 500 rows)</button>}
            {onQueryLocally && <button type="button" role="menuitem" onClick={() => { setOpen(false); onQueryLocally(); }}>Query Locally (DuckDB)…</button>}
        </div>}
    </div>;
}

const LOG_STATUS_ICONS: Record<string, string> = {
    running: '▶',
    success: '✓',
    error: '✗',
    cancelled: '⊘',
    retrying: '↻',
};

function appendLogSpan(parent: HTMLElement, className: string, text: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
    return span;
}

/** Legacy plain/status line builder shared by loose log rows and run-card bodies. */
function createSharedLogLine(row: LogRow): HTMLElement {
    const line = document.createElement('div');
    line.className = 'console-line';
    const time = String(row[0] ?? '');
    const message = String(row[1] ?? '');
    if (message === '') {
        line.classList.add('console-line--empty');
        line.innerHTML = '&nbsp;';
        return line;
    }
    if (message.startsWith('---')) {
        line.classList.add('separator');
        appendLogSpan(line, 'console-time', time);
        appendLogSpan(line, 'console-msg', message);
        return line;
    }
    const parsed = parseRunLogMessage(message);
    if (!parsed) {
        appendLogSpan(line, 'console-time', time);
        appendLogSpan(line, 'console-msg', message);
        return line;
    }
    line.classList.add(`status-${parsed.status}`);
    appendLogSpan(line, 'console-time', time);
    const badge = document.createElement('span');
    badge.className = `log-status log-status--${parsed.status}`;
    const icon = document.createElement('span');
    icon.className = 'log-status-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = LOG_STATUS_ICONS[parsed.status];
    const label = document.createElement('span');
    label.textContent = parsed.status.toUpperCase();
    badge.append(icon, label);
    line.appendChild(badge);
    const msg = document.createElement('span');
    msg.className = 'console-msg';
    if (parsed.sqlPreview) appendLogSpan(msg, 'log-line-sql', parsed.sqlPreview);
    const meta = [parsed.connection, parsed.duration, parsed.rowCount].filter((part): part is string => !!part);
    if (meta.length > 0) appendLogSpan(msg, 'log-meta-inline', meta.join(' · '));
    if (parsed.errorText) appendLogSpan(msg, 'log-error-hint', compactSqlErrorMessage(parsed.errorText));
    line.appendChild(msg);
    return line;
}

/**
 * Uses the legacy run-group renderer (statement cards, chips and SQL previews)
 * so the shared Logs tab matches the legacy transcript instead of flattening
 * every row into one text line.
 */
function SharedLogConsole({
    rows,
    lanesJson,
    sourceUri,
    executing = false,
    cancelling = false,
    startedAt,
    onCancel,
}: {
    readonly rows: readonly (readonly unknown[])[];
    readonly lanesJson?: string;
    readonly sourceUri?: string;
    readonly executing?: boolean;
    readonly cancelling?: boolean;
    /** Epoch milliseconds when the current execution started. */
    readonly startedAt?: number;
    readonly onCancel?: () => void;
}): ReactNode {
    const view = useRef<HTMLDivElement>(null);
    const wrapper = useRef<HTMLDivElement>(null);
    const [search, setSearch] = useState('');
    const filteredRows = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        if (!query) return rows;
        return rows.filter(row => row.some(value =>
            value !== null && value !== undefined && String(value).toLocaleLowerCase().includes(query),
        ));
    }, [rows, search]);
    useEffect(() => {
        const element = view.current;
        if (!element) return;
        const wasAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        const previousTop = element.scrollTop;
        element.replaceChildren();
        if (filteredRows.length === 0) {
            element.appendChild(createSharedLogLine(['', search.trim() ? 'No matching log messages.' : 'No log messages yet.']));
        } else {
            appendRunLogRows(element, filteredRows as LogRow[], createSharedLogLine);
        }
        // The legacy queue presentation owns pause/resume/recover/cancel and
        // per-job details; reuse it instead of flattening the queue into rows.
        if (wrapper.current) updateSqlQueueLogs(lanesJson, sourceUri);
        element.scrollTop = wasAtBottom ? element.scrollHeight : previousTop;
    }, [filteredRows, lanesJson, search, sourceUri]);
    return <div className="ui-result-grid ui-legacy-log console-wrapper" ref={wrapper}>
        <div className="ui-log-toolbar">
            {executing && <span className={`ui-log-running${cancelling ? ' ui-log-running-cancelling' : ''}`}>
                {/* The Logs tab header already spins; this chip adds the state text,
                    the elapsed clock and Cancel without a second animated ring. */}
                <span className="ui-log-running-state" role="status" aria-live="polite">
                    <span>{cancelling ? 'Cancelling…' : 'Running…'}</span>
                </span>
                {startedAt !== undefined && <ExecutionElapsed className="ui-log-running-elapsed" startedAt={startedAt} />}
                {cancelling || onCancel === undefined ? null : <button type="button" className="ui-log-running-cancel" onClick={onCancel}>Cancel</button>}
            </span>}
            <input
                aria-label="Search log"
                placeholder="Search log…"
                value={search}
                onChange={event => setSearch(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape') setSearch(''); }}
            />
            <span role="status">{filteredRows.length.toLocaleString()} / {rows.length.toLocaleString()}</span>
            {search.length > 0 && <button type="button" onClick={() => setSearch('')}>Clear</button>}
        </div>
        <div className="console-view" ref={view} role="log" aria-label="Query log" aria-live="polite" />
    </div>;
}

/**
 * ECharts is a large ESM-only dependency. Load the range-chart surface on
 * demand so panels that never open Charts keep grid startup light and DOM-free
 * test environments do not have to resolve the renderer.
 */
function LazySharedRangeChart(props: SharedRangeChartProps): ReactNode {
    const [Chart, setChart] = useState<ComponentType<SharedRangeChartProps> | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        void import('./sharedRangeChart.js')
            .then(module => {
                if (!cancelled) setChart(() => module.SharedRangeChart);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);
    if (failed) {
        return <div className="ui-range-chart-loading" role="status">Unable to load the chart renderer.</div>;
    }
    if (!Chart) {
        return <div className="ui-range-chart-loading" role="status">Loading chart…</div>;
    }
    return <Chart {...props} />;
}

/**
 * Explore is the largest legacy analysis surface (column cards, filters,
 * server-side pivot, ECharts composer and ranking). It is DOM-based but fully
 * functional, so the shared layout mounts it into a React-owned host while the
 * rest of the panel stays React. The legacy `analysisContainer` is moved into
 * the host for the duration of the view and restored on unmount.
 */
function SharedExploreHost({
    result,
    rows,
    label,
    diskBacked,
    sql,
    refreshSql,
}: {
    readonly result: UiResultSurfaceState;
    readonly rows: readonly unknown[][];
    readonly label: string;
    readonly diskBacked: boolean;
    readonly sql?: string;
    readonly refreshSql?: string;
}): ReactNode {
    const hostRef = useRef<HTMLDivElement>(null);
    const resultSetIndex = result.statementIndex;
    const resultSetId = result.resultSetId;
    const sourceId = result.sourceId;
    // Completed results are hydrated again for unrelated state changes. That
    // changes the result object identity without changing its data; remounting
    // Explore for it would cancel in-flight ranking/pivot requests. The mount
    // effect therefore keys off the stable result identity and reads the
    // latest snapshot through refs.
    const resultRef = useRef(result);
    resultRef.current = result;
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const currentResult = resultRef.current;
        const currentRows = rowsRef.current;
        const existing = document.getElementById('analysisContainer');
        const container = existing ?? document.createElement('div');
        const created = !existing;
        if (created) {
            container.id = 'analysisContainer';
            container.className = 'analysis-container';
        }
        const originalParent = container.parentElement;
        const originalDisplay = container.style.display;
        host.appendChild(container);
        container.style.display = 'block';

        const exploreResultSet: ResultSet = {
            resultSetId: currentResult.resultSetId,
            statementIndex: currentResult.statementIndex,
            name: label,
            columns: currentResult.columns.map((column, index) => ({ name: column.name, type: column.type, index, scale: column.scale })),
            data: currentRows.map(row => [...row]),
            totalRowCount: currentResult.totalRowCount,
            storageMode: diskBacked ? 'sqlite' : 'memory',
            isStreamingComplete: currentResult.status !== 'loading' && currentResult.status !== 'streaming',
            isCancelled: currentResult.cancellation !== 'none',
            limitReached: currentResult.limitReached === true,
            executionTimestamp: currentResult.lastSequence,
            sql,
            refreshSql,
        };
        setExploreContext({
            sourceUri: currentResult.sourceId,
            resultSetIndex,
            resultSet: exploreResultSet,
        });

        // Explore owns the ECharts composer/ranking modules, which are large
        // ESM-only dependencies. Load them only when the view is opened.
        let disposed = false;
        let dispose: (() => void) | undefined;
        void import('./explore/explorePanel.js')
            .then(module => {
                if (disposed) return;
                module.renderExploreView(resultSetIndex);
                dispose = module.disposeExploreView;
            })
            .catch(() => {
                if (!disposed) container.textContent = 'Unable to load Explore.';
            });

        return () => {
            disposed = true;
            dispose?.();
            clearExploreRowRequests();
            clearExploreContext();
            container.innerHTML = '';
            if (created) {
                container.remove();
            } else {
                container.style.display = originalDisplay || 'none';
                if (originalParent) originalParent.appendChild(container);
            }
        };
    }, [diskBacked, label, refreshSql, resultSetId, resultSetIndex, sourceId, sql]);
    return <div className="ui-legacy-explore" ref={hostRef} />;
}

function isSharedColumnHidden(result: UiResultSurfaceState | undefined, columnIndex: number): boolean {
    const column = result?.columns[columnIndex];
    if (!result || !column) return false;
    const visibility = result.view.columnVisibility;
    if (!visibility) return false;
    const key = column.name.trim() || `column-${columnIndex}`;
    return visibility[key] === false || visibility[column.name] === false || visibility[String(columnIndex)] === false;
}

export function SharedResultPanelApp({ controller }: { readonly controller: SharedResultPanelController }): ReactNode {
    const state = useSharedControllerState(controller);
    const [selectedRow, setSelectedRow] = useState<number | undefined>();
    const [selection, setSelection] = useState<DataGridSelection | undefined>();
    const [rowViewOpen, setRowViewOpen] = useState(false);
    const [analysisKind, setAnalysisKind] = useState<UiResultAnalysisKind | undefined>();
    const [analysisTable, setAnalysisTable] = useState<UiResultAnalysisTable | undefined>();
    const [analysisLoading, setAnalysisLoading] = useState(false);
    const [analysisError, setAnalysisError] = useState<string | undefined>();
    const [filterState, setFilterState] = useState<DataGridColumnFilterState | undefined>();
    const [pivotOpen, setPivotOpen] = useState(false);
    const [viewLayout, setViewLayout] = useState<'table' | 'charts' | 'mini-charts' | 'diff' | 'explore' | 'analytical'>('table');
    const [diffBaselineId, setDiffBaselineId] = useState<string | undefined>();
    const [exportOpen, setExportOpen] = useState(false);
    const [exportFormat, setExportFormat] = useState('excel');
    const [exportDestination, setExportDestination] = useState<ResultExportDestination>('file');
    const [exportScope, setExportScope] = useState<'loaded' | 'all'>('loaded');
    const [refreshLimitOpen, setRefreshLimitOpen] = useState(false);
    const [refreshLimitInitial, setRefreshLimitInitial] = useState('');
    const [dismissedLimitKey, setDismissedLimitKey] = useState<string | undefined>();
    const [copyingAll, setCopyingAll] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const analysisGenerationRef = useRef(0);
    const dataGridRef = useRef<DataGridHandle>(null);
    const columnSearchRef = useRef<HTMLInputElement>(null);
    const focusSidebarSearchRef = useRef(false);
    const pendingColumnScrollRef = useRef<{ readonly resultSetId: string; readonly columnIndex: number } | undefined>(undefined);
    const activeResult = controller.activeResult();
    const closeAnalysis = useCallback(() => {
        analysisGenerationRef.current += 1;
        setAnalysisKind(undefined);
        setAnalysisTable(undefined);
        setAnalysisLoading(false);
        setAnalysisError(undefined);
    }, []);
    useEffect(() => {
        setSelectedRow(undefined);
        setSelection(undefined);
        setFilterState(undefined);
        setPivotOpen(false);
        if (!controller.isTestExploreWorkflowActive()) setViewLayout('table');
        setDiffBaselineId(undefined);
        setExportOpen(false);
        setRefreshLimitOpen(false);
        setDismissedLimitKey(undefined);
        closeAnalysis();
        postHostMessage({ command: 'selectionStatsChanged', stats: null });
    }, [activeResult?.sourceId, activeResult?.resultSetId, closeAnalysis, controller]);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (!event.altKey || event.ctrlKey || event.metaKey) return;
            const target = event.target;
            if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null) return;
            if (event.key.toLocaleLowerCase() === 'z') {
                event.preventDefault();
                controller.undoFilter(controller.activeResult());
            } else if (event.key.toLocaleLowerCase() === 'y') {
                event.preventDefault();
                controller.redoFilter(controller.activeResult());
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [controller]);
    const updateView = useCallback((patch: Partial<UiResultSurfaceState['view']>): void => {
        if ('globalFilter' in patch || 'columnFilters' in patch || 'sorting' in patch) {
            closeAnalysis();
        }
        if (activeResult) controller.updateView(activeResult.resultSetId, patch);
    }, [activeResult, closeAnalysis, controller]);
    const applyColumnFilter = useCallback(() => {
        const result = controller.activeResult();
        const state = filterState;
        if (!result || !state) return;
        const definitions = { ...(result.view.columnFilterDefinitions ?? {}) };
        const columnFilters = { ...result.view.columnFilters };
        delete columnFilters[state.columnName];
        const selectsEveryLoadedValue = state.operator === 'in'
            && !state.truncated
            && state.selectedKeys.length === state.options.length;
        const activeConditions = (state.conditions ?? [{
            operator: state.operator,
            value: state.value,
            ...(state.value2 === undefined ? {} : { value2: state.value2 }),
        }]).filter(condition =>
            condition.operator === 'isNull'
            || condition.operator === 'isNotNull'
            || condition.operator === 'isEmpty'
            || condition.operator === 'isNotEmpty'
            || condition.value.trim() !== ''
            || (condition.operator === 'between' && (condition.value2 ?? '').trim() !== ''),
        );
        if (selectsEveryLoadedValue || activeConditions.length === 0) {
            delete definitions[state.columnName];
        } else {
            const values = state.selectedKeys.flatMap(key => {
                const option = state.options.find(candidate => candidate.key === key);
                return option === undefined ? [] : [option.value];
            });
            if (state.operator === 'in') {
                definitions[state.columnName] = { operator: 'in', value: '', values };
            } else {
                const first = activeConditions[0]!;
                definitions[state.columnName] = {
                    operator: first.operator,
                    value: first.value,
                    ...(first.value2 === undefined ? {} : { value2: first.value2 }),
                    ...(activeConditions.length > 1
                        ? {
                            conditions: activeConditions.map(condition => ({
                                operator: condition.operator,
                                value: condition.value,
                                ...(condition.value2 === undefined ? {} : { value2: condition.value2 }),
                            })),
                            logic: state.conditionLogic ?? 'and',
                        }
                        : {}),
                };
            }
        }
        controller.updateView(result.resultSetId, { columnFilters, columnFilterDefinitions: definitions });
        setFilterState(undefined);
    }, [controller, filterState]);
    const clearColumnFilter = useCallback(() => {
        const result = controller.activeResult();
        const state = filterState;
        if (!result || !state) return;
        const definitions = { ...(result.view.columnFilterDefinitions ?? {}) };
        const columnFilters = { ...result.view.columnFilters };
        delete definitions[state.columnName];
        delete columnFilters[state.columnName];
        controller.updateView(result.resultSetId, { columnFilters, columnFilterDefinitions: definitions });
        setFilterState(undefined);
    }, [controller, filterState]);
    const openColumnFilter = useCallback((request: DataGridColumnFilterRequest): void => {
        const result = controller.activeResult();
        if (!result) return;
        const base = buildSharedFilterState(request, controller.getRows(result), result.view);
        if (!controller.isDiskBackedResult(result)) {
            setFilterState(base);
            return;
        }
        setFilterState({ ...base, options: [], selectedKeys: [], loading: true, truncated: false, error: undefined });
        void controller.requestFilterValues(result, request.columnIndex).then(({ values, truncated }) => {
            setFilterState(current => {
                if (!current || current.columnName !== request.column.name) return current;
                const definition = result.view.columnFilterDefinitions?.[request.column.name];
                const selectedKeys = definition?.operator === 'in' && definition.values !== undefined
                    ? values
                        .filter(option => definition.values!.some(value => sharedFilterValueKey(value) === option.key))
                        .map(option => option.key)
                    : values.map(option => option.key);
                return {
                    ...current,
                    options: values,
                    selectedKeys,
                    loading: false,
                    truncated,
                    error: undefined,
                };
            });
        }).catch(error => {
            setFilterState(current => current && current.columnName === request.column.name
                ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
                : current);
        });
    }, [controller]);
    const handleSelectionChange = useCallback((nextSelection: DataGridSelection | undefined): void => {
        setSelection(nextSelection);
        const result = controller.activeResult();
        postHostMessage({
            command: 'selectionStatsChanged',
            stats: controller.calculateSelectionStats(result, nextSelection),
        });
    }, [controller]);
    const runAnalysis = useCallback((kind: UiResultAnalysisKind, pivot?: SharedPivotPlan, force = false): void => {
        const result = controller.activeResult();
        if (!result) return;
        if (!force && analysisKind === kind && !analysisLoading) {
            closeAnalysis();
            return;
        }
        const generation = ++analysisGenerationRef.current;
        setRowViewOpen(false);
        setAnalysisKind(kind);
        setAnalysisTable(undefined);
        setAnalysisError(undefined);
        setAnalysisLoading(true);
        void controller.requestAnalysis(kind, result, pivot).then(table => {
            if (analysisGenerationRef.current !== generation) return;
            setAnalysisTable(table);
            setAnalysisLoading(false);
        }).catch(error => {
            if (analysisGenerationRef.current !== generation) return;
            setAnalysisLoading(false);
            setAnalysisError(error instanceof Error ? error.message : String(error));
        });
    }, [analysisKind, analysisLoading, closeAnalysis, controller]);
    const toggleAggregateFooter = useCallback((): void => {
        const result = controller.activeResult();
        if (!result) return;
        if (Object.keys(result.view.columnAggregations ?? {}).length > 0) {
            controller.updateView(result.resultSetId, { columnAggregations: {} });
            return;
        }
        const next: Record<string, readonly UiResultColumnAggregation[]> = {};
        result.columns.forEach(column => {
            if (isDataGridNumericColumn(column)) next[column.name] = [{ fn: 'sum', position: 'bottom' }];
        });
        if (Object.keys(next).length === 0 && result.columns[0]) {
            next[result.columns[0].name] = [{ fn: 'count', position: 'bottom' }];
        }
        controller.updateView(result.resultSetId, { columnAggregations: next });
    }, [controller]);
    const requestRefresh = useCallback((): void => {
        const result = controller.activeResult();
        if (!result) return;
        const refreshSql = controller.getResultSql(result)?.refreshSql;
        const limit = sharedRefreshLimit(refreshSql);
        if (limit !== undefined) {
            setRefreshLimitInitial(limit);
            setRefreshLimitOpen(true);
            return;
        }
        controller.refresh(result);
    }, [controller]);
    const sourceResults = useMemo(
        () => Object.values(state.results.byResultSetId).filter(result => result.sourceId === state.results.activeSourceId),
        [state.results],
    );
    const rows = controller.getRows(activeResult);
    const activeSql = controller.getResultSql(activeResult);
    const resultState = asyncStateFor(activeResult, rows.length);
    const activeResultKey = activeResult ? resultKey(activeResult.sourceId, activeResult.resultSetId) : undefined;
    const sourceExecuting = controller.isSourceExecuting(state.results.activeSourceId);
    const sourceExecutionStartedAt = controller.getExecutionStartedAt(state.results.activeSourceId);
    const showLimitBanner = activeResult?.limitReached === true && activeResultKey !== dismissedLimitKey;
    const refreshFailure = controller.getRefreshFailure(activeResult);
    // Range charts follow the grid's filtered/sorted order and hide columns
    // that the user hid, matching the legacy table-model extraction. A 2x2+
    // grid selection narrows the chart to that range, as the legacy toolbar
    // chart action did.
    const chartSelection = useMemo(() => {
        if (!selection || !activeResult || activeResult.view.grouping.length > 0) return undefined;
        const rowStart = Math.min(selection.anchorRow, selection.focusRow);
        const rowEnd = Math.max(selection.anchorRow, selection.focusRow);
        const colStart = Math.min(selection.anchorColumn, selection.focusColumn);
        const colEnd = Math.max(selection.anchorColumn, selection.focusColumn);
        if (rowEnd - rowStart + 1 < 2 || colEnd - colStart + 1 < 2) return undefined;
        return { rowStart, rowEnd, colStart, colEnd };
    }, [activeResult, selection]);
    const chartColumns = useMemo(() => {
        if (!activeResult) return [];
        return resolveDataGridColumns(activeResult.columns, rows)
            .map((column, index) => ({ column, index }))
            .filter(({ column, index }) => activeResult.view.columnVisibility?.[column.name] !== false
                && (!chartSelection || (index >= chartSelection.colStart && index <= chartSelection.colEnd)));
    }, [activeResult, chartSelection, rows]);
    const chartRows = useMemo(() => {
        if (!activeResult) return [];
        const visibleIndexes = chartColumns.map(item => item.index);
        const processed = processDataGridRows(activeResult.columns, rows, activeResult.view);
        const ranged = chartSelection ? processed.slice(chartSelection.rowStart, chartSelection.rowEnd + 1) : processed;
        return ranged.map(row => visibleIndexes.map(index => row[index]));
    }, [activeResult, chartColumns, chartSelection, rows]);
    const chartColumnProps = useMemo(() => chartColumns.map(item => item.column), [chartColumns]);
    const diffBaselineResults = useMemo(() => {
        if (!activeResult) return [];
        return sourceResults
            .filter(result => result.resultSetId !== activeResult.resultSetId
                && result.status !== 'error'
                && !controller.isLogResult(result))
            .sort((left, right) => left.statementIndex - right.statementIndex);
    }, [activeResult, controller, sourceResults]);
    const diffBaselines = useMemo<DiffBaseline[]>(
        () => diffBaselineResults.map(result => ({
            id: result.resultSetId,
            label: `Result ${result.statementIndex + 1} (${result.totalRowCount.toLocaleString()} rows)`,
            columns: result.columns,
            rows: controller.getRows(result),
        })),
        [controller, diffBaselineResults],
    );
    // Legacy picks the nearest previous result as the default baseline, or the
    // last result when the active result is first.
    const defaultDiffBaselineId = useMemo(() => {
        if (!activeResult || diffBaselineResults.length === 0) return undefined;
        const previous = [...diffBaselineResults]
            .reverse()
            .find(result => result.statementIndex < activeResult.statementIndex);
        return (previous ?? diffBaselineResults[diffBaselineResults.length - 1])!.resultSetId;
    }, [activeResult, diffBaselineResults]);
    const pivotDefaults = useMemo(
        () => activeResult ? chooseSharedPivotPlan(activeResult.columns, rows) : undefined,
        [activeResult, rows],
    );
    const openPivot = useCallback((force = false): void => {
        if (!force && analysisKind === 'pivot' && !analysisLoading) {
            closeAnalysis();
            return;
        }
        setRowViewOpen(false);
        setPivotOpen(true);
    }, [analysisKind, analysisLoading, closeAnalysis]);
    const createPivot = useCallback((configuration: PivotConfiguration): void => {
        setPivotOpen(false);
        runAnalysis('pivot', configuration, true);
    }, [runAnalysis]);
    const activeLayout: ResultLayoutKind = analysisKind === 'pivot' ? 'pivot' : viewLayout;
    // Pivot is a layout, not a compact analysis panel: it replaces the table
    // instead of stacking a second grid above it.
    const pivotActive = analysisKind === 'pivot';
    const tableLayoutActive = viewLayout === 'table' && !pivotActive;
    const selectLayout = useCallback((layout: ResultLayoutKind): void => {
        setPivotOpen(false);
        if (layout === 'pivot') {
            setViewLayout('table');
            openPivot(true);
            return;
        }
        closeAnalysis();
        setRowViewOpen(false);
        setViewLayout(layout === 'table' ? 'table' : layout);
    }, [closeAnalysis, openPivot]);
    const schemaCapability = capability(state.capabilities, 'result-panel.schema-navigation');
    const editInfo = controller.getEditInfo(activeResult);
    const editing = controller.isEditMode();
    const pendingEditCount = controller.getPendingEditCount(activeResult);
    const isLogResult = controller.isLogResult(activeResult);
    const isErrorResult = activeResult?.status === 'error';
    // Any result of this source can own the cancellation request (the Logs tab
    // itself never does), so derive it from the source-level cancel state.
    const cancelling = controller.isSourceCancelling(state.results.activeSourceId);
    // A source-level executing flag is authoritative for "query still running":
    // a Logs result keeps its own lifecycle state and a previously completed
    // data result can stay selected while the next statement runs.
    const executionStatus: ResultExecutionBannerStatus = sourceExecuting
        ? (cancelling ? 'finalizing' : 'loading')
        : activeResult?.status === 'loading' || activeResult?.status === 'streaming'
            ? (cancelling ? 'finalizing' : 'loading')
            : activeResult?.status === 'cancelled'
                ? 'cancelled'
                : activeResult?.status === 'error'
                    ? 'error'
                    : 'idle';
    // The banner is hidden for Logs (that surface owns its own header chip), so
    // it only needs the clock for the data-result lifecycle.
    const view: UiResultSurfaceState['view'] = activeResult?.view ?? { globalFilter: '', columnFilters: {}, sorting: [], grouping: [], aggregation: undefined, columnAggregations: undefined, pivotColumn: undefined, scrollTop: 0, scrollLeft: 0 };
    const diskGroupData = controller.getDiskGroupData(activeResult);
    const hasAggregations = Object.keys(view.columnAggregations ?? {}).length > 0;
    const rowViewDisplayRows = useMemo(() => {
        if (!selection) return [] as number[];
        const ranges = [{
            minRow: Math.min(selection.anchorRow, selection.focusRow),
            maxRow: Math.max(selection.anchorRow, selection.focusRow),
        }, ...(selection.additionalRanges ?? [])];
        const rows = new Set<number>();
        for (const range of ranges) {
            for (let row = range.minRow; row <= range.maxRow; row += 1) rows.add(row);
        }
        return [...rows].sort((left, right) => left - right);
    }, [selection]);
    const rowViewSelectedCount = rowViewDisplayRows.length;
    const rowViewColumns = useMemo(
        () => activeResult && rowViewOpen && !isLogResult ? resolveDataGridColumns(activeResult.columns, rows) : [],
        [activeResult, isLogResult, rowViewOpen, rows],
    );
    const rowViewRows = useMemo(() => {
        if (!activeResult || !rowViewOpen || isLogResult || rowViewSelectedCount > 10) return [];
        const sourceIndices = processDataGridRowIndices(activeResult.columns, rows, activeResult.view);
        const values: unknown[][] = [];
        for (const row of rowViewDisplayRows) {
            const sourceIndex = sourceIndices[row];
            const rowValues = sourceIndex === undefined ? undefined : rows[sourceIndex];
            if (rowValues) values.push([...rowValues]);
        }
        return values;
    }, [activeResult, isLogResult, rowViewDisplayRows, rowViewOpen, rowViewSelectedCount, rows]);
    const rowViewPlaceholder = !activeResult
        ? 'Select 1 to 10 rows to view details or compare'
        : activeResult.view.grouping.length > 0
            ? 'Row View is unavailable while results are grouped'
            : rowViewSelectedCount === 0
                ? 'Select 1 to 10 rows to view details or compare'
                : rowViewSelectedCount > 10
                    ? 'Select 1 to 10 rows to compare'
                    : activeResult.columns.length === 0
                        ? 'This result has no data columns'
                        : undefined;
    const toggleRowView = useCallback((): void => {
        setRowViewOpen(current => {
            if (!current) closeAnalysis();
            return !current;
        });
    }, [closeAnalysis]);
    const exportRowViewXlsb = useCallback((): void => {
        if (!activeResult || rowViewSelectedCount === 0 || activeResult.view.grouping.length > 0) return;
        const sourceIndices = processDataGridRowIndices(activeResult.columns, rows, activeResult.view);
        const selected: number[] = [];
        for (const row of rowViewDisplayRows) {
            const sourceIndex = sourceIndices[row];
            if (sourceIndex !== undefined) selected.push(sourceIndex);
        }
        if (selected.length === 0) return;
        postHostMessage({
            command: 'openInExcel',
            data: {
                sourceUri: activeResult.sourceId,
                results: [{
                    resultSetIndex: activeResult.statementIndex,
                    rowIndices: selected,
                    columnIds: activeResult.columns.map((_column, index) => String(index)),
                    name: `Row View - ${controller.getResultLabel(activeResult) ?? 'Result'}`,
                    isActive: true,
                }],
            },
            sql: '',
        });
    }, [activeResult, controller, rowViewDisplayRows, rowViewSelectedCount, rows]);
    const openCellValue = (context: DataGridCellContext): void => {
        const result = activeResult;
        const row = rows[context.rowIndex];
        const column = result?.columns[context.columnIndex];
        if (!result || !row || !column) return;
        const value = row[context.columnIndex];
        callPanelMethod('openValueViewer', {
            rowIndex: context.rowIndex,
            rowNumber: context.rowIndex + 1,
            columnId: column.name,
            columnName: column.name,
            dataType: column.type ?? 'text',
            value,
            isNull: value === null || value === undefined,
        });
    };
    const getColumnFormatting = useCallback((column: { readonly name: string }, columnIndex: number): DataGridFormattingOptions | undefined =>
        controller.getFormattingForColumn(column, columnIndex), [controller]);
    const openAnalysisCellValue = (context: DataGridCellContext): void => {
        const row = analysisTable?.rows[context.rowIndex];
        const column = analysisTable?.columns[context.columnIndex];
        if (!row || !column) return;
        callPanelMethod('openValueViewer', {
            rowIndex: context.rowIndex,
            rowNumber: context.rowIndex + 1,
            columnId: column.name,
            columnName: column.name,
            dataType: column.type ?? 'text',
            value: row[context.columnIndex],
            isNull: row[context.columnIndex] === null || row[context.columnIndex] === undefined,
        });
    };
    const copySelection = (payload: { readonly columns: readonly { readonly name: string; readonly type?: string; readonly scale?: number }[]; readonly rows: readonly (readonly unknown[])[]; readonly includeHeaders?: boolean }, format?: DataGridClipboardFormat): void => {
        writeSharedClipboard(payload, format ?? controller.getCopyFormat());
    };
    const copyAllResults = useCallback((): void => {
        setCopyingAll(true);
        void controller.copyAllActive()
            .then(count => {
                if (count === 0) postHostMessage({ command: 'info', text: 'No rows to copy.' });
            })
            .catch(error => {
                postHostMessage({ command: 'info', text: error instanceof Error ? error.message : String(error) });
            })
            .finally(() => setCopyingAll(false));
    }, [controller]);
    const toggleSidebarColumn = useCallback((column: { readonly name: string }, columnIndex: number): void => {
        const result = controller.activeResult();
        if (!result) return;
        const key = column.name.trim().length > 0 ? column.name.trim() : `column-${columnIndex}`;
        const visibility = { ...(result.view.columnVisibility ?? {}) };
        const visible = visibility[key] !== false && visibility[String(columnIndex)] !== false;
        visibility[key] = !visible;
        controller.updateView(result.resultSetId, { columnVisibility: visibility });
    }, [controller]);
    const showAllSidebarColumns = useCallback((): void => {
        const result = controller.activeResult();
        if (!result) return;
        controller.updateView(result.resultSetId, { columnVisibility: {} });
    }, [controller]);
    const hideAllSidebarColumns = useCallback((): void => {
        const result = controller.activeResult();
        if (!result) return;
        const visibility: Record<string, boolean> = {};
        result.columns.forEach((column, index) => {
            visibility[column.name.trim() || `column-${index}`] = false;
        });
        controller.updateView(result.resultSetId, { columnVisibility: visibility });
    }, [controller]);
    const scrollToSidebarColumn = useCallback((_column: { readonly name: string }, columnIndex: number): void => {
        const cell = document.querySelector<HTMLElement>(`[data-column-index="${columnIndex}"]`);
        cell?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }, []);
    const groupSidebarColumn = useCallback((column: { readonly name: string }, columnIndex: number): void => {
        const result = controller.activeResult();
        if (!result) return;
        const key = column.name.trim() || `column-${columnIndex}`;
        if (result.view.grouping.includes(key)) return;
        controller.updateView(result.resultSetId, { grouping: [...result.view.grouping, key] });
    }, [controller]);
    const ungroupSidebarColumn = useCallback((column: { readonly name: string }, columnIndex: number): void => {
        const result = controller.activeResult();
        if (!result) return;
        const key = column.name.trim() || `column-${columnIndex}`;
        controller.updateView(result.resultSetId, {
            grouping: result.view.grouping.filter(item => item !== key),
        });
    }, [controller]);
    const clearSidebarGrouping = useCallback((): void => {
        const result = controller.activeResult();
        if (!result) return;
        controller.updateView(result.resultSetId, { grouping: [] });
    }, [controller]);
    const scrollToGridColumn = useCallback((columnIndex: number): void => {
        const result = controller.activeResult();
        const column = result?.columns[columnIndex];
        if (!result || !column) return;
        if (isSharedColumnHidden(result, columnIndex)) {
            const visibility = result.view.columnVisibility;
            const key = column.name.trim() || `column-${columnIndex}`;
            const next = { ...visibility };
            delete next[key];
            delete next[column.name];
            delete next[String(columnIndex)];
            // The grid can only scroll to a mounted column, so wait for the
            // visibility update to commit before issuing the scroll request.
            pendingColumnScrollRef.current = { resultSetId: result.resultSetId, columnIndex };
            controller.updateView(result.resultSetId, { columnVisibility: next });
            return;
        }
        dataGridRef.current?.scrollToColumn(columnIndex);
    }, [controller]);
    useEffect(() => {
        const pending = pendingColumnScrollRef.current;
        if (pending === undefined) return;
        pendingColumnScrollRef.current = undefined;
        if (activeResult?.resultSetId !== pending.resultSetId) return;
        dataGridRef.current?.scrollToColumn(pending.columnIndex);
    }, [activeResult]);
    const openColumnSearch = useCallback((): void => {
        if (sidebarOpen) {
            columnSearchRef.current?.focus();
            columnSearchRef.current?.select();
            return;
        }
        focusSidebarSearchRef.current = true;
        setSidebarOpen(true);
    }, [sidebarOpen]);
    useEffect(() => {
        if (!focusSidebarSearchRef.current || !sidebarOpen) return;
        focusSidebarSearchRef.current = false;
        columnSearchRef.current?.focus();
        columnSearchRef.current?.select();
    }, [sidebarOpen]);
    const selectSidebarColumn = useCallback((_column: { readonly name: string }, columnIndex: number): void => {
        scrollToGridColumn(columnIndex);
    }, [scrollToGridColumn]);
    const reorderSidebarColumn = useCallback((sourceIndex: number, targetIndex: number, after: boolean): void => {
        const result = controller.activeResult();
        if (!result) return;
        const columnOrder = moveDataGridColumnOrder(result.columns, result.view, sourceIndex, targetIndex, after);
        if (!columnOrder) return;
        controller.updateView(result.resultSetId, { columnOrder });
    }, [controller]);
    const columnSidebar = sidebarOpen && activeResult && !isLogResult && !isErrorResult && tableLayoutActive
        ? <ResultColumnSidebar
            columns={activeResult.columns}
            order={resolveDataGridColumnOrder(activeResult.columns, activeResult.view)}
            visibility={activeResult.view.columnVisibility}
            onToggleVisibility={toggleSidebarColumn}
            onShowAll={showAllSidebarColumns}
            onHideAll={hideAllSidebarColumns}
            onSelectColumn={selectSidebarColumn}
            onClose={() => setSidebarOpen(false)}
            grouping={activeResult.view.grouping}
            onGroupColumn={groupSidebarColumn}
            onUngroupColumn={ungroupSidebarColumn}
            onClearGrouping={clearSidebarGrouping}
            onMoveColumn={reorderSidebarColumn}
            searchInputRef={columnSearchRef}
        />
        : undefined;

    return <UiShell activeSurface={state.shell.activeSurface} sidebar={state.shell.activeSurface === 'results' ? columnSidebar : undefined}>
        <FocusOnMount>
            {state.shell.activeSurface === 'results' && <>
                <ResultTabs
                    results={sourceResults}
                    activeResultSetId={state.results.activeResultSetId}
                    activeSourceId={state.results.activeSourceId}
                    onSelect={(id, sourceId) => controller.selectResult(id, sourceId)}
                    getLabel={result => controller.getResultLabel(result)}
                    isPinned={result => controller.isResultPinned(result)}
                    onTogglePin={result => controller.toggleResultPin(result)}
                    onClose={result => controller.closeResult(result)}
                    isBusy={result => controller.isLogResult(result) ? controller.isSourceExecuting(result.sourceId) : undefined}
                />
                <ResultViewToolbar
                    columns={activeResult?.columns ?? []}
                    view={view}
                    onChange={updateView}
                    onAggregate={toggleAggregateFooter}
                    onPivot={() => openPivot()}
                    onRowView={isLogResult || isErrorResult || !tableLayoutActive ? undefined : toggleRowView}
                    rowViewActive={rowViewOpen}
                    activeAnalysis={analysisKind ?? (hasAggregations ? 'aggregate' : undefined)}
                    analysisBusy={analysisLoading}
                    leading={isLogResult || isErrorResult ? undefined : <>
                        <button
                            type="button"
                            className="ui-result-toolbar-icon"
                            aria-label="Toggle column sidebar"
                            aria-pressed={sidebarOpen}
                            title="Show or hide the columns sidebar"
                            onClick={() => setSidebarOpen(value => !value)}
                        ><MenuIcon name="panel-right" /></button>
                        <ResultLayoutSwitcher active={activeLayout} onSelect={selectLayout} busy={analysisLoading} />
                    </>}
                    showAnalysis={!isLogResult && !isErrorResult && tableLayoutActive}
                    showTableControls={!isLogResult && !isErrorResult && tableLayoutActive}
                    // Sorting and grouping remain available from the column
                    // headers and the grouping panel; the toolbar shortcuts
                    // only duplicated them and consumed header width.
                    showSort={false}
                    showGroup={false}
                    onRefresh={isLogResult ? undefined : requestRefresh}
                    onCopy={isLogResult || pivotActive ? undefined : () => controller.copyActive()}
                    onCopyAll={isLogResult || pivotActive ? undefined : copyAllResults}
                    copyingAll={copyingAll}
                    onExport={isLogResult || pivotActive ? undefined : () => setExportOpen(true)}
                    rowCount={isLogResult || pivotActive ? undefined : activeResult?.totalRowCount}
                    actions={activeResult && (isLogResult
                        ? <button type="button" className="ui-result-toolbar-text-button" onClick={() => controller.clearLogs(activeResult.sourceId)}>
                            <MenuIcon name="trash" /> Clear Logs
                        </button>
                        : isErrorResult || !tableLayoutActive ? undefined
                        : <>
                            <button
                                type="button"
                                className="ui-result-toolbar-icon"
                                aria-label={editing ? 'Stop editing' : 'Edit data'}
                                title={editInfo?.isEditable === true ? (editing ? 'Stop editing' : 'Edit data') : editInfo?.reason ?? 'Inline editing is not available for this result.'}
                                aria-pressed={editing}
                                disabled={editInfo?.isEditable !== true}
                                onClick={() => controller.toggleEditMode(activeResult)}
                            ><MenuIcon name={editing ? 'x' : 'pencil'} /></button>
                            {editing && <>
                                <button type="button" disabled={pendingEditCount === 0} onClick={() => controller.saveEdits(activeResult)}>Save {pendingEditCount === 1 ? '1 change' : `${pendingEditCount} changes`}</button>
                                <button type="button" disabled={pendingEditCount === 0} onClick={() => controller.discardEdits(activeResult)}>Discard</button>
                            </>}
                            <SharedMoreMenu
                                onRefreshSql={requestRefresh}
                                onClearFilters={() => controller.clearAllFilters(activeResult)}
                                onExportAllResults={() => controller.exportAllResults()}
                                onUndoFilter={controller.canUndoFilter(activeResult) ? () => controller.undoFilter(activeResult) : undefined}
                                onRedoFilter={controller.canRedoFilter(activeResult) ? () => controller.redoFilter(activeResult) : undefined}
                                onCopyAs={format => controller.copyActiveAs(format)}
                                onCopyAsImage={() => void controller.copyGridAsImage(activeResult)}
                                onQueryLocally={() => controller.queryLocallyDuckDB(activeResult)}
                                onGroupAnalysis={() => runAnalysis('group')}
                                onAggregateAnalysis={() => runAnalysis('aggregate')}
                                onFindColumn={openColumnSearch}
                            />
                        </>)}
                />
                {!isLogResult && <ResultExecutionBanner
                    status={executionStatus}
                    message={activeResult?.message}
                    cancelling={cancelling}
                    startedAt={sourceExecuting ? sourceExecutionStartedAt : undefined}
                    onCancel={activeResult ? () => controller.cancel(activeResult.sourceId) : undefined}
                />}
                {showLimitBanner && <ResultLimitBanner
                    limitReached
                    limit={controller.getQueryRowLimit()}
                    rowCount={activeResult?.totalRowCount}
                    onDismiss={() => setDismissedLimitKey(activeResultKey)}
                />}
                {refreshFailure && <ResultRefreshFailureBanner
                    message={refreshFailure.message}
                    onRetry={() => controller.refresh(activeResult)}
                    onDismiss={() => controller.clearRefreshFailure(activeResult)}
                />}
                {pivotOpen && activeResult && <PivotDialog
                    columns={activeResult.columns}
                    defaults={pivotDefaults}
                    onSubmit={createPivot}
                    onClose={() => setPivotOpen(false)}
                />}
                {analysisKind && analysisKind !== 'pivot' && <ResultAnalysisPanel sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'result-panel'} table={analysisTable} loading={analysisLoading} error={analysisError} onClose={closeAnalysis} onCopySelection={copySelection} onViewCell={openAnalysisCellValue} />}
                <div className="ui-result-main-split">
                {pivotActive
                    ? <ResultAnalysisPanel sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'result-panel'} table={analysisTable} loading={analysisLoading} error={analysisError} onClose={closeAnalysis} onCopySelection={copySelection} onViewCell={openAnalysisCellValue} fill />
                    : resultState === 'error' && activeResult
                    ? <ResultErrorView
                        message={activeResult.message}
                        details={activeResult.errorDetails}
                        sql={activeSql?.sql}
                        {...(activeSql?.sql?.trim()
                            ? {
                                onFixWithAi: () => postHostMessage({
                                    command: 'fixSqlError',
                                    errorMessage: formatDatabaseErrorForPrompt(
                                        activeResult.message,
                                        activeResult.errorDetails,
                                    ),
                                    sql: activeSql.sql ?? '',
                                }),
                            }
                            : {})}
                    />
                    : viewLayout === 'explore' && activeResult && !isLogResult
                    // Explore owns its own loading text and server-side
                    // analyses. Keeping it mounted through a background
                    // hydrate/stream update avoids cancelling an in-flight
                    // ranking/pivot request.
                    ? <SharedExploreHost
                        result={activeResult}
                        rows={rows}
                        label={`Result ${activeResult.statementIndex + 1}`}
                        diskBacked={controller.isDiskBackedResult(activeResult)}
                        sql={activeSql?.sql}
                        refreshSql={activeSql?.refreshSql}
                    />
                    : <AsyncStateView state={resultState} message={activeResult?.message} loadingLabel="Waiting for result data…" showActivity={false}>
                    {activeResult && (isLogResult
                        ? <SharedLogConsole
                            rows={rows}
                            lanesJson={controller.getSqlQueueJson()}
                            sourceUri={activeResult?.sourceId}
                            executing={sourceExecuting}
                            cancelling={cancelling}
                            startedAt={sourceExecutionStartedAt}
                            onCancel={(executionStatus === 'loading' || executionStatus === 'finalizing') && !cancelling ? () => controller.cancel(activeResult.sourceId) : undefined}
                        />
                        : viewLayout === 'charts'
                        ? <LazySharedRangeChart columns={chartColumnProps} rows={chartRows} />
                        : viewLayout === 'mini-charts'
                        ? <MiniChartsView columns={activeResult.columns} rows={rows} />
                        : viewLayout === 'diff'
                        ? <DiffView
                            target={{
                                label: `Result ${activeResult.statementIndex + 1}`,
                                columns: activeResult.columns,
                                rows,
                            }}
                            baselines={diffBaselines}
                            baselineId={diffBaselineId ?? defaultDiffBaselineId}
                            onBaselineChange={setDiffBaselineId}
                        />
                        : viewLayout === 'analytical'
                        ? <SharedAnalyticalView
                            columns={activeResult.columns}
                            rows={rows}
                            grouping={activeResult.view.grouping}
                            onClose={() => setViewLayout('table')}
                        />
                        : <DataGrid
                        ref={dataGridRef}
                        sourceId={activeResult.sourceId}
                        resultSetId={activeResult.resultSetId}
                        columns={activeResult.columns}
                        rows={rows}
                        getColumnFormatting={getColumnFormatting}
                        totalRowCount={activeResult.totalRowCount}
                        groupCounts={diskGroupData?.counts}
                        extraGroups={diskGroupData?.extraGroups}
                        groupCountsPartial={diskGroupData?.partial === true}
                        busy={sourceExecuting || activeResult.status === 'loading' || activeResult.status === 'streaming' || analysisLoading}
                        view={activeResult.view}
                        onViewChange={updateView}
                        showContextMenu
                        showColumnMenu={false}
                        showGroupingPanel={activeResult.view.grouping.length > 0}
                        selectedRowIndex={selectedRow}
                        scroll={{ sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow }}
                        onScroll={position => controller.updateView(activeResult.resultSetId, { scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow })}
                        onLoadMore={() => controller.loadMore(activeResult)}
                        onRowSelect={setSelectedRow}
                        onSelectionChange={handleSelectionChange}
                        onCopySelection={(payload, format?: DataGridClipboardFormat) => writeSharedClipboard(payload, format ?? controller.getCopyFormat())}
                        onViewCell={openCellValue}
                        onOpenColumnFilter={openColumnFilter}
                        showInlineColumnFilters={false}
                        editMode={editing}
                        onDeleteRow={editing ? rowIndex => controller.toggleRowDelete(activeResult, rowIndex) : undefined}
                        isRowDeleted={rowIndex => controller.isRowDeleted(activeResult, rowIndex)}
                        onCellEdit={edit => controller.recordCellEdit(activeResult, edit)}
                        onInsertCellContent={payload => postHostMessage({ command: 'insertCellContent', ...payload })}
                        onOpenResultFormatting={() => callPanelMethod('openResultFormattingPanel', { scope: 'result' })}
                        catalogBound={editInfo?.isEditable === true}
                        onColumnAction={(context, action) => controller.postColumnAction(activeResult, context.columnIndex, action)}
                        onProfileColumn={context => {
                            setViewLayout('explore');
                            window.setTimeout(() => focusExploreColumn(context.columnIndex), 80);
                        }}
                    />)}
                </AsyncStateView>}
                {rowViewOpen && !isLogResult && !pivotActive && activeResult && <RowViewPanel
                    columns={rowViewColumns}
                    rows={rowViewRows}
                    placeholder={rowViewPlaceholder}
                    onClose={() => setRowViewOpen(false)}
                    onExportXlsb={exportRowViewXlsb}
                    onNotify={text => postHostMessage({ command: 'info', text })}
                />}
                </div>
                {filterState && <DataGridColumnFilterPanel
                    state={filterState}
                    onChange={patch => setFilterState(current => current ? { ...current, ...patch } : current)}
                    onApply={applyColumnFilter}
                    onClear={clearColumnFilter}
                    onClose={() => setFilterState(undefined)}
                    summary={view.columnAggregations?.[filterState.columnName] ?? []}
                    onSummaryChange={aggregations => {
                        if (!activeResult) return;
                        const definitions = { ...(activeResult.view.columnAggregations ?? {}) };
                        if (aggregations.length === 0) delete definitions[filterState.columnName];
                        else definitions[filterState.columnName] = aggregations;
                        controller.updateView(activeResult.resultSetId, { columnAggregations: definitions });
                    }}
                />}
                {refreshLimitOpen && <RefreshLimitDialog
                    sql={activeSql?.refreshSql}
                    initialLimit={refreshLimitInitial}
                    onSubmit={limit => {
                        setRefreshLimitOpen(false);
                        controller.refresh(activeResult, limit);
                    }}
                    onCancel={() => setRefreshLimitOpen(false)}
                />}
                {exportOpen && activeResult && <ResultExportDialog
                    format={exportFormat}
                    destination={exportDestination}
                    scope={exportScope}
                    onFormatChange={setExportFormat}
                    onDestinationChange={setExportDestination}
                    onScopeChange={setExportScope}
                    onCancel={() => setExportOpen(false)}
                    onExport={() => {
                        setExportOpen(false);
                        controller.exportActiveWithOptions(exportFormat, exportDestination, exportScope);
                    }}
                />}
            </>}
            {state.shell.activeSurface === 'schema' && <section className="shared-schema-surface" aria-label="Schema">
                <header>
                    <h2>Result schema</h2>
                    <p>Columns of the active result. Catalog actions remain available from the column context menu.</p>
                    {schemaCapability && schemaCapability.status !== 'available' && <p className="shared-schema-note">{schemaCapability.reason ?? 'Catalog metadata is not exposed by this host yet.'}</p>}
                </header>
                {activeResult
                    ? <ResultColumnSidebar
                        columns={activeResult.columns}
                        order={resolveDataGridColumnOrder(activeResult.columns, activeResult.view)}
                        visibility={activeResult.view.columnVisibility}
                        onToggleVisibility={toggleSidebarColumn}
                        onShowAll={showAllSidebarColumns}
                        onHideAll={hideAllSidebarColumns}
                        onSelectColumn={scrollToSidebarColumn}
                        grouping={activeResult.view.grouping}
                        onGroupColumn={groupSidebarColumn}
                        onUngroupColumn={ungroupSidebarColumn}
                        onClearGrouping={clearSidebarGrouping}
                        onMoveColumn={reorderSidebarColumn}
                    />
                    : <AsyncStateView state="empty" emptyLabel="No active result set." />}
            </section>}
            {state.shell.activeSurface === 'history' && <section className="shared-history-surface" aria-label="Query history">
                <HistoryView
                    entries={state.history.entryIds.map(id => ({
                        id,
                        label: id,
                        status: 'recorded',
                        sqlFingerprint: id,
                    }))}
                    state={state.history.status === 'loading' ? 'loading' : state.history.entryIds.length === 0 ? 'empty' : 'ready'}
                    message={state.history.message}
                />
            </section>}
        </FocusOnMount>
    </UiShell>;
}

function ensureSharedStyles(): void {
    if (document.getElementById(SHARED_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SHARED_STYLE_ID;
    style.textContent = `
        body.shared-ui-mode { margin: 0; padding: 0; overflow: hidden; }
        #${SHARED_ROOT_ID} { display: flex; flex-direction: column; width: 100%; min-height: 0; height: 100vh; margin: 0; padding: 0; overflow: hidden; box-sizing: border-box; font: 13px var(--vscode-font-family, sans-serif); }
        #${SHARED_ROOT_ID} .ui-shell { display: flex; width: 100%; flex: 1 1 auto; min-height: 0; height: 100%; flex-direction: column; box-sizing: border-box; }
        #${SHARED_ROOT_ID} .ui-shell-body { display: flex; width: 100%; flex: 1 1 auto; min-height: 0; height: auto; box-sizing: border-box; }
        #${SHARED_ROOT_ID} .ui-shell-main { display: flex; width: 100%; flex: 1 1 auto; min-width: 0; min-height: 0; flex-direction: column; padding: 0; box-sizing: border-box; }
        #${SHARED_ROOT_ID} .ui-shell-main > div { display: flex; width: 100%; flex: 1 1 auto; min-height: 0; flex-direction: column; box-sizing: border-box; }
        #${SHARED_ROOT_ID} .ui-result-main-split { width: 100%; box-sizing: border-box; }
        #${SHARED_ROOT_ID} .ui-result-grid { flex: 1 1 auto; min-height: 0; }
        #${SHARED_ROOT_ID} .ui-shell-header, #${SHARED_ROOT_ID} .ui-result-toolbar,
        #${SHARED_ROOT_ID} .ui-workspace-tabs, #${SHARED_ROOT_ID} .ui-result-tabs { display: flex; gap: 4px; align-items: center; padding: 4px 6px; }
        #${SHARED_ROOT_ID} .ui-shell-header { flex: 0 0 auto; min-height: 30px; justify-content: space-between; border-bottom: 1px solid var(--vscode-panel-border, #444); }
        #${SHARED_ROOT_ID} .ui-shell-header h1 { margin: 0; font-size: 13px; }
        #${SHARED_ROOT_ID} .ui-result-tabs { flex: 0 0 auto; flex-wrap: nowrap; overflow-x: auto; gap: 0; padding: 0 4px; border-bottom: 1px solid var(--vscode-panel-border, #444); background: transparent; }
        #${SHARED_ROOT_ID} .ui-result-tabs { gap: 0; padding: 0; background: transparent; }
        #${SHARED_ROOT_ID} .ui-result-tab { border-bottom: 2px solid transparent; }
        #${SHARED_ROOT_ID} .ui-result-tab-active { border-bottom-color: var(--vscode-focusBorder, #6689a7); }
        #${SHARED_ROOT_ID} .ui-result-tab-label { min-height: 24px; padding: 2px 4px 2px 8px; border: 0; border-right: 1px solid var(--vscode-panel-border, #444); border-radius: 0; background: transparent; }
        #${SHARED_ROOT_ID} .ui-result-tab:last-child .ui-result-tab-label { border-right: 0; }
        #${SHARED_ROOT_ID} .ui-result-tab-label:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
        #${SHARED_ROOT_ID} .ui-result-tab-label[aria-selected="true"] { border-color: transparent; background: transparent; }
        #${SHARED_ROOT_ID} .ui-result-tab-pin, #${SHARED_ROOT_ID} .ui-result-tab-close { width: 16px; min-width: 16px; min-height: 18px; height: 18px; padding: 0; border: 0; border-radius: 3px; background: transparent; font-size: 12px; }
        #${SHARED_ROOT_ID} .ui-result-tab-pin { margin-left: 2px; }
        #${SHARED_ROOT_ID} .ui-result-tab-pin[aria-pressed="true"] { color: var(--vscode-focusBorder, #6689a7); background: color-mix(in srgb, var(--vscode-focusBorder, #6689a7) 18%, transparent); }
        #${SHARED_ROOT_ID} .ui-result-toolbar { flex: 0 0 auto; flex-wrap: wrap; padding: 3px 6px; gap: 3px; }
        #${SHARED_ROOT_ID} .ui-result-toolbar label { display: flex; align-items: center; gap: 4px; margin: 0; min-width: 0; white-space: nowrap; }
        #${SHARED_ROOT_ID} .ui-result-toolbar .ui-result-toolbar-search { box-sizing: border-box; flex: 1 1 200px; min-width: 110px; max-width: 300px; }
        #${SHARED_ROOT_ID} .ui-result-toolbar .ui-result-toolbar-search input { box-sizing: border-box; width: 100%; height: 22px; padding: 1px 6px 1px 26px; }
        #${SHARED_ROOT_ID} .ui-result-toolbar button { min-height: 22px; padding: 1px 7px; font-size: 11px; white-space: nowrap; }
        #${SHARED_ROOT_ID} .ui-result-toolbar button.ui-result-toolbar-icon { display: inline-flex; width: 22px; min-width: 22px; padding: 0; align-items: center; justify-content: center; }
        #${SHARED_ROOT_ID} .ui-result-toolbar-row-count { font-size: 11px; }
        #${SHARED_ROOT_ID} .ui-data-grid-scroll { max-height: none; min-height: 0; flex: 1 1 auto; }
        #${SHARED_ROOT_ID} .ui-data-grid-edit-hint { opacity: 0.8; font-size: 12px; }
        #${SHARED_ROOT_ID} .ui-capability-state, #${SHARED_ROOT_ID} .ui-async-state { padding: 12px; }
    `;
    document.head.appendChild(style);
}

let sharedRoot: Root | undefined;
let sharedController: SharedResultPanelController | undefined;
let sharedHostMessageHandler: ((event: MessageEvent<unknown>) => void) | undefined;

export function mountSharedResultPanel(): boolean {
    if ((globalThis as Record<string, unknown>)[SHARED_MOUNT_FLAG] === true) return true;
    const rootElement = document.getElementById(SHARED_ROOT_ID) ?? document.body.appendChild(document.createElement('div'));
    rootElement.id = SHARED_ROOT_ID;
    rootElement.style.display = 'block';
    document.body.classList.add('shared-ui-mode');
    ensureSharedStyles();
    sharedController = new SharedResultPanelController();
    sharedHostMessageHandler = event => sharedController?.handleHostMessage(event.data);
    window.addEventListener('message', sharedHostMessageHandler);
    sharedRoot = createRoot(rootElement);
    sharedRoot.render(<SharedResultPanelApp controller={sharedController} />);
    (globalThis as Record<string, unknown>)[SHARED_MOUNT_FLAG] = true;
    postHostMessage({ command: 'ready' });
    return true;
}

export function disposeSharedResultPanel(): void {
    if (sharedHostMessageHandler) window.removeEventListener('message', sharedHostMessageHandler);
    sharedHostMessageHandler = undefined;
    sharedRoot?.unmount();
    sharedRoot = undefined;
    sharedController?.dispose();
    sharedController = undefined;
    delete (globalThis as Record<string, unknown>)[SHARED_MOUNT_FLAG];
    document.body.classList.remove('shared-ui-mode');
}

export { resultPanelCapabilities };
