// Tabs module - Tab rendering and management for result panel
import {
    getActiveGridIndex,
    setActiveGridIndex,
    getAllGrids,
    getGrid,
    resetEditSession,
} from './state.js';
import { applyScrollForResultSet, saveAllGridStates, getGridWrapperForResultSet } from './grid/persistence.js';
import { updateResultLimitBanner } from './banners.js';
import { updateRefreshFailureBanner } from './refreshFailureBanner.js';
import { updateControlsVisibility, syncGlobalFilterInput } from './grid.js';
import { renderRowCountInfo } from './filter.js';
import { clearLogs } from './export.js';
import { syncAnalysisView } from './analysis.js';
import { extractKeyNetezzaErrorInfo } from './grid/alternateViews.js';
import { postHostMessage } from './protocol.js';
import { getElementById, asHtml } from './dom.js';
import {
    getActiveSourceUri,
    getResultPanelWindow,
    getResultSets,
    getResultSetAt,
    isActiveSourceExecuting,
    requireActiveSourceUri,
    callPanelMethod,
    type ResultSet,
} from './types.js';

const vscode = { postMessage: postHostMessage };

export function renderDocIndicator(docUri: string | undefined): void {
    const indicator = getElementById('docIndicator');
    if (!indicator) return;

    if (!docUri) {
        indicator.textContent = '';
        return;
    }

    const parts = docUri.split(/[\\/]/);
    const filename = parts[parts.length - 1] || docUri;
    indicator.textContent = '\u25B8 ' + filename;
    indicator.title = docUri;
}

function isActiveSourceExecutingLocal(): boolean {
    return isActiveSourceExecuting();
}

function createLogsTabSpinner() {
    const spinner = document.createElement('span');
    spinner.className = 'result-set-tab__spinner is-hidden';
    spinner.setAttribute('aria-hidden', 'true');
    return spinner;
}

function setLogsTabSpinnerVisible(spinner: Element, visible: boolean): void {
    spinner.classList.toggle('is-hidden', !visible);
}

export function updateLogsTabSpinner() {
    const logIndex = getResultSets().findIndex(resultSet => resultSet?.isLog);
    if (logIndex < 0) {
        return;
    }

    const tabs = document.querySelectorAll('.result-set-tab');
    const logTab = tabs[logIndex];
    if (!logTab) {
        return;
    }

    const executing = isActiveSourceExecuting();
    const showSpinner = executing;

    let spinner = logTab.querySelector('.result-set-tab__spinner');
    if (!spinner) {
        spinner = createLogsTabSpinner();
        logTab.insertBefore(spinner, logTab.firstChild);
    }
    setLogsTabSpinnerVisible(spinner, showSpinner);
}

function createResultStatusBadge(rs: ResultSet | null | undefined): HTMLSpanElement | null {
    if (!rs || rs.isLog) {
        return null;
    }

    const badge = document.createElement('span');
    badge.className = 'result-set-status-badge';

    if (rs.isError) {
        badge.classList.add('state-error');
        badge.textContent = 'Error';
        badge.title = rs.message
            ? extractKeyNetezzaErrorInfo(rs.message)
            : 'This result set contains an execution error.';
        return badge;
    }

    if (rs.isCancelled) {
        badge.classList.add('state-cancelled');
        badge.textContent = 'Partial';
        badge.title = 'Execution was cancelled. Partial rows may still be available.';
        return badge;
    }

    if (Array.isArray(rs.data) && rs.data.length === 0) {
        badge.classList.add('state-empty');
        badge.textContent = 'Empty';
        badge.title = 'The query completed, but this result set contains no rows.';
        return badge;
    }

    return null;
}

export function renderResultSetTabs() {
    const container = document.getElementById('resultSetTabs');
    if (!container) return;

    container.innerHTML = '';

    if (getResultSets().length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';

    getResultSets().forEach((rs, index) => {
        if (!rs) {
            return;
        }
        const tab = createResultSetTab(rs, index);
        container.appendChild(tab);
    });
}

export function createResultSetTab(rs: ResultSet, index: number): HTMLDivElement {
    const tab = document.createElement('div');
    tab.className = 'result-set-tab' + (index === getActiveGridIndex() ? ' active' : '');

    if (rs.isLog) {
        const spinner = createLogsTabSpinner();
        setLogsTabSpinnerVisible(spinner, isActiveSourceExecuting());
        tab.appendChild(spinner);
    }

    // Tab Text
    const textSpan = document.createElement('span');
    const defaultLabel = rs.isLog ? 'Logs' : (rs.isTextContent ? 'MD Export' : `Result ${index}`);
    textSpan.textContent = rs.name || defaultLabel;
    if (rs.isLog) {
        textSpan.title = 'Execution details and status history';
    }
    if (rs.isTextContent) {
        textSpan.title = 'Combined Markdown export document';
    }
    tab.appendChild(textSpan);

    const statusBadge = createResultStatusBadge(rs);
    if (statusBadge) {
        tab.appendChild(statusBadge);
    }

    // Pin Button
    const pinSpan = document.createElement('span');
    pinSpan.className = 'pin-icon codicon codicon-pin';
    pinSpan.title = 'Pin this result';

    const isPinned = getResultPanelWindow().pinnedResults?.some(p =>
        p.sourceUri === getActiveSourceUri() && p.resultSetIndex === index
    ) ?? false;

    if (isPinned) {
        pinSpan.classList.add('pinned');
        pinSpan.title = 'Unpin this result';
    }
    pinSpan.textContent = '📌';

    pinSpan.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
            command: 'toggleResultPin',
            sourceUri: requireActiveSourceUri(),
            resultSetIndex: index
        });
    };
    tab.appendChild(pinSpan);

    // Close Button (x)
    const closeSpan = document.createElement('span');
    closeSpan.className = 'result-set-close-btn';
    closeSpan.textContent = '×';
    closeSpan.title = 'Close this result';
    closeSpan.style.marginLeft = '8px';
    closeSpan.style.cursor = 'pointer';
    closeSpan.style.opacity = '0.6';
    closeSpan.style.fontWeight = 'bold';
    closeSpan.style.fontSize = '16px';
    closeSpan.onmouseover = () => closeSpan.style.opacity = '1';
    closeSpan.onmouseout = () => closeSpan.style.opacity = '0.6';

    closeSpan.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
            command: 'closeResult',
            sourceUri: requireActiveSourceUri(),
            resultSetIndex: index
        });
    };
    tab.appendChild(closeSpan);

    // Context menu (right-click)
    tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e, index);
    });

    tab.onclick = () => switchToResultSet(index);
    return tab;
}

function showContextMenu(e: MouseEvent, index: number): void {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.position = 'fixed';
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';
    menu.style.backgroundColor = 'var(--vscode-menu-background)';
    menu.style.border = '1px solid var(--vscode-menu-border)';
    menu.style.borderRadius = '4px';
    menu.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
    menu.style.zIndex = '10000';
    menu.style.minWidth = '150px';

    const rs = getResultSets()[index];
    const canRefresh = Boolean(rs && !rs.isLog && !rs.isError && !rs.isTextContent && typeof rs.refreshSql === 'string' && rs.refreshSql.trim().length > 0);

    if (canRefresh) {
        const refreshItem = createMenuItem('Refresh This Result', () => {
            callPanelMethod('refreshResultAt', index);
        });
        menu.appendChild(refreshItem);
    }

    // Copilot AI Describe option
    const copilotItem = createMenuItem('✨ Describe data with Copilot AI', () => {
        if (rs) {
            vscode.postMessage({
                command: 'describeWithCopilot',
                data: rs.data,
                sql: rs.sql || ''
            });
        }
    });
    menu.appendChild(copilotItem);

    // Separator
    const separator = document.createElement('div');
    separator.style.height = '1px';
    separator.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
    separator.style.margin = '4px 0';
    menu.appendChild(separator);

    // Close Result option
    const closeResultItem = createMenuItem('Close This Result', () => {
        vscode.postMessage({
            command: 'closeResult',
            sourceUri: requireActiveSourceUri(),
            resultSetIndex: index
        });
    });
    menu.appendChild(closeResultItem);

    // Close All Results option
    const closeAllItem = createMenuItem('Close All Results', () => {
        vscode.postMessage({
            command: 'closeAllResults',
            sourceUri: getActiveSourceUri()
        });
    });
    menu.appendChild(closeAllItem);

    document.body.appendChild(menu);

    const closeMenu = () => {
        if (document.body.contains(menu)) {
            document.body.removeChild(menu);
        }
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('contextmenu', closeMenu);
    };

    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
}

function createMenuItem(text: string, onClick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'context-menu-item';
    item.textContent = text;
    item.style.padding = '8px 12px';
    item.style.cursor = 'pointer';
    item.style.color = 'var(--vscode-menu-foreground)';
    item.style.fontSize = '12px';
    item.style.userSelect = 'none';

    item.addEventListener('mouseover', () => {
        item.style.backgroundColor = 'var(--vscode-menu-selectionBackground)';
    });
    item.addEventListener('mouseout', () => {
        item.style.backgroundColor = 'transparent';
    });
    item.addEventListener('click', () => {
        onClick();
        const parent = item.parentElement;
        if (parent) {
            document.body.removeChild(parent);
        }
    });

    return item;
}

export function switchToResultSet(index: number, skipScrollRestore = false): void {
    if (index < 0 || index >= getAllGrids().length) return;

    // Save state of current grid before switching
    saveAllGridStates();

    setActiveGridIndex(index);
    resetEditSession();
    callPanelMethod('updateEditButtons');

    // Notify extension of manual tab switch
    vscode.postMessage({
        command: 'switchResultSet',
        sourceUri: requireActiveSourceUri(),
        resultSetIndex: index
    });

    updateControlsVisibility(index);
    syncGlobalFilterInput(index);

    // Update tab styling
    const tabs = document.querySelectorAll('.result-set-tab');
    tabs.forEach((tab, i) => {
        if (i === index) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    const source = getActiveSourceUri();
    const shouldRestoreScroll = !skipScrollRestore && !!getGrid(index)?.executionTimestamp;
    const targetWrapper = asHtml(getGridWrapperForResultSet(index));
    const maskScrollRestore = shouldRestoreScroll
        && !!targetWrapper
        && !getResultSetAt(index)?.isLog;

    if (maskScrollRestore) {
        targetWrapper.style.visibility = 'hidden';
    }

    // Show/hide grids
    const gridWrappers = document.querySelectorAll('.grid-wrapper');
    gridWrappers.forEach((wrapper, i) => {
        const htmlWrapper = asHtml(wrapper);
        if (!htmlWrapper) return;
        const wrapperIndex = Number(htmlWrapper.dataset.index ?? i);
        const isTarget = wrapperIndex === index;
        htmlWrapper.classList.toggle('active', isTarget);
        htmlWrapper.style.display = isTarget ? 'block' : 'none';
    });

    if (shouldRestoreScroll) {
        const grid = getGrid(index);
        if (grid?.render) {
            grid.render();
        }
        applyScrollForResultSet(index, {
            sourceUri: source,
            autoBottomLogs: true,
        });
        const sourceUri = source;
        const rsIdx = index;
        // setTimeout (not requestAnimationFrame): layout must settle after display:block + render().
        setTimeout(() => {
            try {
                applyScrollForResultSet(rsIdx, {
                    sourceUri,
                    autoBottomLogs: true,
                });
            } finally {
                if (maskScrollRestore && targetWrapper) {
                    targetWrapper.style.visibility = '';
                }
            }
        }, 50);
    } else if (maskScrollRestore && targetWrapper) {
        targetWrapper.style.visibility = '';
    }

    // Update row count for active tab (do not rely on grid.updateRowCount — grid may be absent)
    renderRowCountInfo(index);
    const grid = getGrid(index);
    if (typeof grid?.updateRowCount === 'function') {
        grid.updateRowCount();
    }

    // Clear column search when switching result sets
    const colSearchInput = getElementById('columnSearch') as HTMLInputElement | null;
    if (colSearchInput) {
        colSearchInput.value = '';
    }
    const colSearchDropdown = document.getElementById('columnSearchDropdown');
    if (colSearchDropdown) {
        colSearchDropdown.style.display = 'none';
    }

    syncAnalysisView();
    updateResultLimitBanner();
    if (getResultPanelWindow().refreshRowView) {
        getResultPanelWindow().refreshRowView!();
    }

    if (document.body.classList.contains('sidebar-layout')) {
        getResultPanelWindow().renderSidebarSchema?.();
    }

    updateRefreshFailureBanner(index);
}
