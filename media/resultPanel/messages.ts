// Messages module - Message handling for result panel
import { decode } from '@msgpack/msgpack';
import { asHostMessage, getHostState, postHostMessage, setHostState } from './protocol.js';
import type { ResultPanelExecutionState } from './hostContracts.js';
import {
    saveCurrentSourceToCache,
    getCachedSource,
    saveScrollStateForSource,
    getScrollStateFromCache,
    saveScrollStateToCache,
    getScrollStateFromGlobalCache,
    setActiveGridIndex,
    getActiveGridIndex,
    getAllGrids,
    getGrid,
    pruneSourceResultsCache,
    evictSourceCacheNotInList,
    getColumnFilterState,
    getAggregationState,
    setAggregationState,
    getPinnedColumnsState,
    getResultFormattingPayload,
    getResultFormattingState,
    setResultFormattingPayload,
    setResultFormattingState,
    getLayoutMode,
    normalizeResultSetsEditability,
    resetEditSession,
    releaseResultSetRows,
} from './state.js';
import { showError } from './utils.js';
import { renderDocIndicator, renderResultSetTabs, switchToResultSet, updateLogsTabSpinner } from './tabs.js';
import { renderGrids, updateLoadingState, appendLogRows, replaceLogRows, updateControlsVisibility, syncGlobalFilterInput } from './grid.js';
import { updateRowCountInfo, applyRowLimitReachedFlag, renderRowCountInfo } from './filter.js';
import { syncDiskStreamingRowCount } from './diskQuerySpec.js';
import { syncAnalysisView } from './analysis.js';
import { updateResultLimitBanner } from './banners.js';
import { handleDatabaseAggregationResult, clearAllDatabaseAggregationPending } from './databaseAggregations.js';
import { handleDatabaseGroupingResult, handleDatabaseGroupingPreviewResult } from './databaseGrouping.js';
import { handleExploreHostMessage } from './explore/hostBridge.js';
import { handleDatabaseFilterValuesResult, handleDatabaseFilterApplyResult, clearAllDatabaseFilterPending } from './databaseFilters.js';
import { updateAllRefreshFailureBanners } from './refreshFailureBanner.js';
import {
    markRunningUiPending,
    resetRunningUiDelay,
    scheduleRunningUiRefresh,
    shouldDeferRunningUi,
} from './runningUiDelay.js';
import {
    completeSourceSwitchEnd,
    scheduleSourceSwitchEnd,
    setUxPerfSessionActive,
    beginSourceSwitchEndSchedule,
    invalidateSourceSwitchEnd,
    UxPerfMark,
} from './uxPerf.js';
import type { ColumnAggregationState, LogRow, ResultSet } from './types.js';
import {
    asScrollState,
    callPanelMethod,
    ensureExecutingSources,
    getActiveSourceUri,
    getResultPanelWindow,
    getResultSets,
    getResultSetAt,
    requireActiveSourceUri,
    setActiveSourceUri,
    setResultSets,
} from './types.js';
import { asHtml } from './dom.js';
import { clearAllSearchWorkerData } from './searchWorkerBridge.js';
import {
    configureResultPanelTrace,
    traceResultPanel,
} from './trace.js';
import { handleResultPanelTestBridgeMessage } from './testBridge.js';
import {
    handleDiskBackedActivate,
    handleDiskQueryResult,
    handleRowCountUpdate,
    handleRowWindow,
    isDiskBackedResultSet,
    clearDiskBackedPendingRequests,
    DISK_BACKED_WEBVIEW_STREAM_CAP,
    DISK_BACKED_STREAMING_PREVIEW_ROWS,
} from './diskBackedGrid.js';
import { clearAllDiskGrouping } from './diskGrouping.js';
import {
    type SavedGridState,
    saveAllGridStates,
    getSavedStateFor,
    findScrollStateBySource,
    getScrollTarget,
    getGridWrapperForResultSet,
    applyScrollForResultSet,
    savePinnedState,
    saveScrollStatesToResultSets,
    restoreScrollFromResultSet,
    setPreserveScrollDuringHydrate,
} from './grid/persistence.js';

export type { SavedGridState } from './grid/persistence.js';
export { updateResultLimitBanner } from './banners.js';
export {
    saveAllGridStates,
    getSavedStateFor,
    findScrollStateBySource,
    savePinnedState,
    saveScrollStatesToResultSets,
    restoreScrollFromResultSet,
} from './grid/persistence.js';

interface HydrateData {
    activeSourceJson?: string;
    sourcesJson?: string;
    pinnedSourcesJson?: string;
    pinnedResultsJson?: string;
    activeResultSetIndex?: number;
    executingSourcesJson?: string;
    streamingCompletedSourcesJson?: string;
    queryRowLimit?: number;
    maxDataResults?: number;
    diskBackedStreamCapEnabled?: boolean;
    resultSetsMsgPack?: Uint8Array | { data?: number[]; byteLength?: number };
    resultSetsJson?: string;
    formatSettings?: unknown;
    dataVersion?: number;
    resultPanelTraceEnabled?: boolean;
    resultSyncVersion?: number;
}

function resolveDiskBackedStreamCapEnabled(message?: Record<string, unknown>): boolean {
    if (message && typeof message.diskBackedStreamCapEnabled === 'boolean') {
        return message.diskBackedStreamCapEnabled;
    }
    return getResultPanelWindow().diskBackedStreamCapEnabled === true;
}

function persistActiveSourceResultCache(): void {
    const activeSource = getActiveSourceUri();
    if (activeSource) {
        saveCurrentSourceToCache(activeSource, getResultSets(), getActiveGridIndex());
    }
}

function formatActiveSourceLabel(sourceUri: string | undefined): string {
    if (!sourceUri || typeof sourceUri !== 'string') {
        return 'current source';
    }

    if (sourceUri.startsWith('untitled:')) {
        return 'Untitled query';
    }

    const normalized = sourceUri.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const lastSegment = segments[segments.length - 1];
    return lastSegment || sourceUri;
}

function getActiveResultSets(): ResultSet[] {
    return getResultSets();
}

function parseSourceSet(value: string | undefined): Set<string> | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(value) as unknown;
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter((source): source is string => typeof source === 'string')
                : [],
        );
    } catch {
        return new Set<string>();
    }
}

function parseSourceUri(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === 'string' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

const pendingResultSyncSources = new Set<string>();

/** Number of source-specific recovery requests waiting for host hydration. */
export function getResultSyncPendingRequestCount(): number {
    return pendingResultSyncSources.size;
}

function requestAuthoritativeResultSync(sourceUri: string | undefined, reason: string): void {
    if (!sourceUri || pendingResultSyncSources.has(sourceUri)) {
        return;
    }
    pendingResultSyncSources.add(sourceUri);
    postHostMessage({ command: 'requestResultSync', sourceUri, reason });
}

function clearPendingResultSyncSourcesNotInList(activeSources: readonly string[]): void {
    const allowed = new Set(activeSources);
    for (const sourceUri of pendingResultSyncSources) {
        if (!allowed.has(sourceUri)) {
            pendingResultSyncSources.delete(sourceUri);
        }
    }
}

function resetStreamingCompletionMarkers(resultSets: ResultSet[] = getResultSets()): void {
    for (const resultSet of resultSets) {
        if (resultSet && !resultSet.isLog && !resultSet.isError && !resultSet.isTextContent) {
            resultSet.isStreamingComplete = false;
        }
    }
}

function getTotalRowCount(resultSets: ResultSet[]): number {
    return resultSets.reduce((sum, resultSet) => {
        return sum + (
            typeof resultSet?.totalRowCount === 'number'
                ? resultSet.totalRowCount
                : (Array.isArray(resultSet?.data) ? resultSet.data.length : 0)
        );
    }, 0);
}

function areSameResultSetReferences(before: ResultSet[], after: ResultSet[]): boolean {
    if (before.length !== after.length) {
        return false;
    }
    for (let index = 0; index < before.length; index += 1) {
        if (before[index] !== after[index]) {
            return false;
        }
    }
    return true;
}

function hasRenderedGridsForResultSets(resultSets: ResultSet[]): boolean {
    if (resultSets.length === 0) {
        return false;
    }
    const container = document.getElementById('gridContainer');
    if (!container) {
        return false;
    }
    const wrappers = container.querySelectorAll('.grid-wrapper');
    if (wrappers.length !== resultSets.length) {
        return false;
    }
    const grids = getAllGrids();
    return grids.length === resultSets.length && grids.some((grid) => grid != null);
}

function shouldPreserveGridsOnActiveSourceRefresh(
    sourceUri: string,
    previousSourceUri: string | undefined,
    previousResultSets: ResultSet[],
): boolean {
    if (!previousSourceUri || sourceUri !== previousSourceUri) {
        return false;
    }
    const currentResultSets = getResultSets();
    if (!areSameResultSetReferences(previousResultSets, currentResultSets)) {
        return false;
    }
    return hasRenderedGridsForResultSets(currentResultSets);
}

function syncExecutionChrome(): void {
    updateLogsTabSpinner();
    updateLoadingState();
    updateExecutionStatusBanner();
    updateResultLimitBanner();
}

function acknowledgeCurrentLogRows(): void {
    const sourceUri = getActiveSourceUri();
    const logResultSet = getResultSets().find(resultSet => resultSet?.isLog);
    if (!sourceUri || !logResultSet) {
        return;
    }
    postHostMessage({
        command: 'logRowsApplied',
        sourceUri,
        executionTimestamp: logResultSet.executionTimestamp ?? 0,
        totalRows: logResultSet.data.length,
    });
}

export function inferExecutionState(): ResultPanelExecutionState {
    const resultSets = getActiveResultSets();
    const activeSource = getActiveSourceUri();
    const panel = getResultPanelWindow();
    const executingSources = panel.executingSources;
    if (executingSources && activeSource && executingSources.has(activeSource)) {
        const latestTabularResult = [...resultSets]
            .reverse()
            .find(resultSet => resultSet && !resultSet.isLog && !resultSet.isError && !resultSet.isTextContent);
        const streamingCompleted = panel.streamingCompletedSources instanceof Set
            ? panel.streamingCompletedSources.has(activeSource)
            : latestTabularResult?.isStreamingComplete === true;
        if (streamingCompleted) {
            return 'finalizing';
        }
        return 'loading';
    }

    const nonLogResultSets = resultSets.filter(resultSet => resultSet && !resultSet.isLog);
    if (nonLogResultSets.some(resultSet => resultSet.isError)) {
        return 'error';
    }
    if (nonLogResultSets.some(resultSet => resultSet.isCancelled)) {
        return 'cancelled';
    }

    const logResultSet = resultSets.find(resultSet => resultSet?.isLog && Array.isArray(resultSet.data));
    if (logResultSet) {
        for (let index = logResultSet.data.length - 1; index >= 0; index -= 1) {
            const row = logResultSet.data[index];
            const message = Array.isArray(row) ? String(row[1] || '') : '';
            if (!message) {
                continue;
            }
            if (/^\s*↻\s+RETRYING:/.test(message)) {
                return 'retrying';
            }
            if (/^\s*✗\s+ERROR:/.test(message)) {
                return 'error';
            }
            if (/^\s*⊘\s+CANCELLED:/.test(message)) {
                return 'cancelled';
            }
            if (/^\s*✓\s+SUCCESS:/.test(message)) {
                return 'success';
            }
            if (/^\s*▶\s+RUNNING:/.test(message)) {
                return 'loading';
            }
        }
    }

    return nonLogResultSets.length > 0 ? 'success' : 'idle';
}

export function cancelActiveQuery(): void {
    // During finalization all rows have already been delivered. `data.length`
    // may only contain the visible preview for disk-backed/capped results, so
    // passing it to the host would truncate the authoritative result.
    const currentRowCounts = inferExecutionState() === 'finalizing'
        ? undefined
        : getResultSets().map((rs) => (Array.isArray(rs?.data) ? rs.data.length : 0));

    const executingSources = Array.from(ensureExecutingSources());

    if (executingSources.length > 0) {
        executingSources.forEach((sourceUri) => {
            postHostMessage({
                command: 'cancelQuery',
                sourceUri,
                currentRowCounts
            });
            handleCancelExecution({ sourceUri });
        });
        return;
    }

    if (getActiveSourceUri()) {
        postHostMessage({
            command: 'cancelQuery',
            sourceUri: requireActiveSourceUri(),
            currentRowCounts
        });
        handleCancelExecution({ sourceUri: requireActiveSourceUri() });
    }
}

export function updateExecutionStatusBanner(): void {
    const banner = document.getElementById('executionStatusBanner');
    const textEl = document.getElementById('executionStatusBannerText');
    const cancelBtn = document.getElementById('executionStatusBannerCancel');
    if (!banner || !textEl) {
        return;
    }

    const state = inferExecutionState();
    const resultSets = getActiveResultSets();
    const totalRowCount = getTotalRowCount(resultSets);
    const nonLogResultCount = resultSets.filter(resultSet => resultSet && !resultSet.isLog).length;
    const errorResultCount = resultSets.filter(resultSet => resultSet && resultSet.isError).length;
    const sourceLabel = formatActiveSourceLabel(getActiveSourceUri());

    banner.className = 'execution-status-banner';

    if (!getActiveSourceUri() || state === 'idle' || state === 'success') {
        resetRunningUiDelay();
        banner.style.display = 'none';
        textEl.textContent = '';
        if (cancelBtn) {
            cancelBtn.style.display = 'none';
        }
        banner.title = '';
        updateLogsTabSpinner();
        return;
    }

    if (state === 'loading' || state === 'retrying') {
        const sourceUri = getActiveSourceUri();
        if (sourceUri) {
            markRunningUiPending(sourceUri);
            if (shouldDeferRunningUi()) {
                scheduleRunningUiRefresh();
                banner.style.display = 'none';
                textEl.textContent = '';
                if (cancelBtn) {
                    cancelBtn.style.display = 'none';
                }
                banner.title = '';
                updateLogsTabSpinner();
                return;
            }
        }
    } else {
        resetRunningUiDelay();
    }

    const messages: Record<ResultPanelExecutionState, string> = {
        loading: `${sourceLabel}: running...`,
        finalizing: `${sourceLabel}: ${totalRowCount.toLocaleString()} rows received; finalizing database session...`,
        retrying: `${sourceLabel}: retrying after a connection interruption...`,
        cancelled: totalRowCount > 0
            ? `${sourceLabel}: cancelled. Partial results retained: ${totalRowCount.toLocaleString()} rows in ${nonLogResultCount} result set(s).`
            : `${sourceLabel}: cancelled. No tabular rows were retained.`,
        error: totalRowCount > 0
            ? `${sourceLabel}: completed with errors. Partial results remain available: ${totalRowCount.toLocaleString()} rows in ${nonLogResultCount} result set(s).`
            : `${sourceLabel}: failed. Review the error result or execution logs for details.`,
        success: totalRowCount > 0
            ? `${sourceLabel}: ${totalRowCount.toLocaleString()} rows ready in ${nonLogResultCount} result set(s).`
            : `${sourceLabel}: no rows returned.`,
        idle: ''
    };

    const message = messages[state] || '';
    if (!message) {
        banner.style.display = 'none';
        textEl.textContent = '';
        if (cancelBtn) {
            cancelBtn.style.display = 'none';
        }
        updateLogsTabSpinner();
        return;
    }

    textEl.textContent = message;
    if (cancelBtn) {
        cancelBtn.style.display = (state === 'loading' || state === 'retrying') ? '' : 'none';
    }

    banner.style.display = 'flex';
    banner.classList.add('visible', `state-${state}`);
    if (state === 'error' && errorResultCount > 0) {
        banner.title = `${errorResultCount} error result set(s) available for review.`;
    } else if (state === 'cancelled' && totalRowCount > 0) {
        banner.title = 'Partial rows are still available in the grid and export actions.';
    } else {
        banner.title = message;
    }

    updateLogsTabSpinner();
}

function reportHydrationMetrics(metrics: {
    durationMs: number;
    payloadBytes: number;
    activeSource: string | null;
    resultSetCount: number;
    totalRowCount: number;
}): void {
    if (!metrics) {
        return;
    }

    postHostMessage({
        command: 'reportHydrationMetrics',
        metrics: {
            durationMs: metrics.durationMs,
            payloadBytes: metrics.payloadBytes,
            activeSource: metrics.activeSource,
            resultSetCount: metrics.resultSetCount,
            totalRowCount: metrics.totalRowCount,
            executionState: inferExecutionState()
        }
    });
}

// Setup message handler for streaming updates
export function setupStreamingMessageHandler(): void {
    getResultPanelWindow().__getResultSyncPendingRequestCount = getResultSyncPendingRequestCount;
    window.addEventListener('message', event => {
        const message = asHostMessage(event.data);

        switch (message.command) {
            case 'testBridge':
                void handleResultPanelTestBridgeMessage(message as {
                    requestId: string;
                    action: string;
                    args?: unknown;
                });
                break;
            case 'cancelExecution':
                handleCancelExecution(message);
                break;
            case 'appendRows':
                handleAppendRows(message);
                break;
            case 'streamingComplete':
                handleStreamingComplete(message);
                break;
            case 'diskBackedActivate':
                clearAllDiskGrouping();
                handleDiskBackedActivate(message);
                break;
            case 'rowCountUpdate':
                handleRowCountUpdate(message);
                break;
            case 'rowWindow':
                handleRowWindow(message);
                break;
            case 'diskQueryResult':
                handleDiskQueryResult(message);
                break;
            case 'databaseAggregationResult':
                handleDatabaseAggregationResult(message as {
                    requestId: number;
                    aggregations?: import('./types.js').DiskAggregationResult[];
                    error?: string;
                });
                break;
            case 'databaseFilterValuesResult':
                handleDatabaseFilterValuesResult(message as {
                    requestId: number;
                    sourceUri?: string;
                    resultSetIndex?: number;
                    columnIndex?: number;
                    values?: import('./types.js').DiskDistinctValue[];
                    truncated?: boolean;
                    error?: string;
                });
                break;
            case 'databaseFilterApplyResult':
                handleDatabaseFilterApplyResult(message as {
                    requestId: number;
                    sourceUri?: string;
                    resultSetIndex?: number;
                    error?: string;
                });
                break;
            case 'databaseGroupingResult':
                handleDatabaseGroupingResult(message as {
                    requestId: number;
                    sourceUri?: string;
                    resultSetIndex?: number;
                    columns?: import('./types.js').ResultSetColumn[];
                    rows?: unknown[][];
                    totalRows?: number;
                    truncated?: boolean;
                    sql?: string;
                    error?: string;
                });
                break;

            case 'databaseGroupingPreviewResult':
                handleDatabaseGroupingPreviewResult(message as {
                    requestId: number;
                    sql?: string;
                    error?: string;
                });
                break;
            case 'exploreFullStatsResult':
            case 'explorePivotResult':
            case 'explorePivotPreviewResult':
            case 'exploreComposerResult':
            case 'exploreComposerPreviewResult':
            case 'exploreFilteredSqlPreviewResult':
                handleExploreHostMessage(message as {
                    command: string;
                    requestId?: number;
                    error?: string;
                });
                break;
            case 'switchToResultSet':
                if (typeof message.resultSetIndex === 'number') {
                    switchToResultSet(message.resultSetIndex);
                }
                break;
    case 'copySelection':
      callPanelMethod('copySelection', true, message.copyFormat || 'markdown');
      break;
    case 'updateCopyFormat':
      if (typeof message.copyFormat === 'string') {
        getResultPanelWindow().defaultCopyFormat = message.copyFormat;
      }
      break;
    case 'selectAll':
      {
        const activeWrapper = asHtml(document.querySelector('.grid-wrapper.active'));
        if (activeWrapper) {
          activeWrapper.focus();
        }
        callPanelMethod('selectAll');
      }
      break;
            case 'hydrate':
                handleHydrate(message.data as HydrateData, typeof message.uxTraceId === 'string' ? message.uxTraceId : undefined);
                break;
            case 'refreshView':
                handleRefreshView();
                break;
            case 'saveEdits':
                break;
            case 'setActiveSource':
                handleSetActiveSource(message);
                break;
            case 'uxPerfSession':
                setUxPerfSessionActive(message.active === true);
                break;
            case 'saveScrollState':
                handleSaveScrollState();
                break;
            case 'resultFormattingState':
                handleResultFormattingState(message.data);
                break;
        }
    });
}

export function handleRefreshView(): void {
    renderGrids();
    updateLoadingState();
    updateExecutionStatusBanner();
    updateResultLimitBanner();

    applyScrollForResultSet(getActiveGridIndex(), {
        sourceUri: getActiveSourceUri(),
        autoBottomLogs: true,
        verifyAfterFrame: true,
    });
}

export function handleResultFormattingState(data: unknown): void {
    if (!data) {
        return;
    }

    setResultFormattingPayload(data as ReturnType<typeof getResultFormattingPayload>);
    renderGrids();
    updateLoadingState();
}

export function handleSaveScrollState(): void {
    const activeSource = getActiveSourceUri();
    const resultSets = getResultSets();
    if (activeSource && resultSets.length > 0) {
        resultSets.forEach((rs, rsIndex) => {
            if (rs && rs.executionTimestamp) {
                const wrapper = getGridWrapperForResultSet(rsIndex);
                const htmlWrapper = asHtml(wrapper);
                const isVisible = htmlWrapper && htmlWrapper.style.display !== 'none';

                let scrollTop = 0;
                let scrollLeft = 0;
                if (isVisible) {
                    const scrollTarget = getScrollTarget(wrapper);
                    if (scrollTarget) {
                        scrollTop = scrollTarget.scrollTop || 0;
                        scrollLeft = scrollTarget.scrollLeft || 0;
                    }
                } else {
                    const cachedScroll = asScrollState(getScrollStateFromGlobalCache(activeSource, rsIndex));
                    if (cachedScroll) {
                        scrollTop = cachedScroll.scrollTop || 0;
                        scrollLeft = cachedScroll.scrollLeft || 0;
                    }
                }

                saveScrollStateToCache(activeSource, rsIndex, {
                    scrollTop: scrollTop,
                    scrollLeft: scrollLeft,
                    timestamp: rs.executionTimestamp
                });
            }
        });
        saveAllGridStates();
    }
}

export function handleSetActiveSource(message: Record<string, unknown>): void {
    const sourceUri = message.sourceUri as string;
    const uxTraceId = typeof message.uxTraceId === 'string' ? message.uxTraceId : undefined;
    const sourceMark = uxTraceId
        ? new UxPerfMark('result_panel.source_switch', uxTraceId)
        : undefined;
    sourceMark?.phase('webview_set_active', { sourceUri }, { uri: sourceUri });

    const activeSource = getActiveSourceUri();
    const resultSets = getResultSets();
    const previousGridIndex = getActiveGridIndex();

    // Do not let a request for a source involved in a switch suppress a later
    // retry. The host normally follows this message with hydrate; if that
    // delivery races, the next append can request recovery again.
    if (activeSource !== sourceUri) {
        if (activeSource) {
            pendingResultSyncSources.delete(activeSource);
        }
        pendingResultSyncSources.delete(sourceUri);
    }

    if (activeSource && resultSets.length > 0) {
        resultSets.forEach((rs, rsIndex) => {
            if (rs && rs.executionTimestamp) {
                const wrapper = getGridWrapperForResultSet(rsIndex);
                const htmlWrapper = asHtml(wrapper);
                const isVisible = htmlWrapper && htmlWrapper.style.display !== 'none';

                let scrollTop = 0;
                let scrollLeft = 0;

                if (isVisible) {
                    const scrollTarget = getScrollTarget(wrapper);
                    if (scrollTarget) {
                        scrollTop = scrollTarget.scrollTop || 0;
                        scrollLeft = scrollTarget.scrollLeft || 0;
                    }
                } else if (activeSource) {
                    const cachedScroll = asScrollState(getScrollStateFromGlobalCache(activeSource, rsIndex));
                    if (cachedScroll) {
                        scrollTop = cachedScroll.scrollTop || 0;
                        scrollLeft = cachedScroll.scrollLeft || 0;
                    }
                }

                saveScrollStateToCache(activeSource, rsIndex, {
                    scrollTop,
                    scrollLeft,
                    timestamp: rs.executionTimestamp
                });
            }
        });
        saveCurrentSourceToCache(activeSource, resultSets, getActiveGridIndex());
    }

    setActiveSourceUri(sourceUri);

    const panel = getResultPanelWindow();
    if (typeof message.sourcesJson === 'string') {
        const sources = JSON.parse(message.sourcesJson) as string[];
        panel.sources = sources;
        clearPendingResultSyncSourcesNotInList(sources);
    }
    if (typeof message.pinnedSourcesJson === 'string') {
        panel.pinnedSources = new Set(JSON.parse(message.pinnedSourcesJson));
    }
    if (typeof message.executingSourcesJson === 'string') {
        panel.executingSources = new Set(JSON.parse(message.executingSourcesJson));
    }
    if (typeof message.streamingCompletedSourcesJson === 'string') {
        panel.streamingCompletedSources = parseSourceSet(message.streamingCompletedSourcesJson);
    }
    if (message.formatSettings) {
        setResultFormattingPayload(message.formatSettings as ReturnType<typeof getResultFormattingPayload>);
    }
    if (typeof message.diskBackedStreamCapEnabled === 'boolean') {
        panel.diskBackedStreamCapEnabled = message.diskBackedStreamCapEnabled;
    }

    const isExecutingSource = panel.executingSources?.has(sourceUri) ?? false;
    if (
        isExecutingSource
        && panel.streamingCompletedSources instanceof Set
        && !panel.streamingCompletedSources.has(sourceUri)
    ) {
        resetStreamingCompletionMarkers();
    }
    const cached = !isExecutingSource
        ? getCachedSource(sourceUri) as { resultSets?: ResultSet[]; activeGridIndex?: number } | undefined
        : undefined;
    if (cached) {
        sourceMark?.phase('cache_hit', {
            sourceUri,
            resultSetCount: cached.resultSets?.length ?? 0,
        }, { uri: sourceUri });
        const cachedResultSets = cached.resultSets ?? [];
        normalizeResultSetsEditability(cachedResultSets);
        setResultSets(cachedResultSets);
        if (typeof cached.activeGridIndex === 'number' && cached.activeGridIndex >= 0 &&
            cached.activeGridIndex < (cached.resultSets?.length || 0)) {
            setActiveGridIndex(cached.activeGridIndex);
        } else {
            setActiveGridIndex(0);
        }
    } else if (isExecutingSource) {
        // Result sets come from hydrate/appendRows — do not restore cache or strip tabs here.
        // (Stripping to logs-only hid manually pinned tabs during streaming.)
        sourceMark?.phase('cache_miss_executing', { sourceUri }, { uri: sourceUri });
    } else {
        sourceMark?.phase('cache_miss', { sourceUri }, { uri: sourceUri });
        setResultSets([]);
        setActiveGridIndex(0);
    }

    if (shouldPreserveGridsOnActiveSourceRefresh(sourceUri, activeSource, resultSets)) {
        if (typeof message.activeResultSetIndex === 'number') {
            setActiveGridIndex(message.activeResultSetIndex);
        }
        renderDocIndicator(getActiveSourceUri());
        syncExecutionChrome();
        getResultPanelWindow().refreshRowView?.();

        const activeRsIndex = getActiveGridIndex();
        if (activeRsIndex !== previousGridIndex) {
            switchToResultSet(activeRsIndex);
        } else {
            updateControlsVisibility(activeRsIndex);
            syncGlobalFilterInput(activeRsIndex);
        }
        syncAnalysisView();
        callPanelMethod('updateEditButtons');
        updateAllRefreshFailureBanners();
        if (sourceMark) {
            scheduleSourceSwitchEnd(
                sourceMark,
                { path: 'preserve_grids', sourceUri },
                { uri: sourceUri },
            );
        }
        return;
    }

    clearAllSearchWorkerData();
    clearDiskBackedPendingRequests();
    clearAllDiskGrouping();
    clearAllDatabaseFilterPending();
    clearAllDatabaseAggregationPending();
    resetEditSession();

    renderDocIndicator(getActiveSourceUri());
    renderResultSetTabs();
    renderGrids();
    sourceMark?.phase('grids_rendered', {
        sourceUri,
        resultSetCount: getResultSets().length,
        cacheHit: !!cached,
    }, { uri: sourceUri });
    updateLoadingState();
    updateExecutionStatusBanner();
    updateResultLimitBanner();
    getResultPanelWindow().refreshRowView?.();

    const activeRsIndex = getActiveGridIndex();
    applyScrollForResultSet(activeRsIndex, {
        sourceUri,
        autoBottomLogs: true,
        verifyAfterFrame: false,
    });
    switchToResultSet(activeRsIndex);
    syncAnalysisView();
    callPanelMethod('updateEditButtons');
    updateAllRefreshFailureBanners();
    if (sourceMark) {
        scheduleSourceSwitchEnd(
            sourceMark,
            {
                path: cached ? 'cache' : 'empty_or_wait_hydrate',
                sourceUri,
                resultSetCount: getResultSets().length,
            },
            { uri: sourceUri },
        );
    }
}

// Track last hydrate data fingerprint to skip duplicates.
// Extension host sometimes sends multiple hydrates in quick succession
// (e.g. visibility change + ready event), causing a visible flash.
let _lastHydrateKey = '';

function buildHydrateDedupKey(data: HydrateData): string {
    return (
        (data.activeSourceJson ?? '') + '|' +
        (data.activeResultSetIndex ?? '') + '|' +
        (data.resultSetsMsgPack instanceof Uint8Array ? data.resultSetsMsgPack.byteLength : 0) + '|' +
        (data.executingSourcesJson ?? '') + '|' +
        (data.streamingCompletedSourcesJson ?? '') + '|' +
        (data.dataVersion ?? '') + '|' +
        (data.resultSyncVersion ?? '')
    );
}

function migrateAggregationStateAcrossRefresh(
    previousSets: readonly ResultSet[],
    nextSets: readonly ResultSet[],
    sourceUri: string | null | undefined,
): void {
    if (!sourceUri) {
        return;
    }
    const count = Math.min(previousSets.length, nextSets.length);
    for (let index = 0; index < count; index += 1) {
        const previous = previousSets[index];
        const next = nextSets[index];
        if (!previous || !next || previous.isLog || next.isLog || previous.isError || next.isError) {
            continue;
        }
        if (previous.executionTimestamp === next.executionTimestamp) {
            continue;
        }
        const aggregations = getAggregationState(index, previous.executionTimestamp, sourceUri);
        if (aggregations && Object.keys(aggregations).length > 0) {
            setAggregationState(index, aggregations, next.executionTimestamp, sourceUri);
        }
    }
}

function releaseRowsForReplacedResults(previous: ResultSet[], next: ResultSet[]): void {
    if (previous.length === 0) {
        return;
    }
    const retained = new Set(next);
    for (const resultSet of previous) {
        if (!retained.has(resultSet)) {
            releaseResultSetRows(resultSet);
        }
    }
}

export function handleHydrate(data: HydrateData, uxTraceId?: string): void {
    configureResultPanelTrace(data.resultPanelTraceEnabled === true);
    traceResultPanel({
        phase: 'hydrate_received',
        sourceUri: parseSourceUri(data.activeSourceJson),
    });
    const newKey = buildHydrateDedupKey(data);
    if (newKey && newKey === _lastHydrateKey) {
        return;
    }
    _lastHydrateKey = newKey;

    const hydrateMark = uxTraceId
        ? new UxPerfMark('result_panel.source_switch', uxTraceId)
        : undefined;
    const hydrateStartedAt = performance.now();
    if (hydrateMark) {
        // Hydrate owns the trace from here — drop pending setActiveSource end.
        invalidateSourceSwitchEnd();
    }
    hydrateMark?.phase('hydrate_start', {
        payloadHint: data.resultSetsMsgPack instanceof Uint8Array
            ? data.resultSetsMsgPack.byteLength
            : 0,
    });

    clearAllSearchWorkerData();
    clearDiskBackedPendingRequests();
    clearAllDiskGrouping();
    // Do not clear database filter/aggregation pending here — apply/distinct responses
    // are posted before hydrate, and stale responses are rejected via request context.

    setPreserveScrollDuringHydrate(true);
    try {
        let payloadBytes = 0;
        const panel = getResultPanelWindow();
        const existingResultSets = getResultSets();
        const previousSource = getActiveSourceUri();
        let hydratedSource = previousSource;

        if (existingResultSets.length > 0) {
            saveAllGridStates();
        }

        if (data.activeSourceJson) {
            hydratedSource = JSON.parse(data.activeSourceJson) as string;
            if (previousSource && existingResultSets.length > 0) {
                saveCurrentSourceToCache(previousSource, existingResultSets, getActiveGridIndex());
            }
            setActiveSourceUri(hydratedSource);
        }

        if (data.sourcesJson) {
            const sources = JSON.parse(data.sourcesJson) as string[];
            panel.sources = sources;
            clearPendingResultSyncSourcesNotInList(sources);
            evictSourceCacheNotInList(sources);
        }
        if (data.pinnedSourcesJson) panel.pinnedSources = new Set(JSON.parse(data.pinnedSourcesJson));
        if (data.pinnedResultsJson) panel.pinnedResults = JSON.parse(data.pinnedResultsJson);

        if (typeof data.queryRowLimit === 'number') {
            panel.queryRowLimit = data.queryRowLimit;
        }
        if (typeof data.maxDataResults === 'number') {
            panel.maxDataResults = data.maxDataResults;
        }
        if (typeof data.diskBackedStreamCapEnabled === 'boolean') {
            panel.diskBackedStreamCapEnabled = data.diskBackedStreamCapEnabled;
        }

        if (data.resultSetsMsgPack) {
            try {
                const pack = data.resultSetsMsgPack;
                const buffer = pack instanceof Uint8Array
                    ? pack
                    : new Uint8Array(pack.data ?? []);
                payloadBytes = buffer.byteLength;
                const nextResultSets = decode(buffer) as ResultSet[];
                if (previousSource && previousSource === hydratedSource) {
                    releaseRowsForReplacedResults(existingResultSets, nextResultSets);
                    migrateAggregationStateAcrossRefresh(existingResultSets, nextResultSets, hydratedSource);
                }
                setResultSets(nextResultSets);
            } catch (e: unknown) {
                console.error('[resultPanel.js] Failed to decode MessagePack resultSets:', e);
                const message = e instanceof Error ? e.message : String(e);
                showError('Failed to decode data: ' + message);
            }
        } else if (data.resultSetsJson) {
            const nextResultSets = JSON.parse(data.resultSetsJson) as ResultSet[];
            if (previousSource && previousSource === hydratedSource) {
                releaseRowsForReplacedResults(existingResultSets, nextResultSets);
                migrateAggregationStateAcrossRefresh(existingResultSets, nextResultSets, hydratedSource);
            }
            setResultSets(nextResultSets);
        }

        const hydratedResultSets = getResultSets();
        const activeHydratedSource = getActiveSourceUri();
        if (activeHydratedSource) {
            pendingResultSyncSources.delete(activeHydratedSource);
        }
        traceResultPanel({
            phase: 'hydrate_applied',
            sourceUri: activeHydratedSource || undefined,
            resultSetCount: hydratedResultSets.length,
            rowCount: getTotalRowCount(hydratedResultSets),
        });
        for (const [resultSetIndex, resultSet] of hydratedResultSets.entries()) {
            const hydratedRows = typeof resultSet?.totalRowCount === 'number'
                ? resultSet.totalRowCount
                : (Array.isArray(resultSet?.data) ? resultSet.data.length : 0);
            traceResultPanel({
                phase: 'hydrate_result_set_applied',
                sourceUri: activeHydratedSource || undefined,
                resultSetIndex,
                rowCount: hydratedRows,
                totalRows: hydratedRows,
                isLog: resultSet?.isLog === true,
            });
        }
        if (activeHydratedSource && hydratedResultSets.length > 0) {
            saveCurrentSourceToCache(activeHydratedSource, hydratedResultSets, getActiveGridIndex());
            pruneSourceResultsCache(activeHydratedSource);
        }

        if (typeof data.activeResultSetIndex === 'number') setActiveGridIndex(data.activeResultSetIndex);
        if (data.executingSourcesJson) panel.executingSources = new Set(JSON.parse(data.executingSourcesJson));
        if (typeof data.streamingCompletedSourcesJson === 'string') {
            panel.streamingCompletedSources = parseSourceSet(data.streamingCompletedSourcesJson);
        }
        if (
            activeHydratedSource
            && panel.executingSources?.has(activeHydratedSource)
            && panel.streamingCompletedSources instanceof Set
            && !panel.streamingCompletedSources.has(activeHydratedSource)
        ) {
            resetStreamingCompletionMarkers(hydratedResultSets);
        }
        if (data.formatSettings) {
            setResultFormattingPayload(data.formatSettings as ReturnType<typeof getResultFormattingPayload>);
        }

        renderDocIndicator(getActiveSourceUri());
        renderResultSetTabs();
        renderGrids();
        traceResultPanel({
            phase: 'hydrate_rendered',
            sourceUri: getActiveSourceUri() || undefined,
            resultSetCount: hydratedResultSets.length,
        });
        hydrateMark?.phase('grids_rendered', {
            resultSetCount: hydratedResultSets.length,
            payloadBytes,
        }, { uri: getActiveSourceUri() || undefined });
        updateLoadingState();
        updateExecutionStatusBanner();
        updateResultLimitBanner();
        panel.refreshRowView?.();

        if (hydratedResultSets.length > 0) {
            if (getActiveGridIndex() >= hydratedResultSets.length) setActiveGridIndex(0);
            switchToResultSet(getActiveGridIndex(), true);
            syncAnalysisView();

            const activeSource = data.activeSourceJson
                ? JSON.parse(data.activeSourceJson) as string
                : getActiveSourceUri();

            applyScrollForResultSet(getActiveGridIndex(), {
                sourceUri: activeSource,
                autoBottomLogs: true,
                verifyAfterFrame: true,
            });

            const endToken = beginSourceSwitchEndSchedule();
            const endScheduledAt = performance.now();
            requestAnimationFrame(() => {
                reportHydrationMetrics({
                    durationMs: performance.now() - hydrateStartedAt,
                    payloadBytes,
                    activeSource: getActiveSourceUri() || null,
                    resultSetCount: hydratedResultSets.length,
                    totalRowCount: getTotalRowCount(hydratedResultSets)
                });

                if (hydrateMark) {
                    completeSourceSwitchEnd(
                        endToken,
                        hydrateMark,
                        {
                            path: 'hydrate',
                            payloadBytes,
                            resultSetCount: hydratedResultSets.length,
                            totalRowCount: getTotalRowCount(hydratedResultSets),
                        },
                        { uri: getActiveSourceUri() || undefined },
                        {
                            frameDelayMs: Math.round((performance.now() - endScheduledAt) * 10) / 10,
                        },
                    );
                }

                setPreserveScrollDuringHydrate(false);
            });
        } else if (hydrateMark) {
            scheduleSourceSwitchEnd(
                hydrateMark,
                {
                    path: 'hydrate_empty',
                    payloadBytes,
                    resultSetCount: 0,
                },
                { uri: getActiveSourceUri() || undefined },
            );
        }
        acknowledgeCurrentLogRows();
        resetEditSession();
        callPanelMethod('updateEditButtons');
    } catch (e: unknown) {
        console.error('[resultPanel.js] Error hydrating view:', e);
        const message = e instanceof Error ? e.message : String(e);
        showError('Hydration error: ' + message);
    }
}

export function handleCancelExecution(message: Record<string, unknown>): void {
    const sourceUri = message.sourceUri as string | undefined;
    const panel = getResultPanelWindow();
    if (sourceUri) {
        panel.executingSources?.delete(sourceUri);
        panel.streamingCompletedSources?.delete(sourceUri);
    }

    if (getActiveSourceUri() === sourceUri) {
        getResultSets().forEach(rs => {
            if (!rs) {
                return;
            }
            rs.isCancelled = true;
            if (rs.limitReached === undefined) rs.limitReached = true;
        });

        if (sourceUri) {
            resetStreamingCompletionMarkers();
        }

        updateLoadingState();
        updateExecutionStatusBanner();
    }
}

export function handleAppendRows(message: Record<string, unknown>): void {
    let resultSetIndex = message.resultSetIndex as number;
    let rows = message.rows as unknown[] | Uint8Array | { type?: string; data?: number[] };
    const totalRows = message.totalRows as number | undefined;
    const limitReached = message.limitReached as boolean | undefined;
    const isLog = message.isLog as boolean | undefined;
    const isFirstChunk = message.isFirstChunk === true;
    const sourceUri = message.sourceUri as string | undefined;
    const fromRow = message.fromRow as number | undefined;
    const logExecutionTimestamp = message.logExecutionTimestamp as number | undefined;

    traceResultPanel({
        phase: 'append_received',
        sourceUri,
        resultSetIndex,
        rowCount: Array.isArray(rows) ? rows.length : undefined,
        totalRows,
        isLog,
        isFirstChunk,
        isLastChunk: message.isLastChunk === true,
    });

    let rowBatch: unknown[][] = [];
    if (Array.isArray(rows)) {
        rowBatch = rows as unknown[][];
    }

    const activeSource = getActiveSourceUri();
    if (sourceUri && activeSource && sourceUri !== activeSource) {
        pendingResultSyncSources.delete(sourceUri);
        traceResultPanel({
            phase: 'append_ignored',
            sourceUri,
            resultSetIndex,
            reason: 'source-mismatch',
        });
        return;
    }

    if (isFirstChunk && !isLog) {
        const panel = getResultPanelWindow();
        const completionSource = sourceUri ?? activeSource;
        if (completionSource) {
            panel.streamingCompletedSources?.delete(completionSource);
        }
        resetStreamingCompletionMarkers();
        clearAllSearchWorkerData();
        clearAllDiskGrouping();
        resetEditSession();
    }

    if (rows instanceof Uint8Array || (rows && (rows as { type?: string }).type === 'Buffer') ||
        (rows && typeof rows === 'object' && (rows as { data?: number[] }).data instanceof Array)) {
        try {
            const rowData = rows as Uint8Array | { data?: number[] };
            const buffer = rowData instanceof Uint8Array ? rowData : new Uint8Array(rowData.data ?? []);
            rowBatch = decode(buffer) as unknown[][];
        } catch (e: unknown) {
            console.error('Failed to decode MessagePack rows:', e);
        }
    }

    const resultSets = getResultSets();
    const hasLogShell = resultSets.some(resultSet => resultSet?.isLog);
    if (!hasLogShell) {
        const reason = isLog ? 'missing-log-shell' : 'missing-log-shell-before-data';
        requestAuthoritativeResultSync(sourceUri, reason);
        traceResultPanel({
            phase: 'append_ignored',
            sourceUri,
            resultSetIndex,
            reason,
        });
        return;
    }
    if (isLog && resultSets.length > 0) {
        const resolvedLogIndex = resultSets.findIndex(resultSet => resultSet?.isLog);
        if (resolvedLogIndex >= 0) {
            resultSetIndex = resolvedLogIndex;
        }
    }

    let createdShell = false;
    if (isFirstChunk && !isLog) {
        const columns = message.columns as ResultSet['columns'] | undefined;
        const sql = message.sql as string | undefined;
        const refreshSql = message.refreshSql as string | undefined;
        const executionTimestamp = message.executionTimestamp as number | undefined;
        if (columns && columns.length > 0 && executionTimestamp !== undefined) {
            const shell: ResultSet = {
                columns,
                data: [],
                isStreamingComplete: false,
                sql: sql ?? '',
                refreshSql: refreshSql ?? sql ?? '',
                executionTimestamp,
                limitReached: limitReached === true,
                isEditable: message.isEditable === true,
                editSource: message.editSource as ResultSet['editSource'],
            };
            const nextResultSets = [...resultSets];
            if (resultSetIndex > nextResultSets.length) {
                console.warn(
                    '[resultPanel] resultSetIndex %s ahead of length %s; appending shell',
                    resultSetIndex,
                    nextResultSets.length,
                );
                nextResultSets.push(shell);
                resultSetIndex = nextResultSets.length - 1;
            } else if (resultSetIndex === nextResultSets.length) {
                nextResultSets.push(shell);
            } else {
                releaseResultSetRows(nextResultSets[resultSetIndex]);
                nextResultSets[resultSetIndex] = shell;
            }
            setResultSets(nextResultSets);
            setActiveGridIndex(resultSetIndex);
            createdShell = true;
        }
    }

    const rs = getResultSets()[resultSetIndex];
    if (rs) {
        if (rs.isCancelled) {
            traceResultPanel({
                phase: 'append_ignored',
                sourceUri,
                resultSetIndex,
                reason: 'result-cancelled',
            });
            return;
        }

        const rowBatchRows = rowBatch;

        if (isLog || rs.isLog) {
            const currentRows = rs.data.length;
            const currentExecutionTimestamp = rs.executionTimestamp ?? 0;
            const hasExecutionMismatch = typeof logExecutionTimestamp === 'number'
                && currentExecutionTimestamp !== logExecutionTimestamp;

            if (hasExecutionMismatch && fromRow !== 0) {
                if (sourceUri) {
                    postHostMessage({
                        command: 'requestLogSync',
                        sourceUri,
                        executionTimestamp: currentExecutionTimestamp,
                        currentRows,
                    });
                }
                return;
            }

            if (typeof fromRow === 'number' && !hasExecutionMismatch) {
                if (currentRows < fromRow) {
                    if (sourceUri) {
                        postHostMessage({
                            command: 'requestLogSync',
                            sourceUri,
                            executionTimestamp: currentExecutionTimestamp,
                            currentRows,
                        });
                    }
                    return;
                }
                if (currentRows >= (totalRows ?? 0)) {
                    if (sourceUri && typeof logExecutionTimestamp === 'number') {
                        postHostMessage({
                            command: 'logRowsApplied',
                            sourceUri,
                            executionTimestamp: logExecutionTimestamp,
                            totalRows: currentRows,
                        });
                    }
                    return;
                }
                if (currentRows !== fromRow) {
                    if (sourceUri) {
                        postHostMessage({
                            command: 'requestLogSync',
                            sourceUri,
                            executionTimestamp: currentExecutionTimestamp,
                            currentRows,
                        });
                    }
                    return;
                }
            }

            if (hasExecutionMismatch) {
                rs.data = [...rowBatchRows];
                rs.executionTimestamp = logExecutionTimestamp;
                replaceLogRows(resultSetIndex, rowBatchRows as LogRow[]);
            } else {
                rs.data.push(...rowBatchRows);
                appendLogRows(resultSetIndex, rowBatchRows as LogRow[]);
            }
            applyRowLimitReachedFlag(rs, limitReached === true);
            updateExecutionStatusBanner();
            updateLoadingState();
            if (sourceUri && typeof logExecutionTimestamp === 'number') {
                postHostMessage({
                    command: 'logRowsApplied',
                    sourceUri,
                    executionTimestamp: logExecutionTimestamp,
                    totalRows: rs.data.length,
                });
            }
            traceResultPanel({
                phase: 'append_applied',
                sourceUri,
                resultSetIndex,
                rowCount: rowBatchRows.length,
                totalRows: rs.data.length,
                isLog: true,
            });
            return;
        }

        if (isDiskBackedResultSet(rs)) {
            applyRowLimitReachedFlag(rs, limitReached === true);
            if (typeof totalRows === 'number') {
                syncDiskStreamingRowCount(rs, totalRows);
                updateRowCountInfo(resultSetIndex, totalRows, limitReached === true);
            }
            updateLoadingState();
            return;
        }

        const previewCapReached = rs.data.length >= DISK_BACKED_STREAMING_PREVIEW_ROWS;
        const streamCapActive = resolveDiskBackedStreamCapEnabled(message)
            && typeof totalRows === 'number'
            && totalRows > DISK_BACKED_WEBVIEW_STREAM_CAP
            && rs.storageMode !== 'sqlite';

        if (streamCapActive && previewCapReached) {
            rs.totalRowCount = totalRows;
            applyRowLimitReachedFlag(rs, limitReached === true);
            updateRowCountInfo(resultSetIndex, totalRows, limitReached === true);
            updateLoadingState();
            updateExecutionStatusBanner();
            updateResultLimitBanner();
            traceResultPanel({
                phase: 'append_applied',
                sourceUri,
                resultSetIndex,
                rowCount: 0,
                totalRows,
                reason: 'stream-cap',
            });
            return;
        }

        let rowsToAppend = rowBatchRows;
        if (streamCapActive && rowBatchRows.length > 0) {
            const remainingPreview = DISK_BACKED_STREAMING_PREVIEW_ROWS - rs.data.length;
            rowsToAppend = remainingPreview > 0
                ? rowBatchRows.slice(0, remainingPreview)
                : [];
        }

        if (rowsToAppend.length > 0) {
            rs.data = [...rs.data, ...rowsToAppend];
        }
        applyRowLimitReachedFlag(rs, limitReached === true);
        if (typeof totalRows === 'number') {
            rs.totalRowCount = totalRows;
        }

        if (createdShell) {
            renderDocIndicator(getActiveSourceUri());
            renderResultSetTabs();
            renderGrids();
            callPanelMethod('updateEditButtons');
        }

        const grid = getGrid(resultSetIndex);

        if (grid?.tanTable) {
            if (!grid.tanTable.options) {
                grid.tanTable.options = {};
            }
            grid.tanTable.options.data = rs.data;

            const didLayoutChange = grid.refreshAutoSizedLayout?.() ?? false;
            if (didLayoutChange && grid.render) {
                grid.render();
            } else {
                grid.createVirtualizer?.();
                grid.renderTableRows?.();
            }
        }

        updateRowCountInfo(resultSetIndex, totalRows ?? rs.data.length, limitReached === true);
        updateLoadingState();
        updateExecutionStatusBanner();
        updateResultLimitBanner();
        persistActiveSourceResultCache();
        traceResultPanel({
            phase: 'append_applied',
            sourceUri,
            resultSetIndex,
            rowCount: rowsToAppend.length,
            totalRows: typeof totalRows === 'number' ? totalRows : rs.data.length,
            isFirstChunk,
            isLastChunk: message.isLastChunk === true,
        });
    }
    else {
        requestAuthoritativeResultSync(sourceUri, 'result-set-missing');
        traceResultPanel({
            phase: 'append_ignored',
            sourceUri,
            resultSetIndex,
            reason: 'result-set-missing',
        });
    }
}

export function handleStreamingComplete(message: Record<string, unknown>): void {
    const resultSetIndex = message.resultSetIndex as number;
    const totalRows = message.totalRows as number | undefined;
    const limitReached = message.limitReached as boolean | undefined;
    const sourceUri = message.sourceUri as string | undefined;

    traceResultPanel({
        phase: 'streaming_complete_received',
        sourceUri,
        resultSetIndex,
        totalRows,
    });

    if (sourceUri) {
        const panel = getResultPanelWindow();
        if (!panel.streamingCompletedSources) {
            panel.streamingCompletedSources = new Set<string>();
        }
        panel.streamingCompletedSources.add(sourceUri);
    }

    const activeSource = getActiveSourceUri();
    if (sourceUri && activeSource && sourceUri !== activeSource) {
        pendingResultSyncSources.delete(sourceUri);
        traceResultPanel({
            phase: 'streaming_complete_ignored',
            sourceUri,
            resultSetIndex,
            reason: 'source-mismatch',
        });
        return;
    }

    const rs = getResultSetAt(resultSetIndex);
    if (!rs) {
        requestAuthoritativeResultSync(sourceUri, 'streaming-complete-result-set-missing');
        traceResultPanel({
            phase: 'streaming_complete_ignored',
            sourceUri,
            resultSetIndex,
            reason: 'result-set-missing',
        });
        return;
    }
    rs.isStreamingComplete = true;
    applyRowLimitReachedFlag(rs, limitReached === true);
    if (typeof totalRows === 'number') {
        if (isDiskBackedResultSet(rs)) {
            syncDiskStreamingRowCount(rs, totalRows);
        } else {
            rs.totalRowCount = totalRows;
        }
    }

    updateRowCountInfo(resultSetIndex, totalRows ?? rs?.totalRowCount ?? rs?.data.length ?? 0, limitReached === true);
    renderRowCountInfo(resultSetIndex);

    updateExecutionStatusBanner();
    updateResultLimitBanner();
    persistActiveSourceResultCache();
    callPanelMethod('updateEditButtons');
    traceResultPanel({
        phase: 'streaming_complete_applied',
        sourceUri,
        resultSetIndex,
        totalRows: typeof totalRows === 'number' ? totalRows : rs?.data.length,
    });
}
