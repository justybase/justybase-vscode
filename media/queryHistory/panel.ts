import type {
    QueryHistoryEntryDto,
    QueryHistoryHostToWebviewMessage,
    QueryHistoryParameterDto,
    QueryHistoryRecoveryActionType,
    QueryHistorySavedViewDto,
    QueryHistoryStatsDto,
    QueryHistoryUiState,
    QueryHistoryWebviewStateSnapshot,
    QueryHistoryWebviewToHostMessage,
} from './hostContracts.js';
import { postToHost, vscode, asHostMessage } from './protocol.js';
import { showParameterDialog as openParameterDialog } from './parameterDialog.js';
import {
    escapeHtml,
    formatDuration,
    formatRowsAffected,
    formatTimestampParts,
    getStatusInfo,
    renderContextChips,
} from './utils.js';
import {
    iconCopy,
    iconEdit,
    iconHistory,
    iconLoading,
    iconPlay,
    iconSave,
    iconStar,
    iconTrash,
    iconWarning,
} from './icons.js';

type QueryHistoryEntry = QueryHistoryEntryDto;
type QueryHistoryStats = QueryHistoryStatsDto;
type QueryHistorySavedView = QueryHistorySavedViewDto;
type QueryHistoryParameter = QueryHistoryParameterDto;

let allHistory: QueryHistoryEntryDto[] = [];
let isLoading = false;
let isEndOfList = false;
let currentUiState: QueryHistoryUiState | null = null;
let savedViews: QueryHistorySavedViewDto[] = [];
let currentFilter: string | null = null;
let pendingQuickRerunId: string | null = null;

function persistState(): void {
    vscode.setState({
        allHistory,
        savedViews,
        currentFilter,
        pendingQuickRerunId,
        currentUiState
    });
}

/**
 * @param actionType
 */
function dispatchRecoveryAction(actionType: QueryHistoryRecoveryActionType): void {
    if (actionType === 'refresh') {
        postToHost({ type: 'refresh' });
        return;
    }

    if (actionType === 'getSavedViews') {
        postToHost({ type: 'getSavedViews' });
        return;
    }

    postToHost({ type: 'getHistory' });
}

/**
 * Initialize the query history view
 */
function init(): void {
    console.log('queryHistory webview: init -> requesting history');

    const savedState = vscode.getState() as QueryHistoryWebviewStateSnapshot | undefined;
    if (savedState) {
        allHistory = savedState.allHistory;
        savedViews = savedState.savedViews;
        currentFilter = savedState.currentFilter;
        pendingQuickRerunId = savedState.pendingQuickRerunId;
        currentUiState = savedState.currentUiState;
    }

    attachEventListeners();

    if (savedViews.length > 0) {
        renderSavedViews(savedViews);
    }

    if (currentUiState) {
        renderUiState(currentUiState);
    } else if (allHistory.length > 0) {
        renderHistory(allHistory, false);
    }

    postToHost({ type: 'getHistory' });
    postToHost({ type: 'getSavedViews' });
}

function updateStats(stats: QueryHistoryStatsDto): void {
    const statsEl = document.getElementById('stats');
    if (statsEl) {
        let text = `${stats.activeEntries} active`;
        if (stats.archivedEntries > 0) {
            text += ` · ${stats.archivedEntries} archived`;
        }
        text += ` · ${stats.totalFileSizeMB} MB`;
        statsEl.textContent = text;
    }
}

function renderUiState(state: QueryHistoryUiState): void {
    currentUiState = state;
    persistState();

    const container = document.getElementById('historyContainer');
    const indicator = document.getElementById('loadingIndicator');
    if (!container || !indicator) {
        return;
    }

    if (state.kind === 'loading') {
        isLoading = true;
        indicator.style.display = 'block';
        if (allHistory.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">${iconLoading()}</div>
                    <div>${escapeHtml(state.message)}</div>
                </div>
            `;
        }
        return;
    }

    isLoading = false;
    indicator.style.display = 'none';

    if (state.kind === 'empty') {
        if (state.stats) {
            updateStats(state.stats);
        }

        container.innerHTML = `
            <div class="empty-state" data-state-kind="empty">
                <div class="empty-state-icon">${iconHistory()}</div>
                <div>${escapeHtml(state.title)}</div>
                <div>${escapeHtml(state.detail)}</div>
                ${state.action ? `<button class="secondary state-action-btn" data-action-type="${escapeHtml(state.action.messageType)}">${escapeHtml(state.action.label)}</button>` : ''}
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="empty-state" data-state-kind="error">
            <div class="empty-state-icon">${iconWarning()}</div>
            <div>${escapeHtml(state.title)}</div>
            <div>${escapeHtml(state.detail)}</div>
            ${state.action ? `<button class="secondary state-action-btn" data-action-type="${escapeHtml(state.action.messageType)}">${escapeHtml(state.action.label)}</button>` : ''}
        </div>
    `;
}

function renderHistory(history: QueryHistoryEntryDto[], append = false): void {
    const container = document.getElementById('historyContainer');
    if (!container) return;

    if (!append) {
        container.innerHTML = '';
        if (history.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">${iconHistory()}</div>
                    <div>No query history found</div>
                </div>
            `;
            return;
        }
    }

    const html = history.map(entry => {
        const statusInfo = getStatusInfo(entry.status);
        const durationInfo = formatDuration(entry.durationMs);
        const rowsText = formatRowsAffected(entry.rowsAffected);
        const ts = formatTimestampParts(entry.timestamp);
        const contextChips = renderContextChips([
            { label: 'Connection', value: entry.connectionName },
            { label: 'Host', value: entry.host },
            { label: 'Database', value: entry.database },
            { label: 'Schema', value: entry.schema },
        ]);
        const tagChips = entry.tags
            ? entry.tags.split(',').map(tag => tag.trim()).filter(Boolean).map(tag =>
                `<span class="tag-chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`
            ).join('')
            : '';
        return `
        <div class="history-item ${statusInfo.className}">
            <div class="history-status-rail" title="${escapeHtml(statusInfo.text)}"></div>
            <div class="history-body">
                <div class="history-header">
                    <div class="history-context">${contextChips}${tagChips ? `<span class="context-tags">${tagChips}</span>` : ''}</div>
                    <div class="history-stats">
                        <span class="stat-duration ${durationInfo.className}" title="Execution time">${durationInfo.text ? escapeHtml(durationInfo.text) : '—'}</span>
                        ${rowsText ? `<span class="stat-sep">|</span><span class="stat-rows" title="Rows returned">${escapeHtml(rowsText)}</span>` : ''}
                    </div>
                </div>
                <div class="history-sql" title="${escapeHtml(entry.query)}">${escapeHtml(entry.query)}</div>
                ${entry.description ? `<div class="history-description">${escapeHtml(entry.description)}</div>` : ''}
                <div class="history-footer">
                    <span class="history-timestamp"><span class="stat-date">${escapeHtml(ts.date)}</span> <span class="stat-time">${escapeHtml(ts.time)}</span></span>
                    <div class="history-actions">
                        <button class="action-btn primary" data-action="quickRerun" data-id="${escapeHtml(entry.id)}" title="Run query">${iconPlay()}<span>Run</span></button>
                        <button class="action-btn" data-action="copy" data-id="${escapeHtml(entry.id)}" title="Copy SQL">${iconCopy()}</button>
                        <button class="action-btn" data-action="edit" data-id="${escapeHtml(entry.id)}" title="Edit">${iconEdit()}</button>
                        <button class="action-btn ${entry.is_favorite ? 'favorite' : ''}" data-action="favorite" data-id="${escapeHtml(entry.id)}" title="Favorite">${iconStar(entry.is_favorite)}</button>
                        <button class="action-btn delete" data-action="delete" data-id="${escapeHtml(entry.id)}" title="Delete">${iconTrash()}</button>
                    </div>
                </div>
            </div>
        </div>
    `}).join('');

    if (append) {
        container.insertAdjacentHTML('beforeend', html);
    } else {
        container.innerHTML = html;
        container.scrollTop = 0;
    }
}

/**
 * Request history refresh
 */
function refreshHistory(): void {
    postToHost({ type: 'refresh' });
}

function loadMore(): void {
    if (isLoading || isEndOfList) return;
    isLoading = true;
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) indicator.style.display = 'block';
    postToHost({ type: 'loadMore' });
}

/**
 * Request to clear all history
 */
function clearAllHistory(): void {
    postToHost({ type: 'clearAll' });
}

/**
 * Delete a specific entry
 * @param {string} id
 */
function deleteEntry(id: string): void {
    postToHost({ type: 'deleteEntry', id });
}

/**
 * Copy query to clipboard
 * @param {string} id
 */
function copyQuery(id: string): void {
    const entry = allHistory.find(historyEntry => historyEntry.id === id);
    if (entry) {
        postToHost({ type: 'copyQuery', query: entry.query });
    }
}

/**
 * Execute a query
 * @param {string} id
 */
function executeQuery(id: string): void {
    const entry = allHistory.find(historyEntry => historyEntry.id === id);
    if (entry) {
        postToHost({ type: 'executeQuery', query: entry.query });
    }
}

/**
 * Show favorites only
 */
function showFavorites(): void {
    postToHost({ type: 'showFavoritesOnly' });
}

/**
 * Show all history
 */
function showAll(): void {
    postToHost({ type: 'getHistory' });
}

/**
 * Show extended view
 */
function showExtendedView(): void {
    postToHost({ type: 'showExtendedView' });
}

/**
 * Toggle favorite status
 * @param {string} id
 */
function toggleFavorite(id: string): void {
    postToHost({ type: 'toggleFavorite', id });
}

/**
 * Edit an entry
 * @param {string} id
 */
function editEntry(id: string): void {
    const entry = allHistory.find(historyEntry => historyEntry.id === id);
    if (entry) {
        postToHost({ type: 'requestEdit', id });
    }
}

/**
 * Filter by a specific tag
 * @param {string} tag
 */
function filterByTag(tag: string): void {
    postToHost({ type: 'filterByTag', tag });
}

/**
 * Attach all event listeners
 */
function attachEventListeners(): void {
    const refreshBtn = document.getElementById('refreshBtn');
    const clearBtn = document.getElementById('clearAllBtn');
    const showAllBtn = document.getElementById('showAllBtn');
    const showFavoritesBtn = document.getElementById('showFavoritesBtn');
    const showExtendedViewBtn = document.getElementById('showExtendedViewBtn');
    const exportBtn = document.getElementById('exportBtn');
    const container = document.getElementById('historyContainer');
    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('searchInput'));

    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            const target = event.target as HTMLInputElement;
            const searchTerm = target.value.trim();

            if (!searchTerm) {
                document.getElementById('searchArchiveBtn')?.remove();
                document.getElementById('searchStatus')?.remove();
                postToHost({ type: 'refresh' });
                return;
            }

            postToHost({ type: 'search', term: searchTerm.toLowerCase() });
        });
    }

    if (container) {
        container.addEventListener('scroll', () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            if (scrollTop + clientHeight >= scrollHeight - 50) {
                loadMore();
            }
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', (event) => {
            event.preventDefault();
            refreshHistory();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', (event) => {
            event.preventDefault();
            clearAllHistory();
        });
    }
    if (showAllBtn) {
        showAllBtn.addEventListener('click', (event) => {
            event.preventDefault();
            showAll();
        });
    }
    if (showFavoritesBtn) {
        showFavoritesBtn.addEventListener('click', (event) => {
            event.preventDefault();
            showFavorites();
        });
    }
    if (showExtendedViewBtn) {
        showExtendedViewBtn.addEventListener('click', (event) => {
            event.preventDefault();
            showExtendedView();
        });
    }
    if (exportBtn) {
        exportBtn.addEventListener('click', (event) => {
            event.preventDefault();
            postToHost({ type: 'exportHistory' });
        });
    }

    if (container) {
        container.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const actionButton = target.closest('.state-action-btn');
            if (actionButton) {
                const actionType = actionButton.getAttribute('data-action-type');
                if (actionType === 'refresh' || actionType === 'getHistory' || actionType === 'getSavedViews') {
                    dispatchRecoveryAction(actionType);
                }
                return;
            }

            const button = target.closest('button');
            if (!button) {
                return;
            }

            const action = button.getAttribute('data-action');
            const id = button.getAttribute('data-id');
            if (!action || !id) {
                return;
            }

            if (action === 'execute') {
                executeQuery(id);
                return;
            }

            if (action === 'copy') {
                copyQuery(id);
                return;
            }

            if (action === 'delete') {
                const entry = allHistory.find(historyEntry => historyEntry.id === id);
                if (entry) {
                    postToHost({ type: 'deleteEntry', id, query: entry.query });
                }
                return;
            }

            if (action === 'favorite') {
                toggleFavorite(id);
                return;
            }

            if (action === 'edit') {
                editEntry(id);
                return;
            }

            if (action === 'quickRerun') {
                requestQuickRerun(id);
            }
        });

        container.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const tagElement = target.closest('.tag-chip');
            if (!tagElement) {
                return;
            }

            const tagText = tagElement.getAttribute('data-tag') || (tagElement.textContent || '').trim();
            if (!tagText) {
                return;
            }
            postToHost({ type: 'requestTagFilter', tags: [tagText] });
        });
    }
}

window.addEventListener('message', (event) => {
    const message = asHostMessage(event.data);
    console.log('queryHistory webview: received message', message);

    switch (message.type) {
        case 'historyData': {
            currentUiState = null;
            currentFilter = message.filter || null;
            isLoading = false;
            const loadingIndicator = document.getElementById('loadingIndicator');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
            updateStats(message.stats);

            if (message.reset) {
                allHistory = message.history;
                isEndOfList = false;
                renderHistory(allHistory, false);
            } else if (message.history.length > 0) {
                allHistory = [...allHistory, ...message.history];
                renderHistory(message.history, true);
            } else {
                isEndOfList = true;
            }

            persistState();
            break;
        }

        case 'searchResults': {
            currentUiState = null;
            currentFilter = message.term;
            isLoading = false;
            allHistory = message.history;
            updateStats(message.stats);
            renderHistory(allHistory, false);

            let statusEl = document.getElementById('searchStatus');
            if (!statusEl) {
                statusEl = document.createElement('div');
                statusEl.id = 'searchStatus';
                statusEl.className = 'search-status';
                const toolbarTop = document.querySelector('.toolbar-top');
                if (toolbarTop) {
                    toolbarTop.appendChild(statusEl);
                }
            }

            const source = message.source === 'active+archive' ? 'Active + Archive' : 'Active';
            statusEl.textContent = `Found ${allHistory.length} result(s) in ${source}`;
            statusEl.style.color = '#5cb85c';

            document.getElementById('searchArchiveBtn')?.remove();
            persistState();
            break;
        }

        case 'archiveSearchResults': {
            currentUiState = null;
            currentFilter = message.term;
            isLoading = false;
            allHistory = message.history;
            updateStats(message.stats);
            renderHistory(allHistory, false);

            let statusEl = document.getElementById('searchStatus');
            if (!statusEl) {
                statusEl = document.createElement('div');
                statusEl.id = 'searchStatus';
                statusEl.className = 'search-status';
                const toolbarTop = document.querySelector('.toolbar-top');
                if (toolbarTop) {
                    toolbarTop.appendChild(statusEl);
                }
            }

            statusEl.textContent = `Found ${allHistory.length} result(s) in Archive`;
            statusEl.style.color = '#5bc0de';
            document.getElementById('searchArchiveBtn')?.remove();
            persistState();
            break;
        }

        case 'entryDeleted': {
            allHistory = allHistory.filter(entry => entry.id !== message.id);
            renderHistory(allHistory, false);
            persistState();
            break;
        }

        case 'updateStats':
            updateStats(message.stats);
            break;

        case 'debug':
            console.log('queryHistory debug:', message.msg, message);
            break;

        case 'savedViewsData':
            renderSavedViews(message.views);
            persistState();
            break;

        case 'viewSaved':
            postToHost({ type: 'getSavedViews' });
            break;

        case 'viewDeleted':
            postToHost({ type: 'getSavedViews' });
            break;

        case 'queryParameters':
            handleQueryParameters(message.parameters);
            break;

        case 'uiState':
            renderUiState(message.state);
            break;
    }
});

// ====================
// Saved Filter Views
// ====================

function renderSavedViews(views: QueryHistorySavedViewDto[]): void {
    savedViews = views;

    let viewsContainer = document.getElementById('savedViewsContainer');
    if (!viewsContainer) {
        viewsContainer = document.createElement('div');
        viewsContainer.id = 'savedViewsContainer';
        viewsContainer.className = 'saved-views-container';

        const toolbar = document.querySelector('.toolbar');
        if (toolbar) {
            toolbar.insertBefore(viewsContainer, toolbar.children[1]);
        }
    }

    const options = views.length === 0
        ? '<option value="">No saved views</option>'
        : views.map(view => `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name)}</option>`).join('');

    viewsContainer.innerHTML = `
        <select id="savedViewsSelect" class="saved-views-select">
            <option value="">Saved Views...</option>
            ${options}
        </select>
        <button id="saveCurrentViewBtn" class="secondary icon-btn" title="Save current filter">${iconSave()}</button>
        <button id="deleteViewBtn" class="secondary icon-btn" title="Delete selected view">${iconTrash()}</button>
    `;

    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('savedViewsSelect'));
    const saveBtn = document.getElementById('saveCurrentViewBtn');
    const deleteBtn = document.getElementById('deleteViewBtn');

    if (select) {
        select.addEventListener('change', (event) => {
            const viewId = (event.target as HTMLSelectElement).value;
            if (viewId) {
                postToHost({ type: 'applyView', viewId });
            }
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', saveCurrentView);
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const selectedView = document.getElementById('savedViewsSelect') as HTMLSelectElement | null;
            if (selectedView?.value) {
                postToHost({ type: 'deleteView', viewId: selectedView.value });
            }
        });
    }
}

/**
 * Save current filter as a view
 */
function saveCurrentView(): void {
    const name = prompt('Enter a name for this view:');
    if (!name || name.trim() === '') return;

    const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
    const searchTerm = searchInput ? searchInput.value : '';

    const filter = {
        searchTerm: searchTerm || undefined,
        favoritesOnly: false
    };

    postToHost({
        type: 'saveView',
        name: name.trim(),
        filter,
        description: ''
    });
}

// ====================
// Quick Rerun with Parameters
// ====================

function handleQueryParameters(parameters: QueryHistoryParameterDto[]): void {
    if (parameters.length === 0) {
        const currentEntryId = pendingQuickRerunId;
        if (currentEntryId) {
            const entry = allHistory.find((entryItem) => entryItem.id === currentEntryId);
            if (entry) {
                postToHost({ type: 'executeQuery', query: entry.query });
            }
        }
        pendingQuickRerunId = null;
        persistState();
        return;
    }

    openParameterDialog({
        parameters,
        onRun(values) {
            const currentEntryId = pendingQuickRerunId;
            if (currentEntryId) {
                postToHost({ type: 'quickRerun', queryId: currentEntryId, parameters: values });
            }
            pendingQuickRerunId = null;
            persistState();
        },
        onCancel() {
            pendingQuickRerunId = null;
            persistState();
        },
    });
}

/**
 * Request quick rerun for a query
 * If no parameters found in query, execute directly.
 * @param id
 */
function requestQuickRerun(id: string): void {
    const entry = allHistory.find(historyEntry => historyEntry.id === id);
    if (!entry) return;

    pendingQuickRerunId = id;
    persistState();
    postToHost({ type: 'parseQueryParameters', query: entry.query });
}

window.addEventListener('load', () => {
    init();
});
