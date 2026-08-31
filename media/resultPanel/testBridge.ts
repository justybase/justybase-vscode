import { applyDatabaseFilter, queryDatabaseFilterValues } from './databaseFilters.js';
import { queryDatabaseAggregations } from './databaseAggregations.js';
import {
    getDiskBackedPendingRequestCount,
    queryDiskAggregations,
    queryDiskCount,
    queryDiskDistinctValues,
    queryDiskGroups,
} from './diskBackedGrid.js';
import { getDatabaseAggregationPendingRequestCount } from './databaseAggregations.js';
import { getDatabaseFilterPendingRequestCount } from './databaseFilters.js';
import { getDatabaseGroupingPendingRequestCount } from './databaseGrouping.js';
import { postHostMessage } from './protocol.js';
import { getGroupingPanelOpen } from './state.js';
import {
    getActiveGridIndex,
    getGrid,
    getGlobalFilterState,
} from './state.js';
import {
    getActiveSourceUri,
    getResultPanelWindow,
    getResultSetAt,
    getResultSets,
} from './types.js';
import { renderRowCountInfo } from './filter.js';
import { switchToResultSet } from './tabs.js';
import { getGridWrapperForResultSet, getScrollTarget } from './grid/persistence.js';
import { isResultPanelTraceEnabled, traceResultPanel } from './trace.js';

interface TestBridgeRequest {
    requestId: string;
    action: string;
    args?: unknown;
}

interface TestBridgeResult {
    sourceUri: string | undefined;
    activeResultSetIndex: number;
    activeResultSetId?: string;
    resultSetCount: number;
    resultSets: Array<{
        resultSetId: string;
        isLog: boolean;
        isError: boolean;
        rowCount: number;
        totalRowCount: number;
        storageMode: string;
        limitReached: boolean;
        hasRefreshSql: boolean;
        columnCount: number;
    }>;
    visibleRowCount: number;
    firstCellFingerprint: string;
    rowCountText: string;
    globalFilterActive: boolean;
    columnFilterCount: number;
    databaseFilterActive: boolean;
    groupingPanelVisible: boolean;
    groupingResultRows: number;
    pendingRequestCount: number;
    viewport: {
        scrollTop: number;
        scrollLeft: number;
        scrollHeight: number;
        clientHeight: number;
        scrollWidth: number;
        clientWidth: number;
        scrollAnchorIndex?: number;
        firstVisibleRowIndex?: number;
        firstVisibleRowFingerprint: string;
    };
}

const ACTION_TIMEOUT_MS = 15_000;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNumberArray(value: unknown): number[] {
    return Array.isArray(value)
        ? value.filter((item): item is number => Number.isInteger(item) && item >= 0)
        : [];
}

function redactError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text
        .replace(/'[^']{0,128}'/g, "'<redacted>'")
        .replace(/\s+/g, ' ')
        .slice(0, 256);
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(
    description: string,
    predicate: () => boolean,
    timeoutMs = ACTION_TIMEOUT_MS,
): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt >= timeoutMs) {
            throw new Error(`Test bridge timed out waiting for ${description}.`);
        }
        await sleep(25);
    }
}

function isActiveFilter(value: unknown): boolean {
    const spec = asRecord(value);
    return Boolean(
        asString(spec.globalSearch).trim()
        || (Array.isArray(spec.columnFilters) && spec.columnFilters.length > 0),
    );
}

function visibleRowCount(resultSet: ReturnType<typeof getResultSetAt>, resultSetIndex: number): number {
    if (!resultSet) return 0;
    if (resultSet.storageMode === 'sqlite') {
        return resultSet.diskFilteredCount ?? resultSet.totalRowCount ?? resultSet.data.length;
    }
    return getGrid(resultSetIndex)?.tanTable?.getFilteredRowModel?.().rows.length
        ?? resultSet.data.length;
}

function pendingRequestCount(): number {
    const panel = getResultPanelWindow();
    const syncCount = typeof panel.__getResultSyncPendingRequestCount === 'function'
        ? panel.__getResultSyncPendingRequestCount()
        : 0;
    return getDatabaseFilterPendingRequestCount()
        + getDatabaseAggregationPendingRequestCount()
        + getDatabaseGroupingPendingRequestCount()
        + getDiskBackedPendingRequestCount()
        + syncCount;
}

function viewportSnapshot(resultSetIndex: number, resultSet: ReturnType<typeof getResultSetAt>, grid: ReturnType<typeof getGrid>): TestBridgeResult['viewport'] {
    const wrapper = getGridWrapperForResultSet(resultSetIndex);
    const target = getScrollTarget(wrapper);
    const visibleRow = wrapper?.querySelector('tbody tr[data-index]:not(.virtual-pad-top):not(.virtual-pad-bottom)') as HTMLElement | null;
    const parsedVisibleRowIndex = visibleRow?.dataset.index === undefined
        ? Number.NaN
        : Number(visibleRow.dataset.index);
    const firstVisibleRowIndex = Number.isInteger(parsedVisibleRowIndex)
        ? parsedVisibleRowIndex
        : undefined;
    const firstVisibleRowFingerprint = visibleRow
        ? hashFingerprint((visibleRow.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 256))
        : '';
    return {
        scrollTop: target?.scrollTop ?? 0,
        scrollLeft: target?.scrollLeft ?? 0,
        scrollHeight: target?.scrollHeight ?? 0,
        clientHeight: target?.clientHeight ?? 0,
        scrollWidth: target?.scrollWidth ?? 0,
        clientWidth: target?.clientWidth ?? 0,
        scrollAnchorIndex: grid?.getScrollAnchorIndex?.(),
        firstVisibleRowIndex,
        firstVisibleRowFingerprint,
    };
}

function traceViewportSnapshot(
    action: string,
    resultSetIndex: number,
    result: TestBridgeResult,
): void {
    traceResultPanel({
        phase: 'test_bridge_viewport',
        command: 'testBridge',
        reason: action,
        resultSetIndex,
        scrollTop: result.viewport.scrollTop,
        scrollLeft: result.viewport.scrollLeft,
        scrollAnchorIndex: result.viewport.scrollAnchorIndex,
        firstVisibleRowIndex: result.viewport.firstVisibleRowIndex,
    });
}

function snapshot(): TestBridgeResult {
    const resultSets = getResultSets();
    const activeResultSetIndex = getActiveGridIndex();
    const activeResultSet = getResultSetAt(activeResultSetIndex);
    const grid = getGrid(activeResultSetIndex);
    const tableState = grid?.tanTable?.getState?.();
    const rowCountElement = document.getElementById('rowCountInfo');
    return {
        sourceUri: getActiveSourceUri(),
        activeResultSetIndex,
        activeResultSetId: activeResultSet?.resultSetId,
        resultSetCount: resultSets.length,
        resultSets: resultSets.map(resultSet => ({
            resultSetId: resultSet?.resultSetId ?? '',
            isLog: resultSet?.isLog === true,
            isError: resultSet?.isError === true,
            rowCount: Array.isArray(resultSet?.data) ? resultSet.data.length : 0,
            totalRowCount: resultSet?.totalRowCount ?? resultSet?.data?.length ?? 0,
            storageMode: resultSet?.storageMode ?? 'memory',
            limitReached: resultSet?.limitReached === true,
            hasRefreshSql: Boolean(resultSet?.refreshSql),
            columnCount: resultSet?.columns?.length ?? 0,
        })),
        visibleRowCount: visibleRowCount(activeResultSet, activeResultSetIndex),
        firstCellFingerprint: activeResultSet?.data?.[0]?.[0] === undefined
            ? ''
            : hashFingerprint(`${typeof activeResultSet.data[0][0]}:${String(activeResultSet.data[0][0])}`),
        rowCountText: rowCountElement?.textContent?.slice(0, 128) ?? '',
        globalFilterActive: Boolean(
            getGlobalFilterState(
                activeResultSetIndex,
                activeResultSet?.executionTimestamp,
                getActiveSourceUri(),
            ).trim(),
        ),
        columnFilterCount: tableState?.columnFilters?.length ?? 0,
        databaseFilterActive: isActiveFilter(activeResultSet?.databaseFilterSpec),
        groupingPanelVisible: getGroupingPanelOpen(),
        groupingResultRows: document.querySelectorAll('#groupingResultsArea .grouping-table tbody tr').length,
        pendingRequestCount: pendingRequestCount(),
        viewport: viewportSnapshot(activeResultSetIndex, activeResultSet, grid),
    };
}

function hashFingerprint(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function setGlobalFilter(value: string): Promise<TestBridgeResult> {
    const input = document.getElementById('globalFilter') as HTMLInputElement | null;
    if (!input) throw new Error('Global filter input is not available.');
    input.value = value;
    getResultPanelWindow().onFilterChanged?.();
    await sleep(175);
    renderRowCountInfo();
    return snapshot();
}

async function setColumnFilter(args: Record<string, unknown>): Promise<TestBridgeResult> {
    const index = asNumber(args.columnIndex, -1);
    const resultSetIndex = getActiveGridIndex();
    const column = getGrid(resultSetIndex)?.tanTable?.getColumn(String(index));
    if (!column) throw new Error(`Column ${index} is not available.`);
    const value = asString(args.value);
    column.setFilterValue(value ? [value] : undefined);
    getGrid(resultSetIndex)?.render?.();
    renderRowCountInfo(resultSetIndex);
    await sleep(50);
    return snapshot();
}

async function scrollResultAction(args: Record<string, unknown>): Promise<TestBridgeResult> {
    const resultSetIndex = getActiveGridIndex();
    const grid = getGrid(resultSetIndex);
    const wrapper = getGridWrapperForResultSet(resultSetIndex);
    const target = getScrollTarget(wrapper);
    if (!target) throw new Error('The active result has no scroll target.');

    const rowIndex = args.rowIndex === undefined ? undefined : asNumber(args.rowIndex, -1);
    if (rowIndex !== undefined && rowIndex >= 0 && grid?.scrollToIndex) {
        grid.scrollToIndex(rowIndex, asString(args.align, 'start'));
    }
    if (rowIndex === undefined || rowIndex < 0 || !grid?.scrollToIndex) {
        if (args.scrollTop !== undefined) target.scrollTop = Math.max(0, asNumber(args.scrollTop));
    }
    if (args.scrollLeft !== undefined) target.scrollLeft = Math.max(0, asNumber(args.scrollLeft));
    target.dispatchEvent(new Event('scroll'));
    // Virtual rows and the debounced persistence listener settle asynchronously.
    await sleep(250);
    return snapshot();
}

async function databaseFilterValues(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) throw new Error('No active result source.');
    const resultSetIndex = getActiveGridIndex();
    const columnIndex = asNumber(args.columnIndex, -1);
    if (columnIndex < 0) throw new Error('A valid filter column is required.');
    const result = await queryDatabaseFilterValues(
        sourceUri,
        resultSetIndex,
        columnIndex,
        args.querySpec as import('./types.js').DiskQuerySpec | undefined,
        { timeoutSeconds: 10 },
    );
    return {
        valueCount: result.values.length,
        truncated: result.truncated,
        nullValueCount: result.values.filter(value => value.raw === null || value.raw === undefined).length,
    };
}

async function applyDatabaseFilterAction(args: Record<string, unknown>): Promise<TestBridgeResult> {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) throw new Error('No active result source.');
    await applyDatabaseFilter(
        sourceUri,
        getActiveGridIndex(),
        args.querySpec as import('./types.js').DiskQuerySpec | undefined,
        { timeoutSeconds: 10 },
    );
    await sleep(50);
    renderRowCountInfo();
    return snapshot();
}

async function databaseAggregationsAction(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sourceUri = getActiveSourceUri();
    if (!sourceUri) throw new Error('No active result source.');
    const aggregations = Array.isArray(args.aggregations)
        ? args.aggregations.filter(item => item && typeof item === 'object') as Array<{ columnIndex: number; fn: string }>
        : [{ columnIndex: 0, fn: 'count' }];
    const results = await queryDatabaseAggregations(sourceUri, getActiveGridIndex(), aggregations, { timeoutSeconds: 10 });
    return {
        count: results.length,
        functions: results.map(result => result.fn),
        numericResultCount: results.filter(result => typeof result.value === 'number').length,
    };
}

async function runGroupingAction(): Promise<Record<string, unknown>> {
    const panel = getResultPanelWindow();
    if (typeof panel.__runGroupingQuery !== 'function') {
        throw new Error('Grouping test hook is not available.');
    }
    await Promise.resolve(panel.__runGroupingQuery());
    await waitFor(
        'grouping results',
        () => Boolean(
            document.querySelector('#groupingResultsArea .grouping-table')
            || document.querySelector('#groupingResultsArea .grouping-error')
            || document.querySelector('#groupingResultsArea .no-results'),
        ),
    );
    const error = document.querySelector('#groupingResultsArea .grouping-error')?.textContent;
    if (error) throw new Error(redactError(error));
    const headers = Array.from(document.querySelectorAll('#groupingResultsArea .grouping-table thead th button'))
        .map(button => (button.textContent ?? '').replace(/\s+[↑↓]$/u, '').slice(0, 128));
    const sqlElement = document.querySelector('.grouping-sql-copy') as HTMLElement | null;
    return {
        columnCount: Math.max(0, headers.length),
        headers,
        rowCount: document.querySelectorAll('#groupingResultsArea .grouping-table tbody tr').length,
        summary: document.querySelector('#groupingResultsArea .grouping-summary')?.textContent?.slice(0, 128) ?? '',
        sqlFingerprint: hashFingerprint(sqlElement?.dataset.sql ?? headers.join('|')),
    };
}

async function diskAction(): Promise<Record<string, unknown>> {
    const resultSetIndex = getActiveGridIndex();
    const resultSet = getResultSetAt(resultSetIndex);
    if (!resultSet || resultSet.storageMode !== 'sqlite') {
        throw new Error('The active result is not disk-backed.');
    }
    const count = await queryDiskCount(resultSetIndex);
    const distinct = await queryDiskDistinctValues(resultSetIndex, 1);
    const aggregations = await queryDiskAggregations(resultSetIndex, [
        { columnIndex: 3, fn: 'sum' },
        { columnIndex: 3, fn: 'count' },
    ]);
    const groups = await queryDiskGroups(
        resultSetIndex,
        [{ columnIndex: 1 }],
        [],
        0,
        100,
        [{ columnIndex: 3, fn: 'sum' }],
    );
    return {
        count,
        distinctCount: distinct.values.length,
        distinctTruncated: distinct.truncated,
        aggregationCount: aggregations.length,
        groupCount: groups.groups?.length ?? 0,
        groupTotalCount: groups.totalCount,
    };
}

async function dispatchAction(action: string, argsValue: unknown): Promise<unknown> {
    const args = asRecord(argsValue);
    switch (action) {
        case 'snapshot':
            return snapshot();
        case 'setGlobalFilter':
            return setGlobalFilter(asString(args.value));
        case 'clearGlobalFilter':
            return setGlobalFilter('');
        case 'setColumnFilter':
            return setColumnFilter(args);
        case 'scrollResult':
            return scrollResultAction(args);
        case 'databaseFilterValues':
            return databaseFilterValues(args);
        case 'applyDatabaseFilter':
            return applyDatabaseFilterAction(args);
        case 'databaseAggregations':
            return databaseAggregationsAction(args);
        case 'openGroupingPanel':
            getResultPanelWindow().toggleDatabaseGroupingPanel?.();
            return snapshot();
        case 'configureGrouping': {
            const configure = getResultPanelWindow().__testConfigureDatabaseGrouping;
            if (!configure) throw new Error('Grouping configuration test hook is not available.');
            configure(
                asNumberArray(args.columns),
                Array.isArray(args.functions) ? args.functions.filter(item => item && typeof item === 'object') as Array<{ fn: string; columnIndex?: number }> : undefined,
            );
            return snapshot();
        }
        case 'runGrouping':
            return runGroupingAction();
        case 'diskQuery':
            return diskAction();
        case 'diskMove': {
            const sourceUri = getActiveSourceUri();
            if (!sourceUri) throw new Error('No active result source.');
            const resultSetIndex = getActiveGridIndex();
            if (getResultSetAt(resultSetIndex)?.storageMode !== 'sqlite') {
                postHostMessage({ command: 'moveToDisk', sourceUri, resultSetIndex });
                await waitFor('disk-backed activation', () => getResultSetAt(resultSetIndex)?.storageMode === 'sqlite');
            }
            return snapshot();
        }
        case 'switchSource': {
            const sourceUri = asString(args.sourceUri);
            if (!sourceUri) throw new Error('A source URI is required.');
            postHostMessage({ command: 'switchSource', sourceUri });
            await waitFor('source switch', () => getActiveSourceUri() === sourceUri);
            const result = snapshot();
            traceViewportSnapshot(action, getActiveGridIndex(), result);
            return result;
        }
        case 'switchResultSet': {
            const sourceUri = getActiveSourceUri();
            const resultSetIndex = asNumber(args.resultSetIndex, -1);
            if (!sourceUri || resultSetIndex < 0) throw new Error('A source and result-set index are required.');
            // The production tab handler changes the local grid first and then
            // informs the host. Reuse that path so the bridge observes both
            // sides of the protocol.
            switchToResultSet(resultSetIndex);
            await waitFor('result-set switch', () => getActiveGridIndex() === resultSetIndex);
            // The production handler schedules a second restore after layout
            // settles. Let that pass run before sampling the viewport so the
            // bridge asserts the user-visible state rather than the transient
            // pre-layout position.
            await sleep(75);
            const result = snapshot();
            traceViewportSnapshot(action, resultSetIndex, result);
            return result;
        }
        case 'togglePin': {
            const sourceUri = getActiveSourceUri();
            if (!sourceUri) throw new Error('No active result source.');
            postHostMessage({ command: 'togglePin', sourceUri });
            await sleep(100);
            return snapshot();
        }
        case 'toggleResultPin': {
            const sourceUri = getActiveSourceUri();
            if (!sourceUri) throw new Error('No active result source.');
            postHostMessage({ command: 'toggleResultPin', sourceUri, resultSetIndex: getActiveGridIndex() });
            await sleep(100);
            return snapshot();
        }
        case 'refresh': {
            const resultSetIndex = getActiveGridIndex();
            const before = getResultSetAt(resultSetIndex)?.executionTimestamp;
            const sourceUri = getActiveSourceUri();
            if (!sourceUri) throw new Error('No active result source.');
            // The toolbar helper opens the LIMIT picker when a query has a
            // trailing LIMIT. The underlying production message is the
            // deterministic path used after the user confirms that picker.
            postHostMessage({ command: 'refreshResult', sourceUri, resultSetIndex });
            await waitFor('result refresh', () => {
                const current = getResultSetAt(resultSetIndex);
                return current?.executionTimestamp !== before && current?.isStreamingComplete !== false;
            });
            return snapshot();
        }
        case 'export': {
            const sourceUri = getActiveSourceUri();
            if (!sourceUri) throw new Error('No active result source.');
            const destination = asString(args.destination);
            if (!destination) throw new Error('An export destination is required.');
            postHostMessage({
                command: 'export',
                format: asString(args.format, 'csv') as import('./hostContracts.js').ResultPanelExportFormat,
                sourceUri,
                resultSetIndex: getActiveGridIndex(),
                destination,
                rowIndices: Array.isArray(args.rowIndices) ? args.rowIndices as number[] : undefined,
                columnIds: Array.isArray(args.columnIds) ? args.columnIds as string[] : undefined,
            } as never);
            await sleep(300);
            return { requested: true };
        }
        default:
            throw new Error(`Unknown result-panel test action: ${action}`);
    }
}

/** Handle a test-only request sent through the same webview message channel as production traffic. */
export async function handleResultPanelTestBridgeMessage(message: TestBridgeRequest): Promise<void> {
    if (!isResultPanelTraceEnabled()) return;
    traceResultPanel({ phase: 'test_bridge_received', command: 'testBridge', reason: message.action });
    try {
        const result = await dispatchAction(message.action, message.args);
        postHostMessage({
            command: 'testBridgeResult',
            requestId: message.requestId,
            action: message.action,
            ok: true,
            result,
        });
        traceResultPanel({ phase: 'test_bridge_result_sent', command: 'testBridgeResult', reason: message.action });
    } catch (error: unknown) {
        const errorText = redactError(error);
        postHostMessage({
            command: 'testBridgeResult',
            requestId: message.requestId,
            action: message.action,
            ok: false,
            error: errorText,
        });
        traceResultPanel({ phase: 'test_bridge_result_sent', command: 'testBridgeResult', reason: message.action, error: errorText });
    }
}
