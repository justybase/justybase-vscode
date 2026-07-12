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
import { renderGrids, updateLoadingState, appendLogRows, updateControlsVisibility, syncGlobalFilterInput } from './grid.js';
import { updateRowCountInfo, applyRowLimitReachedFlag, renderRowCountInfo } from './filter.js';
import { syncDiskStreamingRowCount } from './diskQuerySpec.js';
import { syncAnalysisView } from './analysis.js';
import { updateResultLimitBanner } from './banners.js';
import { handleDatabaseAggregationResult, clearAllDatabaseAggregationPending } from './databaseAggregations.js';
import { handleDatabaseGroupingResult, handleDatabaseGroupingPreviewResult } from './databaseGrouping.js';
import { handleDatabaseFilterValuesResult, handleDatabaseFilterApplyResult, clearAllDatabaseFilterPending } from './databaseFilters.js';
import { updateAllRefreshFailureBanners } from './refreshFailureBanner.js';
import {
    markRunningUiPending,
    resetRunningUiDelay,
    scheduleRunningUiRefresh,
    shouldDeferRunningUi,
} from './runningUiDelay.js';
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
    queryRowLimit?: number;
    maxDataResults?: number;
    diskBackedStreamCapEnabled?: boolean;
    resultSetsMsgPack?: Uint8Array | { data?: number[]; byteLength?: number };
    resultSetsJson?: string;
    formatSettings?: unknown;
    dataVersion?: number;
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

function getTotalRowCount(resultSets: ResultSet[]): number {
    return resultSets.reduce((sum, resultSet) => {
        if (resultSet?.storageMode === 'sqlite') {
            return sum + (resultSet.totalRowCount ?? resultSet.data.length);
        }
        return sum + (Array.isArray(resultSet?.data) ? resultSet.data.length : 0);
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

export function inferExecutionState(): ResultPanelExecutionState {
    const resultSets = getActiveResultSets();
    const activeSource = getActiveSourceUri();
    const executingSources = getResultPanelWindow().executingSources;
    if (executingSources && activeSource && executingSources.has(activeSource)) {
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
    const currentRowCounts = getResultSets()
        .map((rs) => (Array.isArray(rs?.data) ? rs.data.length : 0));

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
    window.addEventListener('message', event => {
        const message = asHostMessage(event.data);

        switch (message.command) {
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
                handleHydrate(message.data as HydrateData);
                break;
            case 'refreshView':
                handleRefreshView();
                break;
            case 'saveEdits':
                break;
            case 'setActiveSource':
                handleSetActiveSource(message);
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
    const activeSource = getActiveSourceUri();
    const resultSets = getResultSets();
    const previousGridIndex = getActiveGridIndex();

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
    if (typeof message.sourcesJson === 'string') panel.sources = JSON.parse(message.sourcesJson);
    if (typeof message.pinnedSourcesJson === 'string') {
        panel.pinnedSources = new Set(JSON.parse(message.pinnedSourcesJson));
    }
    if (typeof message.executingSourcesJson === 'string') {
        panel.executingSources = new Set(JSON.parse(message.executingSourcesJson));
    }
    if (message.formatSettings) {
        setResultFormattingPayload(message.formatSettings as ReturnType<typeof getResultFormattingPayload>);
    }
    if (typeof message.diskBackedStreamCapEnabled === 'boolean') {
        panel.diskBackedStreamCapEnabled = message.diskBackedStreamCapEnabled;
    }

    const isExecutingSource = panel.executingSources?.has(sourceUri) ?? false;
    const cached = !isExecutingSource
        ? getCachedSource(sourceUri) as { resultSets?: ResultSet[]; activeGridIndex?: number } | undefined
        : undefined;
    if (cached) {
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
    } else {
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
        (data.dataVersion ?? '')
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

export function handleHydrate(data: HydrateData): void {
    const newKey = buildHydrateDedupKey(data);
    if (newKey && newKey === _lastHydrateKey) {
        return;
    }
    _lastHydrateKey = newKey;

    clearAllSearchWorkerData();
    clearDiskBackedPendingRequests();
    clearAllDiskGrouping();
    // Do not clear database filter/aggregation pending here — apply/distinct responses
    // are posted before hydrate, and stale responses are rejected via request context.

    setPreserveScrollDuringHydrate(true);
    try {
        const hydrateStartedAt = performance.now();
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
        if (activeHydratedSource && hydratedResultSets.length > 0) {
            saveCurrentSourceToCache(activeHydratedSource, hydratedResultSets, getActiveGridIndex());
            pruneSourceResultsCache(activeHydratedSource);
        }

        if (typeof data.activeResultSetIndex === 'number') setActiveGridIndex(data.activeResultSetIndex);
        if (data.executingSourcesJson) panel.executingSources = new Set(JSON.parse(data.executingSourcesJson));
        if (data.formatSettings) {
            setResultFormattingPayload(data.formatSettings as ReturnType<typeof getResultFormattingPayload>);
        }

        renderDocIndicator(getActiveSourceUri());
        renderResultSetTabs();
        renderGrids();
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

            requestAnimationFrame(() => {
                reportHydrationMetrics({
                    durationMs: performance.now() - hydrateStartedAt,
                    payloadBytes,
                    activeSource: getActiveSourceUri() || null,
                    resultSetCount: hydratedResultSets.length,
                    totalRowCount: getTotalRowCount(hydratedResultSets)
                });

                setPreserveScrollDuringHydrate(false);
            });
        }
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
    if (getActiveSourceUri() === sourceUri) {
        getResultSets().forEach(rs => {
            if (!rs) {
                return;
            }
            rs.isCancelled = true;
            if (rs.limitReached === undefined) rs.limitReached = true;
        });

        const executingSources = getResultPanelWindow().executingSources;
        if (sourceUri && executingSources?.has(sourceUri)) {
            executingSources.delete(sourceUri);
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

    let rowBatch: unknown[][] = [];
    if (Array.isArray(rows)) {
        rowBatch = rows as unknown[][];
    }

    const activeSource = getActiveSourceUri();
    if (sourceUri && activeSource && sourceUri !== activeSource) {
        return;
    }

    if (isFirstChunk && !isLog) {
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
            return;
        }

        const rowBatchRows = rowBatch;

        if (isLog || rs.isLog) {
            rs.data.push(...rowBatchRows);
            appendLogRows(resultSetIndex, rowBatchRows as LogRow[]);
            applyRowLimitReachedFlag(rs, limitReached === true);
            updateExecutionStatusBanner();
            updateLoadingState();
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
    }
}

export function handleStreamingComplete(message: Record<string, unknown>): void {
    const resultSetIndex = message.resultSetIndex as number;
    const totalRows = message.totalRows as number | undefined;
    const limitReached = message.limitReached as boolean | undefined;
    const sourceUri = message.sourceUri as string | undefined;

    const activeSource = getActiveSourceUri();
    if (sourceUri && activeSource && sourceUri !== activeSource) {
        return;
    }

    const rs = getResultSetAt(resultSetIndex);
    if (rs) {
        applyRowLimitReachedFlag(rs, limitReached === true);
        if (typeof totalRows === 'number') {
            if (isDiskBackedResultSet(rs)) {
                syncDiskStreamingRowCount(rs, totalRows);
            } else {
                rs.totalRowCount = totalRows;
            }
        }
    }

    updateRowCountInfo(resultSetIndex, totalRows ?? rs?.totalRowCount ?? rs?.data.length ?? 0, limitReached === true);
    renderRowCountInfo(resultSetIndex);

    updateExecutionStatusBanner();
    updateResultLimitBanner();
    persistActiveSourceResultCache();
    callPanelMethod('updateEditButtons');
}
