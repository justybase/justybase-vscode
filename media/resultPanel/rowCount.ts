import {
    getActiveGridIndex,
    getActiveSourceUri,
    getDiskFilteredCount,
    diskQuerySpecHasFilters,
    getGlobalFilterState,
    getGrid,
    getIsSearching,
    getResultPanelWindow,
    getSortedSearchMatchIndices,
    isActiveSourceExecuting,
} from './rowCountDependencies.js';
import type { ResultSet } from './types.js';

export function isResultSetRowLimitReached(rs: ResultSet | null | undefined): boolean {
    if (!rs || rs.isLog || rs.isError) {
        return false;
    }
    if (rs.limitReached === true) {
        return true;
    }
    const configuredLimit = Number(getResultPanelWindow().queryRowLimit);
    if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
        return false;
    }
    return Array.isArray(rs.data) && rs.data.length >= configuredLimit;
}

export function applyRowLimitReachedFlag(rs: ResultSet | null | undefined, limitReached: boolean): void {
    if (!rs || rs.isLog || rs.isError) {
        return;
    }
    if (limitReached === true) {
        rs.limitReached = true;
        return;
    }
    if (rs.limitReached !== true && isResultSetRowLimitReached(rs)) {
        rs.limitReached = true;
    }
}

function appendRowLimitWarning(container: HTMLElement): void {
    const limit = Number(getResultPanelWindow().queryRowLimit) || 200000;
    const warning = document.createElement('span');
    warning.className = 'row-limit-warning';
    warning.title =
        `Query row limit of ${limit.toLocaleString()} rows was reached. ` +
        'Increase "justybase.query.rowLimit" in settings to fetch more.';
    warning.textContent = ' — limit reached';
    container.appendChild(warning);
}

export function renderRowCountInfo(resultSetIndex: number = getActiveGridIndex()): void {
    const rowCountInfo = document.getElementById('rowCountInfo');
    if (!rowCountInfo || resultSetIndex !== getActiveGridIndex()) {
        return;
    }

    const panelWindow = getResultPanelWindow();
    const rs = panelWindow.resultSets ? panelWindow.resultSets[resultSetIndex] : null;
    if (!rs || rs.isLog || rs.isError || rs.isTextContent) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        return;
    }

    applyRowLimitReachedFlag(rs, rs.limitReached === true);

    if (getIsSearching()) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        const label = document.createElement('span');
        label.className = 'global-filter-searching-label';
        label.textContent = 'Searching…';
        rowCountInfo.appendChild(label);
        return;
    }

    const isDiskBacked = rs.storageMode === 'sqlite';
    const loadedRows = Array.isArray(rs.data) ? rs.data.length : 0;
    const totalRows = isDiskBacked
        ? (rs.totalRowCount ?? 0)
        : (typeof rs.totalRowCount === 'number' ? rs.totalRowCount : loadedRows);
    const activeSource = getActiveSourceUri();
    const streamingCompletionKnown = getResultPanelWindow().streamingCompletedSources instanceof Set;
    const streamingComplete = streamingCompletionKnown
        ? getResultPanelWindow().streamingCompletedSources?.has(activeSource ?? '') === true
        : rs.isStreamingComplete === true;
    const activeStreaming = isActiveSourceExecuting() && !streamingComplete;
    const isStreamingPreview = !isDiskBacked
        && typeof rs.totalRowCount === 'number'
        && rs.totalRowCount > loadedRows
        && (activeStreaming || loadedRows < totalRows);

    const globalFilter = getGlobalFilterState(
        resultSetIndex,
        rs.executionTimestamp,
        getActiveSourceUri(),
    );
    const hasActiveGlobalFilter = Boolean(globalFilter && globalFilter.trim() !== '');

    if (isDiskBacked) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        const filteredCount = getDiskFilteredCount(rs);
        const hasFilters = diskQuerySpecHasFilters(rs.diskQuerySpec) || hasActiveGlobalFilter;
        let text: string;
        if (hasFilters && filteredCount !== totalRows) {
            text = `${filteredCount.toLocaleString()} row${filteredCount !== 1 ? 's' : ''} of ${totalRows.toLocaleString()}`;
        } else {
            text = `${filteredCount.toLocaleString()} row${filteredCount !== 1 ? 's' : ''}`;
        }
        if (activeStreaming) {
            text += ' (streaming…)';
        }
        rowCountInfo.appendChild(document.createTextNode(text));
        if (isResultSetRowLimitReached(rs)) {
            appendRowLimitWarning(rowCountInfo);
        }
        return;
    }

    const sortedMatches = getSortedSearchMatchIndices(resultSetIndex);

    if (hasActiveGlobalFilter && sortedMatches !== undefined) {
        rowCountInfo.textContent = '';
        rowCountInfo.style.opacity = '';
        const matchCount = sortedMatches.length;
        const text = `${matchCount.toLocaleString()} row${matchCount !== 1 ? 's' : ''} of ${totalRows.toLocaleString()}`;
        rowCountInfo.appendChild(document.createTextNode(text));
        if (isResultSetRowLimitReached(rs)) {
            appendRowLimitWarning(rowCountInfo);
        }
        return;
    }

    const grid = getGrid(resultSetIndex);
    const filteredRows = !isStreamingPreview
        ? grid?.tanTable?.getFilteredRowModel?.().rows
        : undefined;
    const hasFilteredCount = Array.isArray(filteredRows);
    const visibleCount = isStreamingPreview
        ? loadedRows
        : (hasFilteredCount ? filteredRows.length : totalRows);

    rowCountInfo.textContent = '';
    rowCountInfo.style.opacity = '';

    let text = `${visibleCount.toLocaleString()} row${visibleCount !== 1 ? 's' : ''}`;
    if ((isStreamingPreview || (hasFilteredCount && visibleCount !== totalRows)) && totalRows > visibleCount) {
        text += ` of ${totalRows.toLocaleString()}`;
    }
    rowCountInfo.appendChild(document.createTextNode(text));

    if (isResultSetRowLimitReached(rs)) {
        appendRowLimitWarning(rowCountInfo);
    }
}

export function updateRowCountInfo(resultSetIndex: number, _totalRows: number, limitReached: boolean): void {
    const panelWindow = getResultPanelWindow();
    const rs = panelWindow.resultSets ? panelWindow.resultSets[resultSetIndex] : null;
    if (rs) {
        applyRowLimitReachedFlag(rs, limitReached === true);
    }
    renderRowCountInfo(resultSetIndex);
}
