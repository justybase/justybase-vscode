import { decode } from '@msgpack/msgpack';
import { createRoot, type Root } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CapabilityDescriptor, UiIdentity } from '@justybase/contracts';
import {
    createInitialUiState,
    createUiStore,
    createAggregateAnalysisTable,
    createGroupAnalysisTable,
    createPivotAnalysisTable,
    resultKey,
    resultAsyncState as getResultAsyncState,
    type UiResultAnalysisKind,
    type UiResultAnalysisTable,
    type UiResultColumn,
    type UiResultEvent,
    type UiResultSurfaceState,
    type UiState,
    type UiStore,
} from '@justybase/ui-core';
import {
    AsyncStateView,
    CapabilityGate,
    DataGrid,
    formatDataGridClipboard,
    formatDataGridCellValue,
    processDataGridRowIndices,
    processDataGridRows,
    resolveDataGridColumns,
    FocusOnMount,
    ResultTabs,
    ResultAnalysisPanel,
    ResultViewToolbar,
    RowDetail,
    UiShell,
    WorkspaceTabs,
} from '@justybase/ui-react';
import type { DataGridClipboardFormat, DataGridCellContext } from '@justybase/ui-react';
import { callPanelMethod } from './types.js';
import type { DiskQuerySpec } from './types.js';
import type { ResultPanelHostToWebviewMessage } from './hostContracts.js';
import { asHostMessage, postHostMessage } from './protocol.js';

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
    readonly isLog?: unknown;
    readonly isError?: unknown;
    readonly isCancelled?: unknown;
    readonly isStreamingComplete?: unknown;
    readonly totalRowCount?: unknown;
}

interface NormalizedResultSet {
    readonly resultSetId?: string;
    readonly executionTimestamp?: number;
    readonly columns: readonly SharedColumn[];
    readonly rows: readonly unknown[][];
    readonly message?: string;
    readonly isLog: boolean;
    readonly isError: boolean;
    readonly isCancelled: boolean;
    readonly isStreamingComplete?: boolean;
    readonly totalRowCount: number;
}

interface ResultRef {
    readonly sourceId: string;
    readonly resultSetIndex: number;
    readonly resultSetId: string;
    readonly executionId: string;
}

interface SharedResultPanelData {
    readonly resultSetsMsgPack?: unknown;
    readonly resultSetsJson?: unknown;
    readonly activeSourceJson?: unknown;
    readonly activeResultSetIndex?: unknown;
    readonly executingSourcesJson?: unknown;
    readonly formatSettings?: unknown;
    readonly dataVersion?: unknown;
    readonly resultSyncVersion?: unknown;
}

const SHARED_MODE = 'shared';
const SHARED_ROOT_ID = 'shared-ui-root';
const SHARED_STYLE_ID = 'justybase-shared-result-panel-styles';
const SHARED_MOUNT_FLAG = '__JUSTYBASE_SHARED_RESULT_PANEL_MOUNTED__';

const resultPanelCapabilities: readonly CapabilityDescriptor[] = [
    {
        key: 'result-panel.data-grid',
        status: 'available',
        owner: 'VS Code Result Panel shared adapter',
        documentation: 'docs/CROSS_PRODUCT_UI_PARITY.md#result-panel',
        removalCondition: 'Remove this descriptor when the shared result adapter is no longer opt-in.',
    },
    {
        key: 'result-panel.schema-navigation',
        status: 'unavailable',
        owner: 'VS Code metadata host adapter',
        reason: 'Schema navigation remains host-owned while the Result Panel migration is opt-in.',
        documentation: 'docs/CROSS_PRODUCT_UI_PARITY.md#vscode',
        removalCondition: 'Expose MetadataPort-backed schema nodes from the VS Code host.',
    },
    {
        key: 'result-panel.guarded-edit',
        status: 'read-only',
        owner: 'VS Code Result Panel host',
        reason: 'The shared Result Panel currently exposes read-only result data.',
        documentation: 'docs/CROSS_PRODUCT_UI_PARITY.md#capabilities',
        removalCondition: 'Route edit previews and guarded writes through ResultPort.',
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
        isLog: candidate.isLog === true,
        isError: candidate.isError === true,
        isCancelled: candidate.isCancelled === true,
        isStreamingComplete: typeof candidate.isStreamingComplete === 'boolean'
            ? candidate.isStreamingComplete
            : undefined,
        totalRowCount,
    };
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

export function sharedResultPanelMode(value: unknown): boolean {
    return value === SHARED_MODE;
}

function sharedModeFromGlobal(): boolean {
    return sharedResultPanelMode((globalThis as { __JUSTYBASE_UI_MODE__?: unknown }).__JUSTYBASE_UI_MODE__);
}

function sourceIndexKey(sourceId: string, resultSetIndex: number): string {
    return `${sourceId}\u0000${resultSetIndex}`;
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

function rowsAsText(columns: readonly SharedColumn[], rows: readonly (readonly unknown[])[]): string {
    return formatDataGridClipboard({ columns, rows }, 'text');
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

interface SharedDatabaseGroupingRequest {
    readonly groupByColumns: readonly { readonly columnIndex: number; readonly columnName: string }[];
    readonly functions: readonly { readonly fn: string; readonly columnIndex?: number; readonly alias?: string }[];
    readonly limit?: number | null;
    readonly filterSpec?: DiskQuerySpec;
}

function isNumericSharedColumn(column: Pick<SharedColumn, 'type'>): boolean {
    return /(?:bigint|smallint|tinyint|integer|int|serial|decimal|numeric|number|double|float|real|money|^dec)/iu.test(column.type ?? '');
}

export function sharedAnalysisQuerySpec(result: UiResultSurfaceState): DiskQuerySpec | undefined {
    const globalSearch = result.view.globalFilter.trim();
    const columnFilters = Object.entries(result.view.columnFilters).flatMap(([name, value]) => {
        const normalized = value.trim();
        if (!normalized) return [];
        const columnIndex = result.columns.findIndex(column => column.name === name);
        if (columnIndex < 0) return [];
        return [{
            columnIndex,
            conditions: [{ type: 'contains', value: normalized }],
        }];
    });
    const spec: DiskQuerySpec = {
        ...(globalSearch ? { globalSearch } : {}),
        ...(columnFilters.length > 0 ? { columnFilters } : {}),
    };
    return spec.globalSearch || (spec.columnFilters?.length ?? 0) > 0 ? spec : undefined;
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
    valueColumnIndex: number,
): UiResultAnalysisTable {
    return createPivotAnalysisTable(
        columns,
        {
            columns: (message.columns ?? []).map(column => ({ name: column.name, type: column.type })),
            rows: message.rows ?? [],
            totalGroups: message.totalRows ?? message.rows?.length ?? 0,
        },
        0,
        1,
        valueColumnIndex,
    );
}

interface PendingAnalysisRequest {
    readonly kind: UiResultAnalysisKind;
    readonly ref: ResultRef;
    readonly resolve: (table: UiResultAnalysisTable) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

function capability(capabilities: readonly CapabilityDescriptor[], key: string): CapabilityDescriptor | undefined {
    return capabilities.find(item => item.key === key);
}

export class SharedResultPanelController {
    private readonly store: UiStore;
    private readonly listeners = new Set<() => void>();
    private readonly rows = new Map<string, readonly unknown[][]>();
    private readonly refs = new Map<string, ResultRef>();
    private readonly nextSequence = new Map<string, number>();
    private readonly nextChunkSequence = new Map<string, number>();
    private readonly cancelRequests = new Map<string, string>();
    private readonly pendingRowWindows = new Map<number, { readonly ref: ResultRef; readonly offset: number }>();
    private readonly pendingAnalysisRequests = new Map<number, PendingAnalysisRequest>();
    private formatSettings: unknown;
    private revision = 0;
    private streamRevision = 0;
    private rowRequestId = 0;
    private analysisRequestId = 0;
    private disposed = false;

    public constructor() {
        const identity: UiIdentity = { productId: 'vscode', workspaceId: 'result-panel' };
        this.store = createUiStore(createInitialUiState(identity, {
            mode: 'shared',
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

    public getRows(result: UiResultSurfaceState | undefined): readonly unknown[][] {
        if (!result) return [];
        return this.rows.get(resultKey(result.sourceId, result.resultSetId)) ?? [];
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
                this.selectSource(valid.sourceUri);
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
                this.applyRowWindow(valid);
                break;
            case 'diskQueryResult':
                this.applyDiskQueryResult(valid);
                break;
            case 'databaseAggregationResult':
                this.applyDatabaseAggregationResult(valid);
                break;
            case 'databaseGroupingResult':
                this.applyDatabaseGroupingResult(valid);
                break;
            case 'cancelExecution':
                this.applyCancellation(valid.sourceUri);
                break;
            case 'switchToResultSet':
                this.selectResultByIndex(valid.resultSetIndex);
                break;
            case 'refreshView':
                this.notify();
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

    public selectResult(resultSetId: string, sourceId?: string): void {
        const activeSourceId = sourceId ?? this.getState().results.activeSourceId;
        const result = Object.values(this.getState().results.byResultSetId)
            .find(candidate => candidate.resultSetId === resultSetId
                && (activeSourceId === undefined || candidate.sourceId === activeSourceId));
        if (!result) return;
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
        this.dispatch({ type: 'results/view', sourceId, resultSetId, patch });
    }

    public refresh(): void {
        const sourceId = this.getState().results.activeSourceId;
        if (sourceId) this.postResultSync(sourceId, 'shared-refresh');
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
        postHostMessage({
            command: 'requestRows',
            sourceUri: result.sourceId,
            resultSetIndex: ref.resultSetIndex,
            offset,
            limit: 2_000,
            requestId,
        });
    }

    public requestAnalysis(kind: UiResultAnalysisKind, result: UiResultSurfaceState): Promise<UiResultAnalysisTable> {
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        if (!ref || ref.resultSetId !== result.resultSetId) {
            return Promise.reject(new Error('The result set is no longer active.'));
        }
        const numericColumns = result.columns
            .map((column, index) => ({ column, index }))
            .filter(item => isNumericSharedColumn(item.column));
        const querySpec = sharedAnalysisQuerySpec(result);
        const requestId = ++this.analysisRequestId;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pendingAnalysisRequests.get(requestId);
                if (!pending) return;
                this.pendingAnalysisRequests.delete(requestId);
                pending.reject(new Error(`${kind} analysis timed out.`));
            }, 300_000);
            this.pendingAnalysisRequests.set(requestId, { kind, ref, resolve, reject, timer });

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

            const pivotColumn = result.columns[1];
            const valueColumn = numericColumns.find(item => item.index > 1);
            if (!pivotColumn || !valueColumn) {
                this.rejectAnalysis(requestId, new Error('Pivot needs two dimensions and a numeric value column.'));
                return;
            }
            const grouping: SharedDatabaseGroupingRequest = {
                groupByColumns: [
                    { columnIndex: 0, columnName: firstColumn.name },
                    { columnIndex: 1, columnName: pivotColumn.name },
                ],
                functions: [{ fn: 'sum', columnIndex: valueColumn.index, alias: `SUM_${valueColumn.column.name}` }],
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
        });
    }

    public cancel(sourceId: string | undefined): void {
        const activeSource = sourceId ?? this.getState().results.activeSourceId;
        if (!activeSource) return;
        const result = Object.values(this.getState().results.byResultSetId)
            .find(candidate => candidate.sourceId === activeSource && (candidate.status === 'loading' || candidate.status === 'streaming'));
        if (!result) return;
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
        postHostMessage({
            command: 'copyToClipboard',
            text: rowsAsText(result.columns, processDataGridRows(result.columns, this.getRows(result), result.view)),
        });
    }

    public exportActive(): void {
        const result = this.activeResult();
        if (!result) return;
        const rows = this.getRows(result);
        const rowIndices = processDataGridRowIndices(result.columns, rows, result.view);
        const ref = this.refs.get(sourceIndexKey(result.sourceId, result.statementIndex));
        const formatSettings = isRecord(this.formatSettings) ? this.formatSettings : undefined;
        const globalSettings = formatSettings && isRecord(formatSettings.global) ? formatSettings.global : undefined;
        const useFormattedValues = globalSettings?.useFormattedValuesForExport === true;
        if (!ref || rowIndices.length === 0) {
            postHostMessage({
                command: 'exportCsv',
                data: rowsAsCsv(result.columns, processDataGridRows(result.columns, rows, result.view), useFormattedValues),
            });
            return;
        }
        postHostMessage({
            command: 'exportCsv',
            data: {
                sourceUri: result.sourceId,
                resultSetIndex: ref.resultSetIndex,
                rowIndices: [...rowIndices],
                rowScope: 'loaded',
                formatting: globalSettings && typeof globalSettings.useFormattedValuesForExport === 'boolean'
                    ? {
                        useFormattedValues: globalSettings.useFormattedValuesForExport,
                        payload: formatSettings,
                    }
                    : undefined,
            },
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

    private applyDatabaseGroupingResult(
        message: Extract<ResultPanelHostToWebviewMessage, { command: 'databaseGroupingResult' }>,
    ): void {
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
        const valueColumnIndex = result.columns.findIndex((column, index) => index > 1 && isNumericSharedColumn(column));
        if (valueColumnIndex < 0) {
            pending.reject(new Error('Pivot value column is no longer available.'));
            return;
        }
        pending.resolve(toPivotAnalysisTable(result.columns, message, valueColumnIndex));
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.listeners.clear();
        this.rows.clear();
        this.refs.clear();
        this.nextSequence.clear();
        this.nextChunkSequence.clear();
        this.cancelRequests.clear();
        this.pendingRowWindows.clear();
        for (const pending of this.pendingAnalysisRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Result panel disposed.'));
        }
        this.pendingAnalysisRequests.clear();
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
        const sourceId = parseJsonString(data.activeSourceJson) ?? 'vscode:results';
        const resultSets = resultSetsFromData(data);
        this.formatSettings = data.formatSettings;
        const activeResultSetIndex = asNonNegativeInteger(data.activeResultSetIndex) ?? 0;
        const executingSources = new Set(parseJsonStrings(data.executingSourcesJson));
        const version = asNonNegativeInteger(data.dataVersion)
            ?? asNonNegativeInteger(data.resultSyncVersion)
            ?? ++this.streamRevision;
        const hydrationRevision = ++this.streamRevision;
        let activeResultSetId: string | undefined;
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
            this.startResult(ref, normalized, executingSources.has(sourceId));
            if (resultSetIndex === activeResultSetIndex) activeResultSetId = resultSetId;
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
            this.nextSequence.delete(key);
            this.nextChunkSequence.delete(key);
            this.cancelRequests.delete(indexKey);
            for (const [requestId, request] of this.pendingRowWindows.entries()) {
                if (request.ref.sourceId === ref.sourceId && request.ref.resultSetId === ref.resultSetId) this.pendingRowWindows.delete(requestId);
            }
        }
        this.dispatch({
            type: 'results/reconcile-source',
            sourceId,
            resultSetIds: [...incomingResultSetIds],
        });

        if (resultSets.length > 0) {
            this.dispatch({ type: 'results/select-source', sourceId });
            this.dispatch({
                type: 'results/select',
                sourceId,
                resultSetId: activeResultSetId
                    ?? Object.values(this.getState().results.byResultSetId).find(result => result.sourceId === sourceId)?.resultSetId
                    ?? '',
            });
        }
        this.dispatch({ type: 'shell/status', status: 'complete' });
        this.setSurface('results');
    }

    private startResult(ref: ResultRef, normalized: NormalizedResultSet, executing: boolean): void {
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
            this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'error', message: normalized.message ?? 'Result failed.' } });
        } else if (normalized.isCancelled) {
            this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'cancelled', totalRowCount: normalized.totalRowCount, message: normalized.message } });
        } else if (normalized.totalRowCount === 0) {
            this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'empty', message: normalized.message } });
        } else {
            this.dispatch({ type: 'execution/event', event: { ...eventBase(ref, sequence++), type: 'complete', totalRowCount: normalized.totalRowCount, message: normalized.message } });
        }
        this.nextSequence.set(resultKey(ref.sourceId, ref.resultSetId), sequence);
        this.nextChunkSequence.delete(resultKey(ref.sourceId, ref.resultSetId));
    }

    private applyAppend(message: Extract<ResultPanelHostToWebviewMessage, { command: 'appendRows' }>): void {
        const sourceId = message.sourceUri ?? this.getState().results.activeSourceId;
        if (!sourceId || (this.getState().results.activeSourceId && this.getState().results.activeSourceId !== sourceId)) return;
        const index = message.resultSetIndex;
        const knownRef = this.refs.get(sourceIndexKey(sourceId, index));
        if (knownRef && message.resultSetId && knownRef.resultSetId !== message.resultSetId) return;
        const resultSetId = message.resultSetId ?? knownRef?.resultSetId ?? `vscode-stream-${sourceId}-${index}`;
        const key = resultKey(sourceId, resultSetId);
        const current = Object.values(this.getState().results.byResultSetId)
            .find(result => result.sourceId === sourceId && result.resultSetId === resultSetId);
        const startsNewExecution = message.isFirstChunk === true || !current;
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
        this.dispatch({ type: 'results/select-source', sourceId });
        this.dispatch({ type: 'results/select', sourceId, resultSetId });
    }

    private applyDiskBackedActivate(message: Extract<ResultPanelHostToWebviewMessage, { command: 'diskBackedActivate' }>): void {
        const currentSource = this.getState().results.activeSourceId;
        if (currentSource && currentSource !== message.sourceUri) return;
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
        this.dispatch({ type: 'results/select-source', sourceId: ref.sourceId });
        this.dispatch({ type: 'results/select', sourceId: ref.sourceId, resultSetId: ref.resultSetId });
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
        });
    }

    private applyRowWindow(message: Extract<ResultPanelHostToWebviewMessage, { command: 'rowWindow' }>): void {
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
        if (message.action !== 'window' || message.rows === undefined) return;
        const pending = this.pendingRowWindows.get(message.requestId);
        this.pendingRowWindows.delete(message.requestId);
        const offset = asNonNegativeInteger(message.offset) ?? 0;
        if (!pending || pending.ref.sourceId !== message.sourceUri || pending.offset !== offset) return;
        const ref = this.refs.get(sourceIndexKey(message.sourceUri, message.resultSetIndex));
        if (!ref || pending.ref !== ref) return;
        this.applyLoadedRows(ref, offset, decodeSharedRows(message.rows), message.totalRows);
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
            totalRowCount: Math.max(result.totalRowCount, totalRows ?? 0, nextRows.length),
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
            } as UiResultEvent,
        });
        this.nextSequence.set(key, nextSequence + 1);
        this.nextChunkSequence.delete(key);
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

    private selectResultByIndex(index: number): void {
        const sourceId = this.getState().results.activeSourceId;
        if (!sourceId) return;
        const ref = this.refs.get(sourceIndexKey(sourceId, index));
        if (ref) this.selectResult(ref.resultSetId, sourceId);
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

export function SharedResultPanelApp({ controller }: { readonly controller: SharedResultPanelController }): ReactNode {
    const state = useSharedControllerState(controller);
    const [selectedRow, setSelectedRow] = useState<number | undefined>();
    const [analysisKind, setAnalysisKind] = useState<UiResultAnalysisKind | undefined>();
    const [analysisTable, setAnalysisTable] = useState<UiResultAnalysisTable | undefined>();
    const [analysisLoading, setAnalysisLoading] = useState(false);
    const [analysisError, setAnalysisError] = useState<string | undefined>();
    const analysisGenerationRef = useRef(0);
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
        closeAnalysis();
    }, [activeResult?.sourceId, activeResult?.resultSetId, closeAnalysis]);
    const updateView = useCallback((patch: Partial<UiResultSurfaceState['view']>): void => {
        if ('globalFilter' in patch || 'columnFilters' in patch || 'sorting' in patch) {
            closeAnalysis();
        }
        if (activeResult) controller.updateView(activeResult.resultSetId, patch);
    }, [activeResult, closeAnalysis, controller]);
    const runAnalysis = useCallback((kind: UiResultAnalysisKind): void => {
        const result = controller.activeResult();
        if (!result) return;
        if (analysisKind === kind && !analysisLoading) {
            closeAnalysis();
            return;
        }
        const generation = ++analysisGenerationRef.current;
        setAnalysisKind(kind);
        setAnalysisTable(undefined);
        setAnalysisError(undefined);
        setAnalysisLoading(true);
        void controller.requestAnalysis(kind, result).then(table => {
            if (analysisGenerationRef.current !== generation) return;
            setAnalysisTable(table);
            setAnalysisLoading(false);
        }).catch(error => {
            if (analysisGenerationRef.current !== generation) return;
            setAnalysisLoading(false);
            setAnalysisError(error instanceof Error ? error.message : String(error));
        });
    }, [analysisKind, analysisLoading, closeAnalysis, controller]);
    const sourceResults = useMemo(
        () => Object.values(state.results.byResultSetId).filter(result => result.sourceId === state.results.activeSourceId),
        [state.results],
    );
    const rows = controller.getRows(activeResult);
    const resultState = asyncStateFor(activeResult, rows.length);
    const schemaCapability = capability(state.capabilities, 'result-panel.schema-navigation');
    const sourceLabel = state.results.activeSourceId?.split(/[\\/]/u).pop() ?? 'Query Results';
    const view = activeResult?.view ?? { globalFilter: '', sorting: [], grouping: [], aggregation: undefined, pivotColumn: undefined };
    const selected = selectedRow === undefined ? undefined : rows[selectedRow];
    const detailColumns = useMemo(
        () => activeResult ? resolveDataGridColumns(activeResult.columns, rows) : [],
        [activeResult?.columns, rows],
    );
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
    const copySelection = (payload: { readonly columns: readonly { readonly name: string; readonly type?: string; readonly scale?: number }[]; readonly rows: readonly (readonly unknown[])[] }, format?: DataGridClipboardFormat): void => {
        postHostMessage({
            command: 'copyToClipboard',
            text: formatDataGridClipboard(
                payload,
                format === undefined || format === 'tsv' ? 'text' : format,
                { includeHeaders: payload.rows.length > 0 },
            ),
        });
    };

    return <UiShell
        title={sourceLabel}
        activeSurface={state.shell.activeSurface}
        onSurfaceChange={surface => controller.setSurface(surface as UiState['shell']['activeSurface'])}
        surfaces={[
            { id: 'results', label: 'Results' },
            { id: 'schema', label: 'Schema' },
            { id: 'history', label: 'History' },
        ]}
        sidebar={<CapabilityGate capability={schemaCapability} fallback={<div role="status">Schema navigation is host-owned in shared mode.</div>}><div>Schema</div></CapabilityGate>}
    >
        <FocusOnMount>
            <WorkspaceTabs tabs={[{ id: state.results.activeSourceId ?? 'result-panel', label: sourceLabel }]} activeId={state.results.activeSourceId ?? 'result-panel'} onSelect={id => controller.selectSource(id)} />
            {state.shell.activeSurface === 'results' && <>
                <ResultTabs results={sourceResults} activeResultSetId={state.results.activeResultSetId} activeSourceId={state.results.activeSourceId} onSelect={(id, sourceId) => controller.selectResult(id, sourceId)} />
                <ResultViewToolbar columns={activeResult?.columns ?? []} view={view} onChange={updateView} onAggregate={() => runAnalysis('aggregate')} onGroup={() => runAnalysis('group')} onPivot={() => runAnalysis('pivot')} activeAnalysis={analysisKind} analysisBusy={analysisLoading} onRefresh={() => controller.refresh()} onCopy={() => controller.copyActive()} onExport={() => controller.exportActive()} />
                {analysisKind && <ResultAnalysisPanel sourceId={activeResult?.sourceId} resultSetId={activeResult?.resultSetId ?? 'result-panel'} table={analysisTable} loading={analysisLoading} error={analysisError} onClose={closeAnalysis} onCopySelection={copySelection} onViewCell={openAnalysisCellValue} />}
                <AsyncStateView state={resultState} message={activeResult?.message} loadingLabel="Waiting for result data…">
                    {activeResult && <DataGrid
                        sourceId={activeResult.sourceId}
                        resultSetId={activeResult.resultSetId}
                        columns={activeResult.columns}
                        rows={rows}
                        totalRowCount={activeResult.totalRowCount}
                        view={activeResult.view}
                        onViewChange={updateView}
                        showContextMenu
                        selectedRowIndex={selectedRow}
                        scroll={{ sourceId: activeResult.sourceId, resultSetId: activeResult.resultSetId, top: activeResult.view.scrollTop, left: activeResult.view.scrollLeft, anchorRow: activeResult.view.anchorRow }}
                        onScroll={position => controller.updateView(activeResult.resultSetId, { scrollTop: position.top, scrollLeft: position.left, anchorRow: position.anchorRow })}
                        onLoadMore={() => controller.loadMore(activeResult)}
                        onRowSelect={setSelectedRow}
                        onCopySelection={(payload, format?: DataGridClipboardFormat) => postHostMessage({ command: 'copyToClipboard', text: formatDataGridClipboard(payload, format === undefined || format === 'tsv' ? 'text' : format, { includeHeaders: payload.includeHeaders ?? true }) })}
                        onViewCell={openCellValue}
                        onOpenResultFormatting={() => callPanelMethod('openResultFormattingPanel', { scope: 'result' })}
                    />}
                </AsyncStateView>
                {selected && activeResult && <RowDetail columns={detailColumns} row={selected} onClose={() => setSelectedRow(undefined)} />}
            </>}
            {state.shell.activeSurface === 'schema' && <CapabilityGate capability={schemaCapability} fallback={<AsyncStateView state="empty" emptyLabel="Schema navigation is not available in this Result Panel yet." />}><div>Schema navigation</div></CapabilityGate>}
            {state.shell.activeSurface === 'history' && <AsyncStateView state="empty" emptyLabel="History remains available through the host until the shared HistoryPort adapter is enabled." />}
        </FocusOnMount>
    </UiShell>;
}

function ensureSharedStyles(): void {
    if (document.getElementById(SHARED_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SHARED_STYLE_ID;
    style.textContent = `
        body.shared-ui-mode { margin: 0; overflow: hidden; }
        body.shared-ui-mode #loadingOverlay, body.shared-ui-mode #executionStatusBanner,
        body.shared-ui-mode #resultLimitBanner, body.shared-ui-mode #resultSetHeader { display: none !important; }
        body.shared-ui-mode .layout-wrapper { display: none !important; }
        #${SHARED_ROOT_ID} { display: block; height: 100vh; overflow: auto; font: 13px var(--vscode-font-family, sans-serif); }
        #${SHARED_ROOT_ID} .ui-shell { min-height: 100%; }
        #${SHARED_ROOT_ID} .ui-shell-header, #${SHARED_ROOT_ID} .ui-result-toolbar,
        #${SHARED_ROOT_ID} .ui-workspace-tabs, #${SHARED_ROOT_ID} .ui-result-tabs { display: flex; gap: 6px; align-items: center; padding: 6px; flex-wrap: wrap; }
        #${SHARED_ROOT_ID} .ui-shell-header { justify-content: space-between; border-bottom: 1px solid var(--vscode-panel-border, #444); }
        #${SHARED_ROOT_ID} .ui-shell-header h1 { margin: 0; font-size: 14px; }
        #${SHARED_ROOT_ID} .ui-shell-body { display: grid; grid-template-columns: minmax(150px, 22%) 1fr; min-height: calc(100vh - 48px); }
        #${SHARED_ROOT_ID} .ui-shell-sidebar { border-right: 1px solid var(--vscode-panel-border, #444); padding: 8px; }
        #${SHARED_ROOT_ID} .ui-shell-main { min-width: 0; padding: 6px; }
        #${SHARED_ROOT_ID} button, #${SHARED_ROOT_ID} input { font: inherit; }
        #${SHARED_ROOT_ID} .ui-data-grid-scroll { max-height: calc(100vh - 180px); }
        #${SHARED_ROOT_ID} .ui-row-detail { margin-top: 8px; padding: 8px; border: 1px solid var(--vscode-panel-border, #444); }
        #${SHARED_ROOT_ID} .ui-row-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
        #${SHARED_ROOT_ID} .ui-row-detail dt { font-weight: 600; }
        #${SHARED_ROOT_ID} .ui-capability-state, #${SHARED_ROOT_ID} .ui-async-state { padding: 12px; }
    `;
    document.head.appendChild(style);
}

let sharedRoot: Root | undefined;
let sharedController: SharedResultPanelController | undefined;
let sharedHostMessageHandler: ((event: MessageEvent<unknown>) => void) | undefined;

export function mountSharedResultPanelIfConfigured(): boolean {
    if (!sharedModeFromGlobal()) return false;
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
